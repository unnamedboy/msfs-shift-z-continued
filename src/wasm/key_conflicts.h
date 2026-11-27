#pragma once

// A heuristic for key conflicts: a simulator command that fires in the short window around a hotkey press,
// and did not fire in the seconds before it, probably shares the key. Times are in seconds of frame time,
// so the windows do not depend on the frame rate. Pure logic, tested on the desktop.

#include <cstddef>
#include <cstdio>

namespace shiftz {

class KeyConflictDetector {
public:
    static constexpr double kBefore = 0.1;    // the sim may run its binding just before our input event arrives
    static constexpr double kAfter = 0.35;
    static constexpr double kBaseline = 2.0;  // commands seen this long before a press are background activity
    // With this many presses already in the baseline, too little of it is free of press windows to tell
    // background activity from answers to those presses, so the press is not judged.
    static constexpr size_t kMaxBaselinePresses = 3;
    static constexpr size_t kMaxReported = 8;
    static constexpr size_t kHistory = 2048;
    static constexpr size_t kPressHistory = 8;

    struct Report {
        bool ready = false;
        int key = 0;          // index passed to onPress
        unsigned press = 0;   // press number passed to onPress
        size_t count = 0;
        int commands[kMaxReported] = {};
    };

    void reset() {
        now_ = 0;
        size_ = next_ = 0;
        presses_ = pressNext_ = 0;
        clearPending();
    }

    // Commands are only known from here on: a press without a full baseline after this is not judged.
    void onWatchStart() { watchSince_ = now_; }

    void advance(double seconds) {
        if (seconds > 0) now_ += seconds;
    }

    void onCommand(int id) {
        history_[next_] = {id, now_};
        next_ = (next_ + 1) % kHistory;
        if (size_ < kHistory) ++size_;
    }

    // key: 0 = cycle, 1 = config. A press while the previous one of that key is still open is not evaluated.
    void onPress(int key, unsigned press) {
        if (key < 0 || key >= kKeys) return;
        pressLog_[pressNext_] = now_;
        pressNext_ = (pressNext_ + 1) % kPressHistory;
        if (presses_ < kPressHistory) ++presses_;
        if (!pending_[key].active) pending_[key] = {true, now_, press};
    }

    // Drops presses that have not been evaluated yet, for example when the keys change.
    void clearPending() {
        for (auto& pending : pending_) pending.active = false;
    }

    // Returns at most one finished report per call, the earliest press first.
    Report poll() {
        Report report;
        int key = -1;
        for (int i = 0; i < kKeys; ++i) {
            if (pending_[i].active && now_ >= pending_[i].time + kAfter &&
                (key < 0 || pending_[i].time < pending_[key].time)) {
                key = i;
            }
        }
        if (key < 0) return report;
        Pending& pending = pending_[key];
        pending.active = false;
        report.ready = true;
        report.key = key;
        report.press = pending.press;
        collect(pending.time, report);
        return report;
    }

    // Writes {"key":"cycle","press":3,"commands":["NAME"]}; returns the length, or 0 if it does not fit.
    // Names hold only A-Z, 0-9 and _, so they need no escaping.
    static int format(const Report& report, const char* const* names, size_t nameCount, char* buffer, size_t size) {
        int length = std::snprintf(buffer, size, "{\"key\":\"%s\",\"press\":%u,\"commands\":[",
                                   report.key == 0 ? "cycle" : "config", report.press);
        bool first = true;
        for (size_t i = 0; i < report.count && length > 0 && static_cast<size_t>(length) < size; ++i) {
            const int id = report.commands[i];
            if (id < 0 || static_cast<size_t>(id) >= nameCount) continue;
            length += std::snprintf(buffer + length, size - length, first ? "\"%s\"" : ",\"%s\"", names[id]);
            first = false;
        }
        if (length <= 0 || static_cast<size_t>(length) >= size) return 0;
        length += std::snprintf(buffer + length, size - length, "]}");
        return static_cast<size_t>(length) < size ? length : 0;
    }

private:
    static constexpr int kKeys = 2;
    struct Entry { int id; double time; };
    struct Pending { bool active = false; double time = 0; unsigned press = 0; };

    // A command in the window of an earlier press (of either key, judged or not) may have answered that
    // press, so it is no evidence of background activity; repeated presses of a conflicting key keep
    // being reported.
    bool nearEarlierPress(double time, double press) const {
        for (size_t i = 0; i < presses_; ++i) {
            const double earlier = pressLog_[i];
            if (earlier < press && time >= earlier - kBefore && time <= earlier + kAfter) return true;
        }
        return false;
    }

    size_t pressesInBaseline(double press) const {
        size_t count = 0;
        for (size_t i = 0; i < presses_; ++i) {
            if (pressLog_[i] < press && pressLog_[i] >= press - kBaseline) ++count;
        }
        return count;
    }

    // A command in the window of a later press belongs to that press, not to this one.
    bool nearLaterPress(double time, double press) const {
        for (size_t i = 0; i < presses_; ++i) {
            const double later = pressLog_[i];
            if (later > press && time >= later - kBefore) return true;
        }
        return false;
    }

    bool background(int id, double press) const {
        const double from = press - kBefore - kBaseline;
        const double to = press - kBefore;
        for (size_t i = 0; i < size_; ++i) {
            const Entry& entry = history_[i];
            if (entry.id == id && entry.time >= from && entry.time < to && !nearEarlierPress(entry.time, press)) {
                return true;
            }
        }
        return false;
    }

    void collect(double press, Report& report) const {
        if (press - kBefore - kBaseline < watchSince_ || pressesInBaseline(press) >= kMaxBaselinePresses) return;
        for (size_t i = 0; i < size_ && report.count < kMaxReported; ++i) {
            const Entry& entry = history_[i];
            if (entry.time < press - kBefore || entry.time > press + kAfter || nearLaterPress(entry.time, press)) continue;
            bool duplicate = false;
            for (size_t j = 0; j < report.count; ++j) duplicate = duplicate || report.commands[j] == entry.id;
            if (!duplicate && !background(entry.id, press)) report.commands[report.count++] = entry.id;
        }
    }

    Entry history_[kHistory] = {};
    size_t size_ = 0;
    size_t next_ = 0;
    double pressLog_[kPressHistory] = {};
    size_t presses_ = 0;
    size_t pressNext_ = 0;
    double now_ = 0;
    double watchSince_ = -1e9;
    Pending pending_[kKeys] = {};
};

}  // namespace shiftz
