# Shift Z Continued

Shift Z Continued is an open-source flight data overlay for Microsoft Flight Simulator 2024, inspired by the classic Shift+Z display. It shows flight and performance information directly over the simulator view.

## Installation

1. Download the installation ZIP and extract it.
2. Copy the `shift-z-continued` folder into your MSFS 2024 `Community2024` folder, keeping its contents together.
3. Start or restart MSFS 2024 and enter a flight. The overlay loads by itself, without a toolbar button, and starts hidden.

To uninstall, remove the `shift-z-continued` folder from `Community2024`.

## Using the overlay

The overlay needs no toolbar button, and its keys work anywhere in the simulator through a WASM module. With the simulator focused, press **left or right Shift+Z** to cycle, as in FS9/FSX/P3D:

1. Line 1: latitude, longitude, altitude, magnetic heading, indicated airspeed and wind.
2. Both lines: line 1 plus frame rate, G-force, fuel percentage and simulation rate.
3. Off.

Press **Ctrl+Shift+Z** (either Ctrl and either Shift) to open configuration mode. The text gets a dashed outline and a settings card appears:

- Drag the text to move it anywhere on the screen.
- Click an item to show or hide it.
- Switch altitude between feet and metres, and speeds between knots and km/h.
- **Reset position** moves the text back to the top-left corner.
- **Change key** sets a different combination for cycling or for the settings: Shift, Ctrl or Alt (one or two) with a letter or digit, or F1-F12. While it waits for the keys the button reads **Cancel**; Esc cannot cancel because MSFS opens its pause menu.
- **Done** or the settings key again closes configuration mode.

When a press of either key also triggers a simulator command, the settings open by themselves with a warning that names the command. Remove that binding in the MSFS keyboard controls, choose another key with **Change key**, or press **Ignore**, which turns off conflict warnings for good, for both keys; the settings offer no way to turn them back on. Detection asks SimConnect to report about 1,500 documented simulator commands (all key events except axes, value setters, debug commands and names the sim rejects), watches which of them fire in the frames around the press, and skips commands that were already firing before it. The warning uses the SimConnect name (for example `AUTORUDDER_TOGGLE`); the MSFS controls may list the same command under a more readable name. Simulator actions that are not key events (some camera and UI actions) cannot be detected.

Settings are saved with the simulator's data storage and survive restarts. Outside configuration mode the overlay ignores the mouse, so clicks reach the cockpit.

The WASM module maps both shortcuts with SimConnect input events and sends `SHIFT_Z_CONTINUED_CYCLE` or `SHIFT_Z_CONTINUED_CONFIG` over CommBus to JS; it reports detected conflicts as `SHIFT_Z_CONTINUED_CONFLICT`, and the panel sends the player's keys back as `SHIFT_Z_CONTINUED_SET_KEYS`. `src/wasm/watched_commands.h` is generated from the key event tables of the MSFS 2024 SDK documentation with `python tools/gen_watched_commands.py`. If Ctrl+Shift+Z also fires the Shift+Z mapping, the panel treats messages within 250 ms of each other as one key press. Frame rate is read through the same WASM module using SimConnect frame events; `N/A` indicates that a current value is unavailable.

If WASM input registration fails, FPS continues but there is no keyboard fallback. Key presses while the MSFS pause menu is open are dropped. Development and simulator test notes: [docs/experimental-wasm-hotkey.md](docs/experimental-wasm-hotkey.md).

The overlay is intended for MSFS 2024. The panel registers as a click-through layer covering a 16:9 screen; on wider screens it may not reach the right edge (untested). VR and MSFS 2020 have not been tested. The view (line 1, both, off) is not remembered between flights.

## Build from source

You need Python 3, the MSFS 2024 SDK with its Visual Studio toolset, and Visual Studio C++ build tools. The SDK package tool also uses the installed simulator. Node.js is required for the JavaScript tests.

1. Copy `.env.example` to `.env` in the project root.
2. Set `MSFS2024_SDK` in `.env` to the SDK installation directory. `.env` is ignored by Git.
3. Run `python build.py`.

The build creates a temporary SDK project from `src`, compiles the panel and WASM module, and writes the Community package to `dist/shift-z-continued`. It does not install the package. Run `python package_release.py` after building to create `dist/shift-z-continued.zip` with the installation instructions. The `MSFS2024_SDK` environment variable takes precedence over `.env`; `--sdk` overrides both. Set `MSBUILD_EXE` if Visual Studio cannot be detected automatically.

## Tests

Run these commands from the project root:

```text
node --test tests/panel.test.js
python -m unittest discover -s tests
python tests/run_cpp_tests.py
```

The C++ test uses Visual Studio C++ build tools and simulator test doubles. These tests do not replace checking the package in MSFS.

## GitHub Actions

Pushes and pull requests targeting `develop` run tests on GitHub-hosted Windows. Pushes to `develop` and manual runs on that branch also build and upload `shift-z-continued.zip` when a compatible self-hosted runner is available. Download the ZIP from the workflow run's artifacts.

The packaging job requires a Windows x64 self-hosted runner with the custom label `msfs2024`, Python 3, Visual Studio C++ build tools, the MSFS 2024 SDK and an installed simulator. Set `MSFS2024_SDK` in the runner machine's environment and restart the runner after changing it; `MSBUILD_EXE` is optional. Register and start the runner through the repository's **Settings > Actions > Runners** page. Without an online matching runner, the packaging job remains queued while the hosted tests can still run.

The self-hosted packaging job runs trusted `develop` code and is skipped for pull requests. Restrict who can push to the branch and modify workflows, since those changes can execute code on the runner. Keep local paths and the SDK out of the repository.

## License

MIT. This independent project is not affiliated with Microsoft or Asobo Studio and does not include files from Shift+Z Stats.
