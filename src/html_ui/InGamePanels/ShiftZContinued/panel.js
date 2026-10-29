const UPDATE_INTERVAL_MS = 250;
const FPS_TIMEOUT_MS = 3000;
const FPS_MESSAGE = 'SHIFT_Z_CONTINUED_FPS';
const VIEW = { FLIGHT: 0, PERFORMANCE: 1, COMBINED: 2, HIDDEN: 3, COUNT: 4 };

class ShiftZContinued extends UIElement {
  connectedCallback() {
    super.connectedCallback();
    this.statsElement = this.querySelector('#stats');
    this.view = VIEW.FLIGHT;
    this.fps = null;
    this.fpsUpdatedAt = 0;

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

    if (typeof RegisterCommBusListener === 'function') {
      this.commBus = RegisterCommBusListener();
      this.commBus.on(FPS_MESSAGE, this.onFps);
    }

    this.onKeyDown = event => {
      const isShiftZ = event.shiftKey && (event.code === 'KeyZ' || event.keyCode === 90);
      if (isShiftZ && !event.repeat) {
        this.view = (this.view + 1) % VIEW.COUNT;
        this.render();
      }
    };
    document.addEventListener('keydown', this.onKeyDown);
    this.updateTimer = setInterval(() => this.render(), UPDATE_INTERVAL_MS);
    this.render();
  }

  disconnectedCallback() {
    clearInterval(this.updateTimer);
    if (this.commBus && typeof this.commBus.off === 'function') {
      this.commBus.off(FPS_MESSAGE, this.onFps);
    }
    this.commBus = null;
    document.removeEventListener('keydown', this.onKeyDown);
    super.disconnectedCallback();
  }

  readSimVar(name, unit) {
    try {
      const value = SimVar.GetSimVarValue(name, unit);
      return Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  formatSimVar(name, unit, decimalPlaces = 0) {
    const value = this.readSimVar(name, unit);
    return value === null ? 'N/A' : value.toFixed(decimalPlaces);
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
    return `${hemisphere}${degrees}\u00b0 ${minutes.toFixed(2)}'`;
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
    const windDirection = this.readSimVar('AMBIENT WIND DIRECTION', 'degrees');
    const magneticVariation = this.readSimVar('MAGVAR', 'degrees');
    let magneticWind = 'N/A';
    if (windDirection !== null && magneticVariation !== null) {
      magneticWind = String(Math.round(((windDirection - magneticVariation) % 360 + 360) % 360) % 360);
    }

    return [
      `LAT: ${this.formatCoordinate('PLANE LATITUDE', 'N', 'S')}`,
      `LON: ${this.formatCoordinate('PLANE LONGITUDE', 'E', 'W')}`,
      `ALT: ${this.formatSimVar('PLANE ALTITUDE', 'feet')} FT MSL`,
      `Mag ${this.formatSimVar('PLANE HEADING DEGREES MAGNETIC', 'degrees')}`,
      `${this.formatSimVar('AIRSPEED INDICATED', 'knots', 1)} KIAS`,
      `WIND ${magneticWind} Mag @ ${this.formatSimVar('AMBIENT WIND VELOCITY', 'knots')} kts.`,
    ].join('  ');
  }

  formatPerformanceData() {
    const rate = this.readSimulationRate();
    const fps = this.fps !== null && Date.now() - this.fpsUpdatedAt < FPS_TIMEOUT_MS
      ? this.fps.toFixed(1) : 'N/A';
    const fuelQuantity = this.readSimVar('FUEL TOTAL QUANTITY', 'gallons');
    const fuelCapacity = this.readSimVar('FUEL TOTAL CAPACITY', 'gallons');
    const fuel = fuelQuantity !== null && fuelCapacity !== null && fuelCapacity > 0
      ? String(Math.round(fuelQuantity / fuelCapacity * 100)) : 'N/A';
    const gForce = this.readSimVar('G FORCE', 'number');
    const force = gForce === null ? 'N/A' : `${gForce >= 0 ? '+' : ''}${gForce.toFixed(1)}`;

    return `FRAMES/SEC = ${fps}  ${force} Gs  FUEL ${fuel} %  SIMRATE ${rate === null ? 'N/A' : rate}`;
  }

  setText(text) {
    // Draw degree marks without relying on a simulator font containing the glyph.
    this.statsElement.textContent = '';
    text.split('\u00b0').forEach((piece, index) => {
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
    if (this.view === VIEW.HIDDEN) {
      this.setText('');
      return;
    }
    if (typeof SimVar === 'undefined') {
      this.setText('Waiting for simulator data...');
      return;
    }

    let text;
    if (this.view === VIEW.FLIGHT) text = this.formatFlightData();
    else if (this.view === VIEW.PERFORMANCE) text = this.formatPerformanceData();
    else text = `${this.formatFlightData()}\n${this.formatPerformanceData()}`;
    this.setText(text);
  }
}

customElements.define('shift-z-continued', ShiftZContinued);
checkAutoload();
