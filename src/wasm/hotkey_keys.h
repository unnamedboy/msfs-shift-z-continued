#pragma once

// Parses the request the panel sends: "id=N;watch=0|1;cycle=DEF|DEF;config=DEF|DEF".
// Each DEF is a SimConnect input string such as VK_LSHIFT+Z. Pure logic, testable on the desktop.

#include <cstddef>
#include <cstring>

namespace shiftz {

struct HotkeySet {
    static constexpr size_t kMaxDefinitions = 8;  // two modifiers with a left and a right side, two letter cases
    static constexpr size_t kMaxLength = 40;
    char definitions[2][kMaxDefinitions][kMaxLength + 1] = {};  // [0] cycle, [1] config
    size_t counts[2] = {};
};

inline bool isDefinitionChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '+';
}

// Returns false (and leaves keys unusable) for anything malformed; both keys need at least one definition.
inline bool parseHotkeySet(const char* text, size_t length, HotkeySet& keys) {
    keys = HotkeySet{};
    if (!text) return false;
    while (length > 0 && text[length - 1] == '\0') --length;  // tolerate a sent terminator
    size_t position = 0;
    bool seen[2] = {false, false};
    while (position < length) {
        size_t end = position;
        while (end < length && text[end] != ';') ++end;
        const char* part = text + position;
        const size_t partLength = end - position;
        int key = -1;
        size_t prefix = 0;
        if (partLength > 6 && std::strncmp(part, "cycle=", 6) == 0) { key = 0; prefix = 6; }
        else if (partLength > 7 && std::strncmp(part, "config=", 7) == 0) { key = 1; prefix = 7; }
        if (key < 0 || seen[key]) return false;
        seen[key] = true;
        size_t start = prefix;
        while (start <= partLength) {
            size_t stop = start;
            while (stop < partLength && part[stop] != '|') ++stop;
            const size_t defLength = stop - start;
            if (defLength == 0 || defLength > HotkeySet::kMaxLength ||
                keys.counts[key] >= HotkeySet::kMaxDefinitions) {
                return false;
            }
            for (size_t i = 0; i < defLength; ++i) {
                if (!isDefinitionChar(part[start + i])) return false;
            }
            std::memcpy(keys.definitions[key][keys.counts[key]], part + start, defLength);
            keys.definitions[key][keys.counts[key]][defLength] = '\0';
            ++keys.counts[key];
            start = stop + 1;
        }
        position = end + 1;
    }
    return seen[0] && seen[1];
}

struct KeyRequest {
    unsigned id = 0;
    bool watch = false;  // watch simulator commands for key conflicts
    HotkeySet keys;
};

// Fills request.id as soon as it is readable, so even a rejected request can be answered.
inline bool parseKeyRequest(const char* text, size_t length, KeyRequest& request) {
    request = KeyRequest{};
    if (!text || length < 4 || std::strncmp(text, "id=", 3) != 0) return false;
    size_t position = 3;
    unsigned id = 0;
    for (size_t digits = 0; position < length && text[position] >= '0' && text[position] <= '9'; ++digits) {
        if (digits == 9) return false;
        id = id * 10 + static_cast<unsigned>(text[position++] - '0');
    }
    if (position == 3) return false;
    request.id = id;
    constexpr size_t kWatchLength = 9;  // ";watch=0;"
    if (length - position < kWatchLength) return false;
    if (std::strncmp(text + position, ";watch=1;", kWatchLength) == 0) request.watch = true;
    else if (std::strncmp(text + position, ";watch=0;", kWatchLength) != 0) return false;
    position += kWatchLength;
    return parseHotkeySet(text + position, length - position, request.keys);
}

}  // namespace shiftz
