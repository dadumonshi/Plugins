/**
 * spectral.js — алгоритм шумоподавления Movexe DeNoise (чистая математика, без DOM).
 * Импортируется AudioWorklet'ом (обработка) и основным потоком (графики, обучение по файлу).
 * spectral.js — Movexe DeNoise noise-reduction algorithm (pure math, no DOM).
 * Imported by the AudioWorklet (processing) and the main thread (graphs, file learning).
 *
 * ══ Спектральное вычитание / Spectral subtraction ═══════════════════════════════
 *
 *  1. STFT: кадр N = 2048, шаг H = N/4 (перекрытие 75 %), окно Ханна на анализе и
 *     синтезе; сумма w² при 75 % = 1.5 → выход × 2/3 (точное восстановление).
 *     STFT: N = 2048, hop N/4, Hann on analysis and synthesis; Σw² = 1.5 → output × 2/3.
 *
 *  2. Оценка шума N[k] (мощность по бинам) / noise estimate per bin:
 *     • Learn — среднее |X|² за 2–5 с шума (noise print);
 *     • Adaptive — Minimum Statistics (Martin, 2001): минимум сглаженной мощности за
 *       ~2.5 с × поправка смещения 2.0; оценка растёт не быстрее +3 дБ/с (не «съедает»
 *       протяжные звуки) и падает мгновенно — следит за медленно меняющимся шумом;
 *     • без профиля используется Minimum Statistics автоматически.
 *
 *  3. Эффективный шум / effective noise:  Nₑ[k] = max(α[k]·N[k], T)
 *     α — коэффициент пере-вычитания (over-subtraction): растёт с Reduction, падает с
 *     Artifact Control, усиливается Low/High Cut на краях спектра; T — порог (Threshold):
 *     всё тише T по бину считается шумом.
 *
 *  4. Усиление Винера с «решением на основе решения» (decision-directed, Ephraim–Malah):
 *        γ = P/Nₑ,   ξ = a·G²ₚᵣₑᵥ·γₚᵣₑᵥ + (1−a)·max(γ−1, 0),   G = ξ/(1+ξ)
 *     a = 0.88…0.98 (Artifact Control). Именно сглаживание ξ во времени убирает
 *     «музыкальный шум» (водянистость) — главный артефакт наивного вычитания.
 *     The DD smoothing of ξ is what removes "musical noise" (the watery artefact).
 *
 *  5. Пол подавления: G ≥ 10^(−Depth[k]/20), Depth — Reduction или нарисованная кривая.
 *  6. Против артефактов: медиана по 3 соседним бинам (одиночные «звёздочки»),
 *     сглаживание по частоте max(G, сглаженное) — заполняет провалы, не трогая гармоники
 *     (Smoothing), атака/восстановление по времени (Attack/Release).
 *  7. Tone/Warmth — ослабляет подавление в зоне 80–800 Гц (возвращает «тело» голоса).
 *  8. Frequency Range — обработка только выбранной области: G' = 1 − w·(1 − G).
 *  9. Broadband — то же на 32 полосах (гладко, без точной подстройки под гармоники);
 *     Hybrid — среднее геометрическое спектрального и полосного усиления.
 *  10. G применяется к комплексному спектру, IFFT, окно, сложение с перекрытием.
 */

export const DN_DEFAULTS = Object.freeze({
  mode: 'reduce',          // 'learn' | 'reduce' | 'adaptive' (состояние / state)
  algorithm: 'hybrid',     // 'broadband' | 'spectral' | 'hybrid'
  reduction: 18,
  threshold: -70,
  attack: 5,
  release: 150,
  smoothing: 50,
  frequencyRange: 'full',  // 'low' | 'mid' | 'high' | 'full'
  highCut: 0,
  lowCut: 0,
  artifactControl: 60,
  tone: 20,
  stereoLink: 100,
  mix: 100,
  outputGain: 0,
  channelMode: 'stereo',   // 'stereo' | 'mid-side' | 'left-right' | 'mono'
  adaptive: false,
  freeze: false,
  learnSeconds: 3,
  bypass: false
});

/** Числовые параметры (документация и пределы) / numeric params (docs & limits). */
export const DN_PARAMS = Object.freeze({
  reduction: { min: 0, max: 40, log: false, label: 'Подавление', unit: 'дБ' },
  threshold: { min: -80, max: 0, log: false, label: 'Порог', unit: 'дБ' },
  attack: { min: 0.1, max: 100, log: true, label: 'Атака', unit: 'мс' },
  release: { min: 10, max: 1000, log: true, label: 'Восстан.', unit: 'мс' },
  smoothing: { min: 0, max: 100, log: false, label: 'Сглаживание', unit: '%' },
  artifactControl: { min: 0, max: 100, log: false, label: 'Артефакты', unit: '%' },
  tone: { min: 0, max: 100, log: false, label: 'Тон', unit: '%' },
  lowCut: { min: 0, max: 100, log: false, label: 'НЧ-шум', unit: '%' },
  highCut: { min: 0, max: 100, log: false, label: 'ВЧ-шум', unit: '%' },
  stereoLink: { min: 0, max: 100, log: false, label: 'Связь L/R', unit: '%' },
  mix: { min: 0, max: 100, log: false, label: 'Микс', unit: '%' },
  outputGain: { min: -12, max: 12, log: false, label: 'Выход', unit: 'дБ', bipolar: true },
  learnSeconds: { min: 2, max: 5, log: false, label: 'Обучение', unit: 'с' }
});

export const DN_ENUMS = Object.freeze({
  mode: ['learn', 'reduce', 'adaptive'],
  algorithm: ['broadband', 'spectral', 'hybrid'],
  frequencyRange: ['low', 'mid', 'high', 'full'],
  channelMode: ['stereo', 'mid-side', 'left-right', 'mono']
});

export const DN_LABELS = Object.freeze({
  learn: 'Обучение', reduce: 'Подавление', adaptive: 'Адаптивный',
  broadband: 'Широкополосный', spectral: 'Спектральный', hybrid: 'Гибрид',
  low: 'НЧ', mid: 'СЧ', high: 'ВЧ', full: 'Весь',
  stereo: 'Стерео', 'mid-side': 'Mid/Side', 'left-right': 'Лев/Прав', mono: 'Моно'
});

const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

export function sanitizeDenoise(src = {}) {
  const out = { ...DN_DEFAULTS };
  for (const [k, sp] of Object.entries(DN_PARAMS)) {
    const v = Number(src[k]);
    if (Number.isFinite(v)) out[k] = clampN(v, sp.min, sp.max);
  }
  for (const [k, list] of Object.entries(DN_ENUMS)) if (list.includes(src[k])) out[k] = src[k];
  for (const k of ['adaptive', 'freeze', 'bypass']) if (typeof src[k] === 'boolean') out[k] = src[k];
  // Совместимость со структурой из ТЗ: mode может быть алгоритмом / spec compatibility
  if (DN_ENUMS.algorithm.includes(src.mode)) out.algorithm = src.mode;
  return out;
}

/* ================================================================== *
 *  Кривые на лог-сетке частот / curves on a log frequency grid
 * ================================================================== */

/** 96 точек от 20 Гц до 20 кГц (шаг ≈ 1/9.6 октавы) / 96 points 20 Hz–20 kHz. */
export const CURVE_FREQS = Object.freeze(Array.from({ length: 96 }, (_, i) => 20 * Math.pow(1000, i / 95)));

/**
 * Значение кривой на частоте f (лог-интерполяция, null → fallback).
 * Curve value at f (log interpolation, null → fallback).
 */
export function curveAt(points, f, fallback) {
  if (!points) return fallback;
  const x = (Math.log(clampN(f, 20, 20000) / 20) / Math.log(1000)) * 95;
  const i = Math.floor(x), t = x - i;
  const a = points[clampN(i, 0, 95)], b = points[clampN(i + 1, 0, 95)];
  const va = a == null ? fallback : a, vb = b == null ? fallback : b;
  return va + (vb - va) * t;
}

/** Кривая → массив по бинам FFT / curve → per-bin array. */
export function curveToBins(points, n, fs, fallback) {
  const bins = n / 2 + 1, out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) out[k] = curveAt(points, Math.max(1, (k * fs) / n), fallback);
  return out;
}

/**
 * Профиль (дБ по бинам своего размера) → бины нужного N и частоты дискретизации.
 * Profile (dB per bin of its own size) → bins for another N / sample rate.
 */
export function resampleProfile(profile, n, fs) {
  const src = profile.bins, sn = profile.fftSize, sfs = profile.sampleRate;
  const bins = n / 2 + 1, out = new Float32Array(bins);
  // Поправка уровня: при другом N меняется мощность шума на бин (∝ N) / per-bin power ∝ N
  const corr = 10 * Math.log10(sn / n);
  for (let k = 0; k < bins; k++) {
    const f = (k * fs) / n;
    const x = (f / sfs) * sn;
    const i = Math.min(src.length - 1, Math.floor(x)), t = Math.min(1, x - i);
    const a = src[i], b = src[Math.min(src.length - 1, i + 1)];
    out[k] = (Number.isFinite(a) ? a + ((Number.isFinite(b) ? b : a) - a) * t : -140) + corr;
  }
  return out;
}

/* ================================================================== *
 *  Весовые функции / weighting functions
 * ================================================================== */

const oct = (f, f0) => Math.log2(Math.max(f, 1) / f0);
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Frequency Range: 1 — обрабатывать, 0 — нет (плавные границы в 1 октаву). */
export function rangeWeight(range, f) {
  switch (range) {
    case 'low': return 1 - smoothstep(oct(f, 400));                    // < 400 Гц
    case 'mid': return smoothstep(oct(f, 150) + 0.5) * (1 - smoothstep(oct(f, 5000)));
    case 'high': return smoothstep(oct(f, 1500));                      // > 1.5–3 кГц
    default: return 1;
  }
}
const lowW = (f) => 1 - smoothstep(oct(f, 120));     // гул/рокот ниже ~120–240 Гц
const highW = (f) => smoothstep(oct(f, 5000));       // шипение выше ~5–10 кГц
const toneW = (f) => Math.exp(-Math.pow(oct(f, 260) / 1.4, 2)); // «тело» 80–800 Гц

/* ================================================================== *
 *  Процессор / processor
 * ================================================================== */

export class SpectralProcessor {
  /** @param {number} n размер FFT / FFT size  @param {number} fs частота дискретизации */
  constructor(n, fs) {
    this.n = n;
    this.fs = fs;
    this.bins = n / 2 + 1;
    this.hop = n / 4;
    this.REF = (n / 4) * (n / 4); // синус 0 дБFS с окном Ханна / 0 dBFS sine with Hann
    const b = this.bins;
    this.alpha = new Float32Array(b);
    this.floor = new Float32Array(b);
    this.rangeW = new Float32Array(b);
    this.toneExp = new Float32Array(b);
    this.depth = null;           // кривая глубины по бинам, дБ / per-bin depth curve
    this.profilePow = null;      // профиль, мощность / profile power
    // Полосы для Broadband: 32 лог-полосы / 32 log bands
    this.nb = 32;
    this.bandOf = new Uint8Array(b);
    this.bandPos = new Float32Array(b);
    const fLo = 30, fHi = fs / 2;
    for (let k = 0; k < b; k++) {
      const f = Math.max((k * fs) / n, fLo);
      const x = (Math.log(f / fLo) / Math.log(fHi / fLo)) * this.nb;
      this.bandOf[k] = Math.min(this.nb - 1, Math.floor(x));
      this.bandPos[k] = Math.min(this.nb - 1, Math.max(0, x - 0.5));
    }
    this.configure(DN_DEFAULTS);
  }

  /** Пересчёт весов из параметров / recompute weights from params. */
  configure(p) {
    this.p = p;
    const { n, fs } = this;
    const art = p.artifactControl / 100;
    const aBase = 1 + 2 * (p.reduction / 40) * (1 - 0.6 * art);
    for (let k = 0; k < this.bins; k++) {
      const f = Math.max(1, (k * fs) / n);
      this.alpha[k] = aBase * (1 + 3 * (p.lowCut / 100) * lowW(f)) * (1 + 3 * (p.highCut / 100) * highW(f));
      const d = this.depth ? this.depth[k] : p.reduction;
      this.floor[k] = Math.pow(10, -d / 20);
      this.rangeW[k] = rangeWeight(p.frequencyRange, f);
      this.toneExp[k] = 1 - 0.6 * (p.tone / 100) * toneW(f);
    }
    this.thrPow = this.REF * Math.pow(10, p.threshold / 10);
    this.dd = 0.88 + 0.1 * art;
    const hopSec = this.hop / fs;
    this.ca = 1 - Math.exp(-hopSec / Math.max(1e-4, p.attack / 1000));
    this.cr = 1 - Math.exp(-hopSec / Math.max(1e-3, p.release / 1000));
    this.fsm = 0.85 * (p.smoothing / 100); // сглаживание по частоте / frequency smoothing
    this.riseStep = Math.pow(10, (3 * hopSec) / 10);  // +3 дБ/с для трекера / tracker rise rate
  }

  setDepth(depthBins) { this.depth = depthBins; this.configure(this.p); }

  /** Профиль в дБ (по бинам этого N) или null / profile in dB or null. */
  setProfile(dbBins) {
    if (!dbBins) { this.profilePow = null; return; }
    const pw = new Float64Array(this.bins);
    for (let k = 0; k < this.bins; k++) pw[k] = this.REF * Math.pow(10, dbBins[k] / 10);
    this.profilePow = pw;
  }

  /** Новое состояние канала / new channel state. */
  channel() {
    const b = this.bins;
    const U = 6;
    return {
      G: new Float32Array(b).fill(1),    // итоговое усиление / final gain
      Gs: new Float32Array(b).fill(1),   // сглаженное по времени / time-smoothed
      Gprev: new Float32Array(b).fill(1),
      gPrev: new Float32Array(b),        // γ предыдущего кадра / previous γ
      tmp: new Float32Array(b),
      // Minimum Statistics
      S: new Float64Array(b),
      curMin: new Float64Array(b).fill(Infinity),
      mins: Array.from({ length: U }, () => new Float64Array(b).fill(Infinity)),
      U, V: 40, count: 0, sub: 0, warm: 0,   // окно U·V ≈ 2.5 с / window ≈ 2.5 s
      noise: new Float64Array(b),
      bandP: new Float64Array(this.nb), bandN: new Float64Array(this.nb),
      bandG: new Float32Array(this.nb).fill(1), bandGprev: new Float32Array(this.nb).fill(1), bandgPrev: new Float32Array(this.nb)
    };
  }

  /** Засеять трекер профилем (старт Adaptive с обученного шума). Seed tracker with profile. */
  seedTracker(ch) {
    if (!this.profilePow) return;
    for (let k = 0; k < this.bins; k++) {
      ch.S[k] = this.profilePow[k];
      for (const m of ch.mins) m[k] = this.profilePow[k] / 2;
      ch.curMin[k] = this.profilePow[k] / 2;
      ch.noise[k] = this.profilePow[k];
    }
    ch.warm = (ch.U + 1) * ch.V + 11; // сразу рабочий режим / straight to steady state
  }

  /**
   * Minimum Statistics: минимум сглаженной мощности за U·V кадров (~1.5 с).
   * Minimum Statistics: min of smoothed power over U·V frames (~1.5 s).
   */
  track(ch, P, frozen) {
    if (frozen) return;
    const b = this.bins;
    // Первые 10 кадров только сглаживаем: минимум «сырого» кадра на 15–20 дБ ниже шума.
    // First 10 frames only smooth: a raw single-frame minimum is 15–20 dB below the noise.
    const settle = ch.warm < 10;
    for (let k = 0; k < b; k++) {
      const s = (ch.S[k] = ch.warm ? 0.85 * ch.S[k] + 0.15 * P[k] : P[k]);
      if (!settle && s < ch.curMin[k]) ch.curMin[k] = s;
    }
    ch.warm++;
    if (settle) { for (let k = 0; k < b; k++) ch.noise[k] = ch.S[k]; return; }
    if (++ch.count >= ch.V) {
      ch.count = 0;
      const m = ch.mins[ch.sub];
      m.set(ch.curMin);
      ch.curMin.fill(Infinity);
      ch.sub = (ch.sub + 1) % ch.U;
    }
    // Оценка шума растёт не быстрее +3 дБ/с и падает мгновенно: протяжные ноты и гласные
    // не «записываются» в шум, а реальное изменение шума отслеживается за секунды.
    // The estimate rises at most +3 dB/s and falls instantly: sustained notes and vowels
    // are not learned as noise, while real noise changes are tracked within seconds.
    const rise = this.riseStep;
    for (let k = 0; k < b; k++) {
      let mn = ch.curMin[k];
      for (let u = 0; u < ch.U; u++) if (ch.mins[u][k] < mn) mn = ch.mins[u][k];
      // Поправка смещения минимума (измерена для сглаживания 0.85 и окна 2.5 с: ×2.0 ≈ +3 дБ)
      // Minimum bias compensation (measured for 0.85 smoothing and a 2.5 s window)
      const target = mn * 2.0;
      const cur = ch.noise[k];
      ch.noise[k] = !(cur > 0) || target <= cur || ch.warm <= (ch.U + 1) * ch.V + 10 ? target : Math.min(target, cur * rise);
    }
  }

  /**
   * Оценка шума для кадра: профиль, трекер или их комбинация.
   * Noise estimate for this frame: profile, tracker or both.
   * @returns {'profile'|'adaptive'|'auto'}
   */
  noiseFor(ch, P, { adaptive, frozen }) {
    const useTracker = adaptive || !this.profilePow;
    if (useTracker) this.track(ch, P, frozen);
    if (!useTracker) { ch.noise.set(this.profilePow); return 'profile'; }
    return adaptive ? 'adaptive' : 'auto';
  }

  /**
   * Усиления по бинам для кадра мощности P → ch.G.
   * Per-bin gains for power frame P → ch.G.
   */
  gains(ch, P) {
    const b = this.bins, p = this.p, N = ch.noise;
    const a = this.dd, thr = this.thrPow;
    const G = ch.G, tmp = ch.tmp;
    const algo = p.algorithm;

    // ── спектральное усиление (Винер + decision-directed) / spectral gain ──
    if (algo !== 'broadband') {
      for (let k = 0; k < b; k++) {
        const ne = Math.max(N[k] * this.alpha[k], thr, 1e-20);
        const g = P[k] / ne;
        const xi = a * ch.Gprev[k] * ch.Gprev[k] * ch.gPrev[k] + (1 - a) * Math.max(g - 1, 0);
        let w = xi / (1 + xi);
        if (w < this.floor[k]) w = this.floor[k];
        tmp[k] = w;
        ch.gPrev[k] = g;
        ch.Gprev[k] = w;
      }
    }
    // ── полосное усиление (Broadband/Hybrid) / band gain ──
    if (algo !== 'spectral') {
      const nb = this.nb, bp = ch.bandP, bn = ch.bandN;
      bp.fill(0); bn.fill(0);
      for (let k = 1; k < b; k++) {
        const j = this.bandOf[k];
        bp[j] += P[k];
        bn[j] += Math.max(N[k] * this.alpha[k], thr);
      }
      for (let j = 0; j < nb; j++) {
        if (bn[j] <= 0) { ch.bandG[j] = 1; continue; }
        const g = bp[j] / bn[j];
        const xi = a * ch.bandGprev[j] * ch.bandGprev[j] * ch.bandgPrev[j] + (1 - a) * Math.max(g - 1, 0);
        ch.bandG[j] = xi / (1 + xi);
        ch.bandGprev[j] = ch.bandG[j];
        ch.bandgPrev[j] = g;
      }
      for (let k = 0; k < b; k++) {
        const x = this.bandPos[k], i = Math.floor(x), t = x - i;
        const gb = ch.bandG[i] + (ch.bandG[Math.min(nb - 1, i + 1)] - ch.bandG[i]) * t;
        const fl = this.floor[k];
        const v = Math.max(gb, fl);
        tmp[k] = algo === 'broadband' ? v : Math.sqrt(tmp[k] * v); // гибрид — среднее геометрическое
      }
    }

    // ── медиана 3 бинов против «звёздочек» (musical noise) / 3-bin median ──
    if (p.artifactControl > 20) {
      let prev = tmp[0];
      for (let k = 1; k < b - 1; k++) {
        const x = prev, y = tmp[k], z = tmp[k + 1];
        prev = y;
        tmp[k] = x > y ? (y > z ? y : x > z ? z : x) : (x > z ? x : y > z ? z : y);
      }
    }
    // ── сглаживание по частоте (вперёд-назад) / frequency smoothing (forward-backward) ──
    // Берём max(G, сглаженное): сглаживание только «заполняет» провалы рядом с сигналом
    // (меньше водянистости) и никогда не занижает гармоники голоса.
    // max(G, smoothed): smoothing only fills dips near the signal (less watery sound)
    // and never pulls voice harmonics down.
    const c = this.fsm;
    if (c > 0.001) {
      const sm = ch.sm || (ch.sm = new Float32Array(b));
      sm[0] = tmp[0];
      for (let k = 1; k < b; k++) sm[k] = tmp[k] * (1 - c) + sm[k - 1] * c;
      for (let k = b - 2; k >= 0; k--) sm[k] = sm[k] * (1 - c) + sm[k + 1] * c;
      for (let k = 0; k < b; k++) if (sm[k] > tmp[k]) tmp[k] = sm[k];
    }
    // ── атака/восстановление, тон, диапазон / attack/release, tone, range ──
    for (let k = 0; k < b; k++) {
      const t = tmp[k];
      const s = ch.Gs[k] + (t > ch.Gs[k] ? this.ca : this.cr) * (t - ch.Gs[k]);
      ch.Gs[k] = s;
      let g = this.toneExp[k] < 1 ? Math.pow(s, this.toneExp[k]) : s;
      g = 1 - this.rangeW[k] * (1 - g);
      G[k] = g;
    }
    return G;
  }
}
