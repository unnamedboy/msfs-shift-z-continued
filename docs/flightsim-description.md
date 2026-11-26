# flightsim.to listing (v1.1)

Paste-ready text for https://flightsim.to/addon/117949/shift-z-continued.

## Listing settings to change

- **Compatibility:** untick **MSFS 2020**. The add-on is built and tested only for MSFS 2024.
- **File:** upload `shift-z-continued.zip` from the [1.1.0 release](https://github.com/unnamedboy/msfs-shift-z-continued/releases/tag/v1.1.0) and set the version to **1.1.0**.
- **Version history:** add the 1.1 entry below.

## Description

MSFS 2024 has no built-in version of the classic Shift+Z flight information overlay. Inspired by Shift+Z Stats, I made an independent, open-source take on it for MSFS 2024.

The overlay shows flight and performance information as red text over the simulator view, in the style of the classic Shift+Z display.

**Features**

- Latitude and longitude
- Altitude (feet or metres MSL), magnetic heading and indicated airspeed (knots or km/h)
- Wind direction (magnetic) and speed
- Frame rate (FPS)
- G-force
- Fuel remaining (percent of capacity)
- Simulation rate

**Using it**

- Press **Shift+Z** to cycle: line 1 (position, altitude, heading, airspeed, wind), both lines, off. No toolbar button and no clicking on the overlay first.
- Press **Ctrl+Shift+Z** to open the settings: drag the text anywhere on the screen, choose which items to show, switch feet/metres and knots/km/h, and change either key. Settings are saved.
- Outside the settings the overlay ignores the mouse, so cockpit clicks go through.

**Key conflicts**

The default MSFS 2024 keyboard profile binds Shift+Z to Slew mode, and your profile may bind other commands to these keys. When one of the add-on's keys also triggers a simulator command, the settings open by themselves and name that command. Remove the binding in the MSFS keyboard controls, choose another key, or press **Ignore** to turn these warnings off for good.

**Installation**

1. Extract the ZIP file.
2. Copy the `shift-z-continued` folder into your MSFS 2024 Community folder, keeping its contents together.
3. Start MSFS 2024 and enter a flight. The overlay starts hidden; press Shift+Z to show it.

To uninstall, delete the `shift-z-continued` folder from your Community folder.

**Known limitations**

- The overlay area is sized for 16:9 screens; ultrawide screens are untested.
- The warning shows the SimConnect command name (for example AUTORUDDER_TOGGLE), which can differ from the name in the MSFS controls.
- Ignore cannot be undone from the settings.
- Key presses while the MSFS pause menu is open are dropped.
- MSFS 2020 and VR are not supported.

**Open source**

Source code and issue tracker: https://github.com/unnamedboy/msfs-shift-z-continued

MIT license. This is an independent project, not affiliated with Microsoft, Asobo Studio or Shift+Z Stats, and it contains no files from Shift+Z Stats.

## Version history

**1.1.0**: The overlay loads by itself, without the toolbar. Shift+Z works anywhere in the simulator and cycles line 1, both lines, off. New settings (Ctrl+Shift+Z): move the text, choose items, metric units, change the keys. Warns when a key is also bound to a simulator command.

**1.0**: First release. Shift+Z cycling between flight data, performance data, both and a blank display. Opened from the in-game toolbar.
