const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(className = '') {
    this.className = className; this.value = ''; this.nodes = []; this.children = [];
    this.style = {}; this.handlers = new Map(); this.classes = new Set();
    this.classList = {
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
      contains: name => this.classes.has(name),
    };
  }
  get textContent() { return this.value; }
  set textContent(value) { this.value = value; this.nodes = []; }
  appendChild(node) {
    this.nodes.push(node); this.children.push(node);
    if (!(node instanceof FakeElement) || node.className === 'degree-mark') {
      this.value += node.className === 'degree-mark' ? '°' : node.textContent;
    }
    return node;
  }
  setAttribute() {}
  addEventListener(type, fn) { this.handlers.set(type, fn); }
  removeEventListener(type, fn) { if (this.handlers.get(type) === fn) this.handlers.delete(type); }
  fire(type, event = {}) { this.handlers.get(type)(event); }
}

const PANEL_DIR = path.join(__dirname, '../src/html_ui/InGamePanels/ShiftZContinued');
function createPanel(simVar, stored = null, { storageReady = true, commBus = true } = {}) {
  const storage = { ready: storageReady, value: stored };
  const docListeners = new Map();
  const root = new FakeElement();
  root.getBoundingClientRect = () => ({ width: 1000, height: 500 });
  const text = new FakeElement();
  text.getBoundingClientRect = () => ({ width: 200, height: 40 });
  const config = new FakeElement();
  const elements = { '#ShiftZContinued': root, '#stats': text, '#config': config };
  const saved = [];
  const wasmCalls = [];
  let Panel, cleared, busReady;
  const events = new Map();
  class UIElement { connectedCallback() {} disconnectedCallback() {} querySelector(selector) { return elements[selector]; } }
  const context = {
    UIElement, SimVar: simVar, window: { innerWidth: 1920, innerHeight: 1080 },
    GetStoredData(key) { assert.equal(key, 'SHIFT_Z_CONTINUED_SETTINGS'); return storage.ready ? storage.value : null; },
    SetStoredData(key, value) { if (storage.ready) { storage.value = value; saved.push(JSON.parse(value)); } },
    RegisterCommBusListener(ready) {
      busReady = ready;
      return { on(name, fn) { events.set(name, fn); }, off(name) { events.delete(name); },
        callWasm(name, text) { wasmCalls.push([name, text]); return Promise.resolve(); } };
    },
    document: {
      addEventListener(type, fn) { docListeners.set(type, fn); },
      removeEventListener(type, fn) { if (docListeners.get(type) === fn) docListeners.delete(type); },
      createElement() { return new FakeElement(); },
      createTextNode(value) { return { textContent: value }; },
    },
    customElements: { define(name, type) { assert.equal(name, 'shift-z-continued'); Panel = type; } },
    setInterval() { return 42; }, clearInterval(id) { cleared = id; }, checkAutoload() {},
  };
  if (!commBus) delete context.RegisterCommBusListener;
  vm.createContext(context);
  for (const file of ['hotkeys.js', 'panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'), context, { filename: file });
  }
  const panel = new Panel(); panel.connectedCallback();
  const button = label => {
    const all = [];
    const walk = element => { all.push(element); element.children.forEach(child => child instanceof FakeElement && walk(child)); };
    walk(config);
    return all.find(element => element.className.includes('config-button') && element.textContent.startsWith(label));
  };
  const makeStorageReady = () => { storage.ready = true; docListeners.get('dataStorageReady')(); };
  const find = className => {
    const all = [];
    const walk = element => { all.push(element); element.children.forEach(child => child instanceof FakeElement && walk(child)); };
    walk(config);
    return all.filter(element => element.className.split(' ').includes(className));
  };
  const key = (keyCode, mods = {}) => docListeners.get('keydown')(Object.assign({ keyCode, preventDefault() {} }, mods));
  return { panel, text, root, config, docListeners, events, saved, button, find, key, wasmCalls, context,
    busReady: () => busReady(), storageReady: makeStorageReady, cleared: () => cleared };
}
const sim = {
  GetSimVarValue(name) { return { 'PLANE LATITUDE': 51.964833, 'PLANE LONGITUDE': 4.465667,
    'PLANE ALTITUDE': 635, 'PLANE HEADING DEGREES MAGNETIC': 72, 'AIRSPEED INDICATED': 85.6,
    'AMBIENT WIND DIRECTION': 2, 'MAGVAR': 5, 'AMBIENT WIND VELOCITY': 8,
    'FUEL TOTAL QUANTITY': 49, 'FUEL TOTAL CAPACITY': 100, 'G FORCE': 1 }[name]; },
  GetGlobalVarValue() { return 1; },
};

test('starts off and cycles line 1, both lines, off over the bus like FSX', () => {
  const { text, docListeners, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_FPS')('{"fps":38.2}');
  docListeners.get('keydown')({ keyCode: 90, shiftKey: true });
  assert.equal(text.textContent, '', 'Shift+Z through the DOM does not cycle; WASM does');
  const press = () => events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent, '');
  press();
  assert.match(text.textContent, /^LAT: N51° 57\.89'  LON: E4° 27\.94'/);
  assert.equal(text.nodes.filter(node => node.className === 'degree-mark').length, 2);
  assert.match(text.textContent, /ALT: 635 FT MSL  Mag 72  85\.6 KIAS  WIND 357 Mag @ 8 kts\.$/);
  press(); assert.match(text.textContent, /^LAT:.*\nFRAMES\/SEC = 38\.2  \+1\.0 Gs  FUEL 49 %  SIMRATE 1$/);
  press(); assert.equal(text.textContent, '');
  press(); assert.match(text.textContent, /^LAT:[^\n]*$/);
});

test('removes all bus and mouse subscriptions on disconnect', () => {
  const { panel, docListeners, events, text, cleared } = createPanel(sim);
  assert.equal(events.size, 5);
  assert.ok(docListeners.has('mousemove') && docListeners.has('mouseup') && text.handlers.has('mousedown'));
  panel.disconnectedCallback();
  assert.equal(events.size, 0);
  assert.equal(docListeners.size, 0, 'mouse and storage listeners removed'); assert.equal(text.handlers.size, 0); assert.equal(cleared(), 42);
});

test('FPS accepts valid simulator messages and ignores invalid or stale values', () => {
  const { panel, text, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(text.textContent, /FRAMES\/SEC = N\/A/);
  const receive = events.get('SHIFT_Z_CONTINUED_FPS');
  receive('{"fps":57.25}'); panel.render();
  assert.match(text.textContent, /FRAMES\/SEC = 57\.3/);
  receive('{invalid'); receive('{"fps":-1}'); panel.render();
  assert.match(text.textContent, /FRAMES\/SEC = 57\.3/);
  panel.fpsUpdatedAt = Date.now() - 4000; panel.render();
  assert.match(text.textContent, /FRAMES\/SEC = N\/A/);
});

test('unavailable data and FPS show placeholders', () => {
  const { text, events } = createPanel({ GetSimVarValue() { return 0; }, GetGlobalVarValue() { return 1; } });
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(text.textContent, /FRAMES\/SEC = N\/A/); assert.match(text.textContent, /FUEL N\/A %/);
  const missing = createPanel({ GetSimVarValue() { return NaN; }, GetGlobalVarValue() { throw Error(); } });
  missing.events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(missing.text.textContent, /LAT: N\/A/);
  assert.match(missing.text.textContent, /ALT: N\/A FT MSL/);
});

test('stored settings choose fields, metric units and position', () => {
  const stored = JSON.stringify({ x: 40, y: 500, altitudeUnit: 'm', speedUnit: 'kmh',
    fields: { lat: false, lon: false, hdg: false, fps: false, g: false, fuel: false, simrate: false } });
  const { text, events } = createPanel(sim, stored);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent, 'ALT: 194 M MSL  158.5 KM/H IAS  WIND 357 Mag @ 15 km/h.');
  assert.equal(text.style.left, '40%'); assert.equal(text.style.top, '95%');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent.includes('\n'), false, 'an empty second line adds no line break');
});

test('corrupt or foreign stored settings fall back to defaults per key', () => {
  for (const stored of ['{broken', '"text"', JSON.stringify({ x: 'a', speedUnit: 'mph', fields: { lat: 'no' } })]) {
    const { text, events } = createPanel(sim, stored);
    events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
    assert.match(text.textContent, /^LAT: .* FT MSL .* KIAS/);
    assert.equal(text.style.left, '1%'); assert.equal(text.style.top, '0.5%');
  }
});

test('Ctrl+Shift+Z firing the Shift+Z mapping too toggles configuration only, in either order', () => {
  const { panel, root } = createPanel(sim);
  panel.onCycle(1000);
  assert.equal(panel.view, 1);
  panel.onCycle(5000); panel.onConfig(5100); // cycle first
  assert.equal(panel.view, 1); assert.equal(root.classList.contains('config-mode'), true);
  panel.onConfig(9000); panel.onCycle(9100); // config first
  assert.equal(panel.view, 1); assert.equal(root.classList.contains('config-mode'), false);
  panel.onCycle(9400);
  assert.equal(panel.view, 2, 'a separate press after the window still cycles');
});

test('configuration mode previews both lines while off and drags the text within the screen', () => {
  const { panel, text, root, docListeners, saved, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(root.classList.contains('config-mode'), true);
  assert.match(text.textContent, /^LAT:.*\nFRAMES\/SEC/);
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 300, clientY: 200 });
  assert.equal(text.style.left, '21%'); assert.equal(text.style.top, '20.5%');
  docListeners.get('mousemove')({ clientX: 5000, clientY: -900 });
  assert.equal(text.style.left, '80%', 'the whole text box stays inside the right edge'); assert.equal(text.style.top, '0%');
  docListeners.get('mousemove')({ clientX: -5000, clientY: 5000 });
  assert.equal(text.style.left, '0%'); assert.equal(text.style.top, '92%', 'the whole text box stays above the bottom edge');
  docListeners.get('mouseup')({});
  assert.deepEqual([saved.at(-1).x, saved.at(-1).y], [0, 92]);
  docListeners.get('mousemove')({ clientX: 300, clientY: 300 });
  assert.equal(text.style.left, '0%', 'moving after release does not drag');
  panel.onConfig(Date.now() + 1000);
  assert.equal(text.textContent, '', 'leaving configuration returns to the off view');
});

test('mousedown outside configuration mode does nothing', () => {
  const { text, docListeners } = createPanel(sim);
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 300, clientY: 200 });
  assert.equal(text.style.left, '1%');
});

test('settings card toggles fields and units, resets position and closes with Done', () => {
  const { text, root, events, saved, button } = createPanel(sim, JSON.stringify({ x: 50, y: 50 }));
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(button('Latitude').classList.contains('on'), true);
  button('Latitude').fire('click');
  assert.equal(button('Latitude').classList.contains('on'), false);
  assert.equal(saved.at(-1).fields.lat, false);
  assert.doesNotMatch(text.textContent, /LAT:/);
  button('Altitude: feet').fire('click');
  assert.equal(saved.at(-1).altitudeUnit, 'm'); assert.ok(button('Altitude: metres'));
  button('Speed: knots').fire('click');
  assert.equal(saved.at(-1).speedUnit, 'kmh'); assert.match(text.textContent, /KM\/H IAS/);
  button('Reset position').fire('click');
  assert.equal(text.style.left, '1%'); assert.equal(saved.at(-1).y, 0.5);
  button('Done').fire('click');
  assert.equal(root.classList.contains('config-mode'), false);
  assert.equal(text.textContent, '');
});

test('all items unchecked still leaves something to drag in configuration mode', () => {
  const fields = { lat: false, lon: false, alt: false, hdg: false, ias: false, wind: false, fps: false, g: false, fuel: false, simrate: false };
  const { text, events } = createPanel(sim, JSON.stringify({ fields }));
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(text.textContent, '(no items selected)');
});

test('settings stored by an earlier flight load once the sim data storage is ready', () => {
  const stored = JSON.stringify({ x: 30, altitudeUnit: 'm', fields: { lat: false } });
  const { text, events, storageReady, saved } = createPanel(sim, stored, { storageReady: false });
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(text.textContent, /^LAT:/, 'defaults until storage is ready');
  storageReady();
  assert.doesNotMatch(text.textContent, /LAT:/);
  assert.match(text.textContent, /ALT: 194 M MSL/);
  assert.equal(text.style.left, '30%');
  assert.equal(saved.length, 0, 'loading does not write settings back');
});

test('storage becoming ready does not discard changes made earlier in the flight', () => {
  const { text, events, storageReady, button } = createPanel(sim, JSON.stringify({ speedUnit: 'kmh' }), { storageReady: false });
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  button('Altitude: feet').fire('click');
  storageReady();
  assert.match(text.textContent, /M MSL/);
  assert.match(text.textContent, /KIAS/, 'the in-flight choice wins over the late stored value');
});

test('the right-edge limit uses the full text width even when the box shrinks at the edge', () => {
  const { text, docListeners, events } = createPanel(sim);
  // Like Coherent: an absolute box shrinks to the space left of it (losing a pixel to rounding at the edge),
  // while its content keeps its full width.
  text.scrollWidth = 200;
  text.getBoundingClientRect = () => {
    const space = 1000 - parseFloat(text.style.left) / 100 * 1000;
    return { width: space >= 201 ? 200 : Math.floor(space) - 1, height: 40 };
  };
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  for (let drag = 1; drag <= 3; drag++) {
    text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
    for (let move = 0; move < 20; move++) docListeners.get('mousemove')({ clientX: 5000, clientY: 100 });
    docListeners.get('mouseup')({});
    assert.equal(text.style.left, '80%', `drag ${drag} keeps the whole text inside`);
  }
});

test('key combinations expand to the same SimConnect strings the WASM module uses by default', () => {
  const { context } = createPanel(sim);
  const run = code => vm.runInContext(code, context);
  assert.equal(run('hotkeySetText(DEFAULT_HOTKEYS)'),
    'cycle=VK_LSHIFT+Z|VK_LSHIFT+z|VK_RSHIFT+Z|VK_RSHIFT+z;'
    + 'config=VK_LCONTROL+VK_LSHIFT+Z|VK_LCONTROL+VK_LSHIFT+z|VK_LCONTROL+VK_RSHIFT+Z|VK_LCONTROL+VK_RSHIFT+z|'
    + 'VK_RCONTROL+VK_LSHIFT+Z|VK_RCONTROL+VK_LSHIFT+z|VK_RCONTROL+VK_RSHIFT+Z|VK_RCONTROL+VK_RSHIFT+z');
  const wasmSource = fs.readFileSync(path.join(__dirname, '../src/wasm/fps.cpp'), 'utf8');
  const wasmDefault = [...wasmSource.matchAll(/^\s+"([^"]*)"\s*$|kDefaultKeys\[\] =\s*$|^\s+"([^"]*)";$/gm)]
    .map(match => match[1] || match[2] || '').join('');
  assert.equal(wasmDefault, run('hotkeySetText(DEFAULT_HOTKEYS)'), 'panel and WASM defaults agree');
  assert.equal(run("comboDefinitions({ mods: [], key: 'F9' }).join('|')"), 'VK_F9');
  for (const file of ['hotkeys.js', 'panel.js']) {
    const source = fs.readFileSync(path.join(PANEL_DIR, file), 'utf8');
    assert.doesNotMatch(source, /\.flatMap\(|\.flat\(/, `${file}: Coherent GT has no flat/flatMap`);
  }
  // The L:var codes match the ones tests/fps_test.cpp decodes.
  assert.equal(run('hotkeySetCode(DEFAULT_HOTKEYS, 6)'), (4 * 64 + 25) + (5 * 64 + 25) * 512 + 7 * 262144);
  assert.equal(run("hotkeySetCode({ cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } }, 999)"),
    (2 * 64 + 23) + 44 * 512 + 1000 * 262144);
  assert.equal(run("comboCode({ mods: ['ctrl'], key: '0' })"), 64 + 26);
  assert.equal(run("comboCode({ mods: ['ctrl', 'alt'], key: 'P' })"), 3 * 64 + 15);
  assert.equal(run("comboCode({ mods: [], key: 'F12' })"), 47);
  assert.equal(run("comboDefinitions({ mods: ['alt'], key: '5' }).join('|')"), 'VK_LMENU+5|VK_RMENU+5');
  assert.equal(run("comboText(normalizeCombo({ mods: ['shift', 'ctrl'], key: 'x' }))"), 'Ctrl+Shift+X');
  for (const bad of ["{ mods: [], key: 'Z' }", "{ mods: ['ctrl', 'alt', 'shift'], key: 'Z' }", "{ mods: ['win'], key: 'Z' }",
    "{ mods: ['shift', 'shift'], key: 'Z' }", "{ mods: ['shift'], key: 'F13' }", "{ mods: ['shift'], key: '' }", 'null']) {
    assert.equal(run(`normalizeCombo(${bad})`), null, bad);
  }
});

test('the player keys are sent to WASM when the bus and the stored settings are ready', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { wasmCalls, busReady, storageReady } = createPanel(sim, stored, { storageReady: false });
  busReady();
  assert.deepEqual(wasmCalls.at(-1)[0], 'SHIFT_Z_CONTINUED_SET_KEYS');
  assert.match(wasmCalls.at(-1)[1], /^cycle=VK_LSHIFT\+Z/, 'defaults before storage is ready');
  storageReady();
  assert.equal(wasmCalls.at(-1)[1], 'cycle=VK_LMENU+X|VK_LMENU+x|VK_RMENU+X|VK_RMENU+x;config=VK_F9');
});

test('stored keys that are invalid or identical fall back to the defaults', () => {
  for (const keys of [{ cycle: { mods: [], key: 'Z' }, config: { mods: ['alt'], key: 'Z' } },
    { cycle: { mods: ['alt'], key: 'Z' }, config: { mods: ['alt'], key: 'z' } }, 'Shift+Z']) {
    const { panel } = createPanel(sim, JSON.stringify({ keys }));
    assert.equal(panel.settings.keys.cycle.key, 'Z');
    assert.deepEqual([...panel.settings.keys.cycle.mods], ['shift']);
    assert.deepEqual([...panel.settings.keys.config.mods], ['ctrl', 'shift']);
  }
});

test('a conflict opens the settings with the command names; Ignore turns off all conflict warnings for good', () => {
  const { panel, root, find, events, saved } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","events":["SLEW_TOGGLE",99,"","AUTORUDDER_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), true);
  const warning = find('config-warning')[0];
  assert.equal(warning.style.display, 'block');
  assert.match(find('config-warning-text')[0].textContent, /^Shift\+Z also triggers SLEW_TOGGLE, AUTORUDDER_TOGGLE in MSFS\./);
  find('config-warning')[0].children.find(child => child.textContent === 'Ignore').fire('click');
  assert.equal(warning.style.display, 'none');
  assert.equal(saved.at(-1).ignoreConflicts, true);
  panel.setConfigMode(false);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","events":["SLEW_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), false, 'not reported again');
  const later = createPanel(sim, JSON.stringify(saved.at(-1)));
  later.events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","events":["SLEW_TOGGLE"]}');
  assert.equal(later.root.classList.contains('config-mode'), false, 'still ignored after a restart');
  later.events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"config","events":["PAUSE_TOGGLE"]}');
  assert.equal(later.root.classList.contains('config-mode'), false, 'the other key and other commands are not reported either');
  const fresh = createPanel(sim);
  fresh.events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"config","events":["PAUSE_TOGGLE"]}');
  assert.match(fresh.find('config-warning-text')[0].textContent,
    /^Ctrl\+Shift\+Z also triggers PAUSE_TOGGLE in MSFS\. .*or press Ignore to stop all key conflict warnings\.$/);
});

test('malformed conflict messages are ignored', () => {
  const { root, events } = createPanel(sim);
  for (const payload of ['{bad', '{"key":"other","events":["A"]}', '{"key":"cycle","events":[]}',
    '{"key":"cycle","events":[1,""]}', '{"key":"cycle"}', 'null']) {
    events.get('SHIFT_Z_CONTINUED_CONFLICT')(payload);
  }
  assert.equal(root.classList.contains('config-mode'), false);
});

test('Change key captures a new combination, sends it to WASM and clears that conflict', () => {
  const { panel, events, button, find, key, wasmCalls, saved } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","events":["SLEW_TOGGLE"]}');
  find('config-key')[0].children.find(child => child.textContent === 'Change key').fire('click');
  assert.match(find('config-key-text')[0].textContent, /press the new keys/);
  assert.match(find('config-message')[0].textContent, /also reach MSFS/);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(panel.configMode, true, 'hotkeys are ignored while capturing');
  assert.equal(panel.view, 0);
  key(16, { shiftKey: true });
  assert.equal(panel.capturing, 'cycle', 'a modifier alone keeps waiting');
  key(88);
  assert.match(find('config-message')[0].textContent, /^Use Shift, Ctrl or Alt/);
  key(90, { ctrlKey: true, shiftKey: true });
  assert.match(find('config-message')[0].textContent, /already the settings key/);
  key(88, { altKey: true });
  assert.equal(panel.capturing, null);
  const viewBefore = panel.view;
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(panel.view, viewBefore, 'a hotkey message arriving right after the capture is ignored');
  panel.onCycle(Date.now() + 1000);
  assert.equal(panel.view, (viewBefore + 1) % 3, 'later presses cycle again');
  assert.equal(find('config-key-text')[0].textContent, 'Cycle key: Alt+X');
  assert.equal(find('config-warning')[0].style.display, 'none');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1).keys.cycle)), { mods: ['alt'], key: 'X' });
  assert.equal(wasmCalls.at(-1)[1].split(';')[0], 'cycle=VK_LMENU+X|VK_LMENU+x|VK_RMENU+X|VK_RMENU+x');
  assert.match(find('config-hint')[0].textContent, /Ctrl\+Shift\+Z or Done/);
  const settingsButton = find('config-key')[1].children.find(child => child.textContent === 'Change key');
  settingsButton.fire('click');
  assert.equal(settingsButton.textContent, 'Cancel');
  settingsButton.fire('click');
  assert.equal(panel.capturing, null);
  assert.equal(settingsButton.textContent, 'Change key');
  assert.equal(find('config-key-text')[1].textContent, 'Settings key: Ctrl+Shift+Z', 'Cancel keeps the old key');
  settingsButton.fire('click');
  key(27);
  assert.equal(panel.capturing, null, 'Esc still cancels if it reaches the panel');
  button('Done').fire('click');
  assert.equal(panel.configMode, false);
});

test('the card shows which path delivered the keys to WASM', async () => {
  const lvarWrites = [];
  const simWithWrites = Object.assign({}, sim, {
    SetSimVarValue(name, unit, value) {
      lvarWrites.push([name, unit, value]);
      return Promise.reject([{ message: 'no such var' }]);
    },
  });
  const { panel, events, busReady, find } = createPanel(simWithWrites);
  busReady();
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(lvarWrites.at(-1)[0], 'L:SHIFT_Z_CONTINUED_KEYS');
  assert.equal(lvarWrites.at(-1)[1], 'number');
  assert.equal(lvarWrites.at(-1)[2] % 262144, (4 * 64 + 25) + (5 * 64 + 25) * 512);
  const link = find('config-link')[0];
  assert.equal(link.textContent, '', 'nothing to report while a path may still deliver');
  assert.equal(link.style.display, 'none');
  await new Promise(resolve => setImmediate(resolve));
  const sentAt = panel.keyLink.sentAt;
  assert.equal(panel.keyLinkText(sentAt + 1000), '', 'CommBus may still answer');
  assert.equal(panel.keyLinkText(sentAt + 3001),
    'The new keys did not reach the add-on (CommBus no reply, LVar call failed: [{"message":"no such var"}]).');
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{"via":"other","result":"applied"}');
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{bad');
  assert.match(panel.keyLinkText(sentAt + 3001), /^The new keys did not reach/, 'malformed statuses change nothing');
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{"via":"commbus","result":"applied"}');
  assert.equal(panel.keyLinkText(sentAt + 3001), '', 'one path applied is enough');
  const before = lvarWrites.at(-1)[2];
  panel.sendKeys(1000);
  assert.notEqual(lvarWrites.at(-1)[2], before, 'every send writes a new value');
  assert.equal(lvarWrites.at(-1)[2] % 262144, before % 262144);
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{"via":"commbus","result":"invalid"}');
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{"via":"lvar","result":"failed"}');
  assert.equal(link.textContent, 'The new keys did not reach the add-on (CommBus invalid, LVar failed).');
  assert.equal(link.style.display, 'block');
});

test('a send never repeats the value already in the L:var', () => {
  let stored = null;
  const writes = [];
  const lvarSim = Object.assign({}, sim, {
    GetSimVarValue(name, unit) { return name === 'L:SHIFT_Z_CONTINUED_KEYS' ? stored : sim.GetSimVarValue(name, unit); },
    SetSimVarValue(name, unit, value) { writes.push(value); stored = value; },
  });
  const { panel, context } = createPanel(lvarSim);
  const code = counter => context.hotkeySetCode(panel.settings.keys, counter);
  panel.keySendCount = 41;
  stored = code(42);
  panel.sendKeys();
  assert.equal(writes.at(-1), code(43), 'the counter skips the stored value');
  panel.sendKeys();
  assert.equal(writes.at(-1), code(44));
});

test('without CommBus the keys still go through the L:var', () => {
  const writes = [];
  const { panel } = createPanel(Object.assign({}, sim, { SetSimVarValue(name, unit, value) { writes.push(value); } }),
    null, { commBus: false });
  panel.sendKeys(0);
  assert.equal(writes.length, 1);
  assert.equal(panel.keyLink.commbus, 'unavailable');
  assert.equal(panel.keyLinkText(3001), 'The new keys did not reach the add-on (CommBus unavailable, LVar no reply).');
});

test('without SimVar.SetSimVarValue the L:var path shows as unavailable', () => {
  const { panel, events, busReady, find } = createPanel(sim);
  busReady();
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(find('config-link')[0].textContent, '');
  assert.equal(panel.keyLinkText(panel.keyLink.sentAt + 3001),
    'The new keys did not reach the add-on (CommBus no reply, LVar unavailable).');
});

test('Change key and Cancel also act on mousedown, without a second toggle from the click', () => {
  const { panel, events, find } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  const cycleButton = find('config-key')[0].children.find(child => child.textContent === 'Change key');
  cycleButton.fire('mousedown', { button: 0 });
  assert.equal(panel.capturing, 'cycle');
  cycleButton.fire('click');
  assert.equal(panel.capturing, 'cycle', 'the click after the mousedown is skipped');
  assert.equal(cycleButton.textContent, 'Cancel');
  cycleButton.fire('mousedown', { button: 2 });
  assert.equal(panel.capturing, 'cycle', 'right button does nothing');
  cycleButton.fire('mousedown', { button: 0 });
  assert.equal(panel.capturing, null, 'Cancel on mousedown');
  assert.equal(cycleButton.textContent, 'Change key');
});
