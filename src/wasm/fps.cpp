#include <MSFS/MSFS.h>
#include <MSFS/MSFS_CommBus.h>
#include <MSFS/MSFS_Vars.h>
#include <MSFS/MSFS_WindowsTypes.h>
#include <SimConnect.h>

#include <cmath>
#include <cstddef>
#include <cstdio>

#include "hotkey_code.h"
#include "hotkey_keys.h"
#include "key_conflicts.h"
#include "watched_commands.h"

// The SDK runtime uses this handler when a stack guard detects corruption.
// Define it inside the module so the simulator does not have to supply it.
#if defined(__wasm__)
extern "C" [[noreturn]] void __stack_chk_fail() {
    __builtin_trap();
}
#endif

namespace {

constexpr SIMCONNECT_CLIENT_EVENT_ID kFrameEvent = 1;
constexpr SIMCONNECT_CLIENT_EVENT_ID kPauseFrameEvent = 2;
constexpr SIMCONNECT_CLIENT_EVENT_ID kCycleDownEvent = 3;
constexpr SIMCONNECT_CLIENT_EVENT_ID kCycleUpEvent = 4;
constexpr SIMCONNECT_CLIENT_EVENT_ID kConfigDownEvent = 5;
constexpr SIMCONNECT_CLIENT_EVENT_ID kConfigUpEvent = 6;
// Conflict detection: SimConnect notifies this module of every command in watched_commands.h (client event
// kWatchFirstEvent + index), in non-maskable groups of at most 1000 events. The detector works on the index.
// The groups have the highest priority: an aircraft that masks a command in its own maskable group would
// otherwise hide it from this module (tenth test: bound keys an airliner handles itself were not seen).
// fsEventsRegisterKeyEventHandler cannot replace this: in a standalone module the sim treats its handler as
// belonging to a dirty module and never calls it (see docs/experimental-wasm-hotkey.md).
constexpr SIMCONNECT_CLIENT_EVENT_ID kWatchFirstEvent = 100;
constexpr SIMCONNECT_NOTIFICATION_GROUP_ID kWatchFirstGroup = 2;
constexpr size_t kWatchGroupSize = 1000;
constexpr size_t kWatchGroupCount = (shiftz::kWatchedCommandCount + kWatchGroupSize - 1) / kWatchGroupSize;
constexpr unsigned long kLoggedExceptions = 5;
constexpr SIMCONNECT_INPUT_GROUP_ID kHotkeyInputGroup = 1;
constexpr SIMCONNECT_NOTIFICATION_GROUP_ID kHotkeyNotificationGroup = 1;
constexpr double kBroadcastIntervalSeconds = 0.25;
constexpr char kFpsMessageName[] = "SHIFT_Z_CONTINUED_FPS";
constexpr char kCycleMessageName[] = "SHIFT_Z_CONTINUED_CYCLE";
constexpr char kConfigMessageName[] = "SHIFT_Z_CONTINUED_CONFIG";

constexpr char kConflictMessageName[] = "SHIFT_Z_CONTINUED_CONFLICT";
constexpr char kSetKeysMessageName[] = "SHIFT_Z_CONTINUED_SET_KEYS";
constexpr char kKeysStatusMessageName[] = "SHIFT_Z_CONTINUED_KEYS_STATUS";
// The panel also writes the key set, encoded as a number (hotkey_code.h), to this L:var.
constexpr char kKeysLVarName[] = "SHIFT_Z_CONTINUED_KEYS";

// Default Shift+Z / Ctrl+Shift+Z for both modifier sides. The SDK lists upper-case letters but its example
// uses lower case, so both are mapped; duplicate down events are absorbed by the held-key latches.
constexpr char kDefaultKeys[] =
    "cycle=VK_LSHIFT+Z|VK_LSHIFT+z|VK_RSHIFT+Z|VK_RSHIFT+z;"
    "config=VK_LCONTROL+VK_LSHIFT+Z|VK_LCONTROL+VK_LSHIFT+z|VK_LCONTROL+VK_RSHIFT+Z|VK_LCONTROL+VK_RSHIFT+z|"
    "VK_RCONTROL+VK_LSHIFT+Z|VK_RCONTROL+VK_LSHIFT+z|VK_RCONTROL+VK_RSHIFT+Z|VK_RCONTROL+VK_RSHIFT+z";
constexpr SIMCONNECT_CLIENT_EVENT_ID kHotkeyEvents[] = {
    kCycleDownEvent, kCycleUpEvent, kConfigDownEvent, kConfigUpEvent,
};
constexpr int kCycleKey = 0;
constexpr int kConfigKey = 1;

HANDLE connection = 0;
double elapsedSeconds = 0;
bool cycleKeyDown = false;
bool configKeyDown = false;
bool hotkeyEventsReady = false;
shiftz::KeyConflictDetector conflicts;
FsLVarId keysLVar = FS_VAR_INVALID_ID;
FsUnitId numberUnit = FS_INVALID_UNIT;
double lastKeysValue = 0;
unsigned long simConnectExceptions = 0;
unsigned long loggedExceptions = 0;  // other exceptions are logged up to kLoggedExceptions
DWORD watchMapSends[shiftz::kWatchedCommandCount] = {};  // packet id of each name mapping, to name unknown ones

// Logs each SimConnect message type this module does not handle, once, so unexpected messages show up.
void noteUnhandledMessage(DWORD id) {
    static bool seen[64] = {};
    static bool seenLarger = false;  // ids of 64 and above are logged once in total
    bool& flag = id < 64 ? seen[id] : seenLarger;
    if (flag) return;
    flag = true;
    std::printf("[ShiftZContinued] SimConnect message type %lu not handled.\n", static_cast<unsigned long>(id));
}

void closeConnection() {
    if (connection) {
        SimConnect_Close(connection);
        connection = 0;
    }
    cycleKeyDown = false;
    configKeyDown = false;
    hotkeyEventsReady = false;
    elapsedSeconds = 0;
    for (auto& send : watchMapSends) send = 0;
    conflicts.reset();
    keysLVar = FS_VAR_INVALID_ID;
    lastKeysValue = 0;
    simConnectExceptions = 0;
    loggedExceptions = 0;
}

// Private client events: no simulator command is invoked and existing bindings are not masked.
bool registerHotkeyEvents() {
    for (const auto event : kHotkeyEvents) {
        if (SimConnect_MapClientEventToSimEvent(connection, event) != S_OK) return false;
    }
    for (const auto event : kHotkeyEvents) {
        if (SimConnect_AddClientEventToNotificationGroup(connection, kHotkeyNotificationGroup, event) != S_OK) return false;
    }
    return SimConnect_SetNotificationGroupPriority(connection, kHotkeyNotificationGroup, SIMCONNECT_GROUP_PRIORITY_STANDARD) == S_OK;
}

bool mapHotkeys(const shiftz::HotkeySet& keys) {
    const SIMCONNECT_CLIENT_EVENT_ID down[2] = {kCycleDownEvent, kConfigDownEvent};
    const SIMCONNECT_CLIENT_EVENT_ID up[2] = {kCycleUpEvent, kConfigUpEvent};
    for (int key = 0; key < 2; ++key) {
        for (size_t i = 0; i < keys.counts[key]; ++i) {
            if (SimConnect_MapInputEventToClientEvent_EX1(connection, kHotkeyInputGroup, keys.definitions[key][i],
                                                          down[key], 0, up[key]) != S_OK) {
                return false;
            }
        }
    }
    return SimConnect_SetInputGroupPriority(connection, kHotkeyInputGroup, SIMCONNECT_GROUP_PRIORITY_STANDARD) == S_OK &&
           SimConnect_SetInputGroupState(connection, kHotkeyInputGroup, SIMCONNECT_STATE_ON) == S_OK;
}

bool applyHotkeys(const shiftz::HotkeySet& keys) {
    cycleKeyDown = false;
    configKeyDown = false;
    if (mapHotkeys(keys)) return true;
    SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
    return false;
}

bool registerHotkey() {
    shiftz::HotkeySet keys;
    shiftz::parseHotkeySet(kDefaultKeys, sizeof(kDefaultKeys) - 1, keys);
    hotkeyEventsReady = registerHotkeyEvents();
    if (!hotkeyEventsReady || !applyHotkeys(keys)) {
        hotkeyEventsReady = false;
        SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
        std::printf("[ShiftZContinued] Hotkey registration failed; FPS remains available.\n");
        return false;
    }
    std::printf("[ShiftZContinued] Shift+Z and Ctrl+Shift+Z mappings registered.\n");
    return true;
}

// Tells the panel whether a key set arrived and was applied, and by which path, so problems show in its card.
void sendKeysStatus(const char* via, const char* result) {
    char payload[96];
    const int length = std::snprintf(payload, sizeof(payload), "{\"via\":\"%s\",\"result\":\"%s\"}", via, result);
    if (length > 0 && static_cast<size_t>(length) < sizeof(payload) &&
        !fsCommBusCall(kKeysStatusMessageName, payload, static_cast<unsigned int>(length), FsCommBusBroadcast_JS)) {
        std::printf("[ShiftZContinued] Key status broadcast failed.\n");
    }
}

// The panel sends the player's keys at start and after every change, over CommBus and through an L:var.
void applyKeyText(const char* buffer, unsigned int size, const char* via) {
    std::printf("[ShiftZContinued] Key set received via %s (%u bytes).\n", via, size);
    shiftz::HotkeySet keys;
    if (!connection || !hotkeyEventsReady || !shiftz::parseHotkeySet(buffer, size, keys)) {
        std::printf("[ShiftZContinued] Ignored invalid key set from the panel.\n");
        sendKeysStatus(via, "invalid");
        return;
    }
    SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
    if (applyHotkeys(keys)) {
        std::printf("[ShiftZContinued] Player key set applied.\n");
        sendKeysStatus(via, "applied");
        return;
    }
    shiftz::HotkeySet defaults;
    shiftz::parseHotkeySet(kDefaultKeys, sizeof(kDefaultKeys) - 1, defaults);
    const bool restored = applyHotkeys(defaults);
    std::printf("[ShiftZContinued] Player key set failed; defaults %s.\n", restored ? "restored" : "unavailable");
    sendKeysStatus(via, restored ? "failed-defaults" : "failed");
}

void onSetKeys(const char* buffer, unsigned int size, void*) {
    applyKeyText(buffer, size, "commbus");
}

void reportConflicts() {
    const auto report = conflicts.poll();
    if (!report.ready) return;
    const char* key = report.key == kCycleKey ? "cycle" : "config";
    if (report.count == 0) {
        std::printf("[ShiftZContinued] Press check (%s): no other command (%lu SimConnect exceptions so far).\n",
                    key, simConnectExceptions);
        return;
    }
    char payload[512];
    const int length = shiftz::KeyConflictDetector::format(report, payload, sizeof(payload),
                                                           shiftz::kWatchedCommands, shiftz::kWatchedCommandCount);
    std::printf("[ShiftZContinued] Press check (%s): %s\n", key, length > 0 ? payload : "report too long");
    if (length > 0 &&
        !fsCommBusCall(kConflictMessageName, payload, static_cast<unsigned int>(length), FsCommBusBroadcast_JS)) {
        std::printf("[ShiftZContinued] Conflict broadcast failed.\n");
    }
}

// Each send changes the value (a counter is part of it), so every send is applied and answered once.
// A value without the counter part was not written by the panel (the sim showed a 1 during flight loading).
void pollKeysLVar() {
    if (keysLVar == FS_VAR_INVALID_ID) return;
    double value = 0;
    if (fsVarsLVarGet(keysLVar, numberUnit, &value) != FS_VAR_ERROR_NONE || value == lastKeysValue) return;
    lastKeysValue = value;
    if (value < shiftz::kHotkeySetBase) return;
    char text[512];
    const size_t length = shiftz::hotkeyTextFromCode(value, text, sizeof(text));
    if (length == 0) {
        std::printf("[ShiftZContinued] Ignored invalid key code %.0f from the panel.\n", value);
        sendKeysStatus("lvar", "invalid");
        return;
    }
    applyKeyText(text, static_cast<unsigned int>(length), "lvar");
}

// A name the sim does not know comes back later as a SimConnect exception for that event only.
void watchCommands() {
    unsigned failed = 0;
    for (size_t i = 0; i < shiftz::kWatchedCommandCount; ++i) {
        const auto event = static_cast<SIMCONNECT_CLIENT_EVENT_ID>(kWatchFirstEvent + i);
        const auto group = static_cast<SIMCONNECT_NOTIFICATION_GROUP_ID>(kWatchFirstGroup + i / kWatchGroupSize);
        if (SimConnect_MapClientEventToSimEvent(connection, event, shiftz::kWatchedCommands[i]) != S_OK) {
            ++failed;
            continue;
        }
        if (SimConnect_GetLastSentPacketID(connection, &watchMapSends[i]) != S_OK) watchMapSends[i] = 0;
        if (SimConnect_AddClientEventToNotificationGroup(connection, group, event) != S_OK) ++failed;
    }
    for (size_t group = 0; group < kWatchGroupCount; ++group) {
        if (SimConnect_SetNotificationGroupPriority(connection, static_cast<SIMCONNECT_NOTIFICATION_GROUP_ID>(
                kWatchFirstGroup + group), SIMCONNECT_GROUP_PRIORITY_HIGHEST) != S_OK) {
            ++failed;
        }
    }
    std::printf("[ShiftZContinued] Watching %u commands for key conflicts (%u calls failed).\n",
                static_cast<unsigned>(shiftz::kWatchedCommandCount), failed);
}

// The watched command whose name mapping had this packet id, or nullptr.
const char* watchedCommandForSend(DWORD sendId) {
    if (sendId == 0) return nullptr;
    for (size_t i = 0; i < shiftz::kWatchedCommandCount; ++i) {
        if (watchMapSends[i] == sendId) return shiftz::kWatchedCommands[i];
    }
    return nullptr;
}

void sendKeyMessage(const char* name) {
    constexpr char payload[] = "{}";
    if (!fsCommBusCall(name, payload, sizeof(payload) - 1, FsCommBusBroadcast_JS)) {
        std::printf("[ShiftZContinued] %s broadcast failed.\n", name);
    }
}

void broadcastFrameRate(float frameRate) {
    char payload[64];
    const int length = std::snprintf(payload, sizeof(payload), "{\"fps\":%.2f}", frameRate);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(payload)) {
        return;
    }

    const bool sent = fsCommBusCall(kFpsMessageName, payload,
                                    static_cast<unsigned int>(length), FsCommBusBroadcast_JS);
    if (!sent) {
        std::printf("[ShiftZContinued] FPS broadcast failed.\n");
    }
}

void CALLBACK onSimConnectMessage(SIMCONNECT_RECV* message, DWORD size, void*) {
    if (!message || size < sizeof(SIMCONNECT_RECV)) return;
    if (message->dwID == SIMCONNECT_RECV_ID_EXCEPTION && size >= sizeof(SIMCONNECT_RECV_EXCEPTION)) {
        const auto* error = static_cast<SIMCONNECT_RECV_EXCEPTION*>(message);
        ++simConnectExceptions;
        const char* unknown = error->dwException == SIMCONNECT_EXCEPTION_NAME_UNRECOGNIZED
            ? watchedCommandForSend(error->dwSendID) : nullptr;
        if (unknown) {
            // Listed in the documentation but unknown to this sim; its notification group entry fails as well.
            std::printf("[ShiftZContinued] Unknown command name %s; not watched.\n", unknown);
        } else if (loggedExceptions < kLoggedExceptions) {
            ++loggedExceptions;
            std::printf("[ShiftZContinued] SimConnect exception %lu (send %lu, index %lu)%s.\n",
                        static_cast<unsigned long>(error->dwException),
                        static_cast<unsigned long>(error->dwSendID),
                        static_cast<unsigned long>(error->dwIndex),
                        loggedExceptions == kLoggedExceptions ? ". Further ones are only counted" : "");
        }
        return;
    }
    if (message->dwID == SIMCONNECT_RECV_ID_OPEN) return;
    // MSFS 2024 can send an event as EVENT_EX1 (five data words), for example one a key binding triggers
    // with parameters. Both forms carry uEventID. (The ninth test saw key bindings arrive as plain EVENT.)
    bool isEvent = false;
    DWORD eventId = 0;
    if (message->dwID == SIMCONNECT_RECV_ID_EVENT && size >= sizeof(SIMCONNECT_RECV_EVENT)) {
        isEvent = true;
        eventId = static_cast<SIMCONNECT_RECV_EVENT*>(message)->uEventID;
    } else if (message->dwID == SIMCONNECT_RECV_ID_EVENT_EX1 && size >= sizeof(SIMCONNECT_RECV_EVENT_EX1)) {
        isEvent = true;
        eventId = static_cast<SIMCONNECT_RECV_EVENT_EX1*>(message)->uEventID;
    }
    if (isEvent) {
        if (eventId >= kWatchFirstEvent && eventId - kWatchFirstEvent < shiftz::kWatchedCommandCount) {
            conflicts.onKeyEvent(static_cast<int>(eventId - kWatchFirstEvent));
            return;
        }
        // Latches suppress key repeat: one message per press until the matching up event.
        if (eventId == kCycleUpEvent) {
            cycleKeyDown = false;
        } else if (eventId == kCycleDownEvent && !cycleKeyDown) {
            cycleKeyDown = true;
            conflicts.onPress(kCycleKey);
            sendKeyMessage(kCycleMessageName);
        } else if (eventId == kConfigUpEvent) {
            configKeyDown = false;
        } else if (eventId == kConfigDownEvent && !configKeyDown) {
            configKeyDown = true;
            conflicts.onPress(kConfigKey);
            sendKeyMessage(kConfigMessageName);
        }
        return;
    }
    if (message->dwID != SIMCONNECT_RECV_ID_EVENT_FRAME) {
        noteUnhandledMessage(message->dwID);
        return;
    }
    if (size < sizeof(SIMCONNECT_RECV_EVENT_FRAME)) {
        return;
    }

    const auto* frame = static_cast<SIMCONNECT_RECV_EVENT_FRAME*>(message);
    const bool isFrameEvent = frame->uEventID == kFrameEvent || frame->uEventID == kPauseFrameEvent;
    if (!isFrameEvent) return;
    conflicts.onFrame();
    reportConflicts();
    pollKeysLVar();
    if (!std::isfinite(frame->fFrameRate) || frame->fFrameRate <= 0) {
        return;
    }

    // Estimate elapsed time from each frame rate and send roughly four updates per second.
    elapsedSeconds += 1.0 / frame->fFrameRate;
    if (elapsedSeconds < kBroadcastIntervalSeconds) {
        return;
    }

    elapsedSeconds = 0;
    broadcastFrameRate(frame->fFrameRate);
}

} // namespace

extern "C" MSFS_CALLBACK void module_init() {
    std::printf("[ShiftZContinued] FPS module initializing.\n");
    if (SimConnect_Open(&connection, "Shift Z Continued FPS", nullptr, 0, 0, 0) != S_OK) {
        std::printf("[ShiftZContinued] SimConnect open failed.\n");
        return;
    }

    if (SimConnect_SubscribeToSystemEvent(connection, kFrameEvent, "Frame") != S_OK ||
        SimConnect_CallDispatch(connection, onSimConnectMessage, nullptr) != S_OK) {
        std::printf("[ShiftZContinued] Frame event subscription or dispatch failed.\n");
        closeConnection();
        return;
    }

    if (SimConnect_SubscribeToSystemEvent(connection, kPauseFrameEvent, "PauseFrame") != S_OK) {
        std::printf("[ShiftZContinued] PauseFrame unavailable; continuing with Frame.\n");
    }
    if (registerHotkey()) {
        watchCommands();
        if (!fsCommBusRegister(kSetKeysMessageName, onSetKeys, nullptr)) {
            std::printf("[ShiftZContinued] CommBus key changes unavailable.\n");
        }
        numberUnit = fsVarsGetUnitId("number");
        keysLVar = fsVarsRegisterLVar(kKeysLVarName);
        std::printf("[ShiftZContinued] Key L:var %s (id %d, unit %d).\n",
                    keysLVar == FS_VAR_INVALID_ID ? "unavailable" : "registered", keysLVar, numberUnit);
    }
    std::printf("[ShiftZContinued] FPS module connected.\n");
}

extern "C" MSFS_CALLBACK void module_deinit() {
    fsCommBusUnregister(kSetKeysMessageName, onSetKeys);
    closeConnection();
}
