# flightsim.to listing (v1.0)

Paste-ready text for https://flightsim.to/addon/117949/shift-z-continued.

## Listing settings to change

- **Compatibility:** untick **MSFS 2020**. The add-on is built and tested only for MSFS 2024.
- **Version history:** add the 1.0 entry below (the page currently shows "No version history available").

## Description

MSFS 2024 has no built-in version of the classic Shift+Z flight information overlay. Inspired by Shift+Z Stats, I made an independent, open-source take on it for MSFS 2024.

The overlay shows flight and performance information as red text at the top of the screen, in the style of the classic Shift+Z display.

**Features**

- Latitude and longitude
- Altitude (feet MSL), magnetic heading and indicated airspeed (knots)
- Wind direction (magnetic) and speed (knots)
- Frame rate (FPS)
- G-force
- Fuel remaining (percent of capacity)
- Simulation rate

Press **Shift+Z** to cycle through flight information, performance information, both lines together, and a blank display.

**Installation**

1. Extract the ZIP file.
2. Copy the `shift-z-continued` folder into your MSFS 2024 Community folder, keeping its contents together.
3. Start MSFS 2024, enter a flight and open the overlay from the in-game toolbar.

**Important:** MSFS 2024 has its own Shift+Z key binding. Remove or reassign it in the simulator's control settings to avoid conflicts.

**Known limitations in 1.0**

- Shift+Z only works while the overlay has keyboard focus. It is not yet a global shortcut and does not open the overlay; use the toolbar for that.
- On some screen setups the start of each line can be cut off at the left edge of the screen. A fix is planned for the next version.
- Units are fixed (feet and knots). Metric units are on the list for a future update.
- MSFS 2020 and VR are not supported.

To uninstall, delete the `shift-z-continued` folder from your Community folder.

**Open source**

Source code and issue tracker: https://github.com/unnamedboy/msfs-shift-z-continued

MIT license. This is an independent project, not affiliated with Microsoft, Asobo Studio or Shift+Z Stats, and it contains no files from Shift+Z Stats.

## Version history

**1.0**: First release. Shift+Z cycling between flight data, performance data, both and a blank display. Opened from the in-game toolbar.
