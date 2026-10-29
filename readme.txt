SHIFT Z CONTINUED
=================

A classic Shift+Z-style flight data overlay for Microsoft Flight Simulator 2024.

Project: https://github.com/unnamedboy/msfs-shift-z-continued

IMPORTANT: SHIFT+Z KEY CONFLICT
-------------------------------
Before using this add-on, open MSFS 2024's Controls settings and remove or
reassign the simulator's existing Shift+Z keyboard binding.

If you leave the default Shift+Z assignment in place, pressing Shift+Z may
trigger the simulator's own command and interfere with this add-on.

Tip: In Controls, search for the Shift+Z key combination (or use the input
search feature), then check the active keyboard control profile. Save the
updated profile before returning to the flight.

INSTALLATION
------------
1. Extract the downloaded archive.
2. Copy the entire "shift-z-continued" package folder into your MSFS 2024
   Community2024 folder. Keep the package's internal folder structure intact.
3. Start or restart Microsoft Flight Simulator 2024.
4. Enter a flight. This experiment attempts to load a blank overlay automatically;
   press Shift+Z to show it. Automatic loading still requires simulator validation.

USAGE
-----
EXPERIMENTAL WASM HOTKEY BUILD (experimental/wasm-hotkey)
With the simulator focused, press left or right Shift+Z from the initial blank view:

  1. Flight data (position, altitude, heading, airspeed and wind)
  2. Performance data (FPS, G-force, fuel percentage and sim rate)
  3. Combined flight and performance data
  4. Blank view

This build captures Shift+Z in WASM and forwards it to the panel over CommBus.
It is intended to work without panel focus; in-simulator validation is pending.
Panel registration attempts startup without a toolbar click, initially blank.
If automatic loading fails, this no-toolbar experiment cannot display the overlay.
There is no DOM keyboard fallback. If WASM hotkey registration fails, keyboard
cycling is unavailable but FPS remains available. Pauses may delay cycle messages.

NOTES / KNOWN LIMITATIONS
-------------------------
- This project is experimental and is still being tested in MSFS 2024.
- Panel positioning, mouse interaction and keyboard focus may require further
  adjustments.
- FPS may display "N/A" if the accompanying WASM module is unavailable.
- Automatic panel startup and the WASM hotkey are experimental and unverified in sim.
- Persistent visibility and user-configurable data fields are not yet available.
- VR and MSFS 2020 are not supported or tested.

UNINSTALLATION
--------------
Remove the "shift-z-continued" package folder from your Community2024 folder.
You can then restore your previous Shift+Z control assignment if desired.

ABOUT
-----
Shift Z Continued is an independent, open-source project inspired by the
classic Shift+Z flight information display. It is not affiliated with
Microsoft or Asobo Studio, and does not contain files from Shift+Z Stats.

Source code and issue tracker:
https://github.com/unnamedboy/msfs-shift-z-continued

License: MIT
