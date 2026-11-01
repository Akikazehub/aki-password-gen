import {
  LEGACY_SPECIAL_CHARS,
  AMBIGUOUS_CHARS,
  entropyBits,
  passphraseEntropyBits,
  generatePassword,
  generatePassphrase,
} from '/assets/generator.mjs';

const STORAGE_KEY = 'apgen/ui/v1';
const DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1500;

const SEPARATORS = { none: '', dash: '-', underscore: '_', dot: '.', space: ' ' };
const NUMERIC_LIMITS = { length: [4, 128], amount: [1, 20], words: [4, 12] };
const PRESET_SETS = { presetBasic: '!@#$%', presetMin: '-_.', presetWide: '!@#$%^&*' };

const DEFAULTS = {
  mode: 'random',
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: false,
  specialChars: LEGACY_SPECIAL_CHARS,
  excludeAmbiguous: true,
  avoidSequences: true,
  allowRepeats: false,
  amount: 1,
  words: 4,
  separatorMode: 'none',
  customSeparator: '',
  prefixDate: true,
};

const settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);

const el = {
  tabRandom: $('tab-random'),
  tabPassphrase: $('tab-passphrase'),
  panelRandom: $('panel-random'),
  panelPassphrase: $('panel-passphrase'),
  passwordOutput: $('password-output'),
  batchList: $('batch-list'),
  btnRegenerate: $('btn-regenerate'),
  btnCopy: $('btn-copy'),
  strengthFill: $('strength-fill'),
  strengthLabel: $('strength-label'),
  genWarning: $('gen-warning'),
  lengthRange: $('length-range'),
  lengthNumber: $('length-number'),
  optLowercase: $('opt-lowercase'),
  optUppercase: $('opt-uppercase'),
  optDigits: $('opt-digits'),
  optSymbols: $('opt-symbols'),
  specialChars: $('special-chars'),
  presetLegacy: $('preset-legacy'),
  presetBasic: $('preset-basic'),
  presetMin: $('preset-min'),
  presetWide: $('preset-wide'),
  labelAmbiguous: $('label-ambiguous'),
  optExcludeAmbiguous: $('opt-exclude-ambiguous'),
  optAvoidSequences: $('opt-avoid-sequences'),
  optAllowRepeats: $('opt-allow-repeats'),
  amount: $('amount'),
  wordsRange: $('words-range'),
  wordsValue: $('words-value'),
  separatorSelect: $('separator-select'),
  customSeparator: $('custom-separator'),
  optDate: $('opt-date'),
  apiPreview: $('api-preview'),
  btnCopyApi: $('btn-copy-api'),
};

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function effectiveSeparator() {
  if (settings.separatorMode === 'custom') return settings.customSeparator;
  return Object.hasOwn(SEPARATORS, settings.separatorMode)
    ? SEPARATORS[settings.separatorMode]
    : '';
}

function randomOptions() {
  return {
    length: settings.length,
    lowercase: settings.lowercase,
    uppercase: settings.uppercase,
    digits: settings.digits,
    symbols: settings.symbols,
    specialChars: settings.specialChars,
    excludeAmbiguous: settings.excludeAmbiguous,
    allowRepeats: settings.allowRepeats,
    avoidSequences: settings.avoidSequences,
  };
}

function isBatchMode() {
  return settings.mode === 'random' && settings.amount > 1;
}

/* ---------- 持久化 ---------- */

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 不可用（隐私模式等）时忽略
  }
}

function restoreSettings() {
  let parsed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return; // JSON 损坏时回退默认值
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = parsed[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === 'boolean') {
      settings[key] = value === true;
    } else if (typeof fallback === 'number') {
      const [min, max] = NUMERIC_LIMITS[key];
      settings[key] = clamp(value, min, max);
    } else {
      settings[key] = String(value);
    }
  }
  if (settings.mode !== 'random' && settings.mode !== 'passphrase') settings.mode = DEFAULTS.mode;
  if (settings.separatorMode !== 'custom' && !Object.hasOwn(SEPARATORS, settings.separatorMode)) {
    settings.separatorMode = DEFAULTS.separatorMode;
  }
}

/* ---------- 模式切换 ---------- */

function setMode(mode) {
  settings.mode = mode;
  const isRandom = mode === 'random';
  el.tabRandom.setAttribute('aria-selected', String(isRandom));
  el.tabRandom.tabIndex = isRandom ? 0 : -1;
  el.panelRandom.hidden = !isRandom;
  el.tabPassphrase.setAttribute('aria-selected', String(!isRandom));
  el.tabPassphrase.tabIndex = isRandom ? -1 : 0;
  el.panelPassphrase.hidden = isRandom;
}

/* ---------- 生成与渲染 ---------- */

let lastResult = [];
let lastError = null;

function generateOne() {
  if (settings.mode === 'passphrase') {
    return generatePassphrase({
      words: settings.words,
      separator: effectiveSeparator(),
      prependDate: settings.prefixDate,
    });
  }
  return generatePassword(randomOptions());
}

function generateAll() {
  el.genWarning.hidden = true;
  lastError = null;
  lastResult = [];
  try {
    const count = settings.mode === 'passphrase' ? 1 : settings.amount;
    for (let i = 0; i < count; i++) lastResult.push(generateOne());
  } catch (err) {
    lastError = err && err.message ? err.message : '请检查字符类型与长度设置';
    el.genWarning.textContent = '生成失败：' + lastError;
    el.genWarning.hidden = false;
  }
}

function makeCopyButton(value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small';
  button.textContent = '复制';
  button.setAttribute('aria-label', '复制本行密码');
  button.addEventListener('click', () => copyText(value, button, '复制'));
  return button;
}

function renderOutput() {
  const batch = isBatchMode();
  el.passwordOutput.hidden = batch;
  el.batchList.hidden = !batch;
  if (batch) {
    el.batchList.replaceChildren();
    for (const value of lastResult) {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'batch-text';
      text.textContent = value;
      row.append(text, makeCopyButton(value));
      el.batchList.append(row);
    }
    if (lastResult.length === 0) {
      const row = document.createElement('li');
      row.textContent = '—';
      el.batchList.append(row);
    }
  } else {
    el.passwordOutput.textContent = lastResult.length > 0 ? lastResult[0] : '—';
  }
}

function renderStrength() {
  let bits = 0;
  try {
    bits = settings.mode === 'passphrase'
      ? passphraseEntropyBits({ words: settings.words })
      : entropyBits(randomOptions());
  } catch {
    bits = 0;
  }
  if (!Number.isFinite(bits)) bits = 0;
  const [name, cls] = bits < 50 ? ['弱', 'weak']
    : bits < 70 ? ['中', 'fair']
    : bits < 90 ? ['强', 'strong']
    : ['极强', 'very-strong'];
  el.strengthLabel.textContent = `强度：${name} (${bits} bit)`;
  el.strengthLabel.className = `strength-label ${cls}`;
  el.strengthFill.className = `strength-fill ${cls}`;
  el.strengthFill.style.width = `${Math.min(100, (bits / 128) * 100)}%`;
}

function buildApiUrl() {
  const parts = [];
  const add = (key, value) => parts.push(`${key}=${encodeURIComponent(value)}`);
  if (settings.mode === 'passphrase') {
    add('length', String(settings.words));
    add('xkcd', 'true');
    if (!settings.prefixDate) add('date', 'false');
    const separator = effectiveSeparator();
    if (separator !== '') add('separator', separator);
  } else {
    add('length', String(settings.length));
    if (!settings.lowercase) add('lowercase', 'false');
    if (!settings.uppercase) add('uppercase', 'false');
    if (!settings.digits) add('digits', 'false');
    if (settings.symbols) {
      if (settings.specialChars === LEGACY_SPECIAL_CHARS) {
        add('special', 'true');
      } else if (settings.specialChars !== '') {
        add('symbols', 'true');
        add('special_chars', settings.specialChars);
      } else {
        add('symbols', 'true');
      }
    }
    if (!settings.excludeAmbiguous) add('exclude_ambiguous', 'false');
    if (!settings.avoidSequences) add('avoid_sequences', 'false');
    if (settings.allowRepeats) add('allow_repeats', 'true');
    if (settings.amount > 1) add('amount', String(settings.amount));
  }
  return `${window.location.origin}/v1/getPassword?${parts.join('&')}`;
}

function renderApiPreview() {
  // 无效配置（如符号集为空、全部字符类关闭）没有对应的 API 语义：
  // 明确提示，而不是给出一个行为与界面矛盾的 URL。
  el.apiPreview.textContent = lastError
    ? `当前设置无法生成密码（${lastError}），API 地址不可用`
    : buildApiUrl();
}

function renderAll() {
  generateAll();
  renderOutput();
  renderStrength();
  renderApiPreview();
}

let regenTimer = 0;

function scheduleRegenerate() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(renderAll, DEBOUNCE_MS);
}

/* ---------- 复制 ---------- */

async function copyText(text, button, defaultLabel) {
  let copied = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) copied = copyViaExecCommand(text);
  flashButton(button, defaultLabel, copied);
}

// navigator.clipboard 在非安全上下文（如局域网 http）下不可用，回退到 execCommand
function copyViaExecCommand(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function flashButton(button, defaultLabel, copied) {
  button.textContent = copied ? '已复制' : '复制失败';
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    button.textContent = defaultLabel;
  }, COPY_FEEDBACK_MS);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  const tabs = [
    { button: el.tabRandom, mode: 'random' },
    { button: el.tabPassphrase, mode: 'passphrase' },
  ];
  tabs.forEach(({ button, mode }, index) => {
    button.addEventListener('click', () => {
      if (settings.mode === mode) return;
      setMode(mode);
      saveSettings();
      renderAll();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].button.focus();
      tabs[next].button.click();
    });
  });

  const bindCheck = (input, key) => {
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      if (key === 'symbols') el.specialChars.disabled = !input.checked;
      saveSettings();
      scheduleRegenerate();
    });
  };
  bindCheck(el.optLowercase, 'lowercase');
  bindCheck(el.optUppercase, 'uppercase');
  bindCheck(el.optDigits, 'digits');
  bindCheck(el.optSymbols, 'symbols');
  bindCheck(el.optExcludeAmbiguous, 'excludeAmbiguous');
  bindCheck(el.optAvoidSequences, 'avoidSequences');
  bindCheck(el.optAllowRepeats, 'allowRepeats');
  bindCheck(el.optDate, 'prefixDate');

  const applyLength = (value, { syncNumber = false } = {}) => {
    settings.length = clamp(value, 4, 128);
    el.lengthRange.value = String(settings.length);
    // 只在滑块拖动和失焦校准时回写数字框，避免打断数字框内的输入。
    if (syncNumber) el.lengthNumber.value = String(settings.length);
    saveSettings();
    scheduleRegenerate();
  };
  el.lengthRange.addEventListener('input', () => applyLength(el.lengthRange.value, { syncNumber: true }));
  el.lengthNumber.addEventListener('input', () => {
    if (el.lengthNumber.value !== '') applyLength(el.lengthNumber.value);
  });
  el.lengthNumber.addEventListener('change', () => applyLength(el.lengthNumber.value, { syncNumber: true }));

  el.specialChars.addEventListener('input', () => {
    settings.specialChars = el.specialChars.value;
    saveSettings();
    scheduleRegenerate();
  });
  const applyPreset = (value) => {
    settings.specialChars = value;
    el.specialChars.value = value;
    saveSettings();
    scheduleRegenerate();
  };
  el.presetLegacy.addEventListener('click', () => applyPreset(LEGACY_SPECIAL_CHARS));
  el.presetBasic.addEventListener('click', () => applyPreset(PRESET_SETS.presetBasic));
  el.presetMin.addEventListener('click', () => applyPreset(PRESET_SETS.presetMin));
  el.presetWide.addEventListener('click', () => applyPreset(PRESET_SETS.presetWide));

  el.amount.addEventListener('input', () => {
    if (el.amount.value === '') return;
    settings.amount = clamp(el.amount.value, 1, 20);
    saveSettings();
    scheduleRegenerate();
  });
  el.amount.addEventListener('change', () => {
    settings.amount = clamp(el.amount.value, 1, 20);
    el.amount.value = String(settings.amount);
    saveSettings();
    scheduleRegenerate();
  });

  el.wordsRange.addEventListener('input', () => {
    settings.words = clamp(el.wordsRange.value, 4, 12);
    el.wordsValue.textContent = String(settings.words);
    saveSettings();
    scheduleRegenerate();
  });

  el.separatorSelect.addEventListener('change', () => {
    settings.separatorMode = el.separatorSelect.value;
    el.customSeparator.hidden = settings.separatorMode !== 'custom';
    saveSettings();
    scheduleRegenerate();
  });
  el.customSeparator.addEventListener('input', () => {
    settings.customSeparator = el.customSeparator.value;
    saveSettings();
    scheduleRegenerate();
  });

  el.btnRegenerate.addEventListener('click', renderAll);
  el.btnCopy.addEventListener('click', () => {
    const text = lastResult.length > 1 ? lastResult.join('\n') : (lastResult[0] || '');
    if (!text) {
      flashButton(el.btnCopy, '复制', false);
      return;
    }
    copyText(text, el.btnCopy, '复制');
  });
  el.btnCopyApi.addEventListener('click', () => {
    if (lastError) {
      flashButton(el.btnCopyApi, '复制 API 地址', false);
      return;
    }
    copyText(buildApiUrl(), el.btnCopyApi, '复制 API 地址');
  });
}

function applySettingsToControls() {
  el.lengthRange.value = String(settings.length);
  el.lengthNumber.value = String(settings.length);
  el.optLowercase.checked = settings.lowercase;
  el.optUppercase.checked = settings.uppercase;
  el.optDigits.checked = settings.digits;
  el.optSymbols.checked = settings.symbols;
  el.specialChars.value = settings.specialChars;
  el.specialChars.disabled = !settings.symbols;
  el.optExcludeAmbiguous.checked = settings.excludeAmbiguous;
  el.optAvoidSequences.checked = settings.avoidSequences;
  el.optAllowRepeats.checked = settings.allowRepeats;
  el.amount.value = String(settings.amount);
  el.wordsRange.value = String(settings.words);
  el.wordsValue.textContent = String(settings.words);
  el.separatorSelect.value = settings.separatorMode;
  el.customSeparator.value = settings.customSeparator;
  el.customSeparator.hidden = settings.separatorMode !== 'custom';
  el.optDate.checked = settings.prefixDate;
  el.labelAmbiguous.textContent = `避免易混淆字符 (${AMBIGUOUS_CHARS.split('').join(' ')})`;
  setMode(settings.mode);
}

function init() {
  restoreSettings();
  applySettingsToControls();
  bindEvents();
  renderAll();
}

init();
