/**
 * denoise-ui.js — панель Movexe DeNoise (bottom sheet / сбоку / под графиком), панель
 * режимов и инструментов под графиком, индикаторы (GR, LED, вход/выход).
 * denoise-ui.js — Movexe DeNoise panel, mode/tool bar under the graph, meters.
 */
import { DN_PARAMS, DN_DEFAULTS, DN_LABELS, DN_ENUMS } from './spectral.js';
import { Knob, HSlider } from './mobile-ui.js';
import { haptics } from './touch.js';
import { BRUSH_LABELS, TARGET_LABELS } from './spectral-editor.js';

const ms = (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' мс';
const pct = (v) => v.toFixed(0) + ' %';
export const DN_FORMAT = {
  reduction: (v) => v.toFixed(1) + ' дБ', threshold: (v) => v.toFixed(1) + ' дБ',
  attack: ms, release: ms,
  smoothing: pct, artifactControl: pct, tone: pct, lowCut: pct, highCut: pct, stereoLink: pct, mix: pct,
  outputGain: (v) => (v > 0.05 ? '+' : v < -0.05 ? '−' : '') + Math.abs(v).toFixed(1) + ' дБ',
  learnSeconds: (v) => v.toFixed(1) + ' с'
};
const KNOBS = ['reduction', 'threshold', 'attack', 'release', 'smoothing', 'artifactControl', 'tone', 'lowCut', 'highCut', 'stereoLink', 'mix', 'outputGain'];

const seg = (key, label) => `
  <div class="opt"><span>${label}</span>
    <div class="seg" role="radiogroup" aria-label="${label}" data-seg="${key}">
      ${DN_ENUMS[key].map((v) => `<button type="button" role="radio" data-v="${v}">${DN_LABELS[v]}</button>`).join('')}
    </div>
  </div>`;

export class DenoisePanel {
  constructor(root, sheet, { toast, controlStyle = 'knobs', actions }) {
    this.root = root;
    this.sheet = sheet;
    this.toast = toast;
    this.actions = actions;    // { saveProfileFile, loadProfileFile, learnFromFile }
    this.controlStyle = controlStyle;
    this.model = null;
    this.head = root.querySelector('.band-head');
    this.body = root.querySelector('.band-body');
    this._build();
  }

  bind(plugin) {
    if (this.model && this._on) this.model.removeEventListener('change', this._on);
    this.plugin = plugin;
    this.model = plugin ? plugin.model : null;
    if (this.model) { this._on = (e) => { if (e.detail.kind !== 'learn') this.render(); }; this.model.addEventListener('change', this._on); }
    this.render();
  }

  open() { if (this.sheet.isSheet) { if (this.sheet.state === 'hidden') this.sheet.set('peek'); } else this.sheet.set('full'); }
  setControlStyle(s) { this.controlStyle = s; this._buildControls(); this.render(); }

  _build() {
    this.head.innerHTML = `
      <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
      <div class="band-head-row ds-head" data-sheet-handle>
        <span class="ds-led" data-led aria-hidden="true"></span>
        <div class="band-title"><div class="band-type">Movexe DeNoise</div><div class="band-sum mono" data-sum></div></div>
        <button class="tgl tgl-bypass ds-quick" data-toggle="bypass" aria-pressed="false">Обход</button>
        <button class="icon-btn" data-act="expand" aria-label="Развернуть"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      </div>`;
    this.body.innerHTML = `
      <div class="opt-row dn-modes">
        ${seg('algorithm', 'Алгоритм')}
        ${seg('frequencyRange', 'Диапазон')}
        ${seg('channelMode', 'Каналы')}
      </div>
      <div class="ctl-row dn-knobs"></div>
      <div class="act-row">
        <button type="button" class="tgl" data-toggle="adaptive" title="Следить за изменением шума (Minimum Statistics)">Адаптивный</button>
        <button type="button" class="tgl" data-toggle="freeze" title="Заморозить оценку шума">Заморозить</button>
        <label class="opt dn-learnsec"><span>Длительность обучения</span>
          <select data-sel="learnSeconds">${[2, 3, 4, 5].map((s) => `<option value="${s}">${s} с</option>`).join('')}</select>
        </label>
      </div>
      <div class="act-row">
        <button type="button" class="chip-btn" data-act="saveProfile">Профиль в файл</button>
        <label class="chip-btn" for="dnProfileFile">Профиль из файла</label>
        <label class="chip-btn" for="dnLearnFile">Обучить по аудиофайлу</label>
        <button type="button" class="chip-btn is-danger" data-act="resetCurves">Сбросить кривые</button>
      </div>
      <input type="file" id="dnProfileFile" accept=".json,application/json" hidden>
      <input type="file" id="dnLearnFile" accept="audio/*" hidden>
      <p class="panel-note">Сначала нажмите «Обучение», пока звучит только шум (2–5 с), затем «Подавление».
        Без профиля шум оценивается автоматически. Рисуйте пальцем по графику: белая линия — глубина подавления,
        оранжевая — профиль шума (переключение и кисти — долгим нажатием).</p>`;
    this.root.addEventListener('click', (e) => this._click(e));
    this.body.querySelector('[data-sel="learnSeconds"]').addEventListener('change', (e) => this.model?.set({ learnSeconds: Number(e.target.value) }));
    this.body.querySelector('#dnProfileFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.actions.loadProfileFile(f); });
    this.body.querySelector('#dnLearnFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.actions.learnFromFile(f); });
    this._buildControls();
  }

  _click(e) {
    const m = this.model;
    if (!m) return;
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const k = t.dataset.toggle;
      m.set({ [k]: !m.params[k] }, { history: k !== 'bypass' && k !== 'freeze' });
      haptics.tick();
      return;
    }
    const s = e.target.closest('[data-seg] [data-v]');
    if (s) { m.set({ [s.closest('[data-seg]').dataset.seg]: s.dataset.v }); haptics.tick(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'expand') this.sheet.set(this.sheet.state === 'full' ? 'peek' : 'full');
    if (a.dataset.act === 'saveProfile') this.actions.saveProfileFile();
    if (a.dataset.act === 'resetCurves') {
      m.begin(); m.setCurve('reduction', null); m.setCurve('profile', null); m.commit();
      this.toast.show('Кривые сброшены', { action: { label: 'Отменить', fn: () => m.undo() } });
    }
  }

  _buildControls() {
    const row = this.body.querySelector('.dn-knobs');
    row.innerHTML = '';
    row.dataset.style = this.controlStyle;
    const C = this.controlStyle === 'sliders' ? HSlider : Knob;
    this.ctl = {};
    for (const key of KNOBS) {
      const c = new C({ id: key, ...DN_PARAMS[key], fmt: DN_FORMAT[key] }, {
        onBegin: () => this.model?.begin(),
        onChange: (v) => this.model?.set({ [key]: v }),
        onEnd: () => this.model?.commit(),
        getDefault: () => DN_DEFAULTS[key]
      });
      c.setColor('var(--ds)');
      this.ctl[key] = c;
      row.appendChild(c.root);
    }
  }

  render() {
    const m = this.model;
    if (!m) return;
    const p = m.params;
    for (const key of KNOBS) this.ctl[key].set(p[key], key === 'stereoLink' && (p.channelMode === 'left-right' || p.channelMode === 'mono'));
    for (const g of this.root.querySelectorAll('[data-seg]')) {
      for (const b of g.querySelectorAll('[data-v]')) {
        const on = p[g.dataset.seg] === b.dataset.v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    for (const t of this.root.querySelectorAll('[data-toggle]')) {
      t.classList.toggle('is-on', !!p[t.dataset.toggle]);
      t.setAttribute('aria-pressed', String(!!p[t.dataset.toggle]));
    }
    this.body.querySelector('[data-sel="learnSeconds"]').value = String(Math.round(p.learnSeconds));
    this.head.querySelector('[data-sum]').textContent = `${DN_LABELS[p.mode]} · ${DN_LABELS[p.algorithm]} · −${p.reduction.toFixed(0)} дБ`;
    this.head.querySelector('[data-act="expand"]').classList.toggle('is-flipped', this.sheet.state === 'full');
  }

  /** Каждый кадр: LED / every frame: LED. */
  tick() {
    if (!this.plugin) return;
    this.head.querySelector('[data-led]').classList.toggle('is-on', this.plugin.meters.gr > 1 && !this.model.params.bypass);
  }
}

/* ================================================================== *
 *  Панель режимов и инструментов под графиком / mode & tool bar
 * ================================================================== */
export class DenoiseBar {
  constructor(root, side, { onLearn, onMode, onSettings, onZoomReset }) {
    this.root = root;
    this.side = side;
    this.model = null;
    root.addEventListener('click', (e) => {
      const m = this.model;
      if (!m) return;
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode === 'learn') onLearn();
      else if (b.dataset.mode) onMode(b.dataset.mode);
      if (b.dataset.brush) { m.setTool({ brush: b.dataset.brush }); haptics.tick(); }
      if (b.dataset.target) { m.setTool({ target: b.dataset.target }); haptics.tick(); }
      if (b.dataset.act === 'freeze') { m.set({ freeze: !m.params.freeze }, { history: false }); haptics.tick(); }
      if (b.dataset.act === 'settings') onSettings();
      if (b.dataset.act === 'zoom') onZoomReset();
    });
  }

  bind(plugin) {
    if (this.model && this._on) this.model.removeEventListener('change', this._on);
    this.plugin = plugin;
    this.model = plugin ? plugin.model : null;
    if (this.model) { this._on = () => this.render(); this.model.addEventListener('change', this._on); }
    this.render();
  }

  render(zoomed = this._zoomed) {
    this._zoomed = zoomed;
    const m = this.model;
    if (!m) return;
    const p = m.params, learning = m.learnProgress >= 0;
    for (const b of this.root.querySelectorAll('[data-mode]')) {
      const on = b.dataset.mode === 'learn' ? learning : !learning && (b.dataset.mode === 'adaptive' ? p.adaptive || p.mode === 'adaptive' : p.mode === 'reduce' && !p.adaptive);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const lb = this.root.querySelector('[data-mode="learn"]');
    lb.textContent = learning ? `Стоп ${Math.round(m.learnProgress * 100)}%` : 'Обучение';
    for (const b of this.root.querySelectorAll('[data-brush]')) b.classList.toggle('is-on', b.dataset.brush === m.brush);
    for (const b of this.root.querySelectorAll('[data-target]')) b.classList.toggle('is-on', b.dataset.target === m.target);
    this.root.querySelector('[data-act="freeze"]').classList.toggle('is-on', p.freeze);
    this.root.querySelector('[data-act="zoom"]').hidden = !zoomed;
  }

  /** Индикаторы сбоку (каждый кадр) / side meters (every frame). */
  meters(engine) {
    if (!this.plugin) return;
    const mt = this.plugin.meters;
    const live = engine?.running && engine.hasSignal && mt.t && performance.now() - mt.t < 500;
    const gr = live ? mt.gr : 0;
    this._gr = gr > (this._gr || 0) ? gr : (this._gr || 0) * 0.92 + gr * 0.08;
    const s = this.side;
    s.led.classList.toggle('is-on', this._gr > 1 && !this.model.params.bypass);
    const t = (this._gr > 0.05 ? '−' : '') + this._gr.toFixed(1);
    if (s.grText.textContent !== t) s.grText.textContent = t;
    s.grBar.style.transform = `scaleY(${Math.min(1, this._gr / 40).toFixed(3)})`;
    const lvl = (el, v) => { el.style.transform = `scaleY(${Math.max(0, Math.min(1, (20 * Math.log10((live ? v : 0) + 1e-9) + 60) / 60)).toFixed(3)})`; };
    lvl(s.inMeter, mt.inPk);
    lvl(s.outMeter, mt.outPk);
  }
}
