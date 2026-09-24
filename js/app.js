/**
 * app.js — точка входа: связывает аудио-движок, цепочку эффектов, запись, графики, жесты и мобильный UI.
 * app.js — entry point: wires the audio engine, FX chain, recorder, graphs, gestures and mobile UI.
 *
 * Эффекты / Effects: Movexe EQ 24 (eq.js), Movexe DeEss (deesser.js), Movexe EQ Lite (api560.js).
 */
import { AudioEngine, audioSupported, micSupported } from './audio.js';
import { registerPlugin, listPlugins, getPlugin } from './fx-chain.js';
import { ProEQPlugin, EQModel, BAND_COLORS, autoTypeFor } from './eq.js';
import { DeEsserPlugin } from './deesser.js';
import { Recorder } from './recorder.js';
import { EQGraph, fmtGain } from './ui.js';
import { DeEssGraph } from './graph.js';
import { GraphGestures, DeEssGestures } from './gestures.js';
import { DeEssPanel } from './deesser-ui.js';
import { LitePlugin, LITE_MODES } from './api560.js';
import { LiteGraph, FaderBank, LitePanel } from './api560-ui.js';
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
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* приватный режим */ }
}

const dev = detectDevice();
const prefs = Object.assign({
  theme: 'dark', haptics: true, controls: 'knobs',
  maxBands: dev.small ? 8 : 24,          // на телефоне по умолчанию 8 полос
  lowPower: dev.lowPower,
  analyzer: { pre: true, post: true, speed: 'medium', tilt: 4.5 },
  fftSize: dev.lowPower ? 4096 : 8192,
  range: 12,
  linearQuality: 'medium',
  tap: 'wet', loop: false,
  liteScale: 100
}, loadPrefs());

/* ---------------- тема и классы <html> / theme & root classes ---------------- */
const root = document.documentElement;
function applyTheme() {
  // По умолчанию всегда тёмная (как у плагинов FabFilter); «Как в системе» — по желанию.
  // Dark by default; "system" is opt-in.
  if (prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = prefs.theme;
  const light = prefs.theme === 'light' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', light ? '#f0f0f0' : '#1a1a1a');
  document.querySelector('meta[name="color-scheme"]').setAttribute('content', light ? 'light' : 'dark');
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

const dsSheet = new BottomSheet($('#dsSheet'));
const dsPanel = new DeEssPanel($('#dsSheet'), dsSheet, { toast, controlStyle: prefs.controls });
const dsGraph = new DeEssGraph($('#dsGraphWrap'), {
  history: $('#dsHistory'), grBar: $('#dsGrBar'), led: $('#dsLed'),
  grText: $('#dsGrText'), peakText: $('#dsPeakText'), inMeter: $('#dsIn'), outMeter: $('#dsOut')
}, { lowPower: prefs.lowPower });
const liteSheet = new BottomSheet($('#liteSheet'));
const liteGraph = new LiteGraph($('#liteGraphWrap'), { lowPower: prefs.lowPower });
const faderBank = new FaderBank($('#liteBank'), { graph: liteGraph });
/** Масштабируемый интерфейс Lite / scalable Lite GUI */
function applyLiteScale(v) {
  prefs.liteScale = v;
  $('#liteEditor').style.setProperty('--lite-scale', String(v / 100));
  savePrefs(prefs);
  requestAnimationFrame(() => liteGraph.resize());
}
const litePanel = new LitePanel($('#liteSheet'), liteSheet, { toast, onScale: applyLiteScale });
litePanel.setScale(prefs.liteScale);
$('#liteEditor').style.setProperty('--lite-scale', String(prefs.liteScale / 100));
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
  if (!audioSupported) throw new Error('Этот браузер не поддерживает Web Audio API');
  registerPlugin(ProEQPlugin);
  registerPlugin(DeEsserPlugin);
  registerPlugin(LitePlugin);
  engine = new AudioEngine({ lowPower: prefs.lowPower, fftSize: prefs.fftSize, maxBands: prefs.maxBands });
  recorder = new Recorder(engine);
  recorder.tapMode = prefs.tap;
} catch (e) {
  console.error(e);
  fatal(e.message);
}

/** Разблокировка аудио первым жестом (политика автозапуска iOS/Chrome). */
const unlock = () => { engine?.resume(); };
document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
document.addEventListener('keydown', unlock, { capture: true });

/* ---------------- текущий слот / current slot ---------------- */
let currentSlotId = null;
let presetName = 'По умолчанию';

function currentSlot() { return engine?.chain.get(currentSlotId) || null; }
function currentModel() { return currentSlot()?.plugin.model || null; }
function currentEditor() { return currentSlot()?.descriptor.editor || null; }
const isEq = (m) => m instanceof EQModel;

let modelListener = null;
function selectSlot(id) {
  const prev = currentModel();
  if (prev && modelListener) prev.removeEventListener('change', modelListener);
  currentSlotId = id;
  const slot = currentSlot();
  const editor = currentEditor();
  const eqPlugin = editor === 'eq' ? slot.plugin : null;
  const dsPlugin = editor === 'deesser' ? slot.plugin : null;
  const litePlugin = editor === 'lite' ? slot.plugin : null;
  $('#app').dataset.editor = editor || 'none';

  graph.bind(eqPlugin, engine);
  panel.bind(eqPlugin ? eqPlugin.model : null);
  dsGraph.bind(dsPlugin, engine);
  dsPanel.bind(dsPlugin);
  liteGraph.bind(litePlugin, engine);
  faderBank.bind(litePlugin);
  litePanel.bind(litePlugin);
  // Рисуем только видимый график (экономия батареи) / draw only the visible graph
  if (eqPlugin) { graph.start(); requestAnimationFrame(() => graph.resize()); } else { graph.stop(); sheet.set('hidden'); }
  if (dsPlugin) { dsGraph.start(); requestAnimationFrame(() => dsGraph.resize()); dsSheet.set(dsSheet.isSheet ? 'peek' : 'full'); }
  else { dsGraph.stop(); dsSheet.set('hidden'); }
  if (litePlugin) { liteGraph.start(); requestAnimationFrame(() => liteGraph.resize()); liteSheet.set(matchMedia('(min-width: 1024px)').matches ? 'full' : 'hidden'); }
  else { liteGraph.stop(); liteSheet.set('hidden'); }

  const m = slot?.plugin.model;
  if (m) {
    if (isEq(m)) {
      m.setMaxBands(Math.max(prefs.maxBands, m.bands.length));
      m.settings.linearQuality = prefs.linearQuality;
    }
    modelListener = (e) => onModelChange(e.detail);
    m.addEventListener('change', modelListener);
  }
  $('#app').classList.toggle('no-plugin', !slot);
  syncEqBar();
  syncLiteBar();
  syncHistory();
  renderFxList();
  scheduleSave();
}

function onModelChange(d) {
  if (d.kind === 'history' || d.kind === 'bands' || d.kind === 'params') syncHistory();
  if (d.kind === 'settings' || (d.kind === 'bands' && currentModel()?.settings?.autoGain)) syncEqBar();
  if (d.kind === 'limit') {
    toast.show(`Достигнут лимит полос: ${d.max}`, { action: { label: 'Изменить', fn: () => drawer.open() } });
  }
  if (d.kind === 'bands' || d.kind === 'settings' || d.kind === 'params') scheduleSave();
  if (currentEditor() === 'lite' && (d.kind === 'params' || d.kind === 'ab')) syncLiteBar();
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
    } catch { /* переполнение / приватный режим */ }
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
      } catch (e) { console.warn('[session] слот пропущен', e); }
    }
    presetName = sess.presetName && sess.presetName !== 'Default' ? sess.presetName : 'По умолчанию';
  }
  if (!engine.chain.slots.length) engine.chain.add('proeq');
  const idx = sess && sess.current >= 0 ? Math.min(sess.current, engine.chain.slots.length - 1) : 0;
  selectSlot(engine.chain.slots[idx].id);
  $('#presetName').textContent = presetName;
}

/* ---------------- цепочка эффектов / FX chain UI ---------------- */
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
      <button class="icon-btn fx-pw${s.bypassed ? ' is-off' : ''}" data-act="bypass" aria-pressed="${!s.bypassed}" aria-label="Обход" title="Обход"><svg viewBox="0 0 24 24"><path d="M12 3v8M7 6.5a7 7 0 1 0 10 0"/></svg></button>
      <button class="icon-btn" data-act="up" aria-label="Выше" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      <button class="icon-btn" data-act="down" aria-label="Ниже" ${i === engine.chain.slots.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      <button class="icon-btn" data-act="remove" aria-label="Удалить"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
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
  if (!engine.chain.slots.length) list.innerHTML = '<li class="empty">Цепочка пуста — нажмите «+ Эффект».</li>';
  const add = document.createElement('button');
  add.className = 'fx-tab fx-tab-add';
  add.textContent = '+';
  add.setAttribute('aria-label', 'Добавить эффект');
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
    toast.show(`${s.name} удалён из цепочки`, {
      action: { label: 'Отменить', fn: () => { const n = engine.chain.add(state.plugin, state.state, state.index); selectSlot(n.id); } }
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
      toast.show(`${d.name} добавлен в цепочку`, { short: true });
      scheduleSave();
    }
  }));
  ctxMenu.show(items, rect.left, rect.bottom + 4);
}
$('#btnAddFx').addEventListener('click', (e) => showAddFxMenu(e.currentTarget.getBoundingClientRect()));
engine?.chain.addEventListener('change', () => { renderFxList(); scheduleSave(); });

/* ---------------- жесты эквалайзера / EQ gestures ---------------- */
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
  sel.value = [...sel.options].some((o) => o.value === String(r)) ? String(r) : '';
});
$('#btnZoomReset').addEventListener('click', () => { graph.resetZoom(); graph.setZoom({ range: prefs.range }); });

function showGraphMenu(band, pos, freq, gain) {
  const m = currentModel();
  if (!isEq(m)) return;
  let items;
  if (band) {
    const idx = m.bands.indexOf(band) + 1;
    items = [
      ...FILTER_TYPES.map((t) => ({ label: FILTER_LABELS[t], checked: band.type === t, color: band.type === t ? BAND_COLORS[band.color] : '', fn: () => m.updateBand(band.id, { type: t }) })),
      '-',
      { label: band.enabled ? `Выключить полосу ${idx}` : `Включить полосу ${idx}`, fn: () => m.updateBand(band.id, { enabled: !band.enabled }) },
      { label: 'Копировать', fn: () => m.copyBand(band.id) },
      { label: 'Вставить', disabled: !EQModel.hasClipboard, fn: () => m.pasteBand() },
      { label: 'Сбросить', fn: () => m.resetBand(band.id) },
      { label: 'Удалить', danger: true, fn: () => m.removeBand(band.id) }
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
      { label: 'Вставить', disabled: !EQModel.hasClipboard, fn: () => m.pasteBand() },
      { label: 'Масштаб 1:1', disabled: !graph.zoomed, fn: () => graph.resetZoom() },
      { label: 'Сбросить все полосы', danger: true, disabled: !m.bands.length, fn: () => m.resetAll() }
    ];
  }
  ctxMenu.show(items, pos.clientX, pos.clientY);
}

/* FAB эквалайзера: добавить полосу в самый большой «пробел» / EQ FAB: add a band in the largest gap */
$('#fab').addEventListener('click', () => {
  const m = currentModel();
  if (!isEq(m)) return;
  const fs = [20, ...m.bands.map((b) => b.freq).sort((a, b) => a - b), 20000];
  let best = 1000, gap = 0;
  for (let i = 1; i < fs.length; i++) {
    const g = Math.log2(fs[i] / fs[i - 1]);
    if (g > gap) { gap = g; best = Math.sqrt(fs[i] * fs[i - 1]); }
  }
  const b = m.addBand({ freq: m.bands.length ? best : 1000, gain: 0, type: m.bands.length ? autoTypeFor(best) : 'bell' });
  if (b) { haptics.select(); panel.open(b); const p = graph.nodePos(b); graph.ripple(p.x, p.y, BAND_COLORS[b.color]); }
});

/* ---------------- де-эссер: жесты и FAB / de-esser: gestures & FAB ---------------- */
new DeEssGestures(dsGraph, {
  unlock,
  openSheet: () => dsPanel.open(),
  toast: (msg, o) => toast.show(msg, o)
});

$('#dsFab').addEventListener('click', (e) => {
  const m = currentModel();
  if (!m || isEq(m)) return;
  const p = m.params;
  const r = e.currentTarget.getBoundingClientRect();
  ctxMenu.show([
    { label: 'Прослушать удаляемое', checked: p.audition, color: p.audition ? 'var(--ds)' : '', fn: () => m.set({ audition: !p.audition }, { history: false }) },
    { label: 'Обход', checked: p.bypass, color: p.bypass ? '#f5a524' : '', fn: () => m.set({ bypass: !p.bypass }, { history: false }) },
    { label: 'Автопорог', checked: p.autoThreshold, color: p.autoThreshold ? 'var(--ds)' : '', fn: () => m.set({ autoThreshold: !p.autoThreshold }) },
    { label: 'Автоуровень', checked: p.autoLevel, color: p.autoLevel ? 'var(--ds)' : '', fn: () => m.set({ autoLevel: !p.autoLevel }) },
    '-',
    { label: 'Открыть все параметры', fn: () => dsSheet.set('full') },
    { label: 'Сбросить частоту и порог', fn: () => m.reset(['frequency', 'threshold']) }
  ], r.left - 170, r.top - 330);
  haptics.tick();
});

/* ---------------- Movexe EQ Lite: панель, FAB / bar & FAB ---------------- */
function syncLiteBar() {
  const m = currentModel();
  if (currentEditor() !== 'lite' || !m) return;
  const p = m.params;
  const io = $('#liteInOut');
  io.textContent = p.bypass ? 'OUT' : 'IN';
  io.setAttribute('aria-pressed', String(!p.bypass));
  for (const b of document.querySelectorAll('.lite-ab [data-ab]')) b.classList.toggle('is-on', b.dataset.ab === m.ab.active);
  for (const b of document.querySelectorAll('.lite-mode [data-mode]')) {
    b.classList.toggle('is-on', b.dataset.mode === p.mode);
    b.setAttribute('aria-checked', String(b.dataset.mode === p.mode));
  }
}
document.querySelector('.lite-bar').addEventListener('click', (e) => {
  const m = currentModel();
  if (currentEditor() !== 'lite' || !m) return;
  if (e.target.closest('#liteInOut')) { m.set({ bypass: !m.params.bypass }, { history: false }); haptics.heavy(); }
  const ab = e.target.closest('[data-ab]');
  if (ab && ab.dataset.ab !== m.ab.active) { m.switchAB(); haptics.tick(); toast.show(`Слот ${m.ab.active}`, { short: true }); }
  const md = e.target.closest('[data-mode]');
  if (md && LITE_MODES.includes(md.dataset.mode)) { m.set({ mode: md.dataset.mode }); haptics.tick(); }
  // Телефон и планшет: кнопка открывает/закрывает панель; ПК: панель всегда видна
  if (e.target.closest('#liteSettings')) {
    const desktop = matchMedia('(min-width: 1024px)').matches;
    liteSheet.set(liteSheet.state !== 'hidden' && !desktop ? 'hidden' : 'full');
  }
});
$('#liteFab').addEventListener('click', () => {
  const m = currentModel();
  if (currentEditor() !== 'lite' || !m) return;
  m.resetAll();
  haptics.heavy();
  toast.show('Все полосы сброшены в 0 дБ', { action: { label: 'Отменить', fn: () => m.undo() } });
});

/* ---------------- нижняя панель эквалайзера / EQ bar ---------------- */
const outKnob = new Knob('output', {
  onBegin: () => currentModel()?.begin(),
  onChange: (v) => { const m = currentModel(); if (isEq(m)) m.setSetting('outputGain', Math.round(v * 10) / 10); },
  onEnd: () => currentModel()?.commit(),
  getDefault: () => 0
});
$('#outKnob').appendChild(outKnob.root);

function syncEqBar() {
  const m = currentModel();
  const s = isEq(m) ? m.settings : null;
  $('#eqBar').classList.toggle('is-disabled', !s);
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
  outKnob.labelEl.textContent = s?.autoGain ? `Выход (авто ${fmtGain(currentSlot().plugin.autoGainDb)})` : 'Выход';
}

$('#eqBar').addEventListener('click', (e) => {
  const m = currentModel();
  if (!isEq(m)) return;
  const mode = e.target.closest('[data-mode]');
  if (mode) {
    m.setSetting('mode', mode.dataset.mode, { history: true });
    haptics.tick();
    if (mode.dataset.mode === 'linear') toast.show('Линейная фаза добавляет задержку', { short: true });
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
function resizeGraphs() {
  requestAnimationFrame(() => { graph.resize(); dsGraph.resize(); liteGraph.resize(); });
}
function setView(v) {
  $('#app').dataset.view = v;
  for (const b of document.querySelectorAll('.bottom-nav [data-view]')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (v === 'presets') refreshPresets();
  if (v === 'eq') resizeGraphs(); // график мог быть скрыт / the graph may have been hidden
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
  // Поворот: панель переезжает вниз (портрет) или вбок (альбом) — пересчитать графики
  resizeGraphs();
});
liteSheet.addEventListener('state', () => litePanel.render());

/* ---------------- транспорт / transport ---------------- */
const btnMic = $('#btnMic');
if (!micSupported) {
  btnMic.disabled = true;
  btnMic.title = 'Для микрофона нужен HTTPS';
}
const micError = (e) => (e.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён'
  : e.name === 'NotFoundError' ? 'Микрофон не найден' : e.message);

btnMic.addEventListener('click', async () => {
  if (!engine) return;
  if (engine.mic) { engine.disableMic(); return; }
  try {
    await engine.enableMic($('#selInput').value || undefined);
    haptics.select();
    if (!engine.monitor) toast.show('Микрофон включён. Для мониторинга используйте наушники!');
    await fillInputs();
  } catch (e) {
    toast.show(micError(e));
  }
});
/** Список входов в двух местах: транспорт (компьютер) и drawer (телефон). */
async function fillInputs() {
  const inputs = await engine.listInputs();
  if (inputs.length < 2) return;
  const cur = engine.mic?.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
  const html = inputs.map((d, i) => `<option value="${d.deviceId}">${(d.label || 'Вход ' + (i + 1)).replace(/</g, '&lt;')}</option>`).join('');
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
    try { await engine.enableMic(e.target.value); } catch (err) { toast.show(micError(err)); }
  });
}

$('#btnMonitor').addEventListener('click', () => { engine?.setMonitor(!engine.monitor); haptics.tick(); });

$('#btnRec').addEventListener('click', async () => {
  if (!recorder) return;
  if (recorder.recording) { recorder.stop(); haptics.select(); return; }
  if (!engine.mic && !engine.player) {
    // Нет источника → включаем микрофон автоматически
    try { await engine.enableMic($('#selInput').value || undefined); }
    catch (e) { toast.show(micError(e)); return; }
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

/* ---------------- записи / takes ---------------- */
const fmtDur = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function renderTakes() {
  if (!recorder) return;
  const ul = $('#takeList');
  if (!recorder.takes.length) {
    ul.innerHTML = '<li class="empty">Записей пока нет. Нажмите ●, чтобы записать звук с микрофона.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const t of [...recorder.takes].reverse()) {
    const playing = engine.player?.takeId === t.id;
    const li = document.createElement('li');
    li.className = 'take' + (playing ? ' is-playing' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="icon-btn take-play" data-act="play" aria-label="${playing ? 'Стоп' : 'Воспроизвести через эффекты'}">
        ${playing ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>'}
      </button>
      <div class="take-info">
        <button class="take-name" data-act="rename" title="Переименовать"></button>
        <span class="take-meta mono">${fmtDur(t.duration)} · ${t.wet ? 'с эффектами' : 'без эффектов'} · ${(t.sampleRate / 1000).toFixed(1)} кГц</span>
      </div>
      <button class="icon-btn" data-act="bounce" aria-label="Обработать эффектами" title="Обработать эффектами"><svg viewBox="0 0 24 24"><path d="M4 12h10M10 6l6 6-6 6M20 5v14"/></svg></button>
      <button class="icon-btn" data-act="download" aria-label="Скачать WAV" title="Скачать WAV"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
      <button class="icon-btn" data-act="delete" aria-label="Удалить" title="Удалить"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>`;
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
    // Чтобы слышать воспроизведение, включаем мониторинг
    if (!engine.monitor) engine.setMonitor(true);
    if (t.wet) toast.show('Запись уже с эффектами — они применятся повторно', { short: true });
  }
  if (act === 'download') downloadBlob(recorder.wav(t), `${t.name.replace(/[^\w\-а-яё ]+/gi, '_')}.wav`);
  if (act === 'delete') { if (engine.player?.takeId === t.id) engine.stop(); recorder.remove(t.id); }
  if (act === 'rename') {
    const n = prompt('Название записи', t.name);
    if (n) recorder.rename(t.id, n);
  }
  if (act === 'bounce') {
    b.disabled = true;
    toast.show('Обработка эффектами…', { short: true });
    try {
      await recorder.bounce(t, engine.chain.toJSON(), getPlugin);
      toast.show('Готово: добавлена запись с эффектами');
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
  } catch (err) { toast.show('Не удалось прочитать аудиофайл'); console.error(err); }
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
  if (currentEditor() === 'deesser') dsPanel.tick();
  if (currentEditor() === 'lite') faderBank.meters(engine);
}

/* ---------------- пресеты / presets ---------------- */
const CAT_LABELS = {
  Custom: 'Свои', User: 'Свои', Vocal: 'Вокал', Voice: 'Голос', Podcast: 'Подкаст', Rap: 'Рэп', Pop: 'Поп', Rock: 'Рок',
  Mix: 'Сведение', Master: 'Мастеринг', Instrument: 'Инструменты', Repair: 'Реставрация', FX: 'Эффекты',
  Snare: 'Малый барабан', Kick: 'Бочка', Guitar: 'Гитара', Bass: 'Бас', Room: 'Комната'
};
const CATEGORIES = {
  eq: ['Custom', 'Vocal', 'Podcast', 'Mix', 'Master', 'Instrument', 'Repair', 'FX'],
  deesser: ['Custom', 'Vocal', 'Podcast', 'Rap', 'Pop', 'Rock'],
  lite: ['Custom', 'Vocal', 'Snare', 'Kick', 'Guitar', 'Bass', 'Room']
};
/** Тип пресетов для текущего эффекта: 'eq' | 'deesser' | 'lite'. */
const presetKind = () => ({ deesser: 'deesser', lite: 'lite' }[currentEditor()] || 'eq');

async function refreshPresets() {
  const box = $('#presetList');
  const kind = presetKind();
  $('#presetsFor').textContent = `Для эффекта: ${currentSlot()?.name || '—'}`;
  const cat = $('#presetCategory');
  cat.innerHTML = CATEGORIES[kind].map((c) => `<option value="${c}">${CAT_LABELS[c]}</option>`).join('');
  box.innerHTML = '<p class="panel-note">Загрузка…</p>';
  let list = [];
  try { list = await presets.list(kind); } catch (e) { box.innerHTML = `<p class="panel-note">${e.message}</p>`; return; }
  $('#srvStatus').textContent = presets.online ? '● сервер' : '○ офлайн';
  $('#srvStatus').classList.toggle('is-online', presets.online);
  const groups = [['Заводские', list.filter((p) => p.factory)], ['Мои', list.filter((p) => !p.factory)]];
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
        <button class="icon-btn" data-act="export" aria-label="Экспорт" title="Экспорт"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
        ${p.factory ? '' : '<button class="icon-btn" data-act="delete" aria-label="Удалить" title="Удалить"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>'}`;
      row.querySelector('b').textContent = p.name;
      row.querySelector('small').textContent = [CAT_LABELS[p.category] || p.category, p.author === 'Factory' ? 'Movexe' : p.author, p.local ? 'на устройстве' : ''].filter(Boolean).join(' · ');
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
      const p = await presets.get(id, presetKind());
      const m = currentModel();
      if (!m) { toast.show('В цепочке нет эффекта'); return; }
      if (isEq(m)) m.loadJSON(p.eq); else m.loadJSON(p);
      presetName = p.name;
      $('#presetName').textContent = presetName;
      $('#presetNameInput').value = p.factory ? '' : p.name;
      haptics.select();
      toast.show(`Пресет: ${p.name}`, { short: true });
      scheduleSave();
      if (matchMedia('(max-width: 1023px)').matches) setView('eq');
    } else if (b.dataset.act === 'export') {
      presets.exportFile(await presets.get(id, presetKind()));
    } else if (b.dataset.act === 'delete') {
      if (!confirm('Удалить пресет?')) return;
      await presets.remove(id);
      refreshPresets();
    }
  } catch (err) { toast.show(err.message); }
});

/** Текущее состояние эффекта в формате пресета / current effect state as a preset. */
function currentPreset(name, category) {
  const m = currentModel();
  if (!m) return null;
  if (isEq(m)) return { name, author: 'User', category, plugin: 'eq', version: 1, eq: m.toJSON() };
  const { ab, ...state } = m.toJSON();
  return { name, author: 'User', category, plugin: presetKind(), version: 1, ...state };
}

$('#presetSave').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#presetNameInput').value.trim();
  const preset = currentPreset(name, $('#presetCategory').value);
  if (!name || !preset) return;
  try {
    const saved = await presets.save(preset);
    presetName = saved.name;
    $('#presetName').textContent = presetName;
    toast.show(presets.online ? 'Пресет сохранён' : 'Пресет сохранён на устройстве', { short: true });
    scheduleSave();
    refreshPresets();
  } catch (err) { toast.show(err.message); }
});

$('#btnExportCur').addEventListener('click', () => {
  const p = currentPreset($('#presetNameInput').value.trim() || presetName, $('#presetCategory').value || 'Custom');
  if (p) presets.exportFile(p);
});

$('#presetImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const p = await presets.importFile(f, presetKind());
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
bindOpt('#optTilt', () => graph.analyzer.tilt, (v) => {
  graph.analyzer.tilt = Number(v); prefs.analyzer = { ...graph.analyzer };
  dsGraph.specIn.tilt = dsGraph.specOut.tilt = Number(v);
});
bindOpt('#optFft', () => prefs.fftSize, (v) => {
  prefs.fftSize = Number(v);
  engine?.chain.slots.forEach((s) => s.plugin.setFftSize?.(prefs.fftSize));
});
bindOpt('#optMaxBands', () => prefs.maxBands, (v) => {
  prefs.maxBands = Number(v);
  engine?.chain.slots.forEach((s) => { const m = s.plugin.model; if (isEq(m)) m.setMaxBands(Math.max(prefs.maxBands, m.bands.length)); });
});
bindOpt('#optLinQ', () => prefs.linearQuality, (v) => {
  prefs.linearQuality = v;
  engine?.chain.slots.forEach((s) => { const m = s.plugin.model; if (isEq(m)) { m.settings.linearQuality = v; if (m.settings.mode === 'linear') s.plugin._scheduleFir(0); } });
});
bindOpt('#optControls', () => prefs.controls, (v) => { prefs.controls = v; panel.setControlStyle(v); dsPanel.setControlStyle(v); });
bindOpt('#optTheme', () => prefs.theme, (v) => {
  prefs.theme = v; applyTheme();
  requestAnimationFrame(() => { graph.refreshTheme(); dsGraph.refreshTheme(); liteGraph.refreshTheme(); });
});
bindOpt('#optHaptics', () => prefs.haptics, (v) => { prefs.haptics = v; haptics.enabled = v; haptics.select(); });
bindOpt('#optLowPower', () => prefs.lowPower, (v) => {
  prefs.lowPower = v;
  root.classList.toggle('low-power', v);
  graph.lowPower = dsGraph.lowPower = liteGraph.lowPower = v;
  resizeGraphs();
});
liteSheet.addEventListener('state', () => litePanel.render());
$('#optHaptics').closest('label').hidden = !dev.vibrate;
$('#btnResetAll').addEventListener('click', () => {
  const m = currentModel();
  if (!m) return;
  if (isEq(m)) { if (!m.bands.length) return; m.resetAll(); }
  else if (currentEditor() === 'lite') m.resetAll();
  else { const { audition, bypass, ...rest } = m.params; void audition; void bypass; m.reset(Object.keys(rest)); }
  drawer.close();
  toast.show('Эффект сброшен', { action: { label: 'Отменить', fn: () => m.undo() } });
});
$('#deviceInfo').textContent = `Ядер CPU: ${navigator.hardwareConcurrency || '?'} · ${dev.lowPower ? 'экономный режим' : 'обычный режим'} · ${dev.coarse ? 'сенсор' : 'мышь'}` +
  (engine ? ` · ${engine.sampleRate} Гц` : '');

/* ---------------- клавиатура / keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const m = currentModel();
  if (!m) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? m.redo() : m.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); m.redo(); return; }
  if (e.key === 'Escape') { ctxMenu.hide(); drawer.close(); }
  if (currentEditor() === 'lite') {
    if (e.key === 'b' || e.key === 'B') m.set({ bypass: !m.params.bypass }, { history: false });
    return;
  }
  if (!isEq(m)) {
    // Де-эссер: B — обход, A — прослушивание / de-esser: B bypass, A audition
    if (e.key === 'b' || e.key === 'B') m.set({ bypass: !m.params.bypass }, { history: false });
    if (e.key === 'a' || e.key === 'A') m.set({ audition: !m.params.audition }, { history: false });
    return;
  }
  const sel = m.selected;
  if (mod && e.key.toLowerCase() === 'c' && sel) { m.copyBand(sel.id); toast.show('Скопировано', { short: true }); return; }
  if (mod && e.key.toLowerCase() === 'v') { m.pasteBand(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !e.target.closest('.ctl')) { e.preventDefault(); m.removeBand(sel.id); return; }
  if (e.key === 'Escape') { m.select(null); return; }
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
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw] не удалось зарегистрировать', e));
  });
}

/* ---------------- старт / start ---------------- */
sheet.addEventListener('state', () => panel.render());
sheet.addEventListener('dismiss', () => { const m = currentModel(); if (isEq(m)) m.select(null); });
dsSheet.addEventListener('state', () => dsPanel.render());
restoreSession();
recorder?.load();
syncTransport();
uiLoop();
if (location.protocol === 'file:') toast.show('Откройте через http(s):// — ES-модули и микрофон не работают с file://');

// Для отладки из консоли / for console debugging
window.proeq = { engine, graph, dsGraph, liteGraph, recorder, presets, get model() { return currentModel(); } };
