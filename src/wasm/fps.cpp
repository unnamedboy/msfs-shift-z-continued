#include <MSFS/MSFS.h>
#include <MSFS/MSFS_CommBus.h>
#include <MSFS/MSFS_WindowsTypes.h>
#include <SimConnect.h>

#include <cmath>
#include <cstddef>
#include <cstdio>

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
// Conflict detection: client event kWatchFirstEvent + i is mapped to kWatchedCommands[i], in non-maskable
// notification groups of at most 1000 events (a SimConnect limit). The groups have the highest priority,
// otherwise an aircraft that masks a command in its own group hides it from this module.
// fsEventsRegisterKeyEventHandler is no alternative: in a standalone module the sim never calls it.
constexpr SIMCONNECT_CLIENT_EVENT_ID kWatchFirstEvent = 100;
constexpr SIMCONNECT_NOTIFICATION_GROUP_ID kWatchFirstGroup = 2;
constexpr size_t kWatchGroupSize = 1000;
constexpr size_t kWatchGroupCount = (shiftz::kWatchedCommandCount + kWatchGroupSize - 1) / kWatchGroupSize;
constexpr SIMCONNECT_INPUT_GROUP_ID kHotkeyInputGroup = 1;
constexpr SIMCONNECT_NOTIFICATION_GROUP_ID kHotkeyNotificationGroup = 1;
constexpr double kBroadcastIntervalSeconds = 0.25;
constexpr char kFpsMessageName[] = "SHIFT_Z_CONTINUED_FPS";
constexpr char kCycleMessageName[] = "SHIFT_Z_CONTINUED_CYCLE";
constexpr char kConfigMessageName[] = "SHIFT_Z_CONTINUED_CONFIG";
constexpr char kConflictMessageName[] = "SHIFT_Z_CONTINUED_CONFLICT";
constexpr char kSetKeysMessageName[] = "SHIFT_Z_CONTINUED_SET_KEYS";
constexpr char kKeysStatusMessageName[] = "SHIFT_Z_CONTINUED_KEYS_STATUS";

// Default Shift+Z / Ctrl+Shift+Z for both modifier sides. The SDK lists upper-case letters but its example
// uses lower case, so both are mapped; duplicate down events are absorbed by the held-key latches.
constexpr char kDefaultKeys[] =
    "cycle=VK_LSHIFT+Z|VK_LSHIFT+z|VK_RSHIFT+Z|VK_RSHIFT+z;"
    "config=VK_LCONTROL+VK_LSHIFT+Z|VK_LCONTROL+VK_LSHIFT+z|VK_LCONTROL+VK_RSHIFT+Z|VK_LCONTROL+VK_RSHIFT+z|"
    "VK_RCONTROL+VK_LSHIFT+Z|VK_RCONTROL+VK_LSHIFT+z|VK_RCONTROL+VK_RSHIFT+Z|VK_RCONTROL+VK_RSHIFT+z";
constexpr SIMCONNECT_CLIENT_EVENT_ID kHotkeyEvents[] = {
    kCycleDownEvent, kCycleUpEvent, kConfigDownEvent, kConfigUpEvent,
};

// A key change is confirmed only after SimConnect has processed the mapping calls: invalid input strings
// are reported later as exceptions, not as failed calls. A system state request sent after the mappings
// is answered after those exceptions.
struct KeyChange {
    bool active = false;
    unsigned id = 0;             // the panel's request id, echoed in the reply
    DWORD check = 0;             // id of the system state request that ends the change
    DWORD lastSendBefore = 0;    // exceptions for later packets belong to this change
    bool failed = false;
    shiftz::HotkeySet keys;
};

HANDLE connection = 0;
bool cycleKeyDown = false;
bool configKeyDown = false;
unsigned pressCount = 0;
shiftz::HotkeySet currentKeys;  // the mappings in effect
KeyChange keyChange;
DWORD checkRequests = 0;
bool watching = false;
bool watchMapped = false;
shiftz::KeyConflictDetector conflicts;
bool frameSincePauseFrame = false;
double broadcastSeconds = 0;

void sendMessage(const char* name, const char* payload, int length) {
    if (length > 0 && !fsCommBusCall(name, payload, static_cast<unsigned int>(length), FsCommBusBroadcast_JS)) {
        std::printf("[ShiftZContinued] %s broadcast failed.\n", name);
    }
}

void sendKeysStatus(unsigned id, const char* result) {
    char payload[64];
    const int length = std::snprintf(payload, sizeof(payload), "{\"id\":%u,\"result\":\"%s\"}", id, result);
    if (length < static_cast<int>(sizeof(payload))) sendMessage(kKeysStatusMessageName, payload, length);
}

void sendPress(const char* name, unsigned press) {
    char payload[32];
    const int length = std::snprintf(payload, sizeof(payload), "{\"press\":%u}", press);
    if (length < static_cast<int>(sizeof(payload))) sendMessage(name, payload, length);
}

void closeConnection() {
    if (connection) {
        SimConnect_Close(connection);
        connection = 0;
    }
    cycleKeyDown = false;
    configKeyDown = false;
    keyChange.active = false;
    watching = false;
    watchMapped = false;
    conflicts.reset();
    broadcastSeconds = 0;
}

// Private client events: no simulator command is invoked and existing bindings are not masked.
bool registerHotkeyEvents() {
    for (const auto event : kHotkeyEvents) {
        if (SimConnect_MapClientEventToSimEvent(connection, event) != S_OK ||
            SimConnect_AddClientEventToNotificationGroup(connection, kHotkeyNotificationGroup, event) != S_OK) {
            return false;
        }
    }
    return SimConnect_SetNotificationGroupPriority(connection, kHotkeyNotificationGroup,
                                                   SIMCONNECT_GROUP_PRIORITY_STANDARD) == S_OK;
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

bool remapHotkeys(const shiftz::HotkeySet& keys) {
    cycleKeyDown = false;
    configKeyDown = false;
    SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
    return mapHotkeys(keys);
}

void restoreHotkeys() {
    if (!remapHotkeys(currentKeys)) std::printf("[ShiftZContinued] Restoring the previous keys failed.\n");
}

void setWatching(bool on) {
    if (on == watching) return;
    watching = on;
    bool ok = true;
    if (!on) {
        for (size_t group = 0; group < kWatchGroupCount; ++group) {
            ok = SimConnect_ClearNotificationGroup(
                     connection, static_cast<SIMCONNECT_NOTIFICATION_GROUP_ID>(kWatchFirstGroup + group)) == S_OK && ok;
        }
        conflicts.clearPending();
        std::printf("[ShiftZContinued] Key conflict watch off%s.\n", ok ? "" : " (a call failed)");
        return;
    }
    conflicts.onWatchStart();
    for (size_t i = 0; i < shiftz::kWatchedCommandCount; ++i) {
        const auto event = static_cast<SIMCONNECT_CLIENT_EVENT_ID>(kWatchFirstEvent + i);
        if (!watchMapped) {
            ok = SimConnect_MapClientEventToSimEvent(connection, event, shiftz::kWatchedCommands[i]) == S_OK && ok;
        }
        const auto group = static_cast<SIMCONNECT_NOTIFICATION_GROUP_ID>(kWatchFirstGroup + i / kWatchGroupSize);
        ok = SimConnect_AddClientEventToNotificationGroup(connection, group, event) == S_OK && ok;
    }
    watchMapped = true;
    for (size_t group = 0; group < kWatchGroupCount; ++group) {
        ok = SimConnect_SetNotificationGroupPriority(connection,
                 static_cast<SIMCONNECT_NOTIFICATION_GROUP_ID>(kWatchFirstGroup + group),
                 SIMCONNECT_GROUP_PRIORITY_HIGHEST) == S_OK && ok;
    }
    std::printf("[ShiftZContinued] Watching %u commands for key conflicts%s.\n",
                static_cast<unsigned>(shiftz::kWatchedCommandCount), ok ? "" : " (a call failed)");
}

// The panel sends the player's keys and the watch setting at start and after every change.
void onSetKeys(const char* buffer, unsigned int size, void*) {
    shiftz::KeyRequest request;
    if (!shiftz::parseKeyRequest(buffer, size, request)) {
        std::printf("[ShiftZContinued] Ignored an invalid key request from the panel.\n");
        sendKeysStatus(request.id, "invalid");
        return;
    }
    setWatching(request.watch);
    // A newer request replaces one still being checked; only the newest is answered.
    keyChange.active = false;
    DWORD lastSend = 0;
    SimConnect_GetLastSentPacketID(connection, &lastSend);
    if (!remapHotkeys(request.keys) ||
        SimConnect_RequestSystemState(connection, ++checkRequests, "Sim") != S_OK) {
        restoreHotkeys();
        std::printf("[ShiftZContinued] The new keys could not be mapped; previous keys restored.\n");
        sendKeysStatus(request.id, "failed");
        return;
    }
    keyChange.active = true;
    keyChange.id = request.id;
    keyChange.check = checkRequests;
    keyChange.lastSendBefore = lastSend;
    keyChange.failed = false;
    keyChange.keys = request.keys;
}

void finishKeyChange() {
    keyChange.active = false;
    conflicts.clearPending();  // presses made while the keys changed are not attributed to either set
    if (keyChange.failed) {
        restoreHotkeys();
        std::printf("[ShiftZContinued] The sim rejected the new keys; previous keys restored.\n");
        sendKeysStatus(keyChange.id, "failed");
        return;
    }
    currentKeys = keyChange.keys;
    sendKeysStatus(keyChange.id, "applied");
}

void onException(const SIMCONNECT_RECV_EXCEPTION& error) {
    if (keyChange.active && error.dwSendID > keyChange.lastSendBefore) {
        keyChange.failed = true;
        return;
    }
    std::printf("[ShiftZContinued] SimConnect exception %lu (packet %lu).\n",
                static_cast<unsigned long>(error.dwException), static_cast<unsigned long>(error.dwSendID));
}

void onEvent(DWORD eventId) {
    if (eventId >= kWatchFirstEvent && eventId - kWatchFirstEvent < shiftz::kWatchedCommandCount) {
        if (watching) conflicts.onCommand(static_cast<int>(eventId - kWatchFirstEvent));
        return;
    }
    // Latches suppress key repeat: one message per press until the matching up event.
    if (eventId == kCycleUpEvent) {
        cycleKeyDown = false;
    } else if (eventId == kConfigUpEvent) {
        configKeyDown = false;
    } else if (eventId == kCycleDownEvent && !cycleKeyDown) {
        cycleKeyDown = true;
        conflicts.onPress(0, ++pressCount);
        sendPress(kCycleMessageName, pressCount);
    } else if (eventId == kConfigDownEvent && !configKeyDown) {
        configKeyDown = true;
        conflicts.onPress(1, ++pressCount);
        sendPress(kConfigMessageName, pressCount);
    }
}

void onFrame(float frameRate) {
    if (!std::isfinite(frameRate) || frameRate <= 0) return;
    const double seconds = 1.0 / frameRate;
    conflicts.advance(seconds);
    const auto report = conflicts.poll();
    if (report.ready && report.count > 0) {
        char payload[512];
        const int length = shiftz::KeyConflictDetector::format(report, shiftz::kWatchedCommands,
                                                               shiftz::kWatchedCommandCount, payload, sizeof(payload));
        sendMessage(kConflictMessageName, payload, length);
    }
    broadcastSeconds += seconds;
    if (broadcastSeconds < kBroadcastIntervalSeconds) return;
    broadcastSeconds = 0;
    char payload[64];
    const int length = std::snprintf(payload, sizeof(payload), "{\"fps\":%.2f}", frameRate);
    if (length < static_cast<int>(sizeof(payload))) sendMessage(kFpsMessageName, payload, length);
}

void CALLBACK onSimConnectMessage(SIMCONNECT_RECV* message, DWORD size, void*) {
    if (!message) return;
    if (message->dwID == SIMCONNECT_RECV_ID_EXCEPTION && size >= sizeof(SIMCONNECT_RECV_EXCEPTION)) {
        onException(*static_cast<SIMCONNECT_RECV_EXCEPTION*>(message));
    } else if (message->dwID == SIMCONNECT_RECV_ID_SYSTEM_STATE && size >= sizeof(SIMCONNECT_RECV) + sizeof(DWORD)) {
        if (keyChange.active && static_cast<SIMCONNECT_RECV_SYSTEM_STATE*>(message)->dwRequestID == keyChange.check) {
            finishKeyChange();
        }
    } else if (message->dwID == SIMCONNECT_RECV_ID_EVENT && size >= sizeof(SIMCONNECT_RECV_EVENT)) {
        onEvent(static_cast<SIMCONNECT_RECV_EVENT*>(message)->uEventID);
    } else if (message->dwID == SIMCONNECT_RECV_ID_EVENT_FRAME && size >= sizeof(SIMCONNECT_RECV_EVENT_FRAME)) {
        const auto* frame = static_cast<SIMCONNECT_RECV_EVENT_FRAME*>(message);
        // It is not known whether Frame keeps firing while paused, so a PauseFrame counts only when no
        // Frame arrived since the previous PauseFrame; time is never counted twice.
        if (frame->uEventID == kFrameEvent) {
            frameSincePauseFrame = true;
            onFrame(frame->fFrameRate);
        } else if (frame->uEventID == kPauseFrameEvent) {
            if (!frameSincePauseFrame) onFrame(frame->fFrameRate);
            frameSincePauseFrame = false;
        }
    }
}

} // namespace

extern "C" MSFS_CALLBACK void module_init() {
    if (SimConnect_Open(&connection, "Shift Z Continued", nullptr, 0, 0, 0) != S_OK) {
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
    shiftz::parseHotkeySet(kDefaultKeys, sizeof(kDefaultKeys) - 1, currentKeys);
    if (!registerHotkeyEvents() || !mapHotkeys(currentKeys)) {
        SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
        std::printf("[ShiftZContinued] Hotkey registration failed; FPS remains available.\n");
        return;
    }
    if (!fsCommBusRegister(kSetKeysMessageName, onSetKeys, nullptr)) {
        std::printf("[ShiftZContinued] Key changes unavailable; the default keys stay.\n");
    }
    std::printf("[ShiftZContinued] Module ready.\n");
}

extern "C" MSFS_CALLBACK void module_deinit() {
    fsCommBusUnregister(kSetKeysMessageName, onSetKeys);
    closeConnection();
}
