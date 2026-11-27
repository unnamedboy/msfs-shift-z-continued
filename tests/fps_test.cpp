// Desktop tests for the WASM module: the real fps.cpp compiled against a small fake of SimConnect and CommBus.
#include <cassert>
#include <cstdlib>
#if defined(_MSC_VER)
#include <crtdbg.h>
// Declared here because <windows.h> clashes with the SDK type stubs.
extern "C" __declspec(dllimport) unsigned int __stdcall SetErrorMode(unsigned int);
#endif
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>
#include "../src/wasm/fps.cpp"

namespace {
// The fake gives every call a packet id; a mapping of `rejectDefinition` succeeds but queues an exception,
// which deliver() hands to the module before the system state answers, as SimConnect does.
struct FakeSim {
    DWORD packet = 0;
    bool failOpen = false, failSubscribe = false;
    int failMapInputs = 0;  // the next n input mappings fail at once
    std::string rejectDefinition;
    std::string rejectName;  // a watched command name the sim does not know
    std::vector<std::string> inputs;                 // input definitions currently mapped
    std::map<std::string, SIMCONNECT_CLIENT_EVENT_ID> watched;  // command name -> client event
    std::set<SIMCONNECT_NOTIFICATION_GROUP_ID> watchGroups;     // groups holding watched events
    // Answers still to deliver, in packet order: an exception (state == 0) or a system state answer.
    struct Answer { SIMCONNECT_RECV_EXCEPTION error; DWORD state; };
    std::vector<Answer> answers;
    std::vector<std::pair<std::string, std::string>> messages;  // CommBus name, payload
    fsCommBusWasmCallback setKeys = nullptr;
    DispatchProc dispatch = nullptr;
    int closed = 0;
} sim;

DWORD send() { return ++sim.packet; }
}

int SimConnect_Open(HANDLE* handle, const char*, void*, DWORD, int, DWORD) {
    if (sim.failOpen) return 1;
    *handle = 7; return S_OK;
}
int SimConnect_SubscribeToSystemEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID, const char*) { send(); return sim.failSubscribe ? 1 : S_OK; }
int SimConnect_CallDispatch(HANDLE, DispatchProc proc, void*) { sim.dispatch = proc; return S_OK; }
int SimConnect_Close(HANDLE) { ++sim.closed; return S_OK; }
int SimConnect_MapClientEventToSimEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID event, const char* name) {
    const DWORD id = send();
    if (name && *name) sim.watched[name] = event;
    if (name && sim.rejectName == name) {
        SIMCONNECT_RECV_EXCEPTION error{}; error.dwID = SIMCONNECT_RECV_ID_EXCEPTION; error.dwException = 7; error.dwSendID = id;
        sim.answers.push_back({error, 0});
    }
    return S_OK;
}
int SimConnect_AddClientEventToNotificationGroup(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID group, SIMCONNECT_CLIENT_EVENT_ID, int maskable) {
    send(); assert(!maskable);  // the module must never hide a key from the sim
    if (group >= kWatchFirstGroup) sim.watchGroups.insert(group);
    return S_OK;
}
int SimConnect_SetNotificationGroupPriority(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID, DWORD) { send(); return S_OK; }
int SimConnect_ClearNotificationGroup(HANDLE, SIMCONNECT_NOTIFICATION_GROUP_ID group) { send(); sim.watchGroups.erase(group); return S_OK; }
int SimConnect_MapInputEventToClientEvent_EX1(HANDLE, SIMCONNECT_INPUT_GROUP_ID, const char* definition, SIMCONNECT_CLIENT_EVENT_ID, DWORD, SIMCONNECT_CLIENT_EVENT_ID, DWORD, int maskable) {
    const DWORD id = send(); assert(!maskable);
    if (sim.failMapInputs > 0) { --sim.failMapInputs; return 1; }
    if (definition == sim.rejectDefinition) {
        SIMCONNECT_RECV_EXCEPTION error{}; error.dwID = SIMCONNECT_RECV_ID_EXCEPTION; error.dwException = 7; error.dwSendID = id;
        sim.answers.push_back({error, 0});
    }
    sim.inputs.emplace_back(definition);
    return S_OK;
}
int SimConnect_SetInputGroupPriority(HANDLE, SIMCONNECT_INPUT_GROUP_ID, DWORD) { send(); return S_OK; }
int SimConnect_SetInputGroupState(HANDLE, SIMCONNECT_INPUT_GROUP_ID, DWORD) { send(); return S_OK; }
int SimConnect_ClearInputGroup(HANDLE, SIMCONNECT_INPUT_GROUP_ID) { send(); sim.inputs.clear(); return S_OK; }
int SimConnect_GetLastSentPacketID(HANDLE, DWORD* id) { *id = sim.packet; return S_OK; }
int SimConnect_RequestSystemState(HANDLE, SIMCONNECT_DATA_REQUEST_ID request, const char* state) {
    send(); assert(std::string(state) == "Sim" && request != 0); sim.answers.push_back({{}, request}); return S_OK;
}
bool fsCommBusCall(const char* name, const char* data, unsigned int length, FsCommBusBroadcastFlags destination) {
    assert(destination == FsCommBusBroadcast_JS);
    sim.messages.emplace_back(name, std::string(data, length)); return true;
}
bool fsCommBusRegister(const char* name, fsCommBusWasmCallback handler, void*) {
    assert(std::string(name) == "SHIFT_Z_CONTINUED_SET_KEYS"); sim.setKeys = handler; return true;
}
int fsCommBusUnregister(const char*, fsCommBusWasmCallback handler) { if (sim.setKeys == handler) sim.setKeys = nullptr; return 1; }

namespace {
void deliver() {
    const auto answers = sim.answers;
    sim.answers.clear();
    for (auto answer : answers) {
        if (answer.state == 0) {
            sim.dispatch(&answer.error, sizeof(answer.error), nullptr);
            continue;
        }
        SIMCONNECT_RECV_SYSTEM_STATE state{}; state.dwID = SIMCONNECT_RECV_ID_SYSTEM_STATE; state.dwRequestID = answer.state;
        sim.dispatch(&state, sizeof(state), nullptr);
    }
}
void event(SIMCONNECT_CLIENT_EVENT_ID id) {
    SIMCONNECT_RECV_EVENT message{}; message.dwID = SIMCONNECT_RECV_ID_EVENT; message.uEventID = id;
    sim.dispatch(&message, sizeof(message), nullptr);
}
void frames(int count, float frameRate = 30, SIMCONNECT_CLIENT_EVENT_ID id = kFrameEvent) {
    SIMCONNECT_RECV_EVENT_FRAME frame{}; frame.dwID = SIMCONNECT_RECV_ID_EVENT_FRAME; frame.uEventID = id; frame.fFrameRate = frameRate;
    for (int i = 0; i < count; ++i) sim.dispatch(&frame, sizeof(frame), nullptr);
}
void request(const std::string& text) { sim.setKeys(text.c_str(), static_cast<unsigned>(text.size()), nullptr); }
std::string last(const char* name) {
    for (auto it = sim.messages.rbegin(); it != sim.messages.rend(); ++it) if (it->first == name) return it->second;
    return "";
}
size_t count(const char* name) {
    size_t n = 0;
    for (const auto& message : sim.messages) n += message.first == name;
    return n;
}
bool mapped(const char* definition) {
    for (const auto& input : sim.inputs) if (input == definition) return true;
    return false;
}
const std::string kAltXF9 = "cycle=VK_LMENU+X|VK_RMENU+X;config=VK_F9";
const std::string kCtrlP = "cycle=VK_LCONTROL+P|VK_RCONTROL+P;config=VK_F9";
}

void testParsing() {
    shiftz::HotkeySet keys;
    const char good[] = "cycle=VK_LMENU+X|VK_LMENU+x;config=VK_F9";
    assert(shiftz::parseHotkeySet(good, sizeof(good), keys));  // a sent terminator is tolerated
    assert(keys.counts[0] == 2 && keys.counts[1] == 1 && std::string(keys.definitions[1][0]) == "VK_F9");
    for (const char* bad : {"", "cycle=VK_F1", "cycle=VK_F1;config=", "cycle=VK_F1;config=A|", "cycle=VK F1;config=VK_F2",
                            "cycle=VK_F1;cycle=VK_F2", "cycle=VK_F1;config=VK_F2;extra=1"}) {
        assert(!shiftz::parseHotkeySet(bad, std::strlen(bad), keys));
    }

    shiftz::KeyRequest request;
    const std::string valid = "id=12;watch=1;" + kAltXF9;
    assert(shiftz::parseKeyRequest(valid.c_str(), valid.size(), request) && request.id == 12 && request.watch);
    const std::string off = "id=3;watch=0;" + kAltXF9;
    assert(shiftz::parseKeyRequest(off.c_str(), off.size(), request) && !request.watch);
    const std::string badKeys = "id=5;watch=1;cycle=VK_F1";
    assert(!shiftz::parseKeyRequest(badKeys.c_str(), badKeys.size(), request) && request.id == 5);  // still answerable
    const std::string nine = "id=1;watch=1;cycle=A|B|C|D|E|F|G|H|I;config=VK_F9";
    assert(!shiftz::parseKeyRequest(nine.c_str(), nine.size(), request));  // more definitions than a combination has
    for (const std::string bad : {"watch=1;" + kAltXF9, "id=;watch=1;" + kAltXF9, "id=1;watch=2;" + kAltXF9,
                                  "id=1234567890;watch=1;" + kAltXF9}) {
        assert(!shiftz::parseKeyRequest(bad.c_str(), bad.size(), request));
    }
}

void testDetector() {
    using Detector = shiftz::KeyConflictDetector;
    // Same scenario at two frame rates: background command 7 all the time, command 9 just after the press.
    for (const double step : {1.0 / 20, 1.0 / 120}) {
        Detector detector;
        auto run = [&](double seconds, bool background) {
            for (double t = 0; t < seconds; t += step) { if (background) detector.onCommand(7); detector.advance(step); }
        };
        run(3, true);
        detector.onPress(0, 1);
        detector.onCommand(7);
        run(0.05, false);
        detector.onCommand(9);
        assert(!detector.poll().ready);
        run(0.4, true);
        auto report = detector.poll();
        assert(report.ready && report.key == 0 && report.press == 1 && report.count == 1 && report.commands[0] == 9);
        assert(!detector.poll().ready);
    }

    // The sim may run the binding just before our input event; repeated presses keep being reported
    // although the same command then appears in the seconds before each press.
    Detector detector;
    for (unsigned press = 1; press <= 3; ++press) {
        detector.onCommand(4);
        detector.advance(0.05);
        detector.onPress(1, press);
        detector.advance(0.5);
        const auto report = detector.poll();
        assert(report.ready && report.key == 1 && report.press == press && report.count == 1 && report.commands[0] == 4);
        detector.advance(0.5);
    }

    // A command in the window of a later press of the other key belongs to that press only.
    detector.advance(3);
    detector.onPress(1, 4);
    detector.advance(0.2);
    detector.onPress(0, 5);
    detector.onCommand(6);
    detector.advance(0.5);
    auto first = detector.poll();
    auto second = detector.poll();
    assert(first.ready && first.key == 1 && first.count == 0);  // the earlier press is evaluated first
    assert(second.ready && second.key == 0 && second.count == 1 && second.commands[0] == 6);

    // A command that fired without a press (while the key was being captured) hides the first press after
    // it, but not the following ones.
    {
        Detector chain;
        chain.advance(5);
        chain.onCommand(4);
        chain.advance(1);
        for (unsigned press = 1; press <= 3; ++press) {
            chain.onPress(0, press);
            chain.onCommand(4);
            chain.advance(0.5);
            const auto result = chain.poll();
            assert(result.ready && result.count == (press == 1 ? 0u : 1u));
            chain.advance(1);
        }
    }

    // Quick presses do not turn a command that fires at least twice a second into a conflict.
    for (const double period : {1.0 / 30, 0.25, 0.5}) {
        Detector busy;
        double nextCommand = 0, nextPress = 3, time = 0;
        unsigned press = 0;
        while (time < 8) {
            if (time >= nextCommand) { busy.onCommand(7); nextCommand += period; }
            if (time >= nextPress) { ++press; busy.onPress(press % 2, press); nextPress += 0.4; }
            busy.advance(1.0 / 60);
            time += 1.0 / 60;
            const auto result = busy.poll();
            assert(!result.ready || result.count == 0);
        }
        assert(press > 10);
    }

    // Three presses in the 2 s before a press: not judged. One of them just over 2 s back: judged.
    for (const double gap : {0.6, 0.7}) {
        Detector burst;
        burst.advance(5);
        for (unsigned press = 1; press <= 3; ++press) {
            burst.onPress(0, press);
            burst.advance(gap);
            burst.poll();
        }
        burst.onPress(0, 4);
        burst.onCommand(8);
        burst.advance(0.5);
        const auto result = burst.poll();
        assert(result.ready && result.count == (gap < 0.65 ? 0u : 1u));
    }

    // Without a full baseline since the watch started, a press is not judged.
    {
        Detector fresh;
        fresh.advance(10);
        fresh.onWatchStart();
        for (const double wait : {1.0, 2.5}) {
            fresh.advance(wait);
            fresh.onPress(0, 1);
            fresh.onCommand(3);
            fresh.advance(0.5);
            const auto result = fresh.poll();
            assert(result.ready && result.count == (wait < 2 ? 0u : 1u));
        }
    }

    // A press whose window has not closed yet is dropped by clearPending.
    detector.onPress(0, 9);
    detector.onCommand(5);
    detector.clearPending();
    detector.advance(1);
    assert(!detector.poll().ready);

    Detector::Report report;
    report.ready = true; report.key = 1; report.press = 4; report.count = 3;
    report.commands[0] = 1; report.commands[1] = 99; report.commands[2] = 0;
    const char* const names[] = {"A_1", "B"};
    char text[64];
    assert(std::string(text, Detector::format(report, names, 2, text, sizeof(text))) ==
           "{\"key\":\"config\",\"press\":4,\"commands\":[\"B\",\"A_1\"]}");
    assert(Detector::format(report, names, 2, text, 20) == 0);
}

void testModule() {
    module_init();
    assert(sim.setKeys && sim.dispatch);
    assert(mapped("VK_LSHIFT+Z") && mapped("VK_RCONTROL+VK_RSHIFT+z"));  // defaults until the panel sends keys
    assert(sim.watched.empty() && sim.watchGroups.empty());            // no watch before the panel asks for it

    // Presses are numbered; key repeat is absorbed until the key is released.
    event(kCycleDownEvent); event(kCycleDownEvent); event(kCycleUpEvent); event(kConfigDownEvent);
    assert(count(kCycleMessageName) == 1 && last(kCycleMessageName) == "{\"press\":1}");
    assert(last(kConfigMessageName) == "{\"press\":2}");
    event(kConfigUpEvent);

    // A key change is answered only after SimConnect has processed it. An unknown watched name, rejected in
    // the same request before the key mappings, does not count against the key change.
    sim.rejectName = "SLEW_TOGGLE";
    request("id=1;watch=1;" + kAltXF9);
    sim.rejectName.clear();
    assert(mapped("VK_LMENU+X") && !mapped("VK_LSHIFT+Z") && last(kKeysStatusMessageName).empty());
    deliver();
    assert(last(kKeysStatusMessageName) == "{\"id\":1,\"result\":\"applied\"}");
    assert(sim.watched.size() == shiftz::kWatchedCommandCount && sim.watched.count("AUTORUDDER_TOGGLE"));
    assert(sim.watchGroups.size() == kWatchGroupCount);

    // Only the newest of two quick requests is answered, and an exception for the older one does not fail it.
    sim.rejectDefinition = "VK_F2";
    request("id=2;watch=1;cycle=VK_F2;config=VK_F9");
    sim.rejectDefinition.clear();
    request("id=3;watch=1;" + kAltXF9);
    deliver();
    assert(last(kKeysStatusMessageName) == "{\"id\":3,\"result\":\"applied\"}");
    assert(count(kKeysStatusMessageName) == 2 && mapped("VK_LMENU+X") && !mapped("VK_F2"));

    // The state answer of a replaced request does not confirm the newer one: that one's own exception,
    // which arrives later, still fails it.
    request("id=20;watch=1;cycle=VK_F3;config=VK_F9");
    sim.rejectDefinition = "VK_F4";
    request("id=21;watch=1;cycle=VK_F4;config=VK_F9");
    sim.rejectDefinition.clear();
    deliver();
    assert(last(kKeysStatusMessageName) == "{\"id\":21,\"result\":\"failed\"}");
    assert(mapped("VK_LMENU+X") && !mapped("VK_F3") && !mapped("VK_F4"));

    // Keys the sim rejects later (an exception, not a failed call) give way to the previous keys, not the defaults.
    // A press made while the rejected keys were mapped is not reported against the restored keys.
    const size_t reportsBefore = count(kConflictMessageName);
    sim.rejectDefinition = "VK_LCONTROL+P";
    request("id=4;watch=1;" + kCtrlP);
    frames(90);
    event(kCycleDownEvent); event(sim.watched.at("PAUSE_TOGGLE")); event(kCycleUpEvent);
    deliver();
    frames(15);
    assert(count(kConflictMessageName) == reportsBefore);
    sim.rejectDefinition.clear();
    assert(last(kKeysStatusMessageName) == "{\"id\":4,\"result\":\"failed\"}");
    assert(mapped("VK_LMENU+X") && mapped("VK_F9") && !mapped("VK_LCONTROL+P") && !mapped("VK_LSHIFT+Z"));

    // A call that fails at once also restores the previous keys.
    sim.failMapInputs = 1;
    request("id=5;watch=1;" + kCtrlP);
    assert(last(kKeysStatusMessageName) == "{\"id\":5,\"result\":\"failed\"}");
    assert(mapped("VK_LMENU+X") && !mapped("VK_LCONTROL+P"));

    request("id=7;watch=1;cycle=bad key;config=VK_F9");
    assert(last(kKeysStatusMessageName) == "{\"id\":7,\"result\":\"invalid\"}" && mapped("VK_LMENU+X"));

    // A watched command that fires with a press is reported with the press number and its SimConnect name.
    const auto slew = sim.watched.at("SLEW_TOGGLE");
    frames(90);
    event(kCycleDownEvent); event(slew); event(kCycleUpEvent);
    const auto press = last(kCycleMessageName);
    frames(15);
    assert(last(kConflictMessageName) == "{\"key\":\"cycle\",\"press\":4,\"commands\":[\"SLEW_TOGGLE\"]}");
    assert(press == "{\"press\":4}");

    // A press made with the old keys is not reported after the keys change.
    const size_t reports = count(kConflictMessageName);
    frames(90);
    event(kCycleDownEvent); event(slew); event(kCycleUpEvent);
    request("id=8;watch=1;" + kCtrlP);
    deliver();
    frames(15);
    assert(count(kConflictMessageName) == reports);

    // Ignore turns the watch off in the sim, not just in the panel.
    request("id=9;watch=0;" + kCtrlP);
    deliver();
    assert(sim.watchGroups.empty() && last(kKeysStatusMessageName) == "{\"id\":9,\"result\":\"applied\"}");
    frames(90);
    event(kCycleDownEvent); event(slew); event(kCycleUpEvent);
    frames(15);
    assert(count(kConflictMessageName) == reports);

    // The watch can be turned on again: the events go back into their groups and conflicts are reported.
    request("id=10;watch=1;" + kCtrlP);
    deliver();
    assert(sim.watchGroups.size() == kWatchGroupCount && sim.watched.size() == shiftz::kWatchedCommandCount);
    // Right after the watch starts there is no baseline yet, so a press is not judged.
    frames(15);
    event(kCycleDownEvent); event(slew); event(kCycleUpEvent);
    frames(15);
    assert(count(kConflictMessageName) == reports);
    frames(90);
    event(kCycleDownEvent); event(slew); event(kCycleUpEvent);
    frames(15);
    assert(count(kConflictMessageName) == reports + 1);


    // FPS goes to JS about four times a second; a PauseFrame after a Frame does not count the frame twice.
    const size_t fps = count(kFpsMessageName);
    for (int i = 0; i < 4; ++i) { frames(1, 4); frames(1, 4, kPauseFrameEvent); }
    assert(count(kFpsMessageName) == fps + 4 && last(kFpsMessageName) == "{\"fps\":4.00}");
    frames(3, 4, kPauseFrameEvent);  // paused, Frame no longer arriving
    assert(count(kFpsMessageName) == fps + 7);
    frames(1, 0);  // unusable frame rates are skipped
    assert(count(kFpsMessageName) == fps + 7);

    module_deinit();
    assert(sim.closed == 1 && !sim.setKeys);
}

void testStartupFailures() {
    sim = FakeSim{};
    sim.failOpen = true;
    module_init(); module_deinit();
    assert(sim.closed == 0);

    sim = FakeSim{};
    sim.failSubscribe = true;
    module_init();
    assert(sim.closed == 1);
    module_deinit();

    // Without hotkeys the FPS line still works.
    sim = FakeSim{};
    sim.failMapInputs = 1;
    module_init();
    assert(sim.inputs.empty());
    frames(1, 4);
    assert(last(kFpsMessageName) == "{\"fps\":4.00}");
    module_deinit();
}

int main() {
#if defined(_MSC_VER)
    // A failed assert or a crash prints to stderr and exits; no dialog that waits for a click.
    SetErrorMode(0x0001 | 0x0002);  // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
    testParsing();
    testDetector();
    testModule();
    testStartupFailures();
    return 0;
}
