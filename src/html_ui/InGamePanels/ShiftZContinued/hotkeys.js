// Hotkey combinations: validation, display text and the SimConnect input strings sent to the WASM module.
// A combination is { mods: ['ctrl' | 'alt' | 'shift'], key: 'Z' | '5' | 'F9' }.

const HOTKEY_MODIFIERS = ['ctrl', 'alt', 'shift'];
const HOTKEY_MODIFIER_INPUTS = {
  ctrl: ['VK_LCONTROL', 'VK_RCONTROL'],
  alt: ['VK_LMENU', 'VK_RMENU'],
  shift: ['VK_LSHIFT', 'VK_RSHIFT'],
};
const HOTKEY_MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
const DEFAULT_HOTKEYS = {
  cycle: { mods: ['shift'], key: 'Z' },
  config: { mods: ['ctrl', 'shift'], key: 'Z' },
};
const HOTKEY_RULES = 'Use Shift, Ctrl or Alt with a letter or digit, or F1-F12 (at most two modifier keys).';

// Returns the combination in canonical form, or null when SimConnect or the rules cannot use it.
function normalizeCombo(combo) {
  if (!combo || typeof combo !== 'object' || !Array.isArray(combo.mods) || typeof combo.key !== 'string') return null;
  const mods = HOTKEY_MODIFIERS.filter(mod => combo.mods.includes(mod));
  if (mods.length !== combo.mods.length || mods.length > 2) return null;
  const key = combo.key.toUpperCase();
  const functionKey = /^F([1-9]|1[0-2])$/.test(key);
  if (!functionKey && !(/^[A-Z0-9]$/.test(key) && mods.length > 0)) return null;
  return { mods, key };
}

function comboText(combo) {
  return [...combo.mods.map(mod => HOTKEY_MODIFIER_LABELS[mod]), combo.key].join('+');
}

function sameCombo(a, b) {
  return comboText(a) === comboText(b);
}

// Every left/right modifier variant; letters in both cases because the SDK documents both spellings.
function comboDefinitions(combo) {
  const keys = /^F\d+$/.test(combo.key) ? [`VK_${combo.key}`]
    : /^[A-Z]$/.test(combo.key) ? [combo.key, combo.key.toLowerCase()] : [combo.key];
  // Plain loops: Coherent GT has no Array.prototype.flatMap.
  let prefixes = [''];
  combo.mods.forEach(mod => {
    const next = [];
    prefixes.forEach(prefix => HOTKEY_MODIFIER_INPUTS[mod].forEach(input => next.push(`${prefix}${input}+`)));
    prefixes = next;
  });
  const definitions = [];
  prefixes.forEach(prefix => keys.forEach(key => definitions.push(prefix + key)));
  return definitions;
}

function hotkeySetText(keys) {
  return `cycle=${comboDefinitions(keys.cycle).join('|')};config=${comboDefinitions(keys.config).join('|')}`;
}

// The key set as one number for L:SHIFT_Z_CONTINUED_KEYS; src/wasm/hotkey_code.h decodes it.
// One combination: modifiers * 64 + key (Ctrl 1, Alt 2, Shift 4; A-Z 0-25, 0-9 26-35, F1-F12 36-47).
// The value: cycle + config * 512 + counter * 262144, so each send is a new value.
const HOTKEY_CODE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HOTKEY_MODIFIER_BITS = { ctrl: 1, alt: 2, shift: 4 };

function comboCode(combo) {
  const bits = combo.mods.reduce((sum, mod) => sum + HOTKEY_MODIFIER_BITS[mod], 0);
  const functionKey = /^F(\d+)$/.exec(combo.key);
  return bits * 64 + (functionKey ? 35 + Number(functionKey[1]) : HOTKEY_CODE_KEYS.indexOf(combo.key));
}

function hotkeySetCode(keys, counter) {
  return comboCode(keys.cycle) + comboCode(keys.config) * 512 + (counter % 1000 + 1) * 262144;
}

// null: only a modifier so far, keep waiting. { cancel: true }: Esc. Otherwise a candidate to normalize.
function comboFromKeyEvent(event) {
  const code = event.keyCode;
  if (code === 27) return { cancel: true };
  if (code === 16 || code === 17 || code === 18) return null;
  const mods = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  let key = '';
  if (code >= 65 && code <= 90) key = String.fromCharCode(code);
  else if (code >= 48 && code <= 57) key = String.fromCharCode(code);
  else if (code >= 112 && code <= 123) key = `F${code - 111}`;
  return { mods, key };
}
