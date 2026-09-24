/**
 * deesser-ui.js — панель управления Movexe DeEss: режимы, крутилки/слайдеры, переключатели.
 * deesser-ui.js — Movexe DeEss control panel: modes, knobs/sliders, toggles.
 *
 * Панель живёт в bottom sheet (телефон, портрет), сбоку (телефон, альбом) или под графиком
 * (планшет/десктоп). Выбранный параметр подсвечивается; long press по крутилке — сброс.
 */
import { DS_PARAMS, DS_DEFAULTS, DS_LABELS } from './detection.js';
import { Knob, HSlider } from './mobile-ui.js';
import { fmtHz, fmtDb } from './graph.js';
import { haptics } from './touch.js';

const ms = (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' мс';

/** Форматирование значений / value formatting. */
export const DS_FORMAT = {
  frequency: (v) => fmtHz(v),
  threshold: (v) => fmtDb(v),
  range: (v) => v.toFixed(1) + ' дБ',
  knee: (v) => v.toFixed(1) + ' дБ',
  attack: ms,
  release: ms,
  lookahead: ms,
  outputGain: (v) => fmtDb(v),
  mix: (v) => v.toFixed(0) + ' %',
  stereoLink: (v) => v.toFixed(0) + ' %'
};

const KNOBS = ['frequency', 'threshold', 'range', 'knee', 'attack', 'release', 'lookahead', 'outputGain', 'mix', 'stereoLink'];

const seg = (key, values, label) => `
  <div class="opt"><span>${label}</span>
    <div class="seg" role="radiogroup" aria-label="${label}" data-seg="${key}">
      ${values.map(([v, t]) => `<button type="button" role="radio" data-v="${v}">${t}</button>`).join('')}
    </div>
  </div>`;

export class DeEssPanel {
  /**
   * @param {HTMLElement} root  .sheet де-эссера / de-esser sheet
   * @param {import('./mobile-ui.js').BottomSheet} sheet
   */
  constructor(root, sheet, { toast, controlStyle = 'knobs' }) {
    this.root = root;
    this.sheet = sheet;
    this.toast = toast;
    this.model = null;
    this.plugin = null;
    this.controlStyle = controlStyle;
    this.head = root.querySelector('.band-head');
    this.body = root.querySelector('.band-body');
    this._build();
    this._onModel = (e) => {
      const k = e.detail.kind;
      if (k === 'params' || k === 'select' || k === 'history') this.render();
    };
  }

  bind(plugin) {
    if (this.model) this.model.removeEventListener('change', this._onModel);
    this.plugin = plugin;
    this.model = plugin ? plugin.model : null;
    if (this.model) this.model.addEventListener('change', this._onModel);
    this.render();
  }

  /** Открыть панель (tap по графику) / open panel (graph tap). */
  open() {
    // Телефон: только «выглянуть», график остаётся доступным / phone: peek only, graph stays usable
    if (this.sheet.isSheet) { if (this.sheet.state === 'hidden') this.sheet.set('peek'); }
    else this.sheet.set('full');
  }

  setControlStyle(style) { this.controlStyle = style; this._buildControls(); this.render(); }

  _build() {
    this.head.innerHTML = `
      <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
      <div class="band-head-row ds-head" data-sheet-handle>
        <span class="ds-led" data-led aria-hidden="true"></span>
        <div class="band-title">
          <div class="band-type">Movexe DeEss</div>
          <div class="band-sum mono" data-sum></div>
        </div>
        <button class="tgl ds-quick" data-toggle="audition" aria-pressed="false" title="Слушать только удаляемые шипящие">Прослушать</button>
        <button class="tgl tgl-bypass ds-quick" data-toggle="bypass" aria-pressed="false">Обход</button>
        <button class="icon-btn" data-act="expand" aria-label="Развернуть"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      </div>`;
    this.body.innerHTML = `
      <div class="opt-row ds-modes">
        ${seg('mode', [['single-vocal', DS_LABELS['single-vocal']], ['allround', DS_LABELS.allround]], 'Детекция')}
        ${seg('processing', [['split', 'Разделение'], ['wideband', 'Широкополосный']], 'Обработка')}
        <label class="opt"><span>Крутизна</span>
          <select data-sel="slope" aria-label="Крутизна фильтра разделения">
            ${[6, 12, 24, 48].map((v) => `<option value="${v}">${v} дБ/окт</option>`).join('')}
          </select>
        </label>
        ${seg('filterShape', [['highpass', 'ВЧ'], ['bandpass', 'Полоса']], 'Фильтр')}
        ${seg('channelMode', [['stereo', 'Стерео'], ['mid-side', 'M/S'], ['left-right', 'Л/П']], 'Каналы')}
      </div>
      <div class="ctl-row ds-knobs"></div>
      <div class="act-row">
        <button type="button" class="tgl" data-toggle="autoThreshold" aria-pressed="false">Автопорог</button>
        <button type="button" class="tgl" data-toggle="autoLevel" aria-pressed="false">Автоуровень</button>
        <button type="button" class="chip-btn" data-act="reset-all">Сбросить всё</button>
      </div>`;

    this.head.addEventListener('click', (e) => this._click(e));
    this.body.addEventListener('click', (e) => this._click(e));
    this.body.querySelector('[data-sel="slope"]').addEventListener('change', (e) => this.model?.set({ slope: Number(e.target.value) }));
    this._buildControls();
  }

  _click(e) {
    if (!this.model) return;
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const k = t.dataset.toggle;
      // Обход и прослушивание — не в истории отмен / bypass & audition are not undoable
      this.model.set({ [k]: !this.model.params[k] }, { history: k !== 'bypass' && k !== 'audition' });
      haptics.tick();
      if (k === 'audition' && this.model.params.audition) this.toast.show('Прослушивание: слышно только то, что удаляется', { short: true });
      return;
    }
    const s = e.target.closest('[data-seg] [data-v]');
    if (s) {
      const key = s.closest('[data-seg]').dataset.seg;
      this.model.set({ [key]: s.dataset.v });
      haptics.tick();
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'expand') this.sheet.set(this.sheet.state === 'full' ? 'peek' : 'full');
    if (a.dataset.act === 'reset-all') {
      const { audition, bypass, ...rest } = DS_DEFAULTS;
      this.model.set(rest);
      this.toast.show('Параметры сброшены', { action: { label: 'Отменить', fn: () => this.model.undo() } });
    }
  }

  _buildControls() {
    const row = this.body.querySelector('.ds-knobs');
    row.innerHTML = '';
    row.dataset.style = this.controlStyle;
    const C = this.controlStyle === 'sliders' ? HSlider : Knob;
    this.ctl = {};
    for (const key of KNOBS) {
      const spec = DS_PARAMS[key];
      const desc = { id: key, ...spec, fmt: DS_FORMAT[key] };
      const c = new C(desc, {
        onSelect: (k) => this.model?.select(k),
        onBegin: () => this.model?.begin(),
        onChange: (v) => this.model?.set({ [key]: v }),
        onEnd: () => this.model?.commit(),
        getDefault: () => DS_DEFAULTS[key]
      });
      c.setColor('var(--ds)');
      this.ctl[key] = c;
      row.appendChild(c.root);
    }
  }

  render() {
    const m = this.model;
    this.root.classList.toggle('has-band', !!m);
    if (!m) return;
    const p = m.params;
    for (const key of KNOBS) {
      const disabled = (key === 'threshold' && p.autoThreshold) || (key === 'stereoLink' && p.channelMode === 'left-right');
      this.ctl[key].set(key === 'threshold' && p.autoThreshold ? this.plugin.meters.thr : p[key], disabled);
      this.ctl[key].setSelected(m.selected === key);
    }
    for (const g of this.root.querySelectorAll('[data-seg]')) {
      for (const b of g.querySelectorAll('[data-v]')) {
        const on = String(p[g.dataset.seg]) === b.dataset.v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    const sl = this.body.querySelector('[data-sel="slope"]');
    sl.value = String(p.slope);
    sl.disabled = p.processing === 'wideband';
    for (const t of this.root.querySelectorAll('[data-toggle]')) {
      const on = !!p[t.dataset.toggle];
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-pressed', String(on));
    }
    this.head.querySelector('[data-act="expand"]').classList.toggle('is-flipped', this.sheet.state === 'full');
    this._sum();
  }

  /** Строка-сводка в шапке (обновляется и из цикла метров). Summary line in the header. */
  _sum() {
    const m = this.model;
    if (!m) return;
    const p = m.params;
    const txt = `${fmtHz(p.frequency)} · ${DS_LABELS[p.mode]} · ${p.processing === 'split' ? 'Разд.' : 'Шир.'}`;
    const el = this.head.querySelector('[data-sum]');
    if (el.textContent !== txt) el.textContent = txt;
  }

  /** Вызывается каждый кадр: LED в шапке и живой автопорог. Called every frame. */
  tick() {
    if (!this.plugin) return;
    const mt = this.plugin.meters;
    const p = this.model.params;
    this.head.querySelector('[data-led]').classList.toggle('is-on', mt.gr > 0.5 && !p.bypass);
    if (p.autoThreshold) this.ctl.threshold.set(mt.thr, true);
  }
}
