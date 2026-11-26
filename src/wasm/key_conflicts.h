#pragma once

// Finds simulator key events that fire together with one of our hotkeys.
// Pure logic with no SDK calls, so it can be tested on the desktop.

#include <cstddef>
#include <cstdio>

namespace shiftz {

class KeyConflictDetector {
public:
    static constexpr int kLookBackFrames = 2;    // the sim may run its binding before our input event arrives
    static constexpr int kLookAheadFrames = 10;
    static constexpr int kBaselineFrames = 60;   // events also seen just before the press are continuous noise
    static constexpr size_t kMaxReported = 8;
    static constexpr size_t kHistory = 2048;

    struct Report {
        bool ready = false;
        int key = 0;  // index passed to onPress
        size_t count = 0;
        int events[kMaxReported] = {};
    };

    void reset() {
        frame_ = 0;
        size_ = 0;
        next_ = 0;
        for (auto& pending : pending_) pending.active = false;
    }

    void onFrame() { ++frame_; }

    void onKeyEvent(int eventId) {
        history_[next_] = {eventId, frame_};
        next_ = (next_ + 1) % kHistory;
        if (size_ < kHistory) ++size_;
    }

    // key: 0 = cycle, 1 = config. A second press before the first is evaluated is ignored.
    void onPress(int key) {
        if (key < 0 || key >= kKeys || pending_[key].active) return;
        pending_[key] = {true, frame_};
    }

    // Call after onFrame; returns at most one finished report per call.
    Report poll() {
        Report report;
        for (int key = 0; key < kKeys; ++key) {
            auto& pending = pending_[key];
            if (!pending.active || frame_ < pending.frame + kLookAheadFrames) continue;
            pending.active = false;
            report.ready = true;
            report.key = key;
            collect(pending.frame, report);
            return report;
        }
        return report;
    }

    // Writes {"key":"cycle","events":["NAME","event 7"]} into buffer: names[id] when the id indexes names
    // (names hold only A-Z, 0-9 and _), "event <id>" otherwise. Returns the length, or 0 if it does not fit.
    static int format(const Report& report, char* buffer, size_t size,
                      const char* const* names = nullptr, size_t nameCount = 0) {
        int length = std::snprintf(buffer, size, "{\"key\":\"%s\",\"events\":[", report.key == 0 ? "cycle" : "config");
        for (size_t i = 0; i < report.count && length > 0 && static_cast<size_t>(length) < size; ++i) {
            const int id = report.events[i];
            const char* separator = i ? "," : "";
            length += names && id >= 0 && static_cast<size_t>(id) < nameCount
                ? std::snprintf(buffer + length, size - length, "%s\"%s\"", separator, names[id])
                : std::snprintf(buffer + length, size - length, "%s\"event %d\"", separator, id);
        }
        if (length <= 0 || static_cast<size_t>(length) >= size) return 0;
        length += std::snprintf(buffer + length, size - length, "]}");
        return static_cast<size_t>(length) < size ? length : 0;
    }

private:
    static constexpr int kKeys = 2;
    struct Entry { int id; long frame; };
    struct Pending { bool active = false; long frame = 0; };

    bool seenBetween(int id, long from, long to) const {
        for (size_t i = 0; i < size_; ++i) {
            const Entry& entry = history_[i];
            if (entry.id == id && entry.frame >= from && entry.frame <= to) return true;
        }
        return false;
    }

    void collect(long pressFrame, Report& report) const {
        const long windowStart = pressFrame - kLookBackFrames;
        const long windowEnd = pressFrame + kLookAheadFrames;
        for (size_t i = 0; i < size_ && report.count < kMaxReported; ++i) {
            const Entry& entry = history_[i];
            if (entry.frame < windowStart || entry.frame > windowEnd) continue;
            bool duplicate = false;
            for (size_t j = 0; j < report.count; ++j) duplicate = duplicate || report.events[j] == entry.id;
            if (duplicate || seenBetween(entry.id, windowStart - kBaselineFrames, windowStart - 1)) continue;
            report.events[report.count++] = entry.id;
        }
    }

    Entry history_[kHistory] = {};
    size_t size_ = 0;
    size_t next_ = 0;
    long frame_ = 0;
    Pending pending_[kKeys] = {};
};

}  // namespace shiftz
