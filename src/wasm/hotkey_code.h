#pragma once
// Decodes the number the panel writes to L:SHIFT_Z_CONTINUED_KEYS into the key-set text that
// parseHotkeySet reads. Mirrors comboCode/hotkeySetCode/hotkeySetText in hotkeys.js.
//
// One combination: modifiers * 64 + key, modifiers 1 Ctrl, 2 Alt, 4 Shift (at most two),
// key 0-25 A-Z, 26-35 0-9, 36-47 F1-F12. Letters and digits need a modifier.
// The value: cycle + config * 512 + send counter * 262144 (the counter makes every send visible).

#include <cmath>
#include <cstddef>
#include <cstdio>

namespace shiftz {

constexpr int kHotkeyCodeBase = 512;
constexpr double kHotkeySetBase = 262144.0;  // kHotkeyCodeBase * kHotkeyCodeBase

inline bool appendText(char* out, size_t size, size_t& pos, const char* text) {
    const int written = std::snprintf(out + pos, size - pos, "%s", text);
    if (written < 0 || static_cast<size_t>(written) >= size - pos) return false;
    pos += static_cast<size_t>(written);
    return true;
}

inline bool appendComboDefinitions(int code, char* out, size_t size, size_t& pos) {
    static const char* const kModifierInputs[3][2] = {
        {"VK_LCONTROL", "VK_RCONTROL"}, {"VK_LMENU", "VK_RMENU"}, {"VK_LSHIFT", "VK_RSHIFT"}};
    if (code < 0 || code >= kHotkeyCodeBase) return false;
    const int modifiers = code / 64;
    const int key = code % 64;
    if (modifiers > 7 || key > 47) return false;
    int mods[2];
    int modCount = 0;
    for (int bit = 0; bit < 3; ++bit) {
        if (modifiers & (1 << bit)) {
            if (modCount == 2) return false;
            mods[modCount++] = bit;
        }
    }
    char keys[2][8];
    int keyCount = 1;
    if (key < 26) {
        if (modCount == 0) return false;
        std::snprintf(keys[0], sizeof(keys[0]), "%c", 'A' + key);
        std::snprintf(keys[1], sizeof(keys[1]), "%c", 'a' + key);
        keyCount = 2;
    } else if (key < 36) {
        if (modCount == 0) return false;
        std::snprintf(keys[0], sizeof(keys[0]), "%c", '0' + key - 26);
    } else {
        std::snprintf(keys[0], sizeof(keys[0]), "VK_F%d", key - 35);
    }
    // Same order as hotkeys.js: first modifier outermost, left before right, then key spellings.
    bool first = true;
    for (int sides = 0; sides < (1 << modCount); ++sides) {
        for (int k = 0; k < keyCount; ++k) {
            if (!first && !appendText(out, size, pos, "|")) return false;
            first = false;
            for (int m = 0; m < modCount; ++m) {
                const int side = (sides >> (modCount - 1 - m)) & 1;
                if (!appendText(out, size, pos, kModifierInputs[mods[m]][side]) || !appendText(out, size, pos, "+")) {
                    return false;
                }
            }
            if (!appendText(out, size, pos, keys[k])) return false;
        }
    }
    return true;
}

// Returns the text length, or 0 when the value is not a valid key set.
inline size_t hotkeyTextFromCode(double value, char* out, size_t size) {
    if (!out || size == 0 || !std::isfinite(value) || value <= 0 || value != std::floor(value)) return 0;
    const int codes = static_cast<int>(std::fmod(value, kHotkeySetBase));
    const int cycle = codes % kHotkeyCodeBase;
    const int config = codes / kHotkeyCodeBase;
    if (cycle == config) return 0;
    size_t pos = 0;
    out[0] = '\0';
    if (!appendText(out, size, pos, "cycle=") || !appendComboDefinitions(cycle, out, size, pos) ||
        !appendText(out, size, pos, ";config=") || !appendComboDefinitions(config, out, size, pos)) {
        out[0] = '\0';
        return 0;
    }
    return pos;
}

}  // namespace shiftz
