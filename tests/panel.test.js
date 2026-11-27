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
// storageReady: the sim's data storage answers at once. readyEvent: it then also fires dataStorageReady.
// keysConfirmed: start as if WASM had already confirmed the saved keys, so conflict reports are shown.
function createPanel(simVar, stored = null, { storageReady = true, readyEvent = storageReady, keysConfirmed = true } = {}) {
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
  vm.createContext(context);
  for (const file of ['hotkeys.js', 'panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'), context, { filename: file });
  }
  const panel = new Panel(); panel.connectedCallback();
  if (readyEvent) docListeners.get('dataStorageReady')();
  panel.keysConfirmed = keysConfirmed;
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
  // Answers the newest key request (or the given id) the way the WASM module does.
  const reply = (result, id = Number(/^id=(\d+);/.exec(wasmCalls.at(-1)[1])[1])) =>
    events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')(JSON.stringify({ id, result }));
  return { panel, text, root, config, docListeners, events, saved, button, find, key, wasmCalls, context, reply,
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


const at = (x, y) => `translate(${x}px, ${y}px)`;
const comboTextOf = combo => `${[...combo.mods].join(',')}+${combo.key}`;
const changeKeyButton = (find, index = 0) => find('config-key')[index].children.find(child => child.textContent === 'Change key');

test('stored settings choose fields, metric units and position', () => {
  const stored = JSON.stringify({ x: 40, y: 500, altitudeUnit: 'm', speedUnit: 'kmh',
    fields: { lat: false, lon: false, hdg: false, fps: false, g: false, fuel: false, simrate: false } });
  const { text, events } = createPanel(sim, stored);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent, 'ALT: 194 M MSL  158.5 KM/H IAS  WIND 357 Mag @ 15 km/h.');
  assert.equal(text.style.transform, at(400, 460), 'a stored position below the screen is shown at the bottom edge');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent.includes('\n'), false, 'an empty second line adds no line break');
});

test('corrupt or foreign stored settings fall back to defaults per key', () => {
  for (const stored of ['{broken', '"text"', JSON.stringify({ x: 'a', speedUnit: 'mph', fields: { lat: 'no' } })]) {
    const { text, events } = createPanel(sim, stored);
    events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
    assert.match(text.textContent, /^LAT: .* FT MSL .* KIAS/);
    assert.equal(text.style.transform, at(10, 3));
  }
});

test('the two keys never suppress each other, however close together', () => {
  const { panel, root, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":1}');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":2}');
  assert.equal(panel.view, 1); assert.equal(root.classList.contains('config-mode'), true);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":3}');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":4}');
  assert.equal(panel.view, 2); assert.equal(root.classList.contains('config-mode'), false);
});

test('the keys work while the saved keys are still being sent', () => {
  const { panel, events, busReady, wasmCalls } = createPanel(sim, JSON.stringify({ x: 30 }));
  busReady();
  assert.equal(wasmCalls.length, 1);
  assert.equal(panel.keyRequest.kind, 'sync');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":1}');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":2}');
  assert.equal(panel.view, 1); assert.equal(panel.configMode, true);
});

test('closing the settings ends a capture and a drag and clears the message', () => {
  const { panel, text, docListeners, find, key, button, saved } = createPanel(sim, JSON.stringify({ x: 10, y: 10 }));
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(90, { ctrlKey: true, shiftKey: true });
  assert.match(find('config-message')[0].textContent, /already the settings key/);
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 200, clientY: 100 });
  button('Done').fire('click');
  assert.equal(panel.capturing, null);
  assert.equal(saved.at(-1).x, 20, 'the drag is saved where it was');
  docListeners.get('mousemove')({ clientX: 400, clientY: 100 });
  assert.equal(panel.settings.x, 20, 'and no longer follows the mouse');
  panel.setConfigMode(true);
  assert.equal(find('config-message')[0].textContent, '');
});

test('configuration mode previews both lines while off and drags the text within the screen', () => {
  const { panel, text, root, docListeners, saved, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  assert.equal(root.classList.contains('config-mode'), true);
  assert.match(text.textContent, /^LAT:.*\nFRAMES\/SEC/);
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 300, clientY: 200 });
  assert.equal(text.style.transform, at(210, 103));
  docListeners.get('mousemove')({ clientX: 5000, clientY: -900 });
  assert.equal(text.style.transform, at(800, 0), 'the whole text box stays inside the right edge');
  docListeners.get('mousemove')({ clientX: -5000, clientY: 5000 });
  assert.equal(text.style.transform, at(0, 460), 'the whole text box stays above the bottom edge');
  docListeners.get('mouseup')({});
  assert.deepEqual([saved.at(-1).x, saved.at(-1).y], [0, 92]);
  docListeners.get('mousemove')({ clientX: 300, clientY: 300 });
  assert.equal(text.style.transform, at(0, 460), 'moving after release does not drag');
  panel.setConfigMode(false);
  assert.equal(text.textContent, '', 'leaving configuration returns to the off view');
});

test('the text stays on screen when it grows, the screen shrinks or it is wider than the screen', () => {
  const { panel, text, root } = createPanel(sim, JSON.stringify({ x: 80, y: 92 }));
  panel.render();
  assert.equal(text.style.transform, at(800, 460));
  text.getBoundingClientRect = () => ({ width: 300, height: 80 });  // longer values, more items, metric units
  panel.render();
  assert.equal(text.style.transform, at(700, 420));
  root.getBoundingClientRect = () => ({ width: 800, height: 400 });  // lower resolution
  panel.render();
  assert.equal(text.style.transform, at(500, 320));
  text.getBoundingClientRect = () => ({ width: 900, height: 450 });  // larger than the panel
  panel.render();
  assert.equal(text.style.transform, at(0, 0));
  assert.equal(panel.settings.x, 80, 'the chosen position is kept for when the text fits again');
});

test('a drag starts from where the text is shown, not from a position held back at the edge', () => {
  const { panel, text, docListeners } = createPanel(sim, JSON.stringify({ x: 80, y: 0.5 }));
  text.getBoundingClientRect = () => ({ width: 300, height: 40 });
  panel.setConfigMode(true);
  assert.equal(text.style.transform, at(700, 3));
  text.fire('mousedown', { button: 0, clientX: 500, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 480, clientY: 100 });
  assert.equal(text.style.transform, at(680, 3));
});

test('mousedown outside configuration mode does nothing', () => {
  const { text, docListeners } = createPanel(sim);
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 300, clientY: 200 });
  assert.equal(text.style.transform, at(10, 3));
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
  assert.equal(text.style.transform, at(10, 3)); assert.equal(saved.at(-1).y, 0.5);
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
  assert.equal(text.style.transform, at(300, 3));
  assert.equal(saved.length, 0, 'loading does not write settings back');
});

test('nothing done before the saved settings are readable can replace them', () => {
  const stored = JSON.stringify({ speedUnit: 'kmh', ignoreConflicts: true,
    keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, text, events, storageReady, button, saved, wasmCalls, busReady, find, key } =
    createPanel(sim, stored, { storageReady: false, keysConfirmed: false });
  busReady();
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  button('Altitude: feet').fire('click');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');  // closing the card saves nothing
  assert.equal(panel.configMode, false);
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  assert.equal(panel.capturing, null, 'no key change before the saved keys are known');
  assert.match(find('config-message')[0].textContent, /still loading/);
  const waited = createPanel(sim, null, { readyEvent: false });
  waited.panel.setConfigMode(true);
  changeKeyButton(waited.find).fire('click');
  assert.match(waited.find('config-message')[0].textContent, /still loading/);
  waited.panel.connectedAt -= 6000;
  waited.panel.render();
  assert.equal(waited.find('config-message')[0].textContent, '', 'the notice goes once the settings count as known');
  key(80, { ctrlKey: true });
  assert.equal(wasmCalls.length, 0);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  assert.equal(panel.conflict, null, 'a report cannot be named or checked against Ignore yet: dropped');
  storageReady();
  assert.equal(saved.length, 0);
  assert.match(text.textContent, /KM\/H IAS/);
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'alt+X');
  assert.equal(panel.settings.ignoreConflicts, true);
  assert.match(wasmCalls.at(-1)[1], /;watch=0;cycle=VK_LMENU\+X/, 'WASM gets the saved keys and watch setting');
});

test('key combinations expand to the same SimConnect strings the WASM module uses by default', () => {
  const { context } = createPanel(sim);
  const run = code => vm.runInContext(code, context);
  const defaults = 'cycle=VK_LSHIFT+Z|VK_LSHIFT+z|VK_RSHIFT+Z|VK_RSHIFT+z;'
    + 'config=VK_LCONTROL+VK_LSHIFT+Z|VK_LCONTROL+VK_LSHIFT+z|VK_LCONTROL+VK_RSHIFT+Z|VK_LCONTROL+VK_RSHIFT+z|'
    + 'VK_RCONTROL+VK_LSHIFT+Z|VK_RCONTROL+VK_LSHIFT+z|VK_RCONTROL+VK_RSHIFT+Z|VK_RCONTROL+VK_RSHIFT+z';
  assert.equal(run('keyRequestText(7, DEFAULT_HOTKEYS, true)'), `id=7;watch=1;${defaults}`);
  assert.equal(run('keyRequestText(8, DEFAULT_HOTKEYS, false)'), `id=8;watch=0;${defaults}`);
  const wasmSource = fs.readFileSync(path.join(__dirname, '../src/wasm/fps.cpp'), 'utf8');
  const wasmDefault = [...wasmSource.matchAll(/^\s+"([^"]*)"\s*$|kDefaultKeys\[\] =\s*$|^\s+"([^"]*)";$/gm)]
    .map(match => match[1] || match[2] || '').join('');
  assert.equal(wasmDefault, defaults, 'panel and WASM defaults agree');
  assert.equal(run("comboDefinitions({ mods: [], key: 'F9' }).join('|')"), 'VK_F9');
  assert.equal(run("comboDefinitions({ mods: ['alt'], key: '5' }).join('|')"), 'VK_LMENU+5|VK_RMENU+5');
  assert.equal(run("comboText(normalizeCombo({ mods: ['shift', 'ctrl'], key: 'x' }))"), 'Ctrl+Shift+X');
  for (const bad of ["{ mods: [], key: 'Z' }", "{ mods: ['ctrl', 'alt', 'shift'], key: 'Z' }", "{ mods: ['win'], key: 'Z' }",
    "{ mods: ['shift', 'shift'], key: 'Z' }", "{ mods: ['shift'], key: 'F13' }", "{ mods: ['shift'], key: '' }", 'null']) {
    assert.equal(run(`normalizeCombo(${bad})`), null, bad);
  }
  for (const file of ['hotkeys.js', 'panel.js']) {
    const source = fs.readFileSync(path.join(PANEL_DIR, file), 'utf8');
    assert.doesNotMatch(source, /\.flatMap\(|\.flat\(/, `${file}: Coherent GT has no flat/flatMap`);
  }
});

test('the saved keys and the watch setting are sent once the bus and the saved settings are ready', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } },
    ignoreConflicts: true });
  const late = createPanel(sim, stored, { storageReady: false });
  late.busReady();
  assert.equal(late.wasmCalls.length, 0, 'no defaults are sent before the saved settings are known');
  late.storageReady();
  assert.equal(late.wasmCalls.at(-1)[0], 'SHIFT_Z_CONTINUED_SET_KEYS');
  assert.equal(late.wasmCalls.at(-1)[1], 'id=1;watch=0;cycle=VK_LMENU+X|VK_LMENU+x|VK_RMENU+X|VK_RMENU+x;config=VK_F9');
  assert.equal(late.wasmCalls.length, 1);

  const early = createPanel(sim, stored);
  early.busReady();
  assert.match(early.wasmCalls.at(-1)[1], /^id=1;watch=0;cycle=VK_LMENU\+X/, 'readable at once: sent at once');

  const empty = createPanel(sim, null, { readyEvent: false });
  empty.busReady();
  empty.panel.setConfigMode(true);
  empty.button('Latitude').fire('click');
  assert.equal(empty.wasmCalls.length, 0);
  assert.equal(empty.saved.length, 0);
  empty.panel.connectedAt -= 6000;  // the storage never reported ready
  empty.panel.render();
  assert.match(empty.wasmCalls.at(-1)[1], /^id=1;watch=1;cycle=VK_LSHIFT\+Z/);
  assert.equal(empty.saved.at(-1).fields.lat, false, 'the earlier change is saved now');
  empty.button('Longitude').fire('click');
  assert.deepEqual([empty.saved.at(-1).fields.lat, empty.saved.at(-1).fields.lon], [false, false]);

  // The storage attaches even later and is still empty: what was chosen meanwhile is written to it.
  const attached = createPanel(sim, null, { storageReady: false });
  attached.panel.connectedAt -= 6000;
  attached.panel.setConfigMode(true);
  attached.button('Latitude').fire('click');
  assert.equal(attached.saved.length, 0, 'the write did not reach the storage');
  attached.storageReady();
  assert.equal(attached.saved.at(-1).fields.lat, false);
});

test('an unconfirmed sync is sent again after a pause, three times at most', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const wait = panel => {  // three seconds pass without an answer
    if (panel.keyRequest) panel.keyRequest.sentAt -= 4000;
    panel.syncSentAt -= 4000;
    panel.render();
  };

  const silent = createPanel(sim, stored);
  silent.busReady();
  wait(silent.panel);
  assert.equal(silent.wasmCalls.length, 2, 'sent again');
  silent.reply('applied');
  assert.equal(silent.panel.message, '');
  assert.equal(silent.panel.syncTries, 0);
  for (let i = 0; i < 6; i++) wait(silent.panel);
  assert.equal(silent.wasmCalls.length, 2, 'confirmed: nothing more is sent');

  const dead = createPanel(sim, stored);
  dead.busReady();
  for (let i = 0; i < 6; i++) wait(dead.panel);
  assert.equal(dead.wasmCalls.length, 3);
  assert.ok(dead.wasmCalls.every(call => /cycle=VK_LMENU\+X/.test(call[1])), 'no answer is not a rejection: no defaults');
  const notice = dead.find('config-message')[0];
  assert.match(notice.textContent, /did not confirm the saved keys/);
  changeKeyButton(dead.find).fire('click');  // start and cancel a capture
  changeKeyButton(dead.find, 1).fire('click');
  dead.find('config-key')[1].children.find(child => child.textContent === 'Cancel').fire('click');
  assert.match(notice.textContent, /did not confirm the saved keys/, 'the notice stays while the keys are unconfirmed');
  dead.panel.requestSync();
  dead.panel.render();
  dead.reply('applied');
  assert.equal(notice.textContent, '', 'a later confirmed sync removes the notice');

  // A call that throws is no rejection either, and is not repeated at once.
  const throwing = createPanel(sim, stored);
  let calls = 0;
  throwing.panel.commBus.callWasm = () => { calls += 1; throw new Error('no bus'); };
  throwing.busReady();
  assert.equal(calls, 1);
  assert.equal(throwing.panel.keyRequest, null, 'the failed call is finished at once, not left to time out');
  assert.equal(throwing.panel.syncTries, 1);
  for (let i = 0; i < 6; i++) wait(throwing.panel);
  assert.equal(calls, 3);
  assert.equal(comboTextOf(throwing.panel.settings.keys.cycle), 'alt+X');

  // WASM rejecting the saved keys and the defaults: each of the three attempts is followed by the defaults.
  const rejecting = createPanel(sim, stored);
  rejecting.busReady();
  for (let i = 0; i < 16; i++) {
    if (rejecting.panel.keyRequest) rejecting.reply('failed');
    else wait(rejecting.panel);
  }
  assert.deepEqual(rejecting.wasmCalls.map(call => /cycle=VK_LMENU/.test(call[1]) ? 'saved' : 'defaults'),
    ['saved', 'defaults', 'saved', 'defaults', 'saved', 'defaults']);
  assert.match(rejecting.find('config-message')[0].textContent, /did not confirm the saved keys/);

  // A key change that WASM confirms settles everything: the notice goes and nothing more is sent.
  const recovered = createPanel(sim, stored);
  recovered.busReady();
  for (let i = 0; i < 6; i++) wait(recovered.panel);
  recovered.panel.setConfigMode(true);
  changeKeyButton(recovered.find).fire('click');
  recovered.key(80, { ctrlKey: true });
  const sends = recovered.wasmCalls.length;
  recovered.reply('applied');
  for (let i = 0; i < 3; i++) wait(recovered.panel);
  assert.equal(recovered.wasmCalls.length, sends);
  assert.equal(recovered.find('config-message')[0].textContent, '');
  assert.equal(recovered.find('config-key-text')[0].textContent, 'Cycle key: Ctrl+P');

  // A key change that is not answered after that starts the attempts again, and the notice wins over its message.
  rejecting.panel.setConfigMode(true);
  changeKeyButton(rejecting.find).fire('click');
  rejecting.key(80, { ctrlKey: true });
  rejecting.panel.keyRequest.sentAt -= 4000;
  rejecting.panel.render();
  assert.match(rejecting.find('config-message')[0].textContent, /did not confirm the new key/);
  assert.match(rejecting.wasmCalls.at(-1)[1], /cycle=VK_LMENU/, 'the saved keys are sent again');
  for (let i = 0; i < 6; i++) wait(rejecting.panel);
  assert.match(rejecting.find('config-message')[0].textContent, /did not confirm the saved keys/);
  assert.equal(comboTextOf(rejecting.panel.settings.keys.cycle), 'alt+X');
});

test('an invalid answer is a rejection, and a late failure of an older call does not end a newer request', async () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const invalid = createPanel(sim, stored);
  invalid.busReady();
  invalid.reply('invalid');
  assert.match(invalid.wasmCalls.at(-1)[1], /cycle=VK_LSHIFT\+Z/, 'the defaults are tried');
  assert.equal(comboTextOf(invalid.panel.settings.keys.cycle), 'alt+X');

  const { panel, busReady, find, key } = createPanel(sim, stored);
  const rejects = [];
  panel.commBus.callWasm = () => new Promise((resolve, reject) => rejects.push(reject));
  busReady();  // the sync call stays open
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(80, { ctrlKey: true });  // a newer request
  const newer = panel.keyRequest;
  rejects[0](new Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.keyRequest, newer);
  assert.equal(find('config-message')[0].textContent, 'Applying the new key...');
});

test('a rejected key change that replaced an unanswered send of the saved keys sends them again', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, busReady, find, key, wasmCalls, reply } = createPanel(sim, stored, { keysConfirmed: false });
  busReady();  // the saved keys are on their way
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(80, { ctrlKey: true });
  reply('failed');  // WASM is back on what it last confirmed, which is not Alt+X
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LMENU\+X/);
  assert.equal(wasmCalls.length, 3);
  reply('applied');
  assert.equal(panel.keysConfirmed, true);
  assert.match(find('config-message')[0].textContent, /did not accept the new key/);
});

test('a rejected callWasm promise counts as an unconfirmed attempt', async () => {
  const { panel, busReady } = createPanel(sim, JSON.stringify({ x: 30 }));
  let calls = 0;
  panel.commBus.callWasm = () => { calls += 1; return Promise.reject(new Error('no bus')); };
  busReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(panel.keyRequest, null);
  assert.equal(panel.syncTries, 1);
});

test('the sync waits for the bus object when its ready callback runs early', () => {
  const { panel, wasmCalls, busReady, find, key } = createPanel(sim, JSON.stringify({ x: 30 }));
  const bus = panel.commBus;
  panel.commBus = null;  // as if RegisterCommBusListener called back before it returned
  busReady();
  assert.equal(wasmCalls.length, 0);
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(88, { altKey: true });
  assert.match(find('config-message')[0].textContent, /not connected; the key was not changed/);
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
  panel.commBus = bus;
  panel.render();
  assert.equal(wasmCalls.length, 1);
});

test('a late storage event without other keys or watch setting sends nothing again', () => {
  const same = createPanel(sim, JSON.stringify({ x: 40 }), { storageReady: false });
  same.panel.connectedAt -= 6000;  // the defaults were taken as the settings and sent
  same.busReady();
  same.reply('applied');
  same.storageReady();
  assert.equal(same.wasmCalls.length, 1);
  assert.equal(same.panel.settings.x, 40, 'the saved position is still taken over');
  assert.equal(same.panel.keysConfirmed, true);

  // The same, but the first send is still unanswered: it is dropped with the old settings and sent again.
  const pending = createPanel(sim, JSON.stringify({ x: 40 }), { storageReady: false, keysConfirmed: false });
  pending.panel.connectedAt -= 6000;
  pending.busReady();
  pending.storageReady();
  assert.equal(pending.wasmCalls.length, 2);
  pending.reply('applied');
  assert.equal(pending.panel.keysConfirmed, true);

  const empty = createPanel(sim, null, { storageReady: false });
  empty.panel.connectedAt -= 6000;
  empty.busReady();
  empty.reply('applied');
  empty.storageReady();
  assert.equal(empty.wasmCalls.length, 1);
});

test('capturing the combination a key already has changes nothing, and its press does not act', () => {
  const { panel, events, find, key, wasmCalls, saved } = createPanel(sim, JSON.stringify({ x: 30 }));
  panel.setConfigMode(true);
  changeKeyButton(find, 1).fire('click');
  key(90, { ctrlKey: true, shiftKey: true });
  assert.equal(find('config-message')[0].textContent, 'Ctrl+Shift+Z is already the settings key.');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":1}');  // WASM saw the same press
  assert.equal(panel.configMode, true);
  assert.equal(panel.capturing, 'config');
  assert.equal(wasmCalls.length, 0);
  assert.equal(saved.length, 0);
});

test('a storage event after the settings were readable changes nothing', () => {
  const stored = JSON.stringify({ x: 30 });
  const { panel, find, key, wasmCalls, busReady, reply, storageReady } = createPanel(sim, stored, { readyEvent: false });
  busReady();
  reply('applied');
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(88, { altKey: true });
  const calls = wasmCalls.length;
  storageReady();
  assert.equal(wasmCalls.length, calls);
  reply('applied');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'alt+X');
});

test('a defaults request that is not answered sends the saved keys again', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, wasmCalls, busReady, reply } = createPanel(sim, stored);
  busReady();
  reply('failed');
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LSHIFT\+Z/);
  panel.keyRequest.sentAt -= 4000;
  panel.syncSentAt -= 4000;
  panel.render();
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LMENU\+X/, 'WASM may have applied the defaults late');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'alt+X');
});

test('stored keys that are invalid or identical fall back to the defaults', () => {
  for (const keys of [{ cycle: { mods: [], key: 'Z' }, config: { mods: ['alt'], key: 'Z' } },
    { cycle: { mods: ['alt'], key: 'Z' }, config: { mods: ['alt'], key: 'z' } }, 'Shift+Z']) {
    const { panel } = createPanel(sim, JSON.stringify({ keys }));
    assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
    assert.equal(comboTextOf(panel.settings.keys.config), 'ctrl,shift+Z');
  }
});

test('a new key is saved only after the WASM module confirms it', () => {
  const { panel, events, find, key, wasmCalls, saved, reply } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":1}');
  changeKeyButton(find).fire('click');
  assert.match(find('config-message')[0].textContent, /also reach MSFS/);
  key(16, { shiftKey: true });
  assert.equal(panel.capturing, 'cycle', 'a modifier alone keeps waiting');
  key(88);
  assert.match(find('config-message')[0].textContent, /^Use Shift, Ctrl or Alt/);
  key(90, { ctrlKey: true, shiftKey: true });
  assert.match(find('config-message')[0].textContent, /already the settings key/);
  const savedBefore = saved.length;
  key(88, { altKey: true });
  assert.equal(panel.capturing, null);
  assert.match(wasmCalls.at(-1)[1], /^id=\d+;watch=1;cycle=VK_LMENU\+X/);
  assert.equal(saved.length, savedBefore, 'nothing saved before the answer');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
  assert.equal(find('config-message')[0].textContent, 'Applying the new key...');
  // The pressed keys also reach the old mappings in WASM; those messages belong to the capture.
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":2}');
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":3}');
  assert.equal(panel.view, 0); assert.equal(panel.configMode, true);
  reply('applied');
  assert.equal(find('config-key-text')[0].textContent, 'Cycle key: Alt+X');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1).keys.cycle)), { mods: ['alt'], key: 'X' });
  assert.equal(find('config-message')[0].textContent, '');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":4}');
  assert.equal(panel.view, 1, 'presses after the answer work at once');
});

test('a rejected or unanswered key change keeps the previous keys; stale answers are ignored', () => {
  const { panel, find, key, wasmCalls, saved, reply, busReady } = createPanel(sim);
  busReady();
  reply('applied');
  panel.setConfigMode(true);
  const change = () => {
    changeKeyButton(find).fire('click');
    key(80, { ctrlKey: true });
    return Number(/^id=(\d+);/.exec(wasmCalls.at(-1)[1])[1]);
  };
  const first = change();
  changeKeyButton(find).fire('click');
  assert.equal(panel.capturing, null, 'no second change while the first is waiting');
  reply('applied', first - 1);
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z', 'an answer with another id changes nothing');
  reply('failed', first);
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
  assert.match(find('config-message')[0].textContent, /did not accept the new key; the previous keys stay in use/);
  assert.equal(saved.filter(entry => entry.keys.cycle.mods.includes('ctrl')).length, 0);

  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LCONTROL\+P/, 'WASM restored the keys itself: nothing is sent again');
  assert.equal(panel.keyRequest, null);
  assert.equal(panel.keysConfirmed, true);

  change();
  panel.keyRequest.sentAt -= 4000;  // no answer within the time limit
  panel.render();
  assert.match(find('config-message')[0].textContent, /did not confirm the new key; the previous keys stay in use/);
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LSHIFT\+Z/, 'the saved keys are sent again in case WASM applied the new ones');
  reply('applied');
  assert.match(find('config-message')[0].textContent, /did not confirm the new key/, 'the answer to that resend keeps the message');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
});

test('saved keys the WASM module rejects at start are replaced by the defaults', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, wasmCalls, busReady, reply, saved } = createPanel(sim, stored);
  busReady();
  reply('failed');
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LSHIFT\+Z/);
  reply('applied');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
  assert.equal(comboTextOf(saved.at(-1).keys.cycle), 'shift+Z');
  assert.match(panel.message, /default keys are back/);
});

test('a report before the saved settings are known does not open the settings', () => {
  const { panel, events, root } = createPanel(sim, null, { storageReady: false, keysConfirmed: false });
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), false);
  assert.equal(panel.conflict, null);
});

test('a report is dropped while the pressed key is uncertain', () => {
  const report = '{"key":"cycle","press":9,"commands":["SLEW_TOGGLE"]}';
  const changing = createPanel(sim, JSON.stringify({ x: 30 }));
  changing.panel.setConfigMode(true);
  changeKeyButton(changing.find).fire('click');
  changing.key(88, { altKey: true });  // waiting for its answer: WASM may already use Alt+X
  changing.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(changing.panel.conflict, null);

  // The saved keys were sent but not confirmed yet; once they are, reports are shown.
  const sending = createPanel(sim, JSON.stringify({ x: 30 }), { keysConfirmed: false });
  sending.busReady();
  sending.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(sending.panel.conflict, null);
  sending.reply('applied');
  sending.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(sending.panel.conflict.key, 'cycle');

  // An unanswered key change leaves WASM's keys uncertain until the saved keys are confirmed again;
  // a rejected one does not, because WASM put the previous keys back.
  const unanswered = createPanel(sim, JSON.stringify({ x: 30 }));
  unanswered.panel.setConfigMode(true);
  changeKeyButton(unanswered.find).fire('click');
  unanswered.key(88, { altKey: true });
  unanswered.panel.keyRequest.sentAt -= 4000;
  unanswered.panel.render();
  unanswered.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(unanswered.panel.conflict, null);
  const rejected = createPanel(sim, JSON.stringify({ x: 30 }));
  rejected.panel.setConfigMode(true);
  changeKeyButton(rejected.find).fire('click');
  rejected.key(88, { altKey: true });
  rejected.reply('failed');
  rejected.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(rejected.panel.conflict.key, 'cycle');

  const unconfirmed = createPanel(sim, JSON.stringify({ x: 30 }));
  unconfirmed.busReady();
  for (let i = 0; i < 6; i++) {
    if (unconfirmed.panel.keyRequest) unconfirmed.panel.keyRequest.sentAt -= 4000;
    unconfirmed.panel.syncSentAt -= 4000;
    unconfirmed.panel.render();
  }
  unconfirmed.events.get('SHIFT_Z_CONTINUED_CONFLICT')(report);
  assert.equal(unconfirmed.root.classList.contains('config-mode'), false);
});

test('a possible conflict opens the settings with the command names', () => {
  const { find, events, root } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE",99,"","AUTORUDDER_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), true);
  assert.equal(find('config-warning')[0].style.display, 'block');
  assert.equal(find('config-warning-text')[0].textContent,
    'Shift+Z may also trigger SLEW_TOGGLE, AUTORUDDER_TOGGLE in MSFS: they ran right after the key press. If so, '
    + 'remove that binding in the MSFS keyboard controls, change the key below, or press Ignore to stop all key '
    + 'conflict warnings.');
});

test('the warning names the current key, and a change of the other key keeps it', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, events, find, key, reply } = createPanel(sim, stored);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  assert.match(find('config-warning-text')[0].textContent, /^Alt\+X may also trigger SLEW_TOGGLE in MSFS: it ran/);
  changeKeyButton(find, 1).fire('click');
  key(119);  // F8 for the settings key
  reply('applied');
  assert.equal(find('config-key-text')[1].textContent, 'Settings key: F8');
  assert.equal(find('config-warning')[0].style.display, 'block');
  assert.equal(panel.conflict.key, 'cycle');
});

test('a press swallowed by a key capture still counts for late reports', () => {
  const { panel, events, find, button, root } = createPanel(sim, JSON.stringify({ x: 30 }));
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":5}');
  assert.equal(panel.view, 0);
  button('Done').fire('click');
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":5,"commands":["SLEW_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), false);
});

test('a late report for a press made before the settings were closed does not open them again', () => {
  const { panel, events, root } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":5}');  // open
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{"press":6}');  // close
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"config","press":6,"commands":["PAUSE_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), false);
  assert.equal(panel.conflict, null);
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{"press":7}');
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":7,"commands":["SLEW_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), true, 'a later press is reported');
});

test('a key change clears the warning for that key once it is confirmed', () => {
  const { panel, events, find, key, reply } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  changeKeyButton(find).fire('click');
  key(88, { altKey: true });
  assert.equal(find('config-warning')[0].style.display, 'block', 'still shown until the new key is confirmed');
  reply('applied');
  assert.equal(find('config-warning')[0].style.display, 'none');
  assert.equal(panel.conflict, null);
});

test('Ignore turns off conflict warnings for good and stops the watch in the WASM module', () => {
  const { panel, root, find, events, saved, wasmCalls, busReady, reply, key } = createPanel(sim);
  busReady();
  reply('applied');
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  find('config-warning')[0].children.find(child => child.textContent === 'Ignore').fire('click');
  assert.equal(find('config-warning')[0].style.display, 'none');
  assert.equal(saved.at(-1).ignoreConflicts, true);
  assert.match(wasmCalls.at(-1)[1], /^id=\d+;watch=0;/);
  reply('applied');
  assert.equal(panel.keysConfirmed, true);
  panel.setConfigMode(false);
  events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"config","press":9,"commands":["PAUSE_TOGGLE"]}');
  assert.equal(root.classList.contains('config-mode'), false);
  const later = createPanel(sim, JSON.stringify(saved.at(-1)));
  later.busReady();
  assert.match(later.wasmCalls.at(-1)[1], /^id=1;watch=0;/, 'the watch stays off after a restart');

  // Ignore pressed while a key change waits: the change is not replaced, the watch stops afterwards.
  const busy = createPanel(sim);
  busy.busReady();
  busy.reply('applied');
  busy.events.get('SHIFT_Z_CONTINUED_CONFLICT')('{"key":"cycle","press":1,"commands":["SLEW_TOGGLE"]}');
  changeKeyButton(busy.find).fire('click');
  busy.key(88, { altKey: true });
  const change = busy.wasmCalls.at(-1)[1];
  busy.find('config-warning')[0].children.find(child => child.textContent === 'Ignore').fire('click');
  assert.equal(busy.wasmCalls.at(-1)[1], change);
  busy.reply('applied');
  assert.equal(comboTextOf(busy.panel.settings.keys.cycle), 'alt+X');
  assert.match(busy.wasmCalls.at(-1)[1], /;watch=0;cycle=VK_LMENU\+X/);
});

test('malformed messages from the WASM module are ignored', () => {
  const { panel, root, events } = createPanel(sim);
  for (const payload of ['{bad', '{"key":"other","press":1,"commands":["A"]}', '{"key":"cycle","press":1,"commands":[]}',
    '{"key":"cycle","press":1,"commands":[1,""]}', '{"key":"cycle"}', 'null']) {
    events.get('SHIFT_Z_CONTINUED_CONFLICT')(payload);
  }
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{bad');
  events.get('SHIFT_Z_CONTINUED_KEYS_STATUS')('{"id":99,"result":"applied"}');
  assert.equal(root.classList.contains('config-mode'), false);
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'shift+Z');
});

test('Change key and Cancel also act on mousedown, without a second toggle from the click', () => {
  const { panel, events, find, key } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_CONFIG')('{}');
  const cycleButton = changeKeyButton(find);
  cycleButton.fire('mousedown', { button: 0 });
  assert.equal(panel.capturing, 'cycle');
  cycleButton.fire('click');
  assert.equal(panel.capturing, 'cycle', 'the click after the mousedown is skipped, however long the button was held');
  cycleButton.fire('click');
  assert.equal(panel.capturing, null, 'a click without a mousedown acts');
  cycleButton.fire('mousedown', { button: 0 });
  cycleButton.fire('click');
  assert.equal(panel.capturing, 'cycle');
  assert.equal(cycleButton.textContent, 'Cancel');
  cycleButton.fire('mousedown', { button: 2 });
  assert.equal(panel.capturing, 'cycle', 'right button does nothing');
  cycleButton.fire('mousedown', { button: 0 });
  assert.equal(panel.capturing, null, 'Cancel on mousedown');
  assert.equal(cycleButton.textContent, 'Change key');
  panel.toggleCapture('config');
  assert.equal(panel.capturing, 'config');
  key(27);
  assert.equal(panel.capturing, null, 'Esc cancels if it reaches the panel');
});

test('saved settings that arrive late end a drag and clear the message; an armed capture stays armed', () => {
  const stored = JSON.stringify({ x: 50, y: 50 });
  const { panel, text, docListeners, find, key, storageReady, saved } = createPanel(sim, stored, { storageReady: false });
  panel.connectedAt -= 6000;
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(88);  // refused: shows the rules
  assert.equal(panel.capturing, 'cycle');
  text.fire('mousedown', { button: 0, clientX: 100, clientY: 100 });
  docListeners.get('mousemove')({ clientX: 160, clientY: 100 });
  storageReady();
  assert.equal(panel.capturing, 'cycle', 'so the message of a key press made just before is still swallowed');
  assert.equal(find('config-message')[0].textContent, 'The keys you press also reach MSFS this once.');
  docListeners.get('mousemove')({ clientX: 300, clientY: 100 });
  docListeners.get('mouseup')({});
  assert.equal(panel.settings.x, 50, 'the saved position is not dragged along');
  assert.equal(saved.length, 0);
});

test('saved settings that arrive late also drop a key change still waiting for its answer', () => {
  const stored = JSON.stringify({ keys: { cycle: { mods: ['alt'], key: 'X' }, config: { mods: [], key: 'F9' } } });
  const { panel, find, key, wasmCalls, busReady, reply, storageReady, saved } = createPanel(sim, stored, { storageReady: false });
  panel.connectedAt -= 6000;  // the storage stayed silent, so the defaults count as the settings
  busReady();
  reply('applied');
  panel.setConfigMode(true);
  changeKeyButton(find).fire('click');
  key(80, { ctrlKey: true });
  const waiting = Number(/^id=(\d+);/.exec(wasmCalls.at(-1)[1])[1]);
  storageReady();
  reply('applied', waiting);
  assert.equal(panel.keyRequest.kind, 'sync');
  assert.equal(comboTextOf(panel.settings.keys.cycle), 'alt+X');
  assert.equal(saved.length, 0, 'the saved keys were not overwritten');
  assert.match(wasmCalls.at(-1)[1], /cycle=VK_LMENU\+X/, 'and WASM gets them');
});
