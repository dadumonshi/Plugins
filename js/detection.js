/**
 * detection.js — алгоритм детекции сибилянтов Movexe DeEss (чистая математика, без DOM).
 * detection.js — Movexe DeEss sibilance detection algorithm (pure math, no DOM).
 *
 * Модуль импортируется и в AudioWorklet (обработка в аудио-потоке), и в основной поток
 * (кривые на графике, тесты). Поэтому здесь нет window/document.
 * Imported both by the AudioWorklet (audio thread) and the main thread (graph, tests),
 * so it must not touch window/document.
 *
 * ── Схема / Signal flow ─────────────────────────────────────────────────────
 *
 *   вход ─┬─► [детект-цепь] ФВЧ/полосовой (2×биквад, 24 дБ/окт) ─► огибающая (RMS) ─┐
 *         │                  ФНЧ (НЧ-опора, только «Одиночный вокал») ─► огибающая ──┤
 *         │                                                                          ▼
 *         │            спектральное взвешивание → связь каналов → мягкое колено
 *         │            → ограничение Range → атака/восстановление → сглаживание
 *         │                                                                          │ g(t)
 *         └─► [аудио-цепь] задержка lookahead ─► Wideband: x·g                       │
 *                                             └► Split:    НЧ(x) + ВЧ(x)·g (LR) ◄───────┘
 *
 * Split — кроссовер Линквица–Райли: НЧ и ВЧ синфазны, сумма имеет ровную АЧХ, поэтому
 * подавление полосы не даёт «горба» и призвуков у частоты раздела.
 * Split uses a Linkwitz–Riley crossover: in-phase bands with a flat-magnitude sum, so
 * band reduction causes no bump or artefacts around the split frequency.
 */

/* ======================================================================
 * Параметры (документация) / Parameters (documentation)
 * ====================================================================== */

/**
 * @typedef {object} DeEssParams
 * @property {'single-vocal'|'allround'} mode  Режим детекции: «Одиночный вокал» сравнивает ВЧ-полосу
 *           с НЧ-опорой (не реагирует на яркие гласные), «Универсальный» — абсолютный уровень полосы.
 * @property {'split'|'wideband'} processing  Split — подавляется только полоса выше частоты;
 *           Wideband — классический де-эссер, ослабляется весь сигнал.
 * @property {6|12|24|48} slope          Крутизна фильтра разделения (Split), дБ/окт.
 * @property {'highpass'|'bandpass'} filterShape  Форма фильтра детекции.
 * @property {number} frequency   Частота детекции, Гц (1000–20000).
 * @property {number} range       Максимальное подавление, дБ (0–30).
 * @property {number} threshold   Порог, дБFS (−60–0).
 * @property {number} knee        Мягкость колена, дБ (0–30).
 * @property {number} attack      Атака, мс (0.05–100).
 * @property {number} release     Восстановление, мс (5–1000).
 * @property {number} lookahead   Упреждение, мс (0–20). Добавляет такую же задержку.
 * @property {number} outputGain  Выходное усиление, дБ (−30…+30).
 * @property {number} mix         Сухой/обработанный, % (0–100).
 * @property {number} stereoLink  Связь каналов, % (0–100).
 * @property {boolean} autoThreshold  Автопорог: следит за средним уровнем полосы.
 * @property {boolean} autoLevel      Автокомпенсация уровня после подавления.
 * @property {'stereo'|'mid-side'|'left-right'} channelMode  Режим каналов.
 * @property {boolean} audition   Прослушивание: на выходе только удаляемый сигнал.
 * @property {boolean} bypass     Обход.
 */

export const DS_DEFAULTS = Object.freeze({
  mode: 'single-vocal',
  processing: 'split',
  slope: 24,
  filterShape: 'highpass',
  frequency: 6500,
  range: 8,
  threshold: -24,
  knee: 6,
  attack: 1,
  release: 60,
  lookahead: 2,
  outputGain: 0,
  mix: 100,
  stereoLink: 100,
  autoThreshold: false,
  autoLevel: false,
  channelMode: 'stereo',
  audition: false,
  bypass: false
});

/** Числовые параметры: пределы, шкала, подписи / numeric params: limits, scale, labels. */
export const DS_PARAMS = Object.freeze({
  frequency: { min: 1000, max: 20000, log: true, label: 'Частота', unit: 'Гц' },
  threshold: { min: -60, max: 0, log: false, label: 'Порог', unit: 'дБ' },
  range: { min: 0, max: 30, log: false, label: 'Глубина', unit: 'дБ' },
  knee: { min: 0, max: 30, log: false, label: 'Колено', unit: 'дБ' },
  attack: { min: 0.05, max: 100, log: true, label: 'Атака', unit: 'мс' },
  release: { min: 5, max: 1000, log: true, label: 'Восстан.', unit: 'мс' },
  lookahead: { min: 0, max: 20, log: false, label: 'Упреждение', unit: 'мс' },
  outputGain: { min: -30, max: 30, log: false, label: 'Выход', unit: 'дБ', bipolar: true },
  mix: { min: 0, max: 100, log: false, label: 'Микс', unit: '%' },
  stereoLink: { min: 0, max: 100, log: false, label: 'Связь L/R', unit: '%' }
});

export const DS_ENUMS = Object.freeze({
  mode: ['single-vocal', 'allround'],
  processing: ['split', 'wideband'],
  slope: [6, 12, 24, 48],
  filterShape: ['highpass', 'bandpass'],
  channelMode: ['stereo', 'mid-side', 'left-right']
});

export const DS_LABELS = Object.freeze({
  'single-vocal': 'Одиночный вокал',
  allround: 'Универсальный',
  split: 'Разделение полосы',
  wideband: 'Широкополосный',
  highpass: 'ВЧ-фильтр',
  bandpass: 'Полосовой',
  stereo: 'Стерео',
  'mid-side': 'Mid/Side',
  'left-right': 'Лев/Прав'
});

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Нормализация/валидация параметров / normalise & validate params. */
export function sanitizeDeEss(src = {}) {
  const out = { ...DS_DEFAULTS };
  for (const [k, spec] of Object.entries(DS_PARAMS)) {
    const v = Number(src[k]);
    if (Number.isFinite(v)) out[k] = clampN(v, spec.min, spec.max);
  }
  for (const [k, list] of Object.entries(DS_ENUMS)) {
    const v = k === 'slope' ? Number(src[k]) : src[k];
    if (list.includes(v)) out[k] = v;
  }
  for (const k of ['autoThreshold', 'autoLevel', 'audition', 'bypass']) {
    if (typeof src[k] === 'boolean') out[k] = src[k];
  }
  return out;
}

/* ======================================================================
 * Биквад (RBJ), Transposed Direct Form II — устойчив к быстрым изменениям.
 * Biquad (RBJ), Transposed Direct Form II — robust to fast coefficient changes.
 * ====================================================================== */

export function rbj(type, f0, q, fs) {
  const w = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const a = sw / (2 * q);
  let b0, b1, b2;
  if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; } // bandpass, пик 0 дБ / 0 dB peak
  const a0 = 1 + a;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - a) / a0 };
}

/** Фильтры 1-го порядка (билинейные) / 1st-order filters (bilinear). */
export function hp1(f0, fs) {
  const k = Math.tan((Math.PI * Math.min(f0, fs * 0.49)) / fs);
  const n = 1 / (1 + k);
  return { b0: n, b1: -n, b2: 0, a1: (k - 1) * n, a2: 0 };
}
export function lp1(f0, fs) {
  const k = Math.tan((Math.PI * Math.min(f0, fs * 0.49)) / fs);
  const n = 1 / (1 + k);
  return { b0: k * n, b1: k * n, b2: 0, a1: (k - 1) * n, a2: 0 };
}

export class Biquad {
  constructor(c) { this.set(c); this.z1 = 0; this.z2 = 0; }
  set(c) { this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2; this.a1 = c.a1; this.a2 = c.a2; }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

/** Добротности Баттерворта / Butterworth section Qs. */
function butterQs(order) {
  const qs = [];
  for (let k = 1; k <= Math.floor(order / 2); k++) {
    const th = order % 2 === 0 ? ((2 * k - 1) * Math.PI) / (2 * order) : (k * Math.PI) / order;
    qs.push(1 / (2 * Math.cos(th)));
  }
  return qs;
}

/**
 * Коэффициенты каскадов / cascade coefficients.
 *  det   — фильтр детекции (24 дБ/окт ФВЧ или полосовой ≈ 1 октава, 2 секции)
 *  ref   — НЧ-опора для «Одиночного вокала» (ФНЧ 12 дБ/окт на частоте/2)
 *  lp/hp — кроссовер Линквица–Райли для режима Split (6/12/24/48 дБ/окт).
 *          НЧ и ВЧ ветви синфазны, их сумма — всепропускающий фильтр (ровная АЧХ),
 *          поэтому |НЧ + g·ВЧ| монотонно меняется от 0 до −Range без «горба» у частоты
 *          раздела. sign = −1 у LR2 (ВЧ-ветвь инвертируется).
 *          Linkwitz–Riley crossover: in-phase branches, allpass sum, so |LP + g·HP|
 *          moves monotonically from 0 to −Range with no bump at the split frequency.
 */
export function designFilters(p, fs) {
  const f = p.frequency;
  const det = p.filterShape === 'bandpass'
    ? [rbj('bandpass', f * 1.25, 1.4, fs), rbj('bandpass', f * 1.25, 1.4, fs)]
    : butterQs(4).map((q) => rbj('highpass', f, q, fs));
  const ref = [rbj('lowpass', f * 0.5, Math.SQRT1_2, fs)];
  let lp, hp, sign = 1;
  switch (Number(p.slope)) {
    case 6: lp = [lp1(f, fs)]; hp = [hp1(f, fs)]; break;                                   // LP1 + HP1 = 1
    case 12: lp = [rbj('lowpass', f, 0.5, fs)]; hp = [rbj('highpass', f, 0.5, fs)]; sign = -1; break; // LR2
    case 48: {                                                                            // LR8 = BW4²
      const qs = butterQs(4);
      lp = [...qs, ...qs].map((q) => rbj('lowpass', f, q, fs));
      hp = [...qs, ...qs].map((q) => rbj('highpass', f, q, fs));
      break;
    }
    default:                                                                              // LR4 = BW2²
      lp = [rbj('lowpass', f, Math.SQRT1_2, fs), rbj('lowpass', f, Math.SQRT1_2, fs)];
      hp = [rbj('highpass', f, Math.SQRT1_2, fs), rbj('highpass', f, Math.SQRT1_2, fs)];
  }
  return { det, ref, lp, hp, sign };
}

/* ======================================================================
 * Гейн-компьютер / Gain computer
 * ====================================================================== */

/**
 * Требуемое подавление (дБ, ≥ 0) для превышения порога `over` = det − threshold.
 * Отношение ∞:1 (как у де-эссера), мягкое колено шириной `knee`, мягкий потолок `range`
 * (гладкий минимум — без излома, который слышен как «щелчок»).
 * Required reduction (dB ≥ 0): ∞:1 ratio, soft knee of width `knee`, smooth `range` ceiling.
 */
export function gainComputer(over, knee, range) {
  let gr;
  if (knee > 0.01 && over > -knee / 2 && over < knee / 2) {
    const t = over + knee / 2;
    gr = (t * t) / (2 * knee); // квадратичное колено / quadratic knee
  } else {
    gr = over > 0 ? over : 0;
  }
  if (range <= 0) return 0;
  // Гладкий минимум(gr, range), мягкость 1 дБ / smooth min with 1 dB softness
  const s = 1;
  return -s * Math.log(Math.exp(-gr / s) + Math.exp(-range / s)) + s * Math.log(1 + Math.exp(-range / s));
}

/** Коэффициент one-pole для постоянной времени ms / one-pole coefficient. */
export const timeCoef = (ms, fs) => 1 - Math.exp(-1 / Math.max(1, (ms / 1000) * fs));

/* ======================================================================
 * Детектор одного канала / single-channel detector
 * ====================================================================== */

export class SibilanceDetector {
  constructor(fs) {
    this.fs = fs;
    this.det = [];
    this.ref = [];
    this.envH = 0;
    this.envL = 0;
    // Быстрая RMS-огибающая детектора (не путать с атакой/восстановлением GR):
    // 0.3 мс вверх / 12 мс вниз — ловит короткие «с», но не дрожит на периоде сигнала.
    // Fast RMS detector envelope (distinct from GR attack/release).
    this.cUp = timeCoef(0.3, fs);
    this.cDown = timeCoef(12, fs);
  }

  configure(filters) {
    const sync = (arr, list) => list.map((c, i) => { const b = arr[i] || new Biquad(c); b.set(c); return b; });
    this.det = sync(this.det, filters.det);
    this.ref = sync(this.ref, filters.ref);
  }

  /**
   * @returns {number} уровень детекции, дБFS (синус 0 дБFS в полосе → ≈ 0 дБ)
   */
  process(x, singleVocal) {
    let h = x;
    for (let i = 0; i < this.det.length; i++) h = this.det[i].process(h);
    const ph = h * h * 2; // ×2: RMS синуса → пиковая шкала / sine RMS → peak scale
    this.envH += (ph > this.envH ? this.cUp : this.cDown) * (ph - this.envH);
    let db = 10 * Math.log10(this.envH + 1e-20);
    if (singleVocal) {
      let l = x;
      for (let i = 0; i < this.ref.length; i++) l = this.ref[i].process(l);
      const pl = l * l * 2;
      this.envL += (pl > this.envL ? this.cUp : this.cDown) * (pl - this.envL);
      // Спектральное взвешивание: «с» — энергия ВЧ ≥ НЧ. Если НЧ сильнее (гласная,
      // яркий инструмент), детекция ослабляется → нет ложных срабатываний и «шепелявости».
      // Spectral weighting: sibilants have HF ≥ LF energy. If LF dominates (vowel),
      // detection is attenuated → no false triggers, no lisping.
      const rel = db - 10 * Math.log10(this.envL + 1e-20);
      if (rel < 0) db += 0.6 * Math.max(rel, -30);
    }
    return db;
  }
}

/* ======================================================================
 * Отклики для графика / Responses for the graph
 * ====================================================================== */

function biquadResp(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  const d = dr * dr + di * di || 1e-30;
  return { re: (nr * dr + ni * di) / d, im: (ni * dr - nr * di) / d };
}

function cascadeResp(list, f, fs) {
  let re = 1, im = 0;
  for (const c of list) {
    const h = biquadResp(c, f, fs);
    const r = re * h.re - im * h.im;
    im = re * h.im + im * h.re;
    re = r;
  }
  return { re, im };
}

/** АЧХ фильтра детекции, дБ / detection filter magnitude, dB. */
export function detectionResponseDb(filters, f, fs) {
  const h = cascadeResp(filters.det, Math.min(f, fs * 0.499), fs);
  return 20 * Math.log10(Math.max(Math.hypot(h.re, h.im), 1e-9));
}

/**
 * Итоговое усиление обработки на частоте f при текущем подавлении grDb.
 * Split: |LP + sign·g·HP| (кроссовер Линквица–Райли); Wideband: −grDb.
 * Effective processing gain at f for reduction grDb.
 */
export function processingGainDb(p, filters, grDb, f, fs) {
  if (p.processing === 'wideband') return -grDb;
  const g = Math.pow(10, -grDb / 20);
  const ff = Math.min(f, fs * 0.499);
  const l = cascadeResp(filters.lp, ff, fs), h = cascadeResp(filters.hp, ff, fs);
  const k = filters.sign * g;
  return 20 * Math.log10(Math.max(Math.hypot(l.re + k * h.re, l.im + k * h.im), 1e-9));
}
