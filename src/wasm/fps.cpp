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
constexpr double kBroadcastIntervalSeconds = 0.25;
constexpr char kFpsMessageName[] = "SHIFT_Z_CONTINUED_FPS";

HANDLE connection = 0;
double elapsedSeconds = 0;

void closeConnection() {
    if (connection) {
        SimConnect_Close(connection);
        connection = 0;
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
    if (!message || message->dwID != SIMCONNECT_RECV_ID_EVENT_FRAME ||
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
    std::printf("[ShiftZContinued] FPS module connected.\n");
}

extern "C" MSFS_CALLBACK void module_deinit() {
    closeConnection();
}
