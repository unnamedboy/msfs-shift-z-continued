# Classic Shift+Z cycle and configuration mode

Branch: `experimental/wasm-hotkey` (builds on the toolbar-free WASM hotkey experiment).

## Why

Players expect the FS9/FSX/P3D behaviour: no toolbar, press Shift+Z and the red text appears. The 1.0 release on flightsim.to also drew two reports: the line is cut off at the left edge on some screens (the panel is anchored right with `defaultWidth=180`, has no header and ignores the mouse, so it cannot be moved), and a request for metres and km/h.

## Goals

- Shift+Z cycles three states like FSX: line 1 → lines 1 + 2 → off. The overlay starts off.
- Ctrl+Shift+Z opens a configuration mode. In it the player can drag the text anywhere on screen, choose which items are shown, switch altitude (ft/m) and speed (kt/km/h) units, reset the position, and leave with **Done** or Ctrl+Shift+Z again.
- Settings survive restarts.
- Outside configuration mode the overlay never takes mouse input.

## Non-goals

- Changing the hotkeys from inside the sim (possible later through CommBus JS → WASM).
- VR, MSFS 2020, a toolbar button.

## Approaches considered

- **A. Second hotkey for configuration (chosen by the user).** The overlay stays fully click-through; one more key.
- B. Hover gear on the overlay: needs a permanently mouse-sensitive area that blocks cockpit clicks at the top of the screen.
- C. Long-press Shift+Z: relies on down/up timing in WASM that is not yet validated.

## Design

- **Panel (`ShiftZContinued.xml`):** keep `managedByToolbar=false`, `DependsOnToolBarAction=false` and `ShowOnEvent CHAIN_MESSAGE_FLIGHT_END_LOADING`. Make it cover the screen (`defaultLeft=0`, `defaultTop=0`, `defaultWidth=100`, `defaultHeight=100`, `noBackground=true`, `isPanelCloseable=false`). The text is positioned inside the panel by JS, so the panel's own anchor no longer decides where the text is. Whether these units cover the whole screen must be checked in the sim; fallback is a `Preset` child with `PanelLayout="FULL_SCREEN"`.
- **WASM (`fps.cpp`):** keep Shift+Z mappings (left and right Shift, with `Z` and `z` because the docs list upper case but the example uses lower case; the existing held-key latch absorbs duplicates). Add Ctrl+Shift+Z mappings (all four Ctrl/Shift sides, both cases) with their own latch, sending `SHIFT_Z_CONTINUED_CONFIG` over CommBus.
- **Overlap:** the docs do not say whether Ctrl+Shift+Z also fires the Shift+Z mapping. The JS panel resolves it: a config message undoes a cycle received within 250 ms before it, and a cycle message within 250 ms after a config message is ignored.
- **JS panel:** a settings object `{ x, y, fields, altitudeUnit, speedUnit }` stored as JSON with `SetStoredData`/`GetStoredData` (`/JS/dataStorage.js`). `x`/`y` are percentages of the panel, clamped so the text stays on screen. Rendering builds the two lines from enabled fields only. Configuration mode adds a class that turns on pointer events for the text box (drag with mousedown/mousemove/mouseup) and a settings card; outside it everything stays `pointer-events: none`.
- **Defaults:** top-left (1 %, 0.5 %), all 1.0 fields on, feet and knots.

## Left to the builder

Exact card layout and styling, field labels, storage key name.

## Must be checked in MSFS 2024

Auto-load without toolbar; panel covers the screen; clicks pass through outside configuration mode; Shift+Z and Ctrl+Shift+Z without focus; dragging and checkboxes work with the sim mouse; settings persist after restarting the sim.

# Addendum (2026-11-26): key conflicts and changing the hotkeys

## Why

A hotkey can collide with any simulator binding, not only the default Shift+Z → Slew: players rebind keys, and the 2020-style layout puts Ctrl+Shift+Z on ALTITUDE_BUG_SELECT. The player should learn about it at once, with the command named, and choose how to resolve it.

## Behaviour (chosen by the user: option B plus ignore)

- When a press of either hotkey also triggers a simulator command, the configuration card opens with a warning naming the command(s).
- The card offers three ways out: remove the binding in MSFS (instructions shown), **Change key** for that hotkey, or **Ignore**. Ignore is remembered per key combination and that combination is never reported again.
- Both hotkeys can be changed: click **Change key**, press the new combination, Esc cancels. Allowed: Shift/Ctrl/Alt (at least one) with A–Z or 0–9, or F1–F12 with or without modifiers; at most two modifiers (SimConnect limit). A combination equal to the other hotkey is refused.
- The new keys are saved with the other settings and sent to WASM at start and on every change.

## Design

- **Detection (WASM):** `fsEventsRegisterKeyEventHandler` sees simulator key events. A frame counter (Frame and PauseFrame) timestamps them in a ring buffer. On a hotkey down event the module looks at events from 2 frames before to 10 frames after the press and drops any event id that also occurred in the 60 frames before that window (continuous events such as axes or instrument updates). What remains is sent as `SHIFT_Z_CONTINUED_CONFLICT` `{"key":"cycle"|"config","events":[ids]}`. Our own mappings use private client events, so they never appear. Commands that are not key events (some camera and UI actions) cannot be seen; the in-sim test records which kinds are caught.
- **Names (JS):** `eventNames.js`, generated by `tools/gen_event_names.py` from the SDK's `MSFS_EventsEnum.h`, maps ids to names (`KEY_SLEW_TOGGLE` → `SLEW_TOGGLE`). Unknown ids show as `event 0x…`.
- **Remap (JS → WASM):** `SHIFT_Z_CONTINUED_SET_KEYS` with text `cycle=DEF|DEF;config=DEF|DEF`, where each DEF is a SimConnect input string. JS expands a combination into all left/right modifier variants and both letter cases. WASM validates the characters (`A-Za-z0-9_+`), the number of definitions and their length, clears the input group and maps the new set; on failure it restores the defaults and logs.
- **JS state:** settings gain `keys: { cycle, config }` (each `{ mods: ['shift'|'ctrl'|'alt'], key: 'Z' }`) and `ignoredConflicts: [comboText]`. While capturing a key, hotkey messages from WASM are ignored.

## Must be checked in MSFS 2024

Without changing any MSFS binding: use Change key to set our cycle key to a combination the active profile already binds to a harmless command, and that command is reported by name; a press without a binding reports nothing over several minutes of flight with an airliner (no false alarms); Ignore silences it after restart; key capture works when the card has focus and the new key cycles without focus; Ctrl+Shift+Z in the 2020 layout reports ALTITUDE_BUG_SELECT if that layout is available.

## Changes during implementation (2026-11-26)

Sim tests changed three parts of this design; details in [the experiment log](../../experimental-wasm-hotkey.md).

- **Detection:** `fsEventsRegisterKeyEventHandler` never fires in a standalone module (the sim treats the handler as belonging to a dirty module). The module instead maps about 1,500 documented SimConnect command names (`src/wasm/watched_commands.h`, generated by `tools/gen_watched_commands.py`) to client events in non-maskable notification groups; the detector logic is unchanged.
- **Names:** SimConnect names differ from the `KEY_` macros (`KEY_AUTOCOORD_TOGGLE` is `AUTORUDDER_TOGGLE`), so the conflict message carries the SimConnect names and `eventNames.js` was dropped.
- **Ignore:** the user clarified that Ignore means no conflict warnings at all from then on, for any key; settings hold `ignoreConflicts: true` instead of a list of combinations.
- **Remap:** CommBus `callWasm` works once the panel avoids `Array.prototype.flatMap` (missing in Coherent GT); the panel also writes the key set as a number to `L:SHIFT_Z_CONTINUED_KEYS` as a second path, and the card shows the result of both. Esc cannot cancel a capture (MSFS opens its pause menu), so the Change key button turns into Cancel.
