# Classic Shift+Z Cycle and Configuration Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift+Z cycles line 1 → both lines → off; Ctrl+Shift+Z opens a draggable configuration mode with field and unit choices that persist.

**Architecture:** The WASM module maps both hotkeys and forwards `SHIFT_Z_CONTINUED_CYCLE` / `SHIFT_Z_CONTINUED_CONFIG` over CommBus. A full-screen, click-through JS panel positions the text itself and stores settings with `SetStoredData`.

**Tech Stack:** C++ MSFS WASM + SimConnect, Coherent JS panel, node:test, Python build.

**Spec:** `docs/superpowers/specs/2026-11-25-config-mode-design.md`

## Global Constraints

- Hotkeys: Shift+Z (either Shift) cycles; Ctrl+Shift+Z (any Ctrl/Shift side) toggles configuration mode. Map both `Z` and `z`.
- Cycle order: off (start) → line 1 → lines 1 + 2 → off.
- Overlap window: 250 ms.
- Defaults: x = 1, y = 0.5 (percent), all fields on, `altitudeUnit: 'ft'`, `speedUnit: 'kt'`.
- Outside configuration mode nothing in the panel takes pointer events.

## Review Focus

- Corrupt or old stored settings (invalid JSON, missing keys, x = 500): fall back per key to defaults and clamp x/y to 0–95.
- Ctrl+Shift+Z firing both mappings in either order: view must not change, configuration mode toggles once.
- Every field of a line unchecked: that line renders empty, no stray separators.
- Configuration mode while the view is off: the preview still shows both lines so there is something to drag.
- Mouse released outside the panel during a drag: drag ends on the next mouseup anywhere or on leaving configuration mode.

---

### Task 1: WASM configuration hotkey

**Files:** Modify `src/wasm/fps.cpp`, `tests/fps_test.cpp`.

**Interfaces:** Produces CommBus message `SHIFT_Z_CONTINUED_CONFIG` with payload `{}`; new client events `kConfigDownEvent = 5`, `kConfigUpEvent = 6`; latch `configKeyDown`.

- [ ] Test: mappings are `VK_LSHIFT+Z`, `VK_LSHIFT+z`, `VK_RSHIFT+Z`, `VK_RSHIFT+z` to cycle events, plus `VK_LCONTROL+VK_LSHIFT+Z` … (4 side combinations × 2 cases) to config events; notification group holds all four events; config down sends one `SHIFT_Z_CONTINUED_CONFIG` per press (held key latched until config up); every registration failure still clears the group and leaves FPS working.
- [ ] Implement with a table of `{definition, down, up}` iterated in `registerHotkey()`.
- [ ] Run `python tests/run_cpp_tests.py`: PASS. Commit.

### Task 2: Panel settings, three-state cycle, overlap rule

**Files:** Modify `src/html_ui/InGamePanels/ShiftZContinued/panel.js`, `index.html` (add `/JS/dataStorage.js`), `tests/panel.test.js`.

**Interfaces:** `loadSettings(): Settings`, `saveSettings()`, `onCycle(now = Date.now())`, `onConfig(now = Date.now())`, `this.configMode: boolean`. `Settings = { x, y, fields: { lat, lon, alt, hdg, ias, wind, fps, g, fuel, simrate }, altitudeUnit: 'ft'|'m', speedUnit: 'kt'|'kmh' }`. Storage key `SHIFT_Z_CONTINUED_SETTINGS`.

- [ ] Tests: cycle off → line 1 → both → off; disabled fields are omitted; metres render `ALT: 194 M MSL`, km/h render `158.5 KM/H` and `WIND … @ 15 km/h.`; corrupt storage falls back; config within 250 ms after a cycle restores the previous view; cycle within 250 ms after config is ignored.
- [ ] Implement. Run `node --test tests/panel.test.js`: PASS. Commit.

### Task 3: Configuration mode UI and drag

**Files:** Modify `panel.js`, `index.html`, `style.css`, `tests/panel.test.js`.

**Interfaces:** Consumes Task 2 settings. DOM: `#stats` (text box, absolutely positioned by `left: x%`, `top: y%`), `#config` (card with one toggle per field, unit toggles, `Reset position`, `Done`). Root gets class `config-mode`.

- [ ] Tests: entering config mode sets the class and shows both lines even when off; a simulated drag from (100,100) to (300,200) on an 1000×500 panel moves x by 20 and y by 20, clamped to 0–95; toggling a field saves; Done leaves config mode and saves.
- [ ] Implement with mousedown on `#stats`, mousemove/mouseup on `document`. Run tests: PASS. Commit.

### Task 4: Full-screen panel registration and docs

**Files:** Modify `src/InGamePanels/ShiftZContinued.xml`, `README.md`, `readme.txt`, `docs/experimental-wasm-hotkey.md`.

- [ ] XML: `defaultLeft="0" defaultTop="0" defaultWidth="100" defaultHeight="100" noBackground="true" isPanelCloseable="false"`, keep the rest.
- [ ] Docs describe the three-state cycle, Ctrl+Shift+Z configuration and the in-sim checklist from the spec.
- [ ] Run all three test commands from README: PASS. Commit.

### Task 5: Build and in-sim test

- [ ] `python build.py` (needs the simulator closed or the package tool waits), `python package_release.py`.
- [ ] Hand the package and the spec's checklist to the MSFS testing session.
