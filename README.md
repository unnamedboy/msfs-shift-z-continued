# Shift Z Continued

Shift Z Continued is an open-source flight data overlay for Microsoft Flight Simulator 2024, inspired by the classic Shift+Z display. It shows flight and performance information directly over the simulator view.

## Installation

1. Download the installation ZIP and extract it.
2. Copy the `shift-z-continued` folder into your MSFS 2024 `Community2024` folder, keeping its contents together.
3. Start or restart MSFS 2024, enter a flight, and open **Shift Z Continued** from the in-game toolbar.

To uninstall, remove the `shift-z-continued` folder from `Community2024`.

## Using the overlay

With the panel open and receiving keyboard input, press **Shift+Z** to cycle through:

1. Flight data: latitude, longitude, altitude, magnetic heading, indicated airspeed and wind.
2. Performance data: frame rate, G-force, fuel percentage and simulation rate.
3. Both lines together.
4. A blank view.

If Shift+Z also triggers a simulator command, check the active control profile in MSFS and reassign or remove the conflicting binding. The shortcut is not global and does not open the panel automatically. Frame rate is read through a WASM module using SimConnect frame events; `N/A` indicates that a current value is unavailable.

The overlay is intended for MSFS 2024. Positioning and keyboard focus may vary with simulator settings; VR and MSFS 2020 have not been tested. Automatic panel startup, persistent visibility and configurable fields are not implemented.

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
