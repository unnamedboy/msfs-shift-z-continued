SHIFT Z CONTINUED
=================

A classic Shift+Z-style flight data overlay for Microsoft Flight Simulator 2024.

Project: https://github.com/unnamedboy/msfs-shift-z-continued

KEY CONFLICTS
-------------
The default MSFS 2024 keyboard profile binds Shift+Z to Slew mode, and your
own profile may bind other commands to Shift+Z or Ctrl+Shift+Z.

When a key of this add-on also triggers a simulator command, its settings open
by themselves and name that command by its SimConnect name (for example
AUTORUDDER_TOGGLE; the MSFS controls may list it under a more readable
name). You can then remove the binding in the MSFS keyboard controls (and
save the profile), choose a different key with "Change key", or press
"Ignore" to keep both. After "Ignore" the add-on no longer warns about
key conflicts at all, and the settings offer no way to turn the warnings
back on. Some camera and menu actions are not visible to the add-on and
cannot be detected.

INSTALLATION
------------
1. Extract the downloaded archive.
2. Copy the entire "shift-z-continued" package folder into your MSFS 2024
   Community2024 folder. Keep the package's internal folder structure intact.
3. Start or restart Microsoft Flight Simulator 2024.
4. Enter a flight. The overlay loads by itself (no toolbar button) and starts
   hidden; press Shift+Z to show it.

USAGE
-----
EXPERIMENTAL WASM HOTKEY BUILD (experimental/wasm-hotkey)
With the simulator focused, press left or right Shift+Z to cycle, as in FSX:

  1. Line 1 (position, altitude, heading, airspeed and wind)
  2. Both lines (line 1 plus FPS, G-force, fuel percentage and sim rate)
  3. Off

Press Ctrl+Shift+Z to open the settings:

  - Drag the red text to move it anywhere on the screen.
  - Click an item to show or hide it.
  - Switch altitude between feet and metres, speed between knots and km/h.
  - "Reset position" returns the text to the top-left corner.
  - "Change key" sets another key for cycling or for the settings: Shift,
    Ctrl or Alt (one or two) with a letter or digit, or F1-F12.
  - "Done" or the settings key again closes the settings.

Settings are saved and survive restarts. Outside the settings the overlay
ignores the mouse, so cockpit clicks are not blocked.

Both shortcuts are captured in WASM and forwarded to the panel over CommBus,
so the overlay does not need keyboard focus. If automatic loading fails, this
no-toolbar build cannot display the overlay. If WASM hotkey registration
fails, keyboard control is unavailable but FPS remains available. Key presses
while the MSFS pause menu is open are dropped.

NOTES / KNOWN LIMITATIONS
-------------------------
- This project is experimental and is still being tested in MSFS 2024.
- FPS may display "N/A" if the accompanying WASM module is unavailable.
- Automatic panel startup and the WASM hotkeys work in MSFS 2024 tests but
  are still experimental.
- The current view (line 1, both, off) is not remembered between flights.
- The overlay area is sized for 16:9 screens; ultrawide screens are untested.
- VR and MSFS 2020 are not supported or tested.

UNINSTALLATION
--------------
Remove the "shift-z-continued" package folder from your Community2024 folder.
You can then restore your previous Shift+Z and Ctrl+Shift+Z control
assignments if desired.

ABOUT
-----
Shift Z Continued is an independent, open-source project inspired by the
classic Shift+Z flight information display. It is not affiliated with
Microsoft or Asobo Studio, and does not contain files from Shift+Z Stats.

Source code and issue tracker:
https://github.com/unnamedboy/msfs-shift-z-continued

License: MIT
