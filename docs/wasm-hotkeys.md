# WASM hotkeys and conflict detection

How the overlay gets its keys and finds key conflicts in MSFS 2024, which SDK behaviour that relies on, and how
it is checked in the simulator.

## Parts

- **Panel** (`src/InGamePanels/ShiftZContinued.xml`): `managedByToolbar=false`, `ShowOnEvent`
  `CHAIN_MESSAGE_FLIGHT_END_LOADING`, no header or close button, `noBackground`. Sizes are percent of the screen
  height: `defaultWidth=178` covers 16:9. Without `resizeDirections="both"` the game started the panel at
  `minHeight` and the `ingame-ui` template kept it a 54 px strip, so `minHeight` is 100 as well.
- **JS** (`src/html_ui/InGamePanels/ShiftZContinued/`): `panel.js` draws the text, the settings card and the
  warning; `hotkeys.js` validates key combinations and turns them into SimConnect input strings.
- **WASM** (`src/wasm/fps.cpp`): maps the two hotkeys, sends key presses and the frame rate to JS, applies the
  player's keys and watches simulator commands for conflicts. `hotkey_keys.h` parses the panel's request,
  `key_conflicts.h` is the detector, `watched_commands.h` the generated command list.

## Messages (CommBus)

| Message | Direction | Payload |
|---|---|---|
| `SHIFT_Z_CONTINUED_CYCLE`, `SHIFT_Z_CONTINUED_CONFIG` | WASM → JS | `{"press":N}`, presses numbered from module start |
| `SHIFT_Z_CONTINUED_FPS` | WASM → JS | `{"fps":38.20}`, about four times a second |
| `SHIFT_Z_CONTINUED_SET_KEYS` | JS → WASM | `id=N;watch=0\|1;cycle=DEF\|DEF;config=DEF\|DEF` |
| `SHIFT_Z_CONTINUED_KEYS_STATUS` | WASM → JS | `{"id":N,"result":"applied"\|"failed"\|"invalid"}` |
| `SHIFT_Z_CONTINUED_CONFLICT` | WASM → JS | `{"key":"cycle","press":N,"commands":["SLEW_TOGGLE"]}` |

## Key changes

The panel keeps the confirmed keys in its settings. A new key is sent with a fresh request id and saved only
when the answer with that id says `applied`; answers to older ids are ignored, and hotkey messages are ignored
while the player's own change is waiting (they come from the keys pressed during the capture); a second
change cannot start until then. The panel sends
its saved keys and the watch setting once the bus is up and the saved settings are readable (they can read as missing before
`dataStorageReady`; without that event it waits 5 s, and until then nothing is saved, so defaults never
replace the saved settings); if WASM rejects them it falls back to the defaults. A rejected change needs nothing more, because
WASM has put back the keys it last confirmed (if those are not the saved keys, because their own send was
still unanswered, the saved keys are sent again). When the player's change is not answered within 3 s, the panel sends the
saved keys again, because WASM may apply the change anyway (a late answer). A send of the saved keys that is not confirmed is repeated after 3 s, three attempts at most; a
call that fails counts as not confirmed, and only a rejection (`failed` or `invalid`) makes the panel try the
defaults, once per rejected attempt. After the third attempt the card says the default keys may be in use.

WASM maps the new keys at once and answers after SimConnect has processed them: an invalid input string is
reported later as an exception, not as a failed call. A `SimConnect_RequestSystemState` sent after the
mappings is answered after any such exception; on an exception for a later packet the previous keys are mapped
again and the answer is `failed`. Only the newest request is answered.

## Conflict detection

A heuristic, not proof: WASM watches the documented simulator commands and reports those that fire from 0.1 s
before to 0.35 s after a hotkey press but not in the 2 s before it. A command inside the window of an earlier
press does not count as "before" (it may have answered that press), so a repeated conflict stays visible; a
command near a later press belongs to that press. A press with three or more presses in the 2 s before it is
not judged, because too little of that time is free of press windows; neither is a press in about the first 2 s
after the watch starts, when the time before it was not watched. Time is summed from the frame rate of each frame, so the
windows do not depend on it; a `PauseFrame` only counts when no `Frame` arrived since the previous one.
Ignore stops the watch in WASM (the notification groups are cleared) and is kept for good.

`tools/gen_watched_commands.py` builds `src/wasm/watched_commands.h` from the key event tables of the SDK
documentation, leaving out axes, setters, debug commands and the names in `tools/unknown_commands.txt`, which
the sim rejected.

## SDK findings (MSFS 2024, November 2026)

- `fsEventsRegisterKeyEventHandler` never calls back in a standalone module; the console showed "Trying to call
  Key Event Handler on dirty module" while the module was READY. Commands are watched through SimConnect
  notification groups instead.
- SimConnect names differ from the `KEY_` macros: the binding `KEY_AUTOCOORD_TOGGLE` is `AUTORUDDER_TOGGLE`;
  the SimConnect name `AUTOCOORD_TOGGLE` is a different command, unknown to the sim.
- Watch groups need `SIMCONNECT_GROUP_PRIORITY_HIGHEST`: at standard priority an airliner that handles a command
  itself (A320neo v2: spoilers, flaps, autopilot disconnect) hides it. The groups are non-maskable, so the
  module never blocks a command.
- Key bindings arrived as `SIMCONNECT_RECV_ID_EVENT`, never as the EX1 form.
- At most 1000 events per notification group and 20 groups per client; 84 documented names are unknown to the
  sim.
- `SimConnect_SubscribeToCommBusEvent` called from a WASM module makes the module dirty at start.
- Coherent GT has no `Array.prototype.flatMap`; a test rejects `flat`/`flatMap` in the panel sources.
- Ctrl+Shift+Z did not also fire the Shift+Z mapping in any test, so the keys need no overlap handling.
- Key presses while the Esc pause menu is open are dropped, not delayed. Esc itself opens that menu, so a key
  capture is cancelled with the button.
- In the settings card a click on Change key/Cancel or a unit button did not always arrive; those buttons also
  act on mousedown.
- The panel's data storage is attached only at `dataStorageReady`; settings are read again then.

## Simulator checks

Run with the package installed and without changing the MSFS bindings; copy the console lines filtered by
`ShiftZContinued`.

1. Automatic loading: enter a flight without the toolbar; the console shows `Module ready.` and, once the
   panel has sent its keys, `Watching 1492 commands for key conflicts.` with no SimConnect exception.
2. Shift+Z without panel focus: line 1 → both lines → off, one step per press, left and right Shift.
3. Mouse passthrough: cockpit clicks under and around the text work outside the settings.
4. Ctrl+Shift+Z opens the card without stepping the view; drag the text to all four edges; switch to metres
   and km/h at the right edge and enable all items: the text stays fully on screen.
5. Change the cycle key to a combination bound in MSFS (A320neo v2: Ctrl+P runs AUTORUDDER_TOGGLE): the key
   applies, the display steps once per press, and the card warns about AUTORUDDER_TOGGLE. Change it back.
6. Press Ignore: the console shows `Key conflict watch off.` and the bound key no longer opens the card.
7. Main Menu → new flight and an MSFS restart keep keys, items, units and position.

Simulator test history (twelve rounds on A310, ATR 72-600, 787-10 and A320neo v2) is in the git history of
`docs/experimental-wasm-hotkey.md`.

## Known limits

- Detection was checked with the A320neo v2 parked or on the ground; other aircraft may fire watched commands
  in ways that cause false reports or hide a conflict.
- The warning names the SimConnect command, which can differ from the name in the MSFS controls.
- The panel width covers 16:9 screens. Ultrawide screens are untested (the text may not reach the right
  edge), and so are narrower ones such as 16:10 or 4:3 (the panel may be wider than the screen).
- Ignore cannot be undone from the settings.
- A second press of the same key within 0.35 s is not judged, and a command that arrives after the first
  press but close to the second is then reported for neither.
- When the other key is pressed 0.35 to 0.45 s after a press, a command between the two can be reported for
  both keys, one warning replacing the other.
- Reports are dropped while the pressed key is uncertain: before the saved settings are readable, while a
  key change waits for its answer, and when the saved keys were not confirmed.
- The check can miss a conflict: on the first press within 2 s after the same command ran for another reason
  (for example while the new key was being captured), after the bound command auto-repeated on a held key,
  and on the fourth and later of several presses within 2 s.
- It can report a command that fires on its own about every 0.7 to 2 s, when presses happen to hide its
  earlier runs.
- Holding the newly captured keys until after WASM confirmed them may count as a press of the new key, if
  MSFS sends a down event for a key held while it is mapped (not seen in tests; unchecked).
