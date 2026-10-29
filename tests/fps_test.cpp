#include <cassert>
#include <limits>
#include <string>
#include <vector>
#include "../src/wasm/fps.cpp"

namespace {
std::vector<std::string> events;
std::vector<std::string> messages;
std::vector<std::string> messageNames;
std::vector<std::string> inputDefinitions;
std::vector<SIMCONNECT_CLIENT_EVENT_ID> notificationEvents;
int hotkeyCall = 0, failHotkeyCall = 0, clearedInputs = 0;
bool inputEnabled = false;
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
int hotkeyResult() { return ++hotkeyCall == failHotkeyCall ? 1 : S_OK; }
int SimConnect_MapClientEventToSimEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID, const char* name) {
    assert(!name || !*name); return hotkeyResult();
}
int SimConnect_AddClientEventToNotificationGroup(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID, SIMCONNECT_CLIENT_EVENT_ID event, int maskable) {
    assert(!maskable); notificationEvents.push_back(event); return hotkeyResult();
}
int SimConnect_SetNotificationGroupPriority(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID, DWORD priority) {
    assert(priority == SIMCONNECT_GROUP_PRIORITY_STANDARD); return hotkeyResult();
}
int SimConnect_MapInputEventToClientEvent_EX1(HANDLE, SIMCONNECT_INPUT_GROUP_ID, const char* definition, SIMCONNECT_CLIENT_EVENT_ID down, DWORD, SIMCONNECT_CLIENT_EVENT_ID up, DWORD, int maskable) {
    assert(down == kCycleDownEvent && up == kCycleUpEvent && !maskable);
    inputDefinitions.emplace_back(definition); return hotkeyResult();
}
int SimConnect_SetInputGroupPriority(HANDLE, SIMCONNECT_INPUT_GROUP_ID, DWORD priority) {
    assert(priority == SIMCONNECT_GROUP_PRIORITY_STANDARD); return hotkeyResult();
}
int SimConnect_SetInputGroupState(HANDLE, SIMCONNECT_INPUT_GROUP_ID, DWORD state) {
    assert(state == SIMCONNECT_STATE_ON);
    const int result = hotkeyResult(); inputEnabled = result == S_OK; return result;
}
int SimConnect_ClearInputGroup(HANDLE, SIMCONNECT_INPUT_GROUP_ID) {
    ++clearedInputs; inputEnabled = false; return S_OK;
}
bool fsCommBusCall(const char* name, const char* data, unsigned int length, FsCommBusBroadcastFlags destination) {
    assert(destination == FsCommBusBroadcast_JS);
    messageNames.emplace_back(name);
    messages.emplace_back(data, length); return true;
}
int main() {
    module_init();
    assert(events.size() == 2 && events[0] == "Frame" && events[1] == "PauseFrame" && callback);
    assert(inputEnabled && hotkeyCall == 9);
    assert((inputDefinitions == std::vector<std::string>{"VK_LSHIFT+z", "VK_RSHIFT+z"}));
    assert((notificationEvents == std::vector<SIMCONNECT_CLIENT_EVENT_ID>{kCycleDownEvent, kCycleUpEvent}));
    SIMCONNECT_RECV_EVENT_FRAME frame{};
    frame.dwID = SIMCONNECT_RECV_ID_EVENT_FRAME; frame.uEventID = 1; frame.fFrameRate = 4;
    callback(&frame, sizeof(frame), nullptr);
    assert(messages.size() == 1 && messages[0] == "{\"fps\":4.00}");
    assert(messageNames[0] == "SHIFT_Z_CONTINUED_FPS");
    frame.fFrameRate = 0; callback(&frame, sizeof(frame), nullptr);
    frame.fFrameRate = std::numeric_limits<float>::quiet_NaN(); callback(&frame, sizeof(frame), nullptr);
    frame.fFrameRate = 4; frame.uEventID = 99; callback(&frame, sizeof(frame), nullptr);
    callback(&frame, sizeof(SIMCONNECT_RECV), nullptr);
    assert(messages.size() == 1);
    frame.uEventID = 2; callback(&frame, sizeof(frame), nullptr);
    assert(messages.size() == 2);
    SIMCONNECT_RECV_EVENT key{};
    key.dwID = SIMCONNECT_RECV_ID_EVENT;
    key.uEventID = 99; callback(&key, sizeof(key), nullptr);
    key.uEventID = kCycleDownEvent; callback(&key, sizeof(SIMCONNECT_RECV), nullptr);
    assert(messages.size() == 2);
    callback(&key, sizeof(key), nullptr);
    callback(&key, sizeof(key), nullptr); // A held key must cycle only once.
    assert(messages.size() == 3 && messages.back() == "{}");
    assert(messageNames.back() == "SHIFT_Z_CONTINUED_CYCLE");
    key.uEventID = kCycleUpEvent; callback(&key, sizeof(key), nullptr);
    key.uEventID = kCycleDownEvent; callback(&key, sizeof(key), nullptr);
    assert(messages.size() == 4);
    module_deinit(); assert(closed == 1);
    // Every registration failure must leave FPS dispatch alive and remove partial inputs.
    for (int failure = 1; failure <= 9; ++failure) {
        hotkeyCall = 0; failHotkeyCall = failure;
        module_init();
        assert(connection && !inputEnabled && !cycleKeyDown);
        const auto before = messages.size();
        callback(&frame, sizeof(frame), nullptr);
        assert(messages.size() == before + 1 && messageNames.back() == "SHIFT_Z_CONTINUED_FPS");
        module_deinit();
    }
    assert(clearedInputs == 9);
    failHotkeyCall = 0;
    const int closedBeforeFailures = closed;
    fail_open = 1; module_init(); module_deinit(); assert(closed == closedBeforeFailures);
    fail_open = 0; fail_subscribe = 1; module_init(); module_deinit(); assert(closed == closedBeforeFailures + 1);
}
