const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPanel(simVar) {
  const listeners = new Map();
  const text = {
    value: '', nodes: [],
    get textContent() { return this.value; },
    set textContent(value) { this.value = value; this.nodes = []; },
    appendChild(node) { this.nodes.push(node); this.value += node.className === 'degree-mark' ? '°' : node.textContent; },
  };
  let Panel, cleared;
  const events = new Map();
  class UIElement { connectedCallback() {} disconnectedCallback() {} querySelector() { return text; } }
  const context = {
    UIElement, SimVar: simVar, RegisterCommBusListener() { return { on(name, fn) { events.set(name, fn); }, off(name) { events.delete(name); } }; },
    document: {
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
      createElement() { return { className: '', setAttribute() {} }; },
      createTextNode(value) { return { textContent: value }; },
    },
    customElements: { define(name, type) { assert.equal(name, 'shift-z-continued'); Panel = type; } },
    setInterval() { return 42; }, clearInterval(id) { cleared = id; }, checkAutoload() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/html_ui/InGamePanels/ShiftZContinued/panel.js'), 'utf8'), context);
  const panel = new Panel(); panel.connectedCallback();
  return { panel, text, listeners, events, cleared: () => cleared };
}
const sim = {
  GetSimVarValue(name) { return { 'PLANE LATITUDE': 51.964833, 'PLANE LONGITUDE': 4.465667,
    'PLANE ALTITUDE': 635, 'PLANE HEADING DEGREES MAGNETIC': 72, 'AIRSPEED INDICATED': 85.6,
    'AMBIENT WIND DIRECTION': 2, 'MAGVAR': 5, 'AMBIENT WIND VELOCITY': 8,
    'FUEL TOTAL QUANTITY': 49, 'FUEL TOTAL CAPACITY': 100, 'G FORCE': 1 }[name]; },
  GetGlobalVarValue() { return 1; },
};
test('starts blank and cycles flight, performance, combined, off, and flight over the bus', () => {
  const { text, listeners, events } = createPanel(sim);
  events.get('SHIFT_Z_CONTINUED_FPS')('{"fps":38.2}');
  assert.equal(listeners.has('keydown'), false);
  const press = () => events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.equal(text.textContent, '');
  press();
  assert.match(text.textContent, /LAT: N51° 57\.89'  LON: E4° 27\.94'/);
  assert.equal(text.nodes.filter(node => node.className === 'degree-mark').length, 2);
  assert.match(text.textContent, /ALT: 635 FT MSL  Mag 72  85\.6 KIAS  WIND 357 Mag @ 8 kts\./);
  press(); assert.match(text.textContent, /FRAMES\/SEC = 38\.2  \+1\.0 Gs  FUEL 49 %  SIMRATE 1/);
  assert.doesNotMatch(text.textContent, /LAT:/);
  press(); assert.match(text.textContent, /^LAT:.*\nFRAMES\/SEC.*SIMRATE 1$/); assert.equal(text.textContent.split('\n').length, 2);
  press(); assert.equal(text.textContent, '');
  press(); assert.match(text.textContent, /LAT:/);
});
test('uses only the bus for cycling and removes both subscriptions on disconnect', () => {
  const { panel, listeners, events, cleared } = createPanel(sim);
  assert.equal(listeners.has('keydown'), false);
  assert.equal(events.size, 2);
  panel.disconnectedCallback();
  assert.equal(events.size, 0);
  assert.equal(listeners.has('keydown'), false); assert.equal(cleared(), 42);
});
test('FPS accepts valid simulator messages and ignores invalid or stale values', () => {
  const { panel, text, listeners, events } = createPanel(sim);
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
  panel.disconnectedCallback();
  assert.equal(events.has('SHIFT_Z_CONTINUED_FPS'), false);
});
test('unavailable data and FPS show placeholders', () => {
  const { text, events } = createPanel({ GetSimVarValue() { return 0; }, GetGlobalVarValue() { return 1; } });
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(text.textContent, /FRAMES\/SEC = N\/A/); assert.match(text.textContent, /FUEL N\/A %/);
  const missing = createPanel({ GetSimVarValue() { return NaN; }, GetGlobalVarValue() { throw Error(); } });
  missing.events.get('SHIFT_Z_CONTINUED_CYCLE')('{}');
  assert.match(missing.text.textContent, /LAT: N\/A/);
});
