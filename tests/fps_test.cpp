#include <cassert>
#include <limits>
#include <string>
#include <vector>
#include "../src/wasm/fps.cpp"

namespace {
std::vector<std::string> events;
std::vector<std::string> messages;
int fail_open = 0, fail_subscribe = 0, closed = 0;
DispatchProc callback = nullptr;
}
int SimConnect_Open(HANDLE* handle, const char*, void*, DWORD, int, DWORD) {
    if (fail_open) return 1;
    *handle = 7; return S_OK;
}
int SimConnect_SubscribeToSystemEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID, const char* name) {
    events.emplace_back(name); return fail_subscribe ? 1 : S_OK;
}
int SimConnect_CallDispatch(HANDLE, DispatchProc proc, void*) { callback = proc; return S_OK; }
int SimConnect_Close(HANDLE) { ++closed; return S_OK; }
bool fsCommBusCall(const char* name, const char* data, unsigned int length, FsCommBusBroadcastFlags destination) {
    assert(std::string(name) == "SHIFT_Z_CONTINUED_FPS");
    assert(destination == FsCommBusBroadcast_JS);
    messages.emplace_back(data, length); return true;
}
int main() {
    module_init();
    assert(events.size() == 2 && events[0] == "Frame" && events[1] == "PauseFrame" && callback);
    SIMCONNECT_RECV_EVENT_FRAME frame{};
    frame.dwID = SIMCONNECT_RECV_ID_EVENT_FRAME; frame.uEventID = 1; frame.fFrameRate = 4;
    callback(&frame, sizeof(frame), nullptr);
    assert(messages.size() == 1 && messages[0] == "{\"fps\":4.00}");
    frame.fFrameRate = 0; callback(&frame, sizeof(frame), nullptr);
    frame.fFrameRate = std::numeric_limits<float>::quiet_NaN(); callback(&frame, sizeof(frame), nullptr);
    frame.fFrameRate = 4; frame.uEventID = 99; callback(&frame, sizeof(frame), nullptr);
    callback(&frame, sizeof(SIMCONNECT_RECV), nullptr);
    assert(messages.size() == 1);
    frame.uEventID = 2; callback(&frame, sizeof(frame), nullptr);
    assert(messages.size() == 2);
    module_deinit(); assert(closed == 1);
    fail_open = 1; module_init(); module_deinit(); assert(closed == 1);
    fail_open = 0; fail_subscribe = 1; module_init(); module_deinit(); assert(closed == 2);
}
