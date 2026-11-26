const UPDATE_INTERVAL_MS = 250;
const FPS_TIMEOUT_MS = 3000;
// Ctrl+Shift+Z may also trigger the Shift+Z mapping; messages this close together are one key press.
const OVERLAP_MS = 250;
const FPS_MESSAGE = 'SHIFT_Z_CONTINUED_FPS';
const CYCLE_MESSAGE = 'SHIFT_Z_CONTINUED_CYCLE';
const CONFIG_MESSAGE = 'SHIFT_Z_CONTINUED_CONFIG';
const CONFLICT_MESSAGE = 'SHIFT_Z_CONTINUED_CONFLICT';
const SET_KEYS_MESSAGE = 'SHIFT_Z_CONTINUED_SET_KEYS';
const KEYS_STATUS_MESSAGE = 'SHIFT_Z_CONTINUED_KEYS_STATUS';
const KEY_LINK_TIMEOUT_MS = 3000;
// A hotkey press that ends a key capture also reaches WASM; its message can arrive just after the capture.
const AFTER_CAPTURE_MS = 500;
const KEY_LINK_PATHS = { commbus: 'CommBus', lvar: 'LVar' };
const KEYS_LVAR = 'L:SHIFT_Z_CONTINUED_KEYS';
const PRESS_CLICK_MS = 1000;
const HOTKEY_LABELS = { cycle: 'Cycle key', config: 'Settings key' };
const SETTINGS_KEY = 'SHIFT_Z_CONTINUED_SETTINGS';
const VIEW = { OFF: 0, FLIGHT: 1, BOTH: 2, COUNT: 3 };
const MAX_POSITION = 95;
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

function clampPosition(value, max = MAX_POSITION) {
  return Math.min(max, Math.max(0, value));
}

// Largest position (percent) that keeps a box of boxSize fully inside panelSize.
function maxPosition(boxSize, panelSize) {
  return boxSize > 0 && boxSize < panelSize ? 100 - boxSize / panelSize * 100 : MAX_POSITION;
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
  if (Number.isFinite(stored.x)) settings.x = clampPosition(stored.x);
  if (Number.isFinite(stored.y)) settings.y = clampPosition(stored.y);
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

function describeError(error) {
  try {
    const text = typeof error === 'string' ? error : JSON.stringify(error);
    return (text || String(error)).slice(0, 120);
  } catch (_) {
    return String(error).slice(0, 120);
  }
}

class ShiftZContinued extends UIElement {
  connectedCallback() {
    super.connectedCallback();
    this.rootElement = this.querySelector('#ShiftZContinued');
    this.statsElement = this.querySelector('#stats');
    this.configElement = this.querySelector('#config');
    this.view = VIEW.OFF;
    this.previousView = VIEW.OFF;
    this.lastCycleAt = -Infinity;
    this.lastConfigAt = -Infinity;
    this.configMode = false;
    this.drag = null;
    this.fps = null;
    this.fpsUpdatedAt = 0;
    this.settingsChanged = false;
    this.settings = this.loadSettings();
    this.conflict = null;
    this.capturing = null;
    this.captureMessage = '';
    this.captureEndedAt = -Infinity;
    this.keyLink = null;
    // A random start keeps a reloaded panel from repeating the value still in the L:var.
    this.keySendCount = Math.floor(Math.random() * 1000);

    this.onFps = payload => {
      try {
        const message = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (message && Number.isFinite(message.fps) && message.fps > 0) {
          this.fps = message.fps;
          this.fpsUpdatedAt = Date.now();
        }
      } catch (_) {
        // Ignore malformed messages from the communication bus.
      }
    };
    this.onCycleMessage = () => this.onCycle();
    this.onConfigMessage = () => this.onConfig();
    this.onConflictMessage = payload => this.onConflict(payload);
    this.onKeysStatusMessage = payload => this.onKeysStatus(payload);
    this.onKeyDown = event => this.captureKey(event);
    this.onDragStart = event => this.startDrag(event);
    this.onDragMove = event => this.moveDrag(event);
    this.onDragEnd = () => this.endDrag();
    // The sim's data storage is only attached after this event, so settings read at startup can be missing.
    this.onStorageReady = () => {
      if (this.settingsChanged) return;
      this.settings = this.loadSettings();
      this.sendKeys();
      this.render();
    };

    if (typeof RegisterCommBusListener === 'function') {
      // The WASM module keeps its default keys until the panel sends the player's keys.
      this.commBus = RegisterCommBusListener(() => this.sendKeys());
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

  loadSettings() {
    try {
      return parseSettings(typeof GetStoredData === 'function' ? GetStoredData(SETTINGS_KEY) : null);
    } catch (_) {
      return defaultSettings();
    }
  }

  saveSettings() {
    this.settingsChanged = true;
    try {
      if (typeof SetStoredData === 'function') SetStoredData(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (_) {
      // Settings still apply for this session.
    }
  }

  // Sent over CommBus and through an L:var: the WASM module applies whichever arrives and reports back.
  // The card only mentions the paths when neither one delivered the keys.
  sendKeys(now = Date.now()) {
    const keys = this.settings.keys;
    const link = { sentAt: now, commbus: 'sent', lvar: 'sent' };
    this.keyLink = link;
    this.keySendCount += 1;
    // WASM only acts on a changed value; after a reload the random counter can repeat the stored one.
    let code = hotkeySetCode(keys, this.keySendCount);
    if (this.readSimVar(KEYS_LVAR, 'number') === code) code = hotkeySetCode(keys, ++this.keySendCount);
    const send = (path, call) => {
      if (!call) {
        link[path] = 'unavailable';
        return;
      }
      try {
        const result = call();
        if (result && typeof result.catch === 'function') {
          result.catch(error => {
            if (link[path] === 'sent') link[path] = `call failed: ${describeError(error)}`;
            this.render();
          });
        }
      } catch (error) {
        link[path] = `call failed: ${describeError(error)}`;
      }
    };
    send('commbus', this.commBus && typeof this.commBus.callWasm === 'function'
      && (() => this.commBus.callWasm(SET_KEYS_MESSAGE, hotkeySetText(keys))));
    send('lvar', typeof SimVar !== 'undefined' && typeof SimVar.SetSimVarValue === 'function'
      && (() => SimVar.SetSimVarValue(KEYS_LVAR, 'number', code)));
  }

  onKeysStatus(payload) {
    let message;
    try {
      message = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      return;
    }
    if (!message || !this.keyLink || !KEY_LINK_PATHS[message.via] || typeof message.result !== 'string') return;
    this.keyLink[message.via] = message.result;
    this.render();
  }

  // Empty while a path may still deliver the keys or once one has; otherwise names what each path reported.
  keyLinkText(now = Date.now()) {
    if (!this.keyLink) return '';
    const paths = Object.keys(KEY_LINK_PATHS);
    const states = paths.map(path => {
      const state = this.keyLink[path];
      return state === 'sent' && now - this.keyLink.sentAt > KEY_LINK_TIMEOUT_MS ? 'no reply' : state;
    });
    if (states.includes('applied') || states.includes('sent')) return '';
    const parts = paths.map((path, index) => `${KEY_LINK_PATHS[path]} ${states[index]}`);
    return `The new keys did not reach the add-on (${parts.join(', ')}).`;
  }

  onCycle(now = Date.now()) {
    if (this.capturing || now - this.captureEndedAt < AFTER_CAPTURE_MS || now - this.lastConfigAt < OVERLAP_MS) return;
    this.previousView = this.view;
    this.lastCycleAt = now;
    this.view = (this.view + 1) % VIEW.COUNT;
    this.render();
  }

  onConfig(now = Date.now()) {
    if (this.capturing || now - this.captureEndedAt < AFTER_CAPTURE_MS) return;
    if (now - this.lastCycleAt < OVERLAP_MS) {
      this.view = this.previousView;
      this.lastCycleAt = -Infinity;
    }
    this.lastConfigAt = now;
    this.setConfigMode(!this.configMode);
  }

  // The WASM module saw simulator commands fire together with one of our keys.
  onConflict(payload) {
    let message;
    try {
      message = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      return;
    }
    if (!message || !HOTKEY_LABELS[message.key] || !Array.isArray(message.events)) return;
    // The WASM module sends SimConnect command names; the MSFS controls may show a more readable name.
    const commands = message.events.filter(name => typeof name === 'string' && name.length > 0);
    if (!commands.length || this.settings.ignoreConflicts) return;
    this.conflict = { key: message.key, text: comboText(this.settings.keys[message.key]), commands };
    if (this.configMode) this.render();
    else this.setConfigMode(true);
  }

  ignoreConflict() {
    if (!this.conflict) return;
    this.settings.ignoreConflicts = true;
    this.conflict = null;
    this.saveSettings();
    this.render();
  }

  // The same button starts and cancels a capture (Esc cannot: MSFS opens its pause menu on Esc).
  toggleCapture(key) {
    if (this.capturing === key) {
      this.endCapture();
    } else {
      this.capturing = key;
      this.captureMessage = '';
    }
    this.render();
  }

  endCapture(now = Date.now()) {
    this.capturing = null;
    this.captureMessage = '';
    this.captureEndedAt = now;
  }

  captureKey(event) {
    if (!this.capturing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const candidate = comboFromKeyEvent(event);
    if (!candidate) return;
    if (candidate.cancel) {
      this.endCapture();
      this.render();
      return;
    }
    const combo = normalizeCombo(candidate);
    const other = this.capturing === 'cycle' ? 'config' : 'cycle';
    if (!combo) {
      this.captureMessage = HOTKEY_RULES;
    } else if (sameCombo(combo, this.settings.keys[other])) {
      this.captureMessage = `${comboText(combo)} is already the ${HOTKEY_LABELS[other].toLowerCase()}.`;
    } else {
      this.settings.keys = Object.assign({}, this.settings.keys, { [this.capturing]: combo });
      if (this.conflict && this.conflict.key === this.capturing) this.conflict = null;
      this.endCapture();
      this.saveSettings();
      this.sendKeys();
    }
    this.render();
  }

  setConfigMode(enabled) {
    this.configMode = enabled;
    if (!enabled) {
      this.drag = null;
      if (this.capturing) this.endCapture();
      this.saveSettings();
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
    // so those buttons also act on mousedown; the click that follows is then skipped.
    const addButton = (parent, text, action, onPress = false) => {
      const button = addElement(parent, 'div', 'config-button', text);
      let pressedAt = -Infinity;
      if (onPress) {
        button.addEventListener('mousedown', event => {
          if (event && event.button > 0) return;
          pressedAt = Date.now();
          action();
        });
      }
      button.addEventListener('click', () => {
        if (Date.now() - pressedAt < PRESS_CLICK_MS) return;
        action();
      });
      return button;
    };

    addElement(card, 'div', 'config-title', 'Shift Z Continued');
    this.warningElement = addElement(card, 'div', 'config-warning');
    this.warningText = addElement(this.warningElement, 'div', 'config-warning-text');
    this.ignoreButton = addButton(this.warningElement, 'Ignore', () => this.ignoreConflict());
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
    this.captureMessageElement = addElement(card, 'div', 'config-message');
    this.keyLinkElement = addElement(card, 'div', 'config-link');
    const actions = addElement(card, 'div', 'config-row');
    this.resetButton = addButton(actions, 'Reset position', () => {
      const defaults = defaultSettings();
      this.settings.x = defaults.x;
      this.settings.y = defaults.y;
      this.saveSettings();
      this.render();
    });
    this.doneButton = addButton(actions, 'Done', () => this.setConfigMode(false));
  }

  updateConfigCard() {
    if (!this.fieldToggles) return;
    FIELDS.forEach(field => {
      this.fieldToggles[field.id].classList.toggle('on', this.settings.fields[field.id]);
    });
    this.altitudeToggle.textContent = `Altitude: ${this.settings.altitudeUnit === 'ft' ? 'feet' : 'metres'}`;
    this.speedToggle.textContent = `Speed: ${this.settings.speedUnit === 'kt' ? 'knots' : 'km/h'}`;
    const keys = this.settings.keys;
    this.hintElement.textContent = `Drag the red text to move it. ${comboText(keys.config)} or Done to close.`;
    Object.keys(this.keyRows).forEach(key => {
      const capturing = this.capturing === key;
      this.keyRows[key].textContent = capturing
        ? `${HOTKEY_LABELS[key]}: press the new keys`
        : `${HOTKEY_LABELS[key]}: ${comboText(keys[key])}`;
      this.keyButtons[key].textContent = capturing ? 'Cancel' : 'Change key';
    });
    this.captureMessageElement.textContent = this.capturing
      ? (this.captureMessage || 'The keys you press also reach MSFS this once.') : this.captureMessage;
    const keyLink = this.keyLinkText();
    this.keyLinkElement.textContent = keyLink;
    this.keyLinkElement.style.display = keyLink ? 'block' : 'none';
    this.warningElement.style.display = this.conflict ? 'block' : 'none';
    this.warningText.textContent = this.conflict
      ? `${this.conflict.text} also triggers ${this.conflict.commands.join(', ')} in MSFS. `
        + 'Remove that binding in the MSFS keyboard controls, change the key below, '
        + 'or press Ignore to stop all key conflict warnings.'
      : '';
  }

  panelSize() {
    const rect = this.rootElement && typeof this.rootElement.getBoundingClientRect === 'function'
      ? this.rootElement.getBoundingClientRect() : null;
    return {
      width: rect && rect.width > 0 ? rect.width : window.innerWidth,
      height: rect && rect.height > 0 ? rect.height : window.innerHeight,
    };
  }

  startDrag(event) {
    if (!this.configMode || event.button > 0) return;
    this.drag = { mouseX: event.clientX, mouseY: event.clientY, x: this.settings.x, y: this.settings.y, width: 0, height: 0 };
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  moveDrag(event) {
    if (!this.drag) return;
    const { width, height } = this.panelSize();
    if (!(width > 0) || !(height > 0)) return;
    const box = this.textBoxSize();
    this.settings.x = clampPosition(this.drag.x + (event.clientX - this.drag.mouseX) / width * 100,
                                    maxPosition(box.width, width));
    this.settings.y = clampPosition(this.drag.y + (event.clientY - this.drag.mouseY) / height * 100,
                                    maxPosition(box.height, height));
    this.applyPosition();
  }

  // An absolute box shrinks to the space left at the panel edge while its text keeps its width, so measuring
  // only the box lets each move creep further out. Use the content width and the widest size seen in this drag.
  textBoxSize() {
    const element = this.statsElement;
    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect() : { width: 0, height: 0 };
    this.drag.width = Math.max(this.drag.width, rect.width || 0, element.scrollWidth || 0);
    this.drag.height = Math.max(this.drag.height, rect.height || 0, element.scrollHeight || 0);
    return { width: this.drag.width, height: this.drag.height };
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.saveSettings();
  }

  applyPosition() {
    this.statsElement.style.left = `${this.settings.x}%`;
    this.statsElement.style.top = `${this.settings.y}%`;
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
    this.applyPosition();
    this.updateConfigCard();
    // Configuration mode always previews both lines so there is something to drag.
    const view = this.configMode ? VIEW.BOTH : this.view;
    if (view === VIEW.OFF) {
      this.setText('');
      return;
    }
    if (typeof SimVar === 'undefined') {
      this.setText('Waiting for simulator data...');
      return;
    }

    const lines = [this.formatFlightData()];
    if (view === VIEW.BOTH) lines.push(this.formatPerformanceData());
    const text = lines.filter(line => line).join('\n');
    this.setText(text || (this.configMode ? '(no items selected)' : ''));
  }
}

customElements.define('shift-z-continued', ShiftZContinued);
checkAutoload();
