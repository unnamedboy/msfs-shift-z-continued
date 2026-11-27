const UPDATE_INTERVAL_MS = 250;
const FPS_TIMEOUT_MS = 3000;
const KEYS_TIMEOUT_MS = 3000;
const STORAGE_WAIT_MS = 5000;
const MAX_SYNC_TRIES = 3;
const LOADING_TEXT = 'The saved settings are still loading; try again in a moment.';
const SYNC_FAILED_TEXT = 'The add-on did not confirm the saved keys; the default keys may be in use.';
const FPS_MESSAGE = 'SHIFT_Z_CONTINUED_FPS';
const CYCLE_MESSAGE = 'SHIFT_Z_CONTINUED_CYCLE';
const CONFIG_MESSAGE = 'SHIFT_Z_CONTINUED_CONFIG';
const CONFLICT_MESSAGE = 'SHIFT_Z_CONTINUED_CONFLICT';
const SET_KEYS_MESSAGE = 'SHIFT_Z_CONTINUED_SET_KEYS';
const KEYS_STATUS_MESSAGE = 'SHIFT_Z_CONTINUED_KEYS_STATUS';
const HOTKEY_LABELS = { cycle: 'Cycle key', config: 'Settings key' };
const SETTINGS_KEY = 'SHIFT_Z_CONTINUED_SETTINGS';
const VIEW = { OFF: 0, FLIGHT: 1, BOTH: 2, COUNT: 3 };
const FEET_TO_METRES = 0.3048;
const KNOTS_TO_KMH = 1.852;
const FIELDS = [
  { id: 'lat', label: 'Latitude' },
  { id: 'lon', label: 'Longitude' },
  { id: 'alt', label: 'Altitude' },
  { id: 'hdg', label: 'Magnetic heading' },
  { id: 'ias', label: 'Indicated airspeed' },
  { id: 'wind', label: 'Wind' },
  { id: 'fps', label: 'Frame rate' },
  { id: 'g', label: 'G-force' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'simrate', label: 'Simulation rate' },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Largest position (percent) that keeps a box fully inside the panel; 0 when the box is larger than the panel.
function maxPosition(boxSize, panelSize) {
  return panelSize > 0 ? Math.max(0, 100 - boxSize / panelSize * 100) : 0;
}

function defaultSettings() {
  const fields = {};
  FIELDS.forEach(field => { fields[field.id] = true; });
  return {
    x: 1, y: 0.5, fields, altitudeUnit: 'ft', speedUnit: 'kt',
    keys: { cycle: normalizeCombo(DEFAULT_HOTKEYS.cycle), config: normalizeCombo(DEFAULT_HOTKEYS.config) },
    ignoreConflicts: false,  // Ignore turns off all conflict warnings for good
  };
}

// Start from defaults and keep only stored values that are valid, so old or corrupt data cannot break the overlay.
function parseSettings(raw) {
  const settings = defaultSettings();
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (_) {
    return settings;
  }
  if (!stored || typeof stored !== 'object') return settings;
  if (Number.isFinite(stored.x)) settings.x = clamp(stored.x, 0, 100);
  if (Number.isFinite(stored.y)) settings.y = clamp(stored.y, 0, 100);
  if (stored.fields && typeof stored.fields === 'object') {
    FIELDS.forEach(field => {
      if (typeof stored.fields[field.id] === 'boolean') settings.fields[field.id] = stored.fields[field.id];
    });
  }
  if (stored.altitudeUnit === 'ft' || stored.altitudeUnit === 'm') settings.altitudeUnit = stored.altitudeUnit;
  if (stored.speedUnit === 'kt' || stored.speedUnit === 'kmh') settings.speedUnit = stored.speedUnit;
  if (stored.keys && typeof stored.keys === 'object') {
    const cycle = normalizeCombo(stored.keys.cycle);
    const config = normalizeCombo(stored.keys.config);
    if (cycle && config && !sameCombo(cycle, config)) settings.keys = { cycle, config };
  }
  if (typeof stored.ignoreConflicts === 'boolean') settings.ignoreConflicts = stored.ignoreConflicts;
  return settings;
}

function parseMessage(payload) {
  try {
    const message = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return message && typeof message === 'object' ? message : null;
  } catch (_) {
    return null;
  }
}

class ShiftZContinued extends UIElement {
  connectedCallback() {
    super.connectedCallback();
    this.rootElement = this.querySelector('#ShiftZContinued');
    this.statsElement = this.querySelector('#stats');
    this.configElement = this.querySelector('#config');
    this.view = VIEW.OFF;
    this.configMode = false;
    this.drag = null;
    this.fps = null;
    this.fpsUpdatedAt = 0;
    const stored = this.readStoredSettings();
    this.settings = parseSettings(stored);
    // Before dataStorageReady the saved settings can read as missing. Until they are known nothing is
    // saved, no key can be changed and nothing is sent to WASM, so defaults never replace the player's
    // keys, items or Ignore.
    this.storageLoaded = typeof stored === 'string' && stored.length > 0;
    this.connectedAt = Date.now();
    this.busConnected = false;
    this.synced = false;  // false: the saved keys and the watch setting still have to go to WASM
    this.syncTries = 0;   // sync attempts in a row that WASM did not confirm
    this.syncSentAt = 0;
    this.keysConfirmed = false;  // WASM answered "applied" for the keys in settings.keys
    this.unsaved = false;
    this.conflict = null;
    this.capturing = null;
    this.message = '';
    // settings.keys hold the keys the WASM module confirmed; a change waits in keyRequest until it answers.
    this.keyRequest = null;
    this.requestCount = 0;
    // Presses are numbered by the WASM module; a conflict report for a press made before the settings were
    // closed must not open them again.
    this.lastPress = 0;
    this.closedAfterPress = 0;

    this.onFps = payload => {
      const message = parseMessage(payload);
      if (message && Number.isFinite(message.fps) && message.fps > 0) {
        this.fps = message.fps;
        this.fpsUpdatedAt = Date.now();
      }
    };
    this.onCycleMessage = payload => this.onHotkey(payload, () => this.onCycle());
    this.onConfigMessage = payload => this.onHotkey(payload, () => this.setConfigMode(!this.configMode));
    this.onConflictMessage = payload => this.onConflict(payload);
    this.onKeysStatusMessage = payload => this.onKeysStatus(payload);
    this.onKeyDown = event => this.captureKey(event);
    this.onDragStart = event => this.startDrag(event);
    this.onDragMove = event => this.moveDrag(event);
    this.onDragEnd = () => this.endDrag();
    // The sim's data storage is only attached after this event. If the settings could not be read before,
    // what it holds replaces anything chosen meanwhile.
    this.onStorageReady = () => {
      if (this.storageLoaded) return;
      const saved = this.readStoredSettings();
      const sent = settings => JSON.stringify([settings.keys, settings.ignoreConflicts]);
      const before = sent(this.settings);
      const dropped = Boolean(this.keyRequest) && typeof saved === 'string' && saved.length > 0;
      if (typeof saved === 'string' && saved.length > 0) {
        this.settings = parseSettings(saved);
        this.keyRequest = null;  // an answer about the settings used so far must not touch the saved ones
        this.conflict = null;    // it named the keys shown before
        this.message = '';
        this.drag = null;
        this.unsaved = false;
      } else {
        this.unsaved = true;     // nothing saved yet: keep what was chosen meanwhile
      }
      this.storageLoaded = true;
      // WASM may hold what was sent before, or be working on a request that was just dropped.
      if (dropped || sent(this.settings) !== before) this.requestSync();
      this.render();
    };

    if (typeof RegisterCommBusListener === 'function') {
      // The WASM module keeps its current keys until the panel sends the player's keys.
      this.commBus = RegisterCommBusListener(() => {
        this.busConnected = true;
        this.render();
      });
      this.commBus.on(FPS_MESSAGE, this.onFps);
      this.commBus.on(CYCLE_MESSAGE, this.onCycleMessage);
      this.commBus.on(CONFIG_MESSAGE, this.onConfigMessage);
      this.commBus.on(CONFLICT_MESSAGE, this.onConflictMessage);
      this.commBus.on(KEYS_STATUS_MESSAGE, this.onKeysStatusMessage);
    }
    this.buildConfigCard();
    this.statsElement.addEventListener('mousedown', this.onDragStart);
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragEnd);
    document.addEventListener('dataStorageReady', this.onStorageReady);
    document.addEventListener('keydown', this.onKeyDown);
    this.updateTimer = setInterval(() => this.render(), UPDATE_INTERVAL_MS);
    this.render();
  }

  disconnectedCallback() {
    clearInterval(this.updateTimer);
    if (this.commBus && typeof this.commBus.off === 'function') {
      this.commBus.off(FPS_MESSAGE, this.onFps);
      this.commBus.off(CYCLE_MESSAGE, this.onCycleMessage);
      this.commBus.off(CONFIG_MESSAGE, this.onConfigMessage);
      this.commBus.off(CONFLICT_MESSAGE, this.onConflictMessage);
      this.commBus.off(KEYS_STATUS_MESSAGE, this.onKeysStatusMessage);
    }
    this.commBus = null;
    if (this.statsElement) this.statsElement.removeEventListener('mousedown', this.onDragStart);
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragEnd);
    document.removeEventListener('dataStorageReady', this.onStorageReady);
    document.removeEventListener('keydown', this.onKeyDown);
    super.disconnectedCallback();
  }

  readStoredSettings() {
    try {
      return typeof GetStoredData === 'function' ? GetStoredData(SETTINGS_KEY) : null;
    } catch (_) {
      return null;
    }
  }

  // If the storage never reports ready (it was ready before this panel existed and holds nothing yet),
  // the settings in use count as the saved ones after a short wait.
  settingsKnown() {
    return this.storageLoaded || Date.now() - this.connectedAt >= STORAGE_WAIT_MS;
  }

  requestSync() {
    this.synced = false;
    this.syncTries = 0;
    this.keysConfirmed = false;
  }

  // Sends the saved keys and the watch setting when they are known and no other request is waiting.
  // An unconfirmed attempt is repeated after a pause; after MAX_SYNC_TRIES it stops until something asks
  // for a sync again.
  syncWhenReady() {
    if (this.synced || !this.busConnected || this.keyRequest || !this.settingsKnown()) return;
    if (this.syncTries >= MAX_SYNC_TRIES) return;
    if (this.syncTries > 0 && Date.now() - this.syncSentAt < KEYS_TIMEOUT_MS) return;
    this.syncSentAt = Date.now();
    this.synced = true;
    if (!this.sendKeys(this.settings.keys, 'sync')) this.synced = false;
  }

  // A change made before the saved settings are known is written once they are.
  saveSettings() {
    this.unsaved = !this.settingsKnown();
    if (this.unsaved) return;
    try {
      if (typeof SetStoredData === 'function') SetStoredData(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (_) {
      // Settings still apply for this session.
    }
  }

  // kind: 'user' for a key the player just chose, 'sync' to (re)send the saved keys and the watch setting,
  // 'defaults' when the saved keys did not work. Only the newest request is answered.
  // Returns false when there is no bus to send on.
  sendKeys(keys, kind) {
    if (!this.commBus || typeof this.commBus.callWasm !== 'function') return false;
    const request = { id: ++this.requestCount, keys, kind, watch: !this.settings.ignoreConflicts, sentAt: Date.now() };
    this.keyRequest = request;
    // A call that fails says nothing about the keys, so it counts like a missing answer.
    const fail = () => {
      if (this.keyRequest === request) this.finishKeys('timeout');
    };
    try {
      const result = this.commBus.callWasm(SET_KEYS_MESSAGE,
        keyRequestText(request.id, keys, request.watch));
      if (result && typeof result.catch === 'function') result.catch(fail);
    } catch (_) {
      fail();
    }
    return true;
  }

  onKeysStatus(payload) {
    const message = parseMessage(payload);
    if (!message || !this.keyRequest || message.id !== this.keyRequest.id) return;
    this.finishKeys(message.result === 'applied' ? 'applied' : 'failed');
  }

  finishKeys(result) {
    const request = this.keyRequest;
    this.keyRequest = null;
    if (result === 'applied') {
      this.keysConfirmed = true;
      this.syncTries = 0;
      // WASM now holds these keys; nothing more to send unless Ignore changed the watch setting meanwhile.
      this.synced = request.watch === !this.settings.ignoreConflicts;
      if (request.kind !== 'sync') {
        Object.keys(HOTKEY_LABELS).forEach(key => {
          if (this.conflict && this.conflict.key === key && !sameCombo(request.keys[key], this.settings.keys[key])) {
            this.conflict = null;
          }
        });
        this.settings.keys = request.keys;
        this.saveSettings();
        this.message = request.kind === 'user' ? '' : 'The saved keys did not work in MSFS; the default keys are back.';
      }
    } else if (request.kind === 'user' && result === 'failed') {
      // WASM has put back the keys it last confirmed. Those are the saved keys, unless this change
      // replaced a send of the saved keys that was still unanswered.
      this.message = 'MSFS did not accept the new key; the previous keys stay in use.';
      if (!this.keysConfirmed) this.requestSync();
    } else if (request.kind === 'user') {
      this.message = 'The add-on did not confirm the new key; the previous keys stay in use.';
      this.requestSync();  // WASM may apply the key after all (a late answer), so it gets the saved keys again
    } else {
      // The saved keys were not confirmed: try the defaults when WASM rejected them, otherwise send again.
      this.keysConfirmed = false;
      if (request.kind === 'sync') this.syncTries += 1;
      if (request.kind === 'sync' && result === 'failed') this.sendKeys(defaultSettings().keys, 'defaults');
      else this.synced = false;
    }
    this.render();
  }

  onHotkey(payload, action) {
    const message = parseMessage(payload);
    if (message && Number.isInteger(message.press)) this.lastPress = Math.max(this.lastPress, message.press);
    // While a key is captured, or the captured key is not confirmed yet, the pressed keys belong to the capture.
    if (this.capturing || (this.keyRequest && this.keyRequest.kind === 'user')) return;
    action();
  }

  onCycle() {
    this.view = (this.view + 1) % VIEW.COUNT;
    this.render();
  }

  // The WASM module saw simulator commands fire right after one of our keys.
  onConflict(payload) {
    const message = parseMessage(payload);
    // A report is only shown when the keys in the settings are the ones WASM confirmed and no key change
    // is waiting; otherwise the key that was pressed is not known.
    if (!this.keysConfirmed || this.settings.ignoreConflicts) return;
    if (this.keyRequest && this.keyRequest.kind === 'user') return;
    if (!message || !HOTKEY_LABELS[message.key] || !Array.isArray(message.commands)) return;
    const commands = message.commands.filter(name => typeof name === 'string' && name.length > 0);
    if (!commands.length) return;
    if (!this.configMode && Number.isInteger(message.press) && message.press <= this.closedAfterPress) return;
    this.conflict = { key: message.key, text: comboText(this.settings.keys[message.key]), commands };
    if (this.configMode) this.render();
    else this.setConfigMode(true);
  }

  ignoreConflicts() {
    this.settings.ignoreConflicts = true;
    this.conflict = null;
    this.saveSettings();
    this.requestSync();  // the sync also stops the watch in the WASM module
    this.render();
  }

  // The same button starts and cancels a capture (Esc cannot: MSFS opens its pause menu on Esc).
  toggleCapture(key) {
    if (this.keyRequest && this.keyRequest.kind === 'user') return;  // one change at a time
    if (!this.settingsKnown()) {
      this.message = LOADING_TEXT;
    } else {
      this.capturing = this.capturing === key ? null : key;
      this.message = '';
    }
    this.render();
  }

  captureKey(event) {
    if (!this.capturing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const candidate = comboFromKeyEvent(event);
    if (!candidate) return;
    if (candidate.cancel) {
      this.capturing = null;
      this.render();
      return;
    }
    const combo = normalizeCombo(candidate);
    const other = this.capturing === 'cycle' ? 'config' : 'cycle';
    if (!combo) {
      this.message = HOTKEY_RULES;
    } else if (sameCombo(combo, this.settings.keys[other]) || sameCombo(combo, this.settings.keys[this.capturing])) {
      // The capture stays armed: WASM also saw this press of a mapped key, and its message must not act.
      const owner = sameCombo(combo, this.settings.keys[other]) ? other : this.capturing;
      this.message = `${comboText(combo)} is already the ${HOTKEY_LABELS[owner].toLowerCase()}.`;
    } else {
      const keys = Object.assign({}, this.settings.keys, { [this.capturing]: combo });
      this.capturing = null;
      this.message = '';
      if (!this.sendKeys(keys, 'user')) this.message = 'The add-on is not connected; the key was not changed.';
    }
    this.render();
  }

  setConfigMode(enabled) {
    this.configMode = enabled;
    if (!enabled) {
      this.endDrag();
      this.capturing = null;
      this.message = '';
      this.closedAfterPress = this.lastPress;
    }
    if (this.rootElement) this.rootElement.classList.toggle('config-mode', enabled);
    this.render();
  }

  buildConfigCard() {
    const card = this.configElement;
    if (!card) return;
    const addElement = (parent, tag, className, text) => {
      const element = document.createElement(tag);
      element.className = className;
      if (text !== undefined) element.textContent = text;
      parent.appendChild(element);
      return element;
    };
    // In the sim a click on the Change key/Cancel button did not always arrive while a capture was armed,
    // so those buttons act on mousedown; the click that belongs to that mousedown is skipped.
    const addButton = (parent, text, action, onPress = false) => {
      const button = addElement(parent, 'div', 'config-button', text);
      let pressed = false;
      if (onPress) {
        button.addEventListener('mousedown', event => {
          if (event && event.button > 0) return;
          pressed = true;
          action();
        });
      }
      button.addEventListener('click', () => {
        if (!pressed) action();
        pressed = false;
      });
      return button;
    };

    addElement(card, 'div', 'config-title', 'Shift Z Continued');
    this.warningElement = addElement(card, 'div', 'config-warning');
    this.warningText = addElement(this.warningElement, 'div', 'config-warning-text');
    addButton(this.warningElement, 'Ignore', () => this.ignoreConflicts());
    this.hintElement = addElement(card, 'div', 'config-hint');
    const list = addElement(card, 'div', 'config-fields');
    this.fieldToggles = {};
    FIELDS.forEach(field => {
      this.fieldToggles[field.id] = addButton(list, field.label, () => {
        this.settings.fields[field.id] = !this.settings.fields[field.id];
        this.saveSettings();
        this.render();
      });
    });
    const units = addElement(card, 'div', 'config-row');
    this.altitudeToggle = addButton(units, '', () => {
      this.settings.altitudeUnit = this.settings.altitudeUnit === 'ft' ? 'm' : 'ft';
      this.saveSettings();
      this.render();
    });
    this.speedToggle = addButton(units, '', () => {
      this.settings.speedUnit = this.settings.speedUnit === 'kt' ? 'kmh' : 'kt';
      this.saveSettings();
      this.render();
    });
    this.keyRows = {};
    this.keyButtons = {};
    Object.keys(HOTKEY_LABELS).forEach(key => {
      const row = addElement(card, 'div', 'config-row config-key');
      this.keyRows[key] = addElement(row, 'div', 'config-key-text');
      this.keyButtons[key] = addButton(row, 'Change key', () => this.toggleCapture(key), true);
    });
    this.messageElement = addElement(card, 'div', 'config-message');
    const actions = addElement(card, 'div', 'config-row');
    addButton(actions, 'Reset position', () => {
      const defaults = defaultSettings();
      this.settings.x = defaults.x;
      this.settings.y = defaults.y;
      this.saveSettings();
      this.render();
    });
    addButton(actions, 'Done', () => this.setConfigMode(false));
  }

  updateConfigCard() {
    if (!this.fieldToggles) return;
    FIELDS.forEach(field => {
      this.fieldToggles[field.id].classList.toggle('on', this.settings.fields[field.id]);
    });
    this.altitudeToggle.textContent = `Altitude: ${this.settings.altitudeUnit === 'ft' ? 'feet' : 'metres'}`;
    this.speedToggle.textContent = `Speed: ${this.settings.speedUnit === 'kt' ? 'knots' : 'km/h'}`;
    if (this.message === LOADING_TEXT && this.settingsKnown()) this.message = '';
    const request = this.keyRequest && this.keyRequest.kind === 'user' ? this.keyRequest : null;
    const keys = request ? request.keys : this.settings.keys;
    this.hintElement.textContent = `Drag the red text to move it. ${comboText(this.settings.keys.config)} or Done to close.`;
    Object.keys(this.keyRows).forEach(key => {
      const capturing = this.capturing === key;
      this.keyRows[key].textContent = capturing
        ? `${HOTKEY_LABELS[key]}: press the new keys`
        : `${HOTKEY_LABELS[key]}: ${comboText(keys[key])}`;
      this.keyButtons[key].textContent = capturing ? 'Cancel' : 'Change key';
    });
    this.messageElement.textContent = this.capturing
      ? (this.message || 'The keys you press also reach MSFS this once.')
      : request ? 'Applying the new key...'
        : this.syncTries >= MAX_SYNC_TRIES ? SYNC_FAILED_TEXT : this.message;
    this.warningElement.style.display = this.conflict ? 'block' : 'none';
    if (this.conflict) {
      const { text, commands } = this.conflict;
      this.warningText.textContent = `${text} may also trigger ${commands.join(', ')} in MSFS: `
        + `${commands.length > 1 ? 'they' : 'it'} ran right after the key press. If so, remove that binding in the `
        + 'MSFS keyboard controls, change the key below, or press Ignore to stop all key conflict warnings.';
    }
  }

  panelSize() {
    const rect = this.rootElement && typeof this.rootElement.getBoundingClientRect === 'function'
      ? this.rootElement.getBoundingClientRect() : null;
    return {
      width: rect && rect.width > 0 ? rect.width : window.innerWidth,
      height: rect && rect.height > 0 ? rect.height : window.innerHeight,
    };
  }

  textSize() {
    const rect = typeof this.statsElement.getBoundingClientRect === 'function'
      ? this.statsElement.getBoundingClientRect() : null;
    return { width: rect ? rect.width : 0, height: rect ? rect.height : 0 };
  }

  startDrag(event) {
    if (!this.configMode || event.button > 0) return;
    const shown = this.shownPosition();
    this.drag = { mouseX: event.clientX, mouseY: event.clientY, x: shown.x, y: shown.y };
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  moveDrag(event) {
    if (!this.drag) return;
    const panel = this.panelSize();
    if (!(panel.width > 0) || !(panel.height > 0)) return;
    const text = this.textSize();
    this.settings.x = clamp(this.drag.x + (event.clientX - this.drag.mouseX) / panel.width * 100,
                            0, maxPosition(text.width, panel.width));
    this.settings.y = clamp(this.drag.y + (event.clientY - this.drag.mouseY) / panel.height * 100,
                            0, maxPosition(text.height, panel.height));
    this.applyPosition();
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.saveSettings();
  }

  // The text sits at the panel's top-left corner and is moved with a transform, so it never wraps or shrinks
  // at the edge. The saved position is kept; what is shown is held inside the panel whatever the text,
  // units or screen size, so the text cannot end up off screen.
  shownPosition() {
    const panel = this.panelSize();
    const text = this.textSize();
    return {
      x: clamp(this.settings.x, 0, maxPosition(text.width, panel.width)),
      y: clamp(this.settings.y, 0, maxPosition(text.height, panel.height)),
    };
  }

  applyPosition() {
    const panel = this.panelSize();
    const { x, y } = this.shownPosition();
    this.statsElement.style.transform =
      `translate(${Math.round(x / 100 * panel.width)}px, ${Math.round(y / 100 * panel.height)}px)`;
  }

  readSimVar(name, unit) {
    try {
      const value = SimVar.GetSimVarValue(name, unit);
      return Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  formatValue(value, decimalPlaces = 0) {
    return value === null ? 'N/A' : value.toFixed(decimalPlaces);
  }

  formatSimVar(name, unit, decimalPlaces = 0) {
    return this.formatValue(this.readSimVar(name, unit), decimalPlaces);
  }

  formatSpeed(knots, decimalPlaces) {
    if (knots === null || this.settings.speedUnit === 'kt') return this.formatValue(knots, decimalPlaces);
    return this.formatValue(knots * KNOTS_TO_KMH, decimalPlaces);
  }

  formatCoordinate(name, positiveHemisphere, negativeHemisphere) {
    const value = this.readSimVar(name, 'degrees');
    if (value === null) return 'N/A';

    const absolute = Math.abs(value);
    let degrees = Math.floor(absolute);
    let minutes = Math.round((absolute - degrees) * 60 * 100) / 100;
    if (minutes >= 60) {
      degrees += 1;
      minutes = 0;
    }
    const hemisphere = value < 0 ? negativeHemisphere : positiveHemisphere;
    return `${hemisphere}${degrees}° ${minutes.toFixed(2)}'`;
  }

  readSimulationRate() {
    try {
      const rate = SimVar.GetGlobalVarValue('SIMULATION RATE', 'number');
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    } catch (_) {
      return null;
    }
  }

  formatFlightData() {
    const fields = this.settings.fields;
    const metric = this.settings.speedUnit === 'kmh';
    const parts = [];
    if (fields.lat) parts.push(`LAT: ${this.formatCoordinate('PLANE LATITUDE', 'N', 'S')}`);
    if (fields.lon) parts.push(`LON: ${this.formatCoordinate('PLANE LONGITUDE', 'E', 'W')}`);
    if (fields.alt) {
      const feet = this.readSimVar('PLANE ALTITUDE', 'feet');
      parts.push(this.settings.altitudeUnit === 'm'
        ? `ALT: ${this.formatValue(feet === null ? null : feet * FEET_TO_METRES)} M MSL`
        : `ALT: ${this.formatValue(feet)} FT MSL`);
    }
    if (fields.hdg) parts.push(`Mag ${this.formatSimVar('PLANE HEADING DEGREES MAGNETIC', 'degrees')}`);
    if (fields.ias) {
      const speed = this.formatSpeed(this.readSimVar('AIRSPEED INDICATED', 'knots'), 1);
      parts.push(metric ? `${speed} KM/H IAS` : `${speed} KIAS`);
    }
    if (fields.wind) {
      const windDirection = this.readSimVar('AMBIENT WIND DIRECTION', 'degrees');
      const magneticVariation = this.readSimVar('MAGVAR', 'degrees');
      let magneticWind = 'N/A';
      if (windDirection !== null && magneticVariation !== null) {
        magneticWind = String(Math.round(((windDirection - magneticVariation) % 360 + 360) % 360) % 360);
      }
      const windSpeed = this.formatSpeed(this.readSimVar('AMBIENT WIND VELOCITY', 'knots'), 0);
      parts.push(`WIND ${magneticWind} Mag @ ${windSpeed} ${metric ? 'km/h' : 'kts'}.`);
    }
    return parts.join('  ');
  }

  formatPerformanceData() {
    const fields = this.settings.fields;
    const parts = [];
    if (fields.fps) {
      const fps = this.fps !== null && Date.now() - this.fpsUpdatedAt < FPS_TIMEOUT_MS
        ? this.fps.toFixed(1) : 'N/A';
      parts.push(`FRAMES/SEC = ${fps}`);
    }
    if (fields.g) {
      const gForce = this.readSimVar('G FORCE', 'number');
      parts.push(`${gForce === null ? 'N/A' : `${gForce >= 0 ? '+' : ''}${gForce.toFixed(1)}`} Gs`);
    }
    if (fields.fuel) {
      const fuelQuantity = this.readSimVar('FUEL TOTAL QUANTITY', 'gallons');
      const fuelCapacity = this.readSimVar('FUEL TOTAL CAPACITY', 'gallons');
      const fuel = fuelQuantity !== null && fuelCapacity !== null && fuelCapacity > 0
        ? String(Math.round(fuelQuantity / fuelCapacity * 100)) : 'N/A';
      parts.push(`FUEL ${fuel} %`);
    }
    if (fields.simrate) {
      const rate = this.readSimulationRate();
      parts.push(`SIMRATE ${rate === null ? 'N/A' : rate}`);
    }
    return parts.join('  ');
  }

  setText(text) {
    // Draw degree marks without relying on a simulator font containing the glyph.
    this.statsElement.textContent = '';
    text.split('°').forEach((piece, index) => {
      if (index) {
        const degree = document.createElement('span');
        degree.className = 'degree-mark';
        degree.setAttribute('aria-label', ' degrees ');
        this.statsElement.appendChild(degree);
      }
      this.statsElement.appendChild(document.createTextNode(piece));
    });
  }

  render() {
    if (!this.statsElement) return;
    if (this.unsaved && this.settingsKnown()) this.saveSettings();
    this.syncWhenReady();
    if (this.keyRequest && Date.now() - this.keyRequest.sentAt > KEYS_TIMEOUT_MS) this.finishKeys('timeout');
    this.updateConfigCard();
    // Configuration mode always previews both lines so there is something to drag.
    const view = this.configMode ? VIEW.BOTH : this.view;
    if (view === VIEW.OFF) {
      this.setText('');
    } else if (typeof SimVar === 'undefined') {
      this.setText('Waiting for simulator data...');
    } else {
      const lines = [this.formatFlightData()];
      if (view === VIEW.BOTH) lines.push(this.formatPerformanceData());
      this.setText(lines.filter(line => line).join('\n') || (this.configMode ? '(no items selected)' : ''));
    }
    this.applyPosition();
  }
}

customElements.define('shift-z-continued', ShiftZContinued);
checkAutoload();
