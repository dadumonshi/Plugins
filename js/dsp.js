/**
 * dsp.js — чистая математика фильтров (без DOM и Web Audio).
 * dsp.js — pure filter math (no DOM, no Web Audio).
 *
 * Модуль используется и в основном потоке (отрисовка кривой, IIR-коэффициенты),
 * и в Web Worker (расчёт FIR для Natural / Linear Phase).
 * The module is shared by the main thread (curve drawing, IIR coefficients)
 * and the Web Worker (FIR design for Natural / Linear Phase).
 *
 * Каждая полоса превращается в список аналоговых секций 1-го/2-го порядка в
 * нормированной s-плоскости (ω0 = 1):
 *   H(s) = (n0 + n1·s + n2·s²) / (d0 + d1·s + d2·s²)
 * Every band becomes a list of 1st/2nd-order analog sections in the normalised
 * s-plane (ω0 = 1). From there we get:
 *   • цифровые коэффициенты через билинейное преобразование с предыскажением
 *     (идентично RBJ Audio EQ Cookbook, т.е. BiquadFilterNode);
 *     digital coefficients via pre-warped bilinear transform (== RBJ cookbook);
 *   • «аналоговую» АЧХ/ФЧХ без сжатия у Найквиста (Natural Phase).
 *     the analog response without Nyquist cramping (Natural Phase).
 */

export const FILTER_TYPES = [
  'bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut',
  'notch', 'bandpass', 'tiltshelf', 'flattilt'
];

export const FILTER_LABELS = {
  bell: 'Bell',
  lowshelf: 'Low Shelf',
  highshelf: 'High Shelf',
  lowcut: 'Low Cut',
  highcut: 'High Cut',
  notch: 'Notch',
  bandpass: 'Band Pass',
  tiltshelf: 'Tilt Shelf',
  flattilt: 'Flat Tilt'
};

/** Крутизна среза, дБ/окт / Available slopes, dB/oct (as in Pro-Q 3). */
export const SLOPES = [6, 12, 18, 24, 30, 36, 48, 72, 96];

/** Стерео-размещение полосы / Per-band stereo placement. */
export const PLACEMENTS = ['stereo', 'left', 'right', 'mid', 'side'];

export const LIMITS = {
  freqMin: 10, freqMax: 30000,
  gainMin: -30, gainMax: 30,
  qMin: 0.025, qMax: 40
};

/** Типы без усиления (вертикальный drag меняет Q) / Gainless types (vertical drag edits Q). */
export const GAINLESS = new Set(['lowcut', 'highcut', 'notch', 'bandpass']);
/** Типы, у которых есть выбор крутизны / Types with a slope selector. */
export const HAS_SLOPE = new Set(['lowcut', 'highcut', 'lowshelf', 'highshelf', 'tiltshelf', 'notch', 'bandpass']);

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (lin) => 20 * Math.log10(Math.max(lin, 1e-12));

/* ------------------------------------------------------------------ *
 * Аналоговые секции / Analog sections
 * ------------------------------------------------------------------ */

/**
 * Секция: { f0, n:[n0,n1,n2], d:[d0,d1,d2], order, native? }
 * native — описание для BiquadFilterNode, если его формула совпадает
 * (гладкая автоматизация AudioParam без щелчков).
 * native — BiquadFilterNode descriptor when its formula matches exactly
 * (lets us automate AudioParams smoothly, click-free).
 */
function sec2(f0, n, d, native) { return { f0, n, d, order: 2, native: native || null }; }
function sec1(f0, n, d) { return { f0, n: [n[0], n[1], 0], d: [d[0], d[1], 0], order: 1, native: null }; }

/** Добротности каскада Баттерворта / Butterworth cascade Q values for order n. */
export function butterworthQs(order) {
  const qs = [];
  const pairs = Math.floor(order / 2);
  for (let k = 1; k <= pairs; k++) {
    const theta = order % 2 === 0 ? ((2 * k - 1) * Math.PI) / (2 * order) : (k * Math.PI) / order;
    qs.push(1 / (2 * Math.cos(theta)));
  }
  return qs; // + одна секция 1-го порядка при нечётном order / + one 1st-order section if odd
}

function shelfSections(kind, f0, gainDb, q, slope) {
  // Каскад из одинаковых полок с разделённым усилением даёт более крутой переход.
  // Cascading identical shelves with split gain yields a steeper transition.
  const order = Math.max(1, Math.round(slope / 6));
  const pairs = Math.floor(order / 2);
  const odd = order % 2 === 1;
  const out = [];
  const g2 = (gainDb * 2) / order;
  const g1 = gainDb / order;
  for (let i = 0; i < pairs; i++) {
    const A = Math.pow(10, g2 / 40);
    const sA = Math.sqrt(A);
    if (kind === 'low') {
      out.push(sec2(f0, [A * A, (A * sA) / q, A], [1, sA / q, A]));
    } else {
      out.push(sec2(f0, [A, (A * sA) / q, A * A], [A, sA / q, 1]));
    }
  }
  if (odd) {
    const A = Math.pow(10, g1 / 40);
    if (kind === 'low') out.push(sec1(f0, [A, 1], [1 / A, 1]));
    else out.push(sec1(f0, [1, A], [1, 1 / A]));
  }
  return out;
}

function cutSections(kind, f0, q, slope) {
  const order = Math.max(1, Math.round(slope / 6));
  const qs = butterworthQs(order);
  // Резонанс: масштабируем самую добротную секцию (как «Q» среза в Pro-Q).
  // Resonance: scale the highest-Q section (like the cut "Q" in Pro-Q).
  const scale = q / Math.SQRT1_2;
  if (qs.length) qs[qs.length - 1] *= scale;
  const out = [];
  for (const qk of qs) {
    const qq = clamp(qk, 0.1, 60);
    if (kind === 'low') {
      out.push(sec2(f0, [0, 0, 1], [1, 1 / qq, 1], { type: 'highpass', f: f0, Q: 20 * Math.log10(qq), gain: 0 }));
    } else {
      out.push(sec2(f0, [1, 0, 0], [1, 1 / qq, 1], { type: 'lowpass', f: f0, Q: 20 * Math.log10(qq), gain: 0 }));
    }
  }
  if (order % 2 === 1) {
    if (kind === 'low') out.push(sec1(f0, [0, 1], [1, 1]));
    else out.push(sec1(f0, [1, 0], [1, 1]));
  }
  return out;
}

/**
 * Полоса → список аналоговых секций.
 * Band → list of analog sections.
 * @param {{type:string,freq:number,gain:number,q:number,slope:number}} b
 */
export function bandSections(b) {
  const f0 = clamp(b.freq, LIMITS.freqMin, LIMITS.freqMax);
  const g = clamp(b.gain, LIMITS.gainMin, LIMITS.gainMax);
  const q = clamp(b.q, LIMITS.qMin, LIMITS.qMax);
  const slope = b.slope || 12;
  switch (b.type) {
    case 'bell': {
      const A = Math.pow(10, g / 40);
      return [sec2(f0, [1, A / q, 1], [1, 1 / (A * q), 1], { type: 'peaking', f: f0, Q: q, gain: g })];
    }
    case 'lowshelf': return shelfSections('low', f0, g, q, slope);
    case 'highshelf': return shelfSections('high', f0, g, q, slope);
    case 'tiltshelf': {
      // Tilt = high shelf (+g) × (−g/2): точка вращения на f0 / pivot at f0.
      const secs = shelfSections('high', f0, g, q, slope);
      const k = Math.pow(10, -g / 40);
      secs[0] = { ...secs[0], n: secs[0].n.map((c) => c * k), native: null };
      return secs;
    }
    case 'flattilt': {
      // Постоянный наклон дБ/окт: 10 полок 1-го порядка через октаву (20 Гц…20 кГц).
      // Constant dB/oct slope: ten 1st-order shelves an octave apart (20 Hz…20 kHz).
      // gain = суммарный наклон на 10 октавах / total tilt over 10 octaves.
      const per = g / 10;
      const A = Math.pow(10, per / 40);
      const secs = [];
      for (let k = 0; k < 10; k++) {
        const fc = 20 * Math.pow(2, k + 0.5);
        secs.push(sec1(fc, [1, A], [1, 1 / A]));
      }
      // Нормировка: 0 дБ на частоте поворота f0 / normalise to 0 dB at pivot f0.
      const h = analogResponse(secs, f0);
      const k = 1 / Math.hypot(h.re, h.im);
      secs[0] = { ...secs[0], n: secs[0].n.map((c) => c * k) };
      return secs;
    }
    case 'lowcut': return cutSections('low', f0, q, slope);
    case 'highcut': return cutSections('high', f0, q, slope);
    case 'notch': {
      const m = Math.max(1, Math.round(slope / 12));
      const out = [];
      for (let i = 0; i < m; i++) out.push(sec2(f0, [1, 0, 1], [1, 1 / q, 1], { type: 'notch', f: f0, Q: q, gain: 0 }));
      return out;
    }
    case 'bandpass': {
      const m = Math.max(1, Math.round(slope / 12));
      const out = [];
      for (let i = 0; i < m; i++) out.push(sec2(f0, [0, 1 / q, 0], [1, 1 / q, 1], { type: 'bandpass', f: f0, Q: q, gain: 0 }));
      return out;
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Отклики / Responses
 * ------------------------------------------------------------------ */

/** Комплексный отклик аналоговых секций на частоте f (Гц). Complex analog response at f (Hz). */
export function analogResponse(sections, f) {
  let re = 1, im = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const w = f / s.f0; // s = j·w
    const w2 = w * w;
    // num = n0 − n2·w² + j·n1·w
    const nr = s.n[0] - s.n[2] * w2, ni = s.n[1] * w;
    const dr = s.d[0] - s.d[2] * w2, di = s.d[1] * w;
    const den = dr * dr + di * di || 1e-30;
    const hr = (nr * dr + ni * di) / den;
    const hi = (ni * dr - nr * di) / den;
    const r = re * hr - im * hi;
    im = re * hi + im * hr;
    re = r;
  }
  return { re, im };
}

/**
 * Билинейное преобразование с предыскажением на f0 (== RBJ cookbook).
 * Pre-warped bilinear transform at f0 (== RBJ cookbook).
 * @returns {{b:number[], a:number[]}} a[0] = 1
 */
export function sectionToDigital(s, fs) {
  const f0 = Math.min(s.f0, fs * 0.4995); // выше Найквиста нельзя / cannot exceed Nyquist
  const K = Math.tan((Math.PI * f0) / fs);
  if (s.order === 1) {
    const [n0, n1] = s.n, [d0, d1] = s.d;
    const b0 = n1 + n0 * K, b1 = -n1 + n0 * K;
    const a0 = d1 + d0 * K, a1 = -d1 + d0 * K;
    return { b: [b0 / a0, b1 / a0], a: [1, a1 / a0] };
  }
  const [n0, n1, n2] = s.n, [d0, d1, d2] = s.d;
  const K2 = K * K;
  const b0 = n2 + n1 * K + n0 * K2;
  const b1 = 2 * (n0 * K2 - n2);
  const b2 = n2 - n1 * K + n0 * K2;
  const a0 = d2 + d1 * K + d0 * K2;
  const a1 = 2 * (d0 * K2 - d2);
  const a2 = d2 - d1 * K + d0 * K2;
  return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0] };
}

/** Отклик цифрового фильтра / Digital response of a list of {b,a}. */
export function digitalResponse(coefs, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let re = 1, im = 0;
  for (let i = 0; i < coefs.length; i++) {
    const { b, a } = coefs[i];
    const b2 = b[2] || 0, a2 = a[2] || 0;
    // H(e^jw) = Σ b_k e^{-jkw} / Σ a_k e^{-jkw}
    const nr = b[0] + b[1] * c1 + b2 * c2, ni = -(b[1] * s1 + b2 * s2);
    const dr = a[0] + a[1] * c1 + a2 * c2, di = -(a[1] * s1 + a2 * s2);
    const den = dr * dr + di * di || 1e-30;
    const hr = (nr * dr + ni * di) / den;
    const hi = (ni * dr - nr * di) / den;
    const r = re * hr - im * hi;
    im = re * hi + im * hr;
    re = r;
  }
  return { re, im };
}

/**
 * Предварительно рассчитанный «ответчик» полосы для быстрой отрисовки.
 * Pre-computed band responder for fast drawing.
 * mode: 'zero' → цифровой (как реально звучит IIR) / digital (what IIR really does)
 *       'natural' | 'linear' → аналоговый прототип / analog prototype.
 */
export function makeResponder(band, mode, fs) {
  const secs = bandSections(band);
  if (mode === 'zero') {
    const coefs = secs.map((s) => sectionToDigital(s, fs));
    const nyq = fs / 2;
    return (f) => (f >= nyq ? null : digitalResponse(coefs, f, fs));
  }
  return (f) => analogResponse(secs, f);
}

/** Модуль в дБ / magnitude in dB. */
export const magDb = (h) => (h ? 20 * Math.log10(Math.max(Math.hypot(h.re, h.im), 1e-9)) : NaN);

/* ------------------------------------------------------------------ *
 * Auto Gain
 * ------------------------------------------------------------------ */

/**
 * Оценка изменения громкости (среднее дБ с весом ~розового шума 40 Гц–12 кГц).
 * Loudness change estimate (pink-ish weighted mean dB, 40 Hz–12 kHz).
 * Возвращает компенсацию в дБ / returns compensation in dB.
 */
export function estimateAutoGain(bands) {
  const active = bands.filter((b) => b.enabled);
  if (!active.length) return 0;
  const resp = active.map((b) => ({ secs: bandSections(b), w: b.placement === 'stereo' ? 1 : 0.5 }));
  const N = 48;
  let sum = 0, wsum = 0;
  for (let i = 0; i < N; i++) {
    const f = 40 * Math.pow(12000 / 40, i / (N - 1));
    // Больший вес середине (чувствительность слуха) / more weight to mids (ear sensitivity).
    const lw = Math.exp(-Math.pow(Math.log2(f / 2000) / 3, 2));
    let db = 0;
    for (const r of resp) db += r.w * magDb(analogResponse(r.secs, f));
    sum += db * lw;
    wsum += lw;
  }
  // Частичная компенсация как у Pro-Q (не 100%) / partial compensation, Pro-Q-like.
  return clamp(-(sum / wsum) * 0.85, -24, 24);
}

/* ------------------------------------------------------------------ *
 * FFT и проектирование FIR / FFT and FIR design
 * ------------------------------------------------------------------ */

/** In-place радикс-2 FFT. inverse=true → IFFT (с делением на N). */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Матрица 2×2 (комплексная) полосы с учётом размещения в стерео.
 * Complex 2×2 matrix of a band according to its stereo placement.
 * Порядок: [LL, LR, RL, RR] — outL = LL·inL + LR·inR ; outR = RL·inL + RR·inR
 */
function placementMatrix(h, placement) {
  const one = { re: 1, im: 0 }, zero = { re: 0, im: 0 };
  switch (placement) {
    case 'left': return [h, zero, zero, one];
    case 'right': return [one, zero, zero, h];
    case 'mid': case 'side': {
      // M = (L+R)/2, S = (L−R)/2 ; L = M+S ; R = M−S
      const hm = placement === 'mid' ? h : one;
      const hs = placement === 'side' ? h : one;
      const p = { re: (hm.re + hs.re) / 2, im: (hm.im + hs.im) / 2 };
      const m = { re: (hm.re - hs.re) / 2, im: (hm.im - hs.im) / 2 };
      return [p, m, m, p];
    }
    default: return [h, zero, zero, h];
  }
}

function cmul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cadd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
function matMul(A, B) { // A·B
  return [
    cadd(cmul(A[0], B[0]), cmul(A[1], B[2])),
    cadd(cmul(A[0], B[1]), cmul(A[1], B[3])),
    cadd(cmul(A[2], B[0]), cmul(A[3], B[2])),
    cadd(cmul(A[2], B[1]), cmul(A[3], B[3]))
  ];
}

/**
 * Проектирование FIR-матрицы для Natural/Linear Phase.
 * Designs the FIR matrix for Natural/Linear Phase.
 * @returns {{kind:'mono'|'matrix', irs:Float32Array[], latency:number}}
 */
export function designFir(bands, { fs, size, mode }) {
  const N = size;
  const half = N >> 1;
  const active = bands.filter((b) => b.enabled);
  const needMatrix = active.some((b) => b.placement !== 'stereo');
  const secsList = active.map((b) => ({ secs: bandSections(b), placement: b.placement }));
  const outs = needMatrix ? 4 : 1;
  const specRe = Array.from({ length: outs }, () => new Float64Array(N));
  const specIm = Array.from({ length: outs }, () => new Float64Array(N));

  for (let k = 0; k <= half; k++) {
    const f = Math.max((k * fs) / N, 0.001);
    let M = [{ re: 1, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }, { re: 1, im: 0 }];
    let mono = { re: 1, im: 0 };
    for (const { secs, placement } of secsList) {
      let h = analogResponse(secs, f);
      // Linear Phase: только модуль (нулевая фаза) / magnitude only (zero phase).
      if (mode === 'linear') h = { re: Math.hypot(h.re, h.im), im: 0 };
      if (needMatrix) M = matMul(placementMatrix(h, placement), M);
      else mono = cmul(mono, h);
    }
    const vals = needMatrix ? M : [mono];
    for (let o = 0; o < outs; o++) {
      let { re, im } = vals[o];
      if (k === 0 || k === half) im = 0; // DC и Найквист вещественные / DC & Nyquist must be real
      specRe[o][k] = re; specIm[o][k] = im;
      if (k > 0 && k < half) { // сопряжённая симметрия / conjugate symmetry → real IR
        specRe[o][N - k] = re; specIm[o][N - k] = -im;
      }
    }
  }

  // Linear: сдвиг N/2 (симметричный IR). Natural: небольшая пред-задержка.
  // Linear: shift by N/2 (symmetric IR). Natural: small pre-delay for pre-ringing.
  const shift = mode === 'linear' ? half : Math.min(128, N >> 4);
  const irs = [];
  for (let o = 0; o < outs; o++) {
    const re = specRe[o], im = specIm[o];
    fft(re, im, true);
    const ir = new Float32Array(N);
    for (let i = 0; i < N; i++) ir[(i + shift) % N] = re[i];
    // Окно / window
    if (mode === 'linear') {
      for (let i = 0; i < N; i++) ir[i] *= 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (N - 1));
    } else {
      for (let i = 0; i < shift; i++) ir[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / shift); // fade-in
      const tail = N >> 2;
      for (let i = 0; i < tail; i++) ir[N - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / tail); // fade-out
    }
    irs.push(ir);
  }
  return { kind: needMatrix ? 'matrix' : 'mono', irs, latency: shift };
}
