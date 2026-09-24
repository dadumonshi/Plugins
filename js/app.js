/**
 * app.js — точка входа: связывает аудио-движок, FX-цепочку, запись, график, жесты и мобильный UI.
 * app.js — entry point: wires the audio engine, FX chain, recorder, graph, gestures and mobile UI.
 */
import { AudioEngine, audioSupported, micSupported } from './audio.js';
import { registerPlugin, listPlugins } from './fx-chain.js';
import { ProEQPlugin, EQModel, BAND_COLORS, autoTypeFor } from './eq.js';
import { Recorder } from './recorder.js';
import { EQGraph, fmtGain } from './ui.js';
import { GraphGestures } from './gestures.js';
import { haptics } from './touch.js';
import {
  detectDevice, fullscreen, watchOrientation, Toast, ContextMenu, Drawer, BottomSheet, BandPanel, Knob
} from './mobile-ui.js';
import { PresetStore, downloadBlob } from './presets.js';
import { FILTER_TYPES, FILTER_LABELS, GAINLESS } from './dsp.js';

const $ = (s) => document.querySelector(s);
const SESSION_KEY = 'proeq.session.v1';
const PREFS_KEY = 'proeq.prefs.v1';

/* ---------------- настройки пользователя / user prefs ---------------- */
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

const dev = detectDevice();
const prefs = Object.assign({
  theme: 'auto', haptics: true, controls: 'knobs',
  maxBands: dev.small ? 8 : 24,          // на телефоне по умолчанию 8 / 8 by default on phones
  lowPower: dev.lowPower,
  analyzer: { pre: true, post: true, speed: 'medium', tilt: 4.5 },
  fftSize: dev.lowPower ? 4096 : 8192,
  range: 12,
  linearQuality: 'medium',
  tap: 'wet', loop: false
}, loadPrefs());

/* ---------------- классы <html> / root classes ---------------- */
const root = document.documentElement;
function applyTheme() {
  if (prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = prefs.theme;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#1a1a1a' : '#f2f2f2');
}
applyTheme();
root.classList.toggle('low-power', !!prefs.lowPower);
root.classList.toggle('is-coarse', dev.coarse);
root.classList.toggle('is-standalone', dev.standalone);
haptics.enabled = prefs.haptics;

/* ---------------- UI-компоненты / UI components ---------------- */
const toast = new Toast($('#toast'));
const ctxMenu = new ContextMenu($('#ctx'));
const drawer = new Drawer($('#drawer'), $('#backdrop'));
const sheet = new BottomSheet($('#sheet'));
const panel = new BandPanel($('#sheet'), sheet, { toast, controlStyle: prefs.controls });
const graph = new EQGraph($('#graphWrap'), { lowPower: prefs.lowPower });
graph.analyzer = { ...prefs.analyzer };
graph.view.range = prefs.range;
const presets = new PresetStore();

function fatal(msg) {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
}

/* ---------------- аудио / audio ---------------- */
let engine = null;
let recorder = null;
try {
  if (!audioSupported) throw new Error('Web Audio API не поддерживается этим браузером / Web Audio API is not supported');
  registerPlugin(ProEQPlugin);
  engine = new AudioEngine({ lowPower: prefs.lowPower, fftSize: prefs.fftSize, maxBands: prefs.maxBands });
  recorder = new Recorder(engine);
  recorder.tapMode = prefs.tap;
} catch (e) {
  console.error(e);
  fatal(e.message);
}

/** Разблокировка аудио первым жестом (iOS/Chrome autoplay policy). Unlock audio on first gesture. */
const unlock = () => { engine?.resume(); };
document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
document.addEventListener('keydown', unlock, { capture: true });

/* ---------------- текущий слот / current slot ---------------- */
let currentSlotId = null;
let presetName = 'Default';

function currentSlot() { return engine?.chain.get(currentSlotId) || null; }
function currentModel() { return currentSlot()?.plugin.model || null; }

let modelListener = null;
function selectSlot(id) {
  const prev = currentModel();
  if (prev && modelListener) prev.removeEventListener('change', modelListener);
  currentSlotId = id;
  const slot = currentSlot();
  const plugin = slot && slot.descriptor.editor === 'eq' ? slot.plugin : null;
  graph.bind(plugin, engine);
  panel.bind(plugin ? plugin.model : null);
  const m = plugin?.model;
  if (m) {
    m.setMaxBands(Math.max(prefs.maxBands, m.bands.length));
    m.settings.linearQuality = prefs.linearQuality;
    modelListener = (e) => onModelChange(e.detail);
    m.addEventListener('change', modelListener);
  }
  $('#app').classList.toggle('no-plugin', !plugin);
  syncEqBar();
  syncHistory();
  renderFxList();
}

function onModelChange(d) {
  if (d.kind === 'history' || d.kind === 'bands') syncHistory();
  if (d.kind === 'settings' || (d.kind === 'bands' && currentModel()?.settings.autoGain)) syncEqBar();
  if (d.kind === 'limit') {
    toast.show(`Лимит полос: ${d.max} · Band limit`, { action: { label: 'Изменить', fn: () => drawer.open() } });
  }
  if (d.kind === 'bands' || d.kind === 'settings') scheduleSave();
}

function syncHistory() {
  const m = currentModel();
  $('#btnUndo').disabled = !m?.canUndo;
  $('#btnRedo').disabled = !m?.canRedo;
}

/* ---------------- сохранение сессии / session persistence ---------------- */
let saveT = 0;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!engine) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ chain: engine.chain.toJSON(), current: engine.chain.slots.findIndex((s) => s.id === currentSlotId), presetName }));
    } catch { /* quota / private mode */ }
  }, 400);
}

function restoreSession() {
  if (!engine) return;
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { /* noop */ }
  if (sess && Array.isArray(sess.chain) && sess.chain.length) {
    for (const s of sess.chain) {
      try {
        const slot = engine.chain.add(s.plugin, s.state);
        if (s.bypass) slot.setBypass(true);
      } catch (e) { console.warn('[session] skip slot', e); }
    }
    presetName = sess.presetName || 'Default';
  }
  if (!engine.chain.slots.length) engine.chain.add('proeq');
  const idx = sess && sess.current >= 0 ? Math.min(sess.current, engine.chain.slots.length - 1) : 0;
  selectSlot(engine.chain.slots[idx].id);
  $('#presetName').textContent = presetName;
}

/* ---------------- FX-цепочка / FX chain UI ---------------- */
function renderFxList() {
  if (!engine) return;
  const list = $('#fxList');
  const tabs = $('#fxTabs');
  list.innerHTML = '';
  tabs.innerHTML = '';
  engine.chain.slots.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'fx-item' + (s.id === currentSlotId ? ' is-current' : '') + (s.bypassed ? ' is-bypassed' : '');
    li.innerHTML = `
      <span class="fx-idx mono">${i + 1}</span>
      <button class="fx-name" data-act="edit">${s.name}</button>
      <button class="icon-btn fx-pw${s.bypassed ? ' is-off' : ''}" data-act="bypass" aria-pressed="${!s.bypassed}" aria-label="Bypass"><svg viewBox="0 0 24 24"><path d="M12 3v8M7 6.5a7 7 0 1 0 10 0"/></svg></button>
      <button class="icon-btn" data-act="up" aria-label="Выше / Move up" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      <button class="icon-btn" data-act="down" aria-label="Ниже / Move down" ${i === engine.chain.slots.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      <button class="icon-btn" data-act="remove" aria-label="Удалить / Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    li.dataset.id = s.id;
    list.appendChild(li);

    const t = document.createElement('button');
    t.className = 'fx-tab' + (s.id === currentSlotId ? ' is-on' : '') + (s.bypassed ? ' is-bypassed' : '');
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(s.id === currentSlotId));
    t.dataset.id = s.id;
    t.textContent = `${i + 1} · ${s.name}`;
    tabs.appendChild(t);
  });
  if (!engine.chain.slots.length) list.innerHTML = '<li class="empty">Цепочка пуста — нажмите «+ FX». Chain is empty.</li>';
  const add = document.createElement('button');
  add.className = 'fx-tab fx-tab-add';
  add.textContent = '+';
  add.setAttribute('aria-label', 'Добавить FX / Add FX');
  add.dataset.add = '1';
  tabs.appendChild(add);
}

$('#fxList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const li = e.target.closest('.fx-item');
  if (!btn || !li) return;
  const id = li.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') { selectSlot(id); setView('eq'); }
  if (act === 'bypass') { const s = engine.chain.get(id); engine.chain.setBypass(id, !s.bypassed); haptics.tick(); }
  if (act === 'up') engine.chain.move(id, -1);
  if (act === 'down') engine.chain.move(id, 1);
  if (act === 'remove') {
    const s = engine.chain.get(id);
    const state = { plugin: s.descriptor.id, state: s.plugin.getState(), index: engine.chain.slots.indexOf(s) };
    engine.chain.remove(id);
    if (id === currentSlotId) selectSlot(engine.chain.slots[0]?.id || null);
    toast.show(`${s.name} удалён · removed`, {
      action: { label: 'Undo', fn: () => { const n = engine.chain.add(state.plugin, state.state, state.index); selectSlot(n.id); } }
    });
  }
  renderFxList();
  scheduleSave();
});

$('#fxTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.fx-tab');
  if (!t) return;
  if (t.dataset.add) { showAddFxMenu(t.getBoundingClientRect()); return; }
  selectSlot(t.dataset.id);
});

function showAddFxMenu(rect) {
  const items = listPlugins().map((d) => ({
    label: `${d.name} <small>${d.category}</small>`,
    fn: () => {
      const s = engine.chain.add(d.id);
      selectSlot(s.id);
      setView('eq');
      toast.show(`${d.name} добавлен в цепочку · added`, { short: true });
      scheduleSave();
    }
  }));
  ctxMenu.show(items, rect.left, rect.bottom + 4);
}
$('#btnAddFx').addEventListener('click', (e) => showAddFxMenu(e.currentTarget.getBoundingClientRect()));
engine?.chain.addEventListener('change', () => { renderFxList(); scheduleSave(); });

/* ---------------- жесты графика / graph gestures ---------------- */
new GraphGestures(graph, {
  unlock,
  openSheet: (b) => panel.open(b),
  closeSheet: () => sheet.set('hidden'),
  openDrawer: () => drawer.open(),
  toast: (msg, o) => toast.show(msg, o),
  zoomChanged: () => { $('#btnZoomReset').hidden = !graph.zoomed; },
  contextMenu: (band, pos, freq, gain) => showGraphMenu(band, pos, freq, gain)
});
graph.addEventListener('zoom', () => {
  $('#btnZoomReset').hidden = !graph.zoomed;
  const r = Math.round(graph.view.range);
  const sel = $('#selRange');
  if (![...sel.options].some((o) => o.value === String(r))) sel.value = '';
  else sel.value = String(r);
});
$('#btnZoomReset').addEventListener('click', () => { graph.resetZoom(); graph.setZoom({ range: prefs.range }); });

function showGraphMenu(band, pos, freq, gain) {
  const m = currentModel();
  if (!m) return;
  let items;
  if (band) {
    const idx = m.bands.indexOf(band) + 1;
    items = [
      ...FILTER_TYPES.map((t) => ({ label: FILTER_LABELS[t], checked: band.type === t, color: band.type === t ? BAND_COLORS[band.color] : '', fn: () => m.updateBand(band.id, { type: t }) })),
      '-',
      { label: band.enabled ? `Bypass полосы ${idx}` : `Включить полосу ${idx}`, fn: () => m.updateBand(band.id, { enabled: !band.enabled }) },
      { label: 'Copy', fn: () => m.copyBand(band.id) },
      { label: 'Paste', disabled: !EQModel.hasClipboard, fn: () => m.pasteBand() },
      { label: 'Reset', fn: () => m.resetBand(band.id) },
      { label: 'Delete', danger: true, fn: () => m.removeBand(band.id) }
    ];
  } else {
    items = [
      ...['bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut', 'notch'].map((t) => ({
        label: `+ ${FILTER_LABELS[t]}`,
        fn: () => {
          const b = m.addBand({ freq, gain: GAINLESS.has(t) ? 0 : Math.max(-30, Math.min(30, gain)), type: t });
          if (b) panel.open(b);
        }
      })),
      '-',
      { label: 'Paste', disabled: !EQModel.hasClipboard, fn: () => m.pasteBand() },
      { label: 'Zoom 1:1', disabled: !graph.zoomed, fn: () => graph.resetZoom() },
      { label: 'Сбросить все · Reset all', danger: true, disabled: !m.bands.length, fn: () => m.resetAll() }
    ];
  }
  ctxMenu.show(items, pos.clientX, pos.clientY);
}

/* ---------------- FAB: добавить полосу / add band ---------------- */
$('#fab').addEventListener('click', () => {
  const m = currentModel();
  if (!m) return;
  // Свободная частота: наибольший «пробел» по октавам / freq in the largest octave gap
  const fs = [20, ...m.bands.map((b) => b.freq).sort((a, b) => a - b), 20000];
  let best = 1000, gap = 0;
  for (let i = 1; i < fs.length; i++) {
    const g = Math.log2(fs[i] / fs[i - 1]);
    if (g > gap) { gap = g; best = Math.sqrt(fs[i] * fs[i - 1]); }
  }
  const b = m.addBand({ freq: m.bands.length ? best : 1000, gain: 0, type: m.bands.length ? autoTypeFor(best) : 'bell' });
  if (b) { haptics.select(); panel.open(b); const p = graph.nodePos(b); graph.ripple(p.x, p.y, BAND_COLORS[b.color]); }
});

/* ---------------- нижняя панель EQ / EQ bar ---------------- */
const outKnob = new Knob('output', {
  onBegin: () => currentModel()?.begin(),
  onChange: (v) => currentModel()?.setSetting('outputGain', Math.round(v * 10) / 10),
  onEnd: () => currentModel()?.commit(),
  getDefault: () => 0
});
$('#outKnob').appendChild(outKnob.root);

function syncEqBar() {
  const m = currentModel();
  const s = m?.settings;
  $('#eqBar').classList.toggle('is-disabled', !m);
  for (const b of document.querySelectorAll('.seg-mode [data-mode]')) {
    const on = s && b.dataset.mode === s.mode;
    b.classList.toggle('is-on', !!on);
    b.setAttribute('aria-checked', String(!!on));
  }
  const setT = (id, on) => { const el = $(id); el.classList.toggle('is-on', !!on); el.setAttribute('aria-pressed', String(!!on)); };
  setT('#tglAuto', s?.autoGain);
  setT('#tglBypass', s?.bypass);
  setT('#tglGrab', s?.grab);
  setT('#tglAnalyzer', graph.analyzer.pre || graph.analyzer.post);
  outKnob.set(s ? s.outputGain : 0);
  outKnob.labelEl.textContent = s?.autoGain ? `Out (auto ${fmtGain(currentSlot().plugin.autoGainDb)})` : 'Output';
}

$('#eqBar').addEventListener('click', (e) => {
  const m = currentModel();
  if (!m) return;
  const mode = e.target.closest('[data-mode]');
  if (mode) {
    m.setSetting('mode', mode.dataset.mode, { history: true });
    haptics.tick();
    if (mode.dataset.mode === 'linear') toast.show('Linear Phase: добавляет задержку · adds latency', { short: true });
  }
  const t = e.target.closest('.tgl');
  if (!t) return;
  if (t.id === 'tglAuto') m.setSetting('autoGain', !m.settings.autoGain, { history: true });
  if (t.id === 'tglBypass') m.setSetting('bypass', !m.settings.bypass);
  if (t.id === 'tglGrab') m.setSetting('grab', !m.settings.grab);
  if (t.id === 'tglAnalyzer') {
    const on = !(graph.analyzer.pre || graph.analyzer.post);
    graph.analyzer.pre = graph.analyzer.post = on;
    $('#optPre').checked = $('#optPost').checked = on;
    prefs.analyzer = { ...graph.analyzer }; savePrefs(prefs);
    graph.dirty.grid = true;
    syncEqBar();
  }
  haptics.tick();
});

$('#selRange').value = String(prefs.range);
$('#selRange').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (!v) return;
  prefs.range = v; savePrefs(prefs);
  graph.setZoom({ range: v });
});

/* ---------------- верхняя панель / top bar ---------------- */
$('#btnUndo').addEventListener('click', () => { currentModel()?.undo(); haptics.tick(); });
$('#btnRedo').addEventListener('click', () => { currentModel()?.redo(); haptics.tick(); });
$('#btnMenu').addEventListener('click', () => drawer.toggle());
$('#btnDrawerClose').addEventListener('click', () => drawer.close());

if (dev.fullscreen) {
  $('#btnFullscreen').hidden = false;
} else {
  // iPhone Safari: Fullscreen API для элементов нет → предлагаем «На экран Домой».
  // iPhone Safari has no element Fullscreen API → suggest "Add to Home Screen".
  $('#btnFullscreen2').textContent = 'Полный экран: «Поделиться → На экран Домой»';
  $('#btnFullscreen2').disabled = true;
}
$('#btnFullscreen').addEventListener('click', () => fullscreen.toggle());
$('#btnFullscreen2').addEventListener('click', () => fullscreen.toggle());
document.addEventListener('fullscreenchange', () => root.classList.toggle('is-fullscreen', fullscreen.active));
document.addEventListener('webkitfullscreenchange', () => root.classList.toggle('is-fullscreen', fullscreen.active));

/* ---------------- навигация (мобильные) / navigation (mobile) ---------------- */
function setView(v) {
  $('#app').dataset.view = v;
  for (const b of document.querySelectorAll('.bottom-nav [data-view]')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (v === 'presets') refreshPresets();
  // График мог быть скрыт — пересчитать размеры / graph may have been hidden — re-measure
  if (v === 'eq') requestAnimationFrame(() => graph.resize());
}
document.querySelector('.bottom-nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  haptics.tick();
  if (b.dataset.nav === 'menu') { drawer.open(); return; }
  setView(b.dataset.view);
});
$('#btnPresets').addEventListener('click', () => setView($('#app').dataset.view === 'presets' ? 'eq' : 'presets'));
$('#btnPresetsClose').addEventListener('click', () => setView('eq'));

watchOrientation((o) => {
  root.dataset.orient = o;
  // Смена ориентации: панель → сбоку (landscape) или снизу (portrait)
  requestAnimationFrame(() => graph.resize());
});

/* ---------------- транспорт / transport ---------------- */
const btnMic = $('#btnMic');
if (!micSupported) {
  btnMic.disabled = true;
  btnMic.title = 'Микрофон требует HTTPS / Microphone needs HTTPS';
}
btnMic.addEventListener('click', async () => {
  if (!engine) return;
  if (engine.mic) { engine.disableMic(); return; }
  try {
    await engine.enableMic($('#selInput').value || undefined);
    haptics.select();
    if (!engine.monitor) toast.show('Микрофон включён. Мониторинг — только в наушниках! · Use headphones for monitoring');
    await fillInputs();
  } catch (e) {
    const msg = e.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён · Mic permission denied'
      : e.name === 'NotFoundError' ? 'Микрофон не найден · No microphone found' : e.message;
    toast.show(msg);
  }
});
/** Список входов в двух местах: транспорт (desktop) и drawer (мобильные). Input list in both places. */
async function fillInputs() {
  const inputs = await engine.listInputs();
  if (inputs.length < 2) return;
  const cur = engine.mic?.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
  const html = inputs.map((d, i) => `<option value="${d.deviceId}">${(d.label || 'Input ' + (i + 1)).replace(/</g, '&lt;')}</option>`).join('');
  for (const sel of [$('#selInput'), $('#optInput')]) {
    sel.innerHTML = html;
    if (cur) sel.value = cur;
  }
  $('#selInput').hidden = false;
}
for (const id of ['#selInput', '#optInput']) {
  $(id).addEventListener('change', async (e) => {
    $('#selInput').value = $('#optInput').value = e.target.value;
    if (!engine?.mic) return;
    try { await engine.enableMic(e.target.value); } catch (err) { toast.show(err.message); }
  });
}

$('#btnMonitor').addEventListener('click', () => { engine?.setMonitor(!engine.monitor); haptics.tick(); });

$('#btnRec').addEventListener('click', async () => {
  if (!recorder) return;
  if (recorder.recording) { recorder.stop(); haptics.select(); return; }
  if (!engine.mic && !engine.player) {
    // Нет источника → включаем микрофон автоматически / no source → enable mic automatically
    try { await engine.enableMic($('#selInput').value || undefined); }
    catch (e) { toast.show(e.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён · Mic permission denied' : e.message); return; }
  }
  await recorder.start();
  haptics.heavy();
});

$('#btnStop').addEventListener('click', () => engine?.stop());

function syncTransport() {
  if (!engine) return;
  btnMic.classList.toggle('is-on', !!engine.mic);
  btnMic.setAttribute('aria-pressed', String(!!engine.mic));
  $('#btnMonitor').classList.toggle('is-on', engine.monitor);
  $('#btnMonitor').setAttribute('aria-pressed', String(engine.monitor));
  $('#btnRec').classList.toggle('is-on', !!recorder?.recording);
  $('#btnRec').setAttribute('aria-pressed', String(!!recorder?.recording));
  $('#app').classList.toggle('is-recording', !!recorder?.recording);
  $('#btnStop').hidden = !engine.player;
  renderTakes();
}
engine?.addEventListener('source', syncTransport);
engine?.addEventListener('monitor', syncTransport);
engine?.addEventListener('playback', syncTransport);
engine?.addEventListener('state', syncTransport);
recorder?.addEventListener('state', syncTransport);
recorder?.addEventListener('takes', renderTakes);

$('#selTap').value = prefs.tap;
$('#selTap').addEventListener('change', (e) => { prefs.tap = e.target.value; savePrefs(prefs); if (recorder) recorder.tapMode = prefs.tap; });
$('#chkLoop').checked = prefs.loop;
$('#chkLoop').addEventListener('change', (e) => { prefs.loop = e.target.checked; savePrefs(prefs); });

/* ---------------- дубли / takes ---------------- */
const fmtDur = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function renderTakes() {
  if (!recorder) return;
  const ul = $('#takeList');
  if (!recorder.takes.length) {
    ul.innerHTML = '<li class="empty">Нет записей. Нажмите ● для записи с микрофона. No takes yet.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const t of [...recorder.takes].reverse()) {
    const playing = engine.player?.takeId === t.id;
    const li = document.createElement('li');
    li.className = 'take' + (playing ? ' is-playing' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="icon-btn take-play" data-act="play" aria-label="${playing ? 'Стоп / Stop' : 'Играть через FX / Play through FX'}">
        ${playing ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>'}
      </button>
      <div class="take-info">
        <button class="take-name" data-act="rename"></button>
        <span class="take-meta mono">${fmtDur(t.duration)} · ${t.wet ? 'wet' : 'dry'} · ${(t.sampleRate / 1000).toFixed(1)} kHz</span>
      </div>
      <button class="icon-btn" data-act="bounce" aria-label="Обработать через FX / Render through FX" title="Render FX"><svg viewBox="0 0 24 24"><path d="M4 12h10M10 6l6 6-6 6M20 5v14"/></svg></button>
      <button class="icon-btn" data-act="download" aria-label="Скачать WAV / Download WAV"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
      <button class="icon-btn" data-act="delete" aria-label="Удалить / Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>`;
    li.querySelector('.take-name').textContent = t.name;
    ul.appendChild(li);
  }
}

$('#takeList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  const li = e.target.closest('.take');
  if (!b || !li || !recorder) return;
  const t = recorder.takes.find((x) => x.id === li.dataset.id);
  if (!t) return;
  const act = b.dataset.act;
  if (act === 'play') {
    await engine.resume();
    if (engine.player?.takeId === t.id) { engine.stop(); return; }
    engine.play(recorder.toBuffer(t), { loop: prefs.loop, takeId: t.id });
    // Чтобы слышать воспроизведение, включаем мониторинг / enable monitoring to hear playback
    if (!engine.monitor) engine.setMonitor(true);
    if (t.wet) toast.show('Дубль уже с FX — эффекты применятся повторно · Take is already wet', { short: true });
  }
  if (act === 'download') downloadBlob(recorder.wav(t), `${t.name.replace(/[^\w\-а-яё ]+/gi, '_')}.wav`);
  if (act === 'delete') { if (engine.player?.takeId === t.id) engine.stop(); recorder.remove(t.id); }
  if (act === 'rename') {
    const n = prompt('Имя дубля / Take name', t.name);
    if (n) recorder.rename(t.id, n);
  }
  if (act === 'bounce') {
    b.disabled = true;
    toast.show('Рендер через FX… · Rendering…', { short: true });
    try {
      const P = (id) => (id === 'proeq' ? ProEQPlugin : null);
      await recorder.bounce(t, engine.chain.toJSON(), P);
      toast.show('Готово: новый дубль с FX · Rendered');
    } catch (err) { toast.show(err.message); }
    b.disabled = false;
  }
});

$('#fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !recorder) return;
  try {
    const t = await recorder.importFile(f);
    toast.show(`Импортировано: ${t.name}`, { short: true });
  } catch (err) { toast.show('Не удалось декодировать файл · Decode failed'); console.error(err); }
});

/* ---------------- цикл UI: метры и таймер / UI loop: meters & timer ---------------- */
const meterIn = $('#meterIn i'), meterOut = $('#meterOut i');
const recTime = $('#recTime');
function uiLoop() {
  requestAnimationFrame(uiLoop);
  if (document.hidden || !engine) return;
  if (engine.running && engine.hasSignal) {
    const lv = engine.levels();
    const toPct = (v) => Math.max(0, Math.min(100, ((20 * Math.log10(v + 1e-9) + 60) / 60) * 100));
    meterIn.style.transform = `scaleX(${toPct(lv.in) / 100})`;
    meterOut.style.transform = `scaleX(${toPct(lv.out) / 100})`;
    meterIn.parentElement.classList.toggle('is-clip', lv.in >= 0.99);
    meterOut.parentElement.classList.toggle('is-clip', lv.out >= 0.99);
  } else {
    meterIn.style.transform = meterOut.style.transform = 'scaleX(0)';
  }
  if (recorder?.recording) recTime.textContent = fmtDur(recorder.elapsed).padStart(7, '0');
  else if (engine.player) recTime.textContent = fmtDur(engine.playPosition).padStart(7, '0');
}

/* ---------------- пресеты / presets ---------------- */
async function refreshPresets() {
  const box = $('#presetList');
  box.innerHTML = '<p class="panel-note">Загрузка… · Loading…</p>';
  let list = [];
  try { list = await presets.list(); } catch (e) { box.innerHTML = `<p class="panel-note">${e.message}</p>`; return; }
  $('#srvStatus').textContent = presets.online ? '● server' : '○ offline';
  $('#srvStatus').classList.toggle('is-online', presets.online);
  const groups = [['Factory', list.filter((p) => p.factory)], ['User', list.filter((p) => !p.factory)]];
  box.innerHTML = '';
  for (const [title, items] of groups) {
    const h = document.createElement('h3');
    h.textContent = title;
    box.appendChild(h);
    if (!items.length) { const p = document.createElement('p'); p.className = 'panel-note'; p.textContent = '—'; box.appendChild(p); continue; }
    for (const p of items) {
      const row = document.createElement('div');
      row.className = 'preset-row';
      row.dataset.id = p.id;
      row.innerHTML = `<button class="preset-load" data-act="load"><b></b><small></small></button>
        <button class="icon-btn" data-act="export" aria-label="Экспорт / Export"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
        ${p.factory ? '' : '<button class="icon-btn" data-act="delete" aria-label="Удалить / Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>'}`;
      row.querySelector('b').textContent = p.name;
      row.querySelector('small').textContent = [p.category, p.author, p.local ? 'local' : ''].filter(Boolean).join(' · ');
      box.appendChild(row);
    }
  }
}

$('#presetList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  const row = e.target.closest('.preset-row');
  if (!b || !row) return;
  const id = row.dataset.id;
  try {
    if (b.dataset.act === 'load') {
      const p = await presets.get(id);
      const m = currentModel();
      if (!m) { toast.show('Нет EQ в цепочке · No EQ in chain'); return; }
      m.loadJSON(p.eq);
      presetName = p.name;
      $('#presetName').textContent = presetName;
      $('#presetNameInput').value = p.factory ? '' : p.name;
      haptics.select();
      toast.show(`Пресет: ${p.name}`, { short: true });
      scheduleSave();
      if (matchMedia('(max-width: 1023px)').matches) setView('eq');
    } else if (b.dataset.act === 'export') {
      presets.exportFile(await presets.get(id));
    } else if (b.dataset.act === 'delete') {
      if (!confirm('Удалить пресет? / Delete preset?')) return;
      await presets.remove(id);
      refreshPresets();
    }
  } catch (err) { toast.show(err.message); }
});

$('#presetSave').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = currentModel();
  if (!m) return;
  const name = $('#presetNameInput').value.trim();
  if (!name) return;
  try {
    const saved = await presets.save({ name, author: 'User', category: 'User', eq: m.toJSON() });
    presetName = saved.name;
    $('#presetName').textContent = presetName;
    toast.show(`Сохранено${presets.online ? '' : ' локально'} · Saved`, { short: true });
    scheduleSave();
    refreshPresets();
  } catch (err) { toast.show(err.message); }
});

$('#btnExportCur').addEventListener('click', () => {
  const m = currentModel();
  if (m) presets.exportFile({ name: $('#presetNameInput').value.trim() || presetName, version: 1, eq: m.toJSON() });
});

$('#presetImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const p = await presets.importFile(f);
    toast.show(`Импортирован: ${p.name}`, { short: true });
    refreshPresets();
  } catch (err) { toast.show(err.message); }
});

/* ---------------- drawer: настройки / settings ---------------- */
function bindOpt(id, get, set) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = get(); else el.value = String(get());
  el.addEventListener('change', () => { set(el.type === 'checkbox' ? el.checked : el.value); savePrefs(prefs); });
}
bindOpt('#optPre', () => graph.analyzer.pre, (v) => { graph.analyzer.pre = v; prefs.analyzer = { ...graph.analyzer }; syncEqBar(); });
bindOpt('#optPost', () => graph.analyzer.post, (v) => { graph.analyzer.post = v; prefs.analyzer = { ...graph.analyzer }; graph.dirty.grid = true; syncEqBar(); });
bindOpt('#optSpeed', () => graph.analyzer.speed, (v) => { graph.analyzer.speed = v; prefs.analyzer = { ...graph.analyzer }; });
bindOpt('#optTilt', () => graph.analyzer.tilt, (v) => { graph.analyzer.tilt = Number(v); prefs.analyzer = { ...graph.analyzer }; });
bindOpt('#optFft', () => prefs.fftSize, (v) => {
  prefs.fftSize = Number(v);
  engine?.chain.slots.forEach((s) => s.plugin.setFftSize?.(prefs.fftSize));
});
bindOpt('#optMaxBands', () => prefs.maxBands, (v) => {
  prefs.maxBands = Number(v);
  engine?.chain.slots.forEach((s) => s.plugin.model?.setMaxBands(Math.max(prefs.maxBands, s.plugin.model.bands.length)));
});
bindOpt('#optLinQ', () => prefs.linearQuality, (v) => {
  prefs.linearQuality = v;
  engine?.chain.slots.forEach((s) => { const m = s.plugin.model; if (m) { m.settings.linearQuality = v; if (m.settings.mode === 'linear') s.plugin._scheduleFir(0); } });
});
bindOpt('#optControls', () => prefs.controls, (v) => { prefs.controls = v; panel.setControlStyle(v); });
bindOpt('#optTheme', () => prefs.theme, (v) => { prefs.theme = v; applyTheme(); requestAnimationFrame(() => graph.refreshTheme()); });
bindOpt('#optHaptics', () => prefs.haptics, (v) => { prefs.haptics = v; haptics.enabled = v; haptics.select(); });
bindOpt('#optLowPower', () => prefs.lowPower, (v) => {
  prefs.lowPower = v;
  root.classList.toggle('low-power', v);
  graph.lowPower = v;
  graph.resize();
});
$('#optHaptics').closest('label').hidden = !dev.vibrate;
$('#btnResetAll').addEventListener('click', () => {
  const m = currentModel();
  if (!m || !m.bands.length) return;
  m.resetAll();
  drawer.close();
  toast.show('Все полосы сброшены · All bands reset', { action: { label: 'Undo', fn: () => m.undo() } });
});
$('#deviceInfo').textContent = `CPU: ${navigator.hardwareConcurrency || '?'} · ${dev.lowPower ? 'low-power' : 'normal'} · ${dev.coarse ? 'touch' : 'mouse'}` +
  (engine ? ` · ${engine.sampleRate} Hz` : '');

/* ---------------- клавиатура / keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const m = currentModel();
  if (!m) return;
  const mod = e.ctrlKey || e.metaKey;
  const sel = m.selected;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? m.redo() : m.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); m.redo(); return; }
  if (mod && e.key.toLowerCase() === 'c' && sel) { m.copyBand(sel.id); toast.show('Copied', { short: true }); return; }
  if (mod && e.key.toLowerCase() === 'v') { m.pasteBand(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !e.target.closest('.ctl')) { e.preventDefault(); m.removeBand(sel.id); return; }
  if (e.key === 'Escape') { m.select(null); ctxMenu.hide(); drawer.close(); return; }
  if (e.key === 'Tab' && m.bands.length && e.target === document.body) {
    e.preventDefault();
    const sorted = [...m.bands].sort((a, b) => a.freq - b.freq);
    const i = sel ? sorted.indexOf(sel) : -1;
    m.select(sorted[(i + (e.shiftKey ? -1 : 1) + sorted.length) % sorted.length].id);
    return;
  }
  if (sel && e.key.startsWith('Arrow') && !e.target.closest('.ctl, .knob-dial')) {
    e.preventDefault();
    const fine = e.shiftKey ? 0.2 : 1;
    if (e.key === 'ArrowLeft') m.updateBand(sel.id, { freq: sel.freq / Math.pow(2, fine / 12) });
    if (e.key === 'ArrowRight') m.updateBand(sel.id, { freq: sel.freq * Math.pow(2, fine / 12) });
    if (e.key === 'ArrowUp') m.updateBand(sel.id, GAINLESS.has(sel.type) ? { q: sel.q * 1.1 } : { gain: sel.gain + 0.5 * fine });
    if (e.key === 'ArrowDown') m.updateBand(sel.id, GAINLESS.has(sel.type) ? { q: sel.q / 1.1 } : { gain: sel.gain - 0.5 * fine });
  }
  if (e.key === 'b' || e.key === 'B') { if (sel) m.updateBand(sel.id, { enabled: !sel.enabled }); }
});

/* ---------------- PWA ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('#btnInstall').hidden = true;
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw] register failed', e));
  });
}

/* ---------------- старт / start ---------------- */
sheet.addEventListener('state', () => panel.render());
sheet.addEventListener('dismiss', () => currentModel()?.select(null));
restoreSession();
recorder?.load();
syncTransport();
graph.start();
uiLoop();
if (location.protocol === 'file:') toast.show('Откройте через http(s):// — ES-модули и микрофон не работают с file://');

// Для отладки из консоли / for console debugging
window.proeq = { engine, graph, recorder, presets, get model() { return currentModel(); } };
