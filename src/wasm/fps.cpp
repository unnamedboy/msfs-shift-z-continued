#include <MSFS/MSFS.h>
#include <MSFS/MSFS_CommBus.h>
#include <MSFS/MSFS_WindowsTypes.h>
#include <SimConnect.h>

#include <cmath>
#include <cstdio>

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
constexpr SIMCONNECT_INPUT_GROUP_ID kHotkeyInputGroup = 1;
constexpr SIMCONNECT_NOTIFICATION_GROUP_ID kHotkeyNotificationGroup = 1;
constexpr double kBroadcastIntervalSeconds = 0.25;
constexpr char kFpsMessageName[] = "SHIFT_Z_CONTINUED_FPS";
constexpr char kCycleMessageName[] = "SHIFT_Z_CONTINUED_CYCLE";

HANDLE connection = 0;
double elapsedSeconds = 0;
bool cycleKeyDown = false;

void closeConnection() {
    if (connection) {
        SimConnect_Close(connection);
        connection = 0;
    }
    cycleKeyDown = false;
    elapsedSeconds = 0;
}

bool registerHotkey() {
    // Private events: no simulator command is invoked and existing bindings are not masked.
    if (SimConnect_MapClientEventToSimEvent(connection, kCycleDownEvent) != S_OK ||
        SimConnect_MapClientEventToSimEvent(connection, kCycleUpEvent) != S_OK ||
        SimConnect_AddClientEventToNotificationGroup(connection, kHotkeyNotificationGroup, kCycleDownEvent) != S_OK ||
        SimConnect_AddClientEventToNotificationGroup(connection, kHotkeyNotificationGroup, kCycleUpEvent) != S_OK ||
        SimConnect_SetNotificationGroupPriority(connection, kHotkeyNotificationGroup, SIMCONNECT_GROUP_PRIORITY_STANDARD) != S_OK ||
        SimConnect_MapInputEventToClientEvent_EX1(connection, kHotkeyInputGroup, "VK_LSHIFT+z", kCycleDownEvent, 0, kCycleUpEvent) != S_OK ||
        SimConnect_MapInputEventToClientEvent_EX1(connection, kHotkeyInputGroup, "VK_RSHIFT+z", kCycleDownEvent, 0, kCycleUpEvent) != S_OK ||
        SimConnect_SetInputGroupPriority(connection, kHotkeyInputGroup, SIMCONNECT_GROUP_PRIORITY_STANDARD) != S_OK ||
        SimConnect_SetInputGroupState(connection, kHotkeyInputGroup, SIMCONNECT_STATE_ON) != S_OK) {
        SimConnect_ClearInputGroup(connection, kHotkeyInputGroup);
        std::printf("[ShiftZContinued] Experimental hotkey registration failed; FPS remains available.\n");
        return false;
    }
    std::printf("[ShiftZContinued] Experimental Shift+Z mappings registered.\n");
    return true;
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
        std::printf("[ShiftZContinued] SimConnect exception %lu (send %lu, index %lu).\n",
                    static_cast<unsigned long>(error->dwException),
                    static_cast<unsigned long>(error->dwSendID),
                    static_cast<unsigned long>(error->dwIndex));
        return;
    }
    if (message->dwID == SIMCONNECT_RECV_ID_EVENT && size >= sizeof(SIMCONNECT_RECV_EVENT)) {
        const auto* event = static_cast<SIMCONNECT_RECV_EVENT*>(message);
        if (event->uEventID == kCycleUpEvent) {
            cycleKeyDown = false;
        } else if (event->uEventID == kCycleDownEvent && !cycleKeyDown) {
            cycleKeyDown = true;
            constexpr char payload[] = "{}";
            if (!fsCommBusCall(kCycleMessageName, payload, sizeof(payload) - 1, FsCommBusBroadcast_JS)) {
                std::printf("[ShiftZContinued] Cycle broadcast failed.\n");
            }
        }
        return;
    }
    if (message->dwID != SIMCONNECT_RECV_ID_EVENT_FRAME ||
        size < sizeof(SIMCONNECT_RECV_EVENT_FRAME)) {
        return;
    }

    const auto* frame = static_cast<SIMCONNECT_RECV_EVENT_FRAME*>(message);
    const bool isFrameEvent = frame->uEventID == kFrameEvent || frame->uEventID == kPauseFrameEvent;
    if (!isFrameEvent || !std::isfinite(frame->fFrameRate) || frame->fFrameRate <= 0) {
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
    registerHotkey();
    std::printf("[ShiftZContinued] FPS module connected.\n");
}

extern "C" MSFS_CALLBACK void module_deinit() {
    closeConnection();
}
