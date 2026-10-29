# Experimental WASM Shift+Z

Branch: `experimental/wasm-hotkey`.

## No-toolbar startup candidate

The installed MSFS 2024 `Propdefs/1.0/Common/propingamepanels.xml` defines `managedByToolbar` (default true), `DependsOnToolBarAction`, `ShowOnEvent`, `headerVisible`, `noBackground`, and `isPanelCloseable` as panel registration properties. This experiment sets `managedByToolbar=false` and `DependsOnToolBarAction=false`, removes the toolbar button and header, and requests showing on `CHAIN_MESSAGE_FLIGHT_END_LOADING`. JS starts in the blank view; the first cycle shows flight data. This is a hypothesis based on the shipped property schema and the flight-loading event described in the [MSFS 2024 panel discussion](https://devsupport.flightsimulator.com/t/custom-made-panels-not-generated/13134). Schema support is not proof of automatic instantiation or event delivery for a standalone package in Free Flight. If it fails, examine the registration lifecycle before adding a bootstrap service or aircraft dependencies.

No simulator installation or runtime test has been performed. The WASM compiled with the installed SDK; the full package build waited on the running simulator and was stopped. Its SPB output is not available. Do not distribute a package with the old toolbar SPB for this new XML.

The existing FPS module maps `VK_LSHIFT+z` and `VK_RSHIFT+z` with `SimConnect_MapInputEventToClientEvent_EX1`. Private down/up client events are added to a notification group, both group priorities are set, and the input group is enabled explicitly. The down event sends `SHIFT_Z_CONTINUED_CYCLE` to JS through CommBus; a held-key latch suppresses repeat down events until key-up. JS subscribes to that event instead of DOM keydown. No existing simulator bindings are masked. Registration failures clear partial mappings and leave FPS operational; asynchronous SimConnect exceptions are logged.

## Validation in MSFS 2024 (pending)

1. Build and install the experimental package, restart the simulator, and enter a flight without opening any toolbar panel. Press Shift+Z: flight data must appear. If nothing appears, distinguish failure to load the JS panel from failure to receive WASM input. Check the WASM console for `Experimental Shift+Z mappings registered` and any SimConnect exceptions. Successful registration alone does not prove delivery.
2. Click the cockpit or outside view so the panel has no keyboard focus. Press left Shift+Z four times: flight -> performance -> combined -> blank -> flight. Repeat with right Shift.
3. Focus the panel and repeat: each press must still advance exactly once. Hold the combination: it must not cycle repeatedly. Release and press again. Test releasing Z first, releasing Shift first, and switching between Shift keys; ensure no stuck latch.
4. Verify FPS updates while using the shortcut, including after cycling back from the blank view. Remove conflicting Shift+Z assignments in the active keyboard profile if the simulator also performs another action.
5. Pause, press/release the shortcut, and resume. Record delayed delivery: the SDK documents that WASM-to-JS messages can queue during pause. This experiment does not expire queued messages.
6. Confirm the blank view keeps the listener alive and the next press shows flight data again. No toolbar button or close button is provided by this startup experiment.
7. Return to the main menu, start another flight, and repeat the focus/hold tests. Test Alt+Tab while the combination is held to detect missing key-up events. Developer-mode package rebuilds should also be checked separately.

## Sources

- [EX1 mapping syntax and modifiers](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/api-reference/inputevents/simconnect_mapinputeventtoclientevent_ex1/).
- [Input groups default to inactive](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/api-reference/inputevents/simconnect_setinputgroupstate/).
- [Official developer confirms PC WASM support with notification groups](https://devsupport.flightsimulator.com/t/is-simconnect-mapinputeventtoclientevent-expected-to-work-on-xbox/17637).
- [JS Communication API and pause queue limitation](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/javascript/communication-api/).
