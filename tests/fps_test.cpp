#include <cassert>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include "../src/wasm/fps.cpp"

namespace {
std::vector<std::string> events;
std::vector<std::string> messages;
std::vector<std::string> messageNames;
std::vector<std::string> inputDefinitions;
std::vector<SIMCONNECT_CLIENT_EVENT_ID> inputDownEvents;
fsCommBusWasmCallback setKeysHandler = nullptr;
double lvarValue = 0;
int lvarRegistrations = 0;
std::vector<SIMCONNECT_CLIENT_EVENT_ID> notificationEvents;
std::vector<std::string> watchedCommands;
std::vector<std::pair<SIMCONNECT_NOTIFICATION_GROUP_ID, SIMCONNECT_CLIENT_EVENT_ID>> watchGroups;
std::vector<SIMCONNECT_NOTIFICATION_GROUP_ID> watchPriorities;
DWORD lastPacket = 0;
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
int SimConnect_MapClientEventToSimEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID event, const char* name) {
    if (name && *name) {  // command watch, not a hotkey
        assert(event == kWatchFirstEvent + watchedCommands.size() % shiftz::kWatchedCommandCount);
        watchedCommands.emplace_back(name); lastPacket += 2; return S_OK;
    }
    return hotkeyResult();
}
int SimConnect_AddClientEventToNotificationGroup(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID group, SIMCONNECT_CLIENT_EVENT_ID event, int maskable) {
    assert(!maskable);
    if (group >= kWatchFirstGroup) { watchGroups.emplace_back(group, event); return S_OK; }
    notificationEvents.push_back(event); return hotkeyResult();
}
int SimConnect_SetNotificationGroupPriority(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID group, DWORD priority) {
    if (group >= kWatchFirstGroup) {  // watch groups come first so no maskable group can hide a command
        assert(priority == SIMCONNECT_GROUP_PRIORITY_HIGHEST); watchPriorities.push_back(group); return S_OK;
    }
    assert(priority == SIMCONNECT_GROUP_PRIORITY_STANDARD);
    return hotkeyResult();
}
int SimConnect_GetLastSentPacketID(HANDLE, DWORD* id) { *id = lastPacket; return S_OK; }
int SimConnect_MapInputEventToClientEvent_EX1(HANDLE, SIMCONNECT_INPUT_GROUP_ID, const char* definition, SIMCONNECT_CLIENT_EVENT_ID down, DWORD, SIMCONNECT_CLIENT_EVENT_ID up, DWORD, int maskable) {
    assert((down == kCycleDownEvent && up == kCycleUpEvent) || (down == kConfigDownEvent && up == kConfigUpEvent));
    assert(!maskable);
    inputDefinitions.emplace_back(definition); inputDownEvents.push_back(down); return hotkeyResult();
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
bool fsCommBusRegister(const char* name, fsCommBusWasmCallback handler, void*) {
    assert(std::string(name) == "SHIFT_Z_CONTINUED_SET_KEYS"); setKeysHandler = handler; return true;
}
FsUnitId fsVarsGetUnitId(const char* unit) { assert(std::string(unit) == "number"); return 11; }
FsLVarId fsVarsRegisterLVar(const char* name) {
    assert(std::string(name) == "SHIFT_Z_CONTINUED_KEYS"); ++lvarRegistrations; return 42;
}
FsVarError fsVarsLVarGet(FsLVarId id, FsUnitId unit, double* value) {
    assert(id == 42 && unit == 11); *value = lvarValue; return FS_VAR_ERROR_NONE;
}
int fsCommBusUnregister(const char*, fsCommBusWasmCallback handler) { if (setKeysHandler == handler) setKeysHandler = nullptr; return 1; }

void testHotkeyParsing() {
    shiftz::HotkeySet keys;
    const char good[] = "cycle=VK_LMENU+X|VK_LMENU+x;config=VK_F9";
    assert(shiftz::parseHotkeySet(good, sizeof(good), keys));  // a sent terminator is tolerated
    assert(keys.counts[0] == 2 && keys.counts[1] == 1);
    assert(std::string(keys.definitions[0][1]) == "VK_LMENU+x" && std::string(keys.definitions[1][0]) == "VK_F9");
    for (const char* bad : {"", "cycle=VK_F1", "config=VK_F1", "cycle=VK_F1;config=", "cycle=VK_F1;config=A|",
                            "cycle=VK F1;config=VK_F2", "cycle=VK_F1;cycle=VK_F2", "other=VK_F1;config=VK_F2",
                            "cycle=VK_F1;config=VK_F2;extra=1"}) {
        assert(!shiftz::parseHotkeySet(bad, std::string(bad).size(), keys));
    }
    std::string many = "cycle=";
    for (int i = 0; i < 17; ++i) many += i ? "|VK_F1" : "VK_F1";
    many += ";config=VK_F2";
    assert(!shiftz::parseHotkeySet(many.c_str(), many.size(), keys));
    std::string longDef = "cycle=" + std::string(41, 'A') + ";config=VK_F2";
    assert(!shiftz::parseHotkeySet(longDef.c_str(), longDef.size(), keys));
}

void testHotkeyCodes() {
    char text[512];
    auto decode = [&](double value) { return std::string(text, shiftz::hotkeyTextFromCode(value, text, sizeof(text))); };
    constexpr double z = 25, shift = 4 * 64, ctrlShift = 5 * 64;
    assert(decode(shift + z + (ctrlShift + z) * 512) == kDefaultKeys);
    assert(decode(shift + z + (ctrlShift + z) * 512 + 7 * 262144) == kDefaultKeys);
    assert(decode(1 * 64 + 26 + 41 * 512) == "cycle=VK_LCONTROL+0|VK_RCONTROL+0;config=VK_F6");
    assert(decode(3 * 64 + 15 + 47 * 512) ==
           "cycle=VK_LCONTROL+VK_LMENU+P|VK_LCONTROL+VK_LMENU+p|VK_LCONTROL+VK_RMENU+P|VK_LCONTROL+VK_RMENU+p|"
           "VK_RCONTROL+VK_LMENU+P|VK_RCONTROL+VK_LMENU+p|VK_RCONTROL+VK_RMENU+P|VK_RCONTROL+VK_RMENU+p;config=VK_F12");
    for (double bad : {0.0, -1.0, 1.5, std::numeric_limits<double>::quiet_NaN(),
                       z + 44 * 512.0,                // letter without a modifier
                       26 + 44 * 512.0,               // digit without a modifier
                       7 * 64 + z + 44 * 512.0,       // three modifiers
                       48 + 44 * 512.0,               // no such key
                       44 + 44 * 512.0}) {            // both keys the same
        assert(shiftz::hotkeyTextFromCode(bad, text, sizeof(text)) == 0);
    }
    assert(shiftz::hotkeyTextFromCode(shift + z + (ctrlShift + z) * 512, text, 40) == 0);  // buffer too small
}

SIMCONNECT_CLIENT_EVENT_ID watchEvent(const char* name) {
    for (size_t i = 0; i < shiftz::kWatchedCommandCount; ++i) {
        if (std::string(shiftz::kWatchedCommands[i]) == name) return static_cast<SIMCONNECT_CLIENT_EVENT_ID>(kWatchFirstEvent + i);
    }
    return 0;
}

void testConflictDetector() {
    shiftz::KeyConflictDetector detector;
    auto frames = [&](int count) { for (int i = 0; i < count; ++i) detector.onFrame(); };
    // Continuous event 100 every frame, then a press that also fires event 200 one frame later.
    for (int i = 0; i < 80; ++i) { detector.onKeyEvent(100); detector.onFrame(); }
    detector.onPress(0);
    detector.onKeyEvent(100);
    frames(1);
    detector.onKeyEvent(200);
    detector.onKeyEvent(200);
    for (int i = 0; i < 8; ++i) { detector.onKeyEvent(100); assert(!detector.poll().ready); detector.onFrame(); }
    frames(1);
    auto report = detector.poll();
    assert(report.ready && report.key == 0 && report.count == 1 && report.events[0] == 200);
    char text[160];
    assert(std::string(text, shiftz::KeyConflictDetector::format(report, text, sizeof(text))) == "{\"key\":\"cycle\",\"events\":[\"event 200\"]}");
    const char* const names[] = {"A", "B"};
    report.events[1] = 1; report.count = 2;
    assert(std::string(text, shiftz::KeyConflictDetector::format(report, text, sizeof(text), names, 2)) == "{\"key\":\"cycle\",\"events\":[\"event 200\",\"B\"]}");
    report.count = 1;
    assert(!detector.poll().ready);

    // A binding the sim runs just before our input event arrives is still caught; quiet presses report nothing.
    frames(100);
    detector.onKeyEvent(300);
    frames(1);
    detector.onPress(1);
    frames(10);
    report = detector.poll();
    assert(report.ready && report.key == 1 && report.count == 1 && report.events[0] == 300);
    frames(100);
    detector.onPress(0);
    frames(10);
    report = detector.poll();
    assert(report.ready && report.count == 0);
    assert(shiftz::KeyConflictDetector::format(report, text, sizeof(text)) > 0);
}

void testKeyEventsAndRemap() {
    assert(setKeysHandler);
    SIMCONNECT_RECV_EVENT_FRAME frame{};
    frame.dwID = SIMCONNECT_RECV_ID_EVENT_FRAME; frame.uEventID = 1; frame.fFrameRate = 0;  // no FPS broadcast
    SIMCONNECT_RECV_EVENT key{};
    key.dwID = SIMCONNECT_RECV_ID_EVENT;
    for (int i = 0; i < 70; ++i) callback(&frame, sizeof(frame), nullptr);
    key.uEventID = kCycleUpEvent; callback(&key, sizeof(key), nullptr);
    key.uEventID = kCycleDownEvent; callback(&key, sizeof(key), nullptr);
    SIMCONNECT_RECV_EVENT watch{};  // SimConnect reports SLEW_TOGGLE, bound to the same key
    watch.dwID = SIMCONNECT_RECV_ID_EVENT; watch.uEventID = watchEvent("SLEW_TOGGLE");
    callback(&watch, sizeof(watch), nullptr);
    const auto before = messages.size();
    for (int i = 0; i < 10; ++i) callback(&frame, sizeof(frame), nullptr);
    assert(messages.size() == before + 1 && messageNames.back() == "SHIFT_Z_CONTINUED_CONFLICT");
    assert(messages.back() == "{\"key\":\"cycle\",\"events\":[\"SLEW_TOGGLE\"]}");
    key.uEventID = kCycleUpEvent; callback(&key, sizeof(key), nullptr);

    // A valid key set from the panel replaces all mappings.
    inputDefinitions.clear(); inputDownEvents.clear();
    const int clearedBefore = clearedInputs;
    const char keys[] = "cycle=VK_LMENU+X|VK_RMENU+X;config=VK_F9";
    setKeysHandler(keys, sizeof(keys) - 1, nullptr);
    assert(clearedInputs == clearedBefore + 1 && inputEnabled);
    assert(messageNames.back() == "SHIFT_Z_CONTINUED_KEYS_STATUS" && messages.back() == "{\"via\":\"commbus\",\"result\":\"applied\"}");
    assert((inputDefinitions == std::vector<std::string>{"VK_LMENU+X", "VK_RMENU+X", "VK_F9"}));
    assert((inputDownEvents == std::vector<SIMCONNECT_CLIENT_EVENT_ID>{kCycleDownEvent, kCycleDownEvent, kConfigDownEvent}));
    // Invalid text changes nothing.
    inputDefinitions.clear();
    const char bad[] = "cycle=VK_F1;config=bad key";
    setKeysHandler(bad, sizeof(bad) - 1, nullptr);
    assert(inputDefinitions.empty() && clearedInputs == clearedBefore + 1);
    assert(messages.back() == "{\"via\":\"commbus\",\"result\":\"invalid\"}");
    // A key set the sim rejects falls back to the defaults.
    hotkeyCall = 0; failHotkeyCall = 1;
    setKeysHandler(keys, sizeof(keys) - 1, nullptr);
    failHotkeyCall = 0;
    assert(inputEnabled && inputDefinitions.size() == 1 + 12 && inputDefinitions.back() == "VK_RCONTROL+VK_RSHIFT+z");
    assert(messages.back() == "{\"via\":\"commbus\",\"result\":\"failed-defaults\"}");

    // The same key set can arrive through the L:var, encoded as a number; each new value is applied once.
    assert(lvarRegistrations == 1);
    constexpr double altX = 2 * 64 + 23, f9 = 36 + 8;
    auto frames = [&](int count) { for (int i = 0; i < count; ++i) callback(&frame, sizeof(frame), nullptr); };
    inputDefinitions.clear();
    lvarValue = altX + f9 * 512 + 262144;
    frames(1);
    assert((inputDefinitions == std::vector<std::string>{"VK_LMENU+X", "VK_LMENU+x", "VK_RMENU+X", "VK_RMENU+x", "VK_F9"}));
    assert(messages.back() == "{\"via\":\"lvar\",\"result\":\"applied\"}");
    const auto countBefore = messages.size();
    frames(3);
    assert(messages.size() == countBefore && inputDefinitions.size() == 5);
    lvarValue = altX + altX * 512 + 2 * 262144;  // both keys the same
    frames(1);
    assert(inputDefinitions.size() == 5 && messages.back() == "{\"via\":\"lvar\",\"result\":\"invalid\"}");
    const auto countZero = messages.size();
    for (double notFromPanel : {0.0, 1.0, altX + f9 * 512}) {  // no send counter: never written by the panel
        lvarValue = notFromPanel;
        frames(1);
    }
    assert(messages.size() == countZero && inputDefinitions.size() == 5);
    lvarValue = altX + f9 * 512 + 3 * 262144;  // the same keys sent again
    frames(1);
    assert(inputDefinitions.size() == 10 && messages.back() == "{\"via\":\"lvar\",\"result\":\"applied\"}");
    lvarValue = 0;
}

int main() {
    testHotkeyParsing();
    testConflictDetector();
    testHotkeyCodes();
    module_init();
    assert((events == std::vector<std::string>{"Frame", "PauseFrame"}) && callback);
    // Every command of watched_commands.h, in order, in non-maskable groups of at most 1000 events.
    assert(watchedCommands.size() == shiftz::kWatchedCommandCount);
    for (size_t i = 0; i < watchedCommands.size(); ++i) assert(watchedCommands[i] == shiftz::kWatchedCommands[i]);
    assert(watchGroups.size() == shiftz::kWatchedCommandCount);
    for (size_t i = 0; i < watchGroups.size(); ++i) {
        assert(watchGroups[i].first == kWatchFirstGroup + i / 1000 && watchGroups[i].second == kWatchFirstEvent + i);
    }
    assert(watchPriorities.size() == kWatchGroupCount && kWatchGroupCount >= 2 && kWatchFirstGroup + kWatchGroupCount <= 20);
    // SimConnect names, not KEY_ names: the auto-rudder key runs "AUTORUDDER_TOGGLE".
    assert(watchEvent("AUTORUDDER_TOGGLE") && watchEvent("SLEW_TOGGLE"));
    {
        // Watched commands alone send nothing.
        SIMCONNECT_RECV_EVENT flight{};
        flight.dwID = SIMCONNECT_RECV_ID_EVENT;
        const auto messagesBefore = messages.size();
        flight.uEventID = watchEvent("AUTORUDDER_TOGGLE"); callback(&flight, sizeof(flight), nullptr);
        flight.uEventID = watchEvent("SLEW_TOGGLE"); callback(&flight, sizeof(flight), nullptr);
        // Ids just outside the watch table are ignored.
        flight.uEventID = kWatchFirstEvent + shiftz::kWatchedCommandCount; callback(&flight, sizeof(flight), nullptr);
        flight.uEventID = kWatchFirstEvent - 1; callback(&flight, sizeof(flight), nullptr);
        assert(messages.size() == messagesBefore && !cycleKeyDown && !configKeyDown);
        // The same events in the EX1 form are handled alike; a press arriving as EX1 still cycles.
        SIMCONNECT_RECV_EVENT_EX1 extended{};
        extended.dwID = SIMCONNECT_RECV_ID_EVENT_EX1;
        extended.uEventID = watchEvent("SLEW_TOGGLE"); callback(&extended, sizeof(extended), nullptr);
        assert(messages.size() == messagesBefore);
        extended.uEventID = kCycleDownEvent; callback(&extended, sizeof(extended), nullptr);
        assert(messages.size() == messagesBefore + 1 && messageNames.back() == "SHIFT_Z_CONTINUED_CYCLE" && cycleKeyDown);
        extended.uEventID = kCycleUpEvent; callback(&extended, sizeof(extended), nullptr);
        assert(!cycleKeyDown);
        // A short EX1 message is ignored.
        extended.uEventID = kCycleDownEvent; callback(&extended, sizeof(SIMCONNECT_RECV_EVENT), nullptr);
        assert(!cycleKeyDown && messages.size() == messagesBefore + 1);
        // Unknown message types are ignored.
        SIMCONNECT_RECV other{}; other.dwID = 40; callback(&other, sizeof(other), nullptr);
        callback(&other, sizeof(other), nullptr);
        assert(messages.size() == messagesBefore + 1);
        // Watched commands seen with the press become a conflict report.
        SIMCONNECT_RECV_EVENT_FRAME tick{};
        tick.dwID = SIMCONNECT_RECV_ID_EVENT_FRAME; tick.uEventID = 1; tick.fFrameRate = 0;
        for (int i = 0; i < 10; ++i) callback(&tick, sizeof(tick), nullptr);
        assert(messages.size() == messagesBefore + 2 && messageNames.back() == "SHIFT_Z_CONTINUED_CONFLICT");
        assert(messages.back().find("\"cycle\"") != std::string::npos);
        assert(messages.back().find("\"SLEW_TOGGLE\"") != std::string::npos);
        assert(messages.back().find("\"AUTORUDDER_TOGGLE\"") != std::string::npos);
        // Exceptions are counted; unknown watched names are logged by name, others only the first few.
        assert(std::string(watchedCommandForSend(2 * (watchEvent("SLEW_TOGGLE") - kWatchFirstEvent + 1))) == "SLEW_TOGGLE");
        assert(std::string(watchedCommandForSend(2)) == shiftz::kWatchedCommands[0]);
        assert(!watchedCommandForSend(0) && !watchedCommandForSend(3) && !watchedCommandForSend(2 * shiftz::kWatchedCommandCount + 2));
        SIMCONNECT_RECV_EXCEPTION error{}; error.dwID = SIMCONNECT_RECV_ID_EXCEPTION;
        error.dwException = SIMCONNECT_EXCEPTION_NAME_UNRECOGNIZED; error.dwSendID = 4;
        callback(&error, sizeof(error), nullptr);
        assert(loggedExceptions == 0);  // an unknown watched name does not use a log slot
        error.dwException = 3; error.dwSendID = 5;
        for (int i = 0; i < 6; ++i) callback(&error, sizeof(error), nullptr);
        assert(simConnectExceptions == 7 && loggedExceptions == kLoggedExceptions);
        SIMCONNECT_RECV open{}; open.dwID = SIMCONNECT_RECV_ID_OPEN; callback(&open, sizeof(open), nullptr);
        messages.clear(); messageNames.clear();
    }
    constexpr int kRegistrationCalls = 23;
    assert(inputEnabled && hotkeyCall == kRegistrationCalls);
    assert((inputDefinitions == std::vector<std::string>{
        "VK_LSHIFT+Z", "VK_LSHIFT+z", "VK_RSHIFT+Z", "VK_RSHIFT+z",
        "VK_LCONTROL+VK_LSHIFT+Z", "VK_LCONTROL+VK_LSHIFT+z", "VK_LCONTROL+VK_RSHIFT+Z", "VK_LCONTROL+VK_RSHIFT+z",
        "VK_RCONTROL+VK_LSHIFT+Z", "VK_RCONTROL+VK_LSHIFT+z", "VK_RCONTROL+VK_RSHIFT+Z", "VK_RCONTROL+VK_RSHIFT+z"}));
    assert((notificationEvents == std::vector<SIMCONNECT_CLIENT_EVENT_ID>{
        kCycleDownEvent, kCycleUpEvent, kConfigDownEvent, kConfigUpEvent}));
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
    // Configuration key: one message per press, independent of the cycle latch.
    key.uEventID = kConfigDownEvent; callback(&key, sizeof(key), nullptr);
    callback(&key, sizeof(key), nullptr);
    assert(messages.size() == 5 && messageNames.back() == "SHIFT_Z_CONTINUED_CONFIG" && messages.back() == "{}");
    key.uEventID = kConfigUpEvent; callback(&key, sizeof(key), nullptr);
    key.uEventID = kConfigDownEvent; callback(&key, sizeof(key), nullptr);
    assert(messages.size() == 6 && messageNames.back() == "SHIFT_Z_CONTINUED_CONFIG");
    key.uEventID = kConfigUpEvent; callback(&key, sizeof(key), nullptr);
    testKeyEventsAndRemap();
    module_deinit(); assert(closed == 1 && !setKeysHandler);
    // Every registration failure must leave FPS dispatch alive and remove partial inputs.
    for (int failure = 1; failure <= kRegistrationCalls; ++failure) {
        hotkeyCall = 0; failHotkeyCall = failure;
        const int clearedBeforeFailure = clearedInputs;
        module_init();
        assert(connection && !inputEnabled && !cycleKeyDown && !configKeyDown);
        assert(clearedInputs > clearedBeforeFailure && !setKeysHandler);
        assert(keysLVar == FS_VAR_INVALID_ID);
        const auto before = messages.size();
        callback(&frame, sizeof(frame), nullptr);
        assert(messages.size() == before + 1 && messageNames.back() == "SHIFT_Z_CONTINUED_FPS");
        module_deinit();
    }
    failHotkeyCall = 0;
    const int closedBeforeFailures = closed;
    fail_open = 1; module_init(); module_deinit(); assert(closed == closedBeforeFailures);
    fail_open = 0; fail_subscribe = 1; module_init(); module_deinit(); assert(closed == closedBeforeFailures + 1);
}
