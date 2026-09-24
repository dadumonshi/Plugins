/**
 * proportionalq.js — алгоритм Proportional Q графического эквалайзера Movexe EQ Lite
 * (в духе API 560). Чистая математика, без DOM.
 * proportionalq.js — Proportional Q algorithm of the Movexe EQ Lite graphic EQ
 * (API 560 style). Pure math, no DOM.
 *
 * ── Что такое Proportional Q ─────────────────────────────────────────────────
 * У классического API 560 нет ручки Q: добротность фильтра сама растёт вместе с
 * величиной подъёма/ослабления. Малые значения (±1…4 дБ) — широкие мягкие «холмы»,
 * большие (±8…12 дБ) — узкие точные пики/провалы. Подъём и ослабление симметричны.
 * The classic API 560 has no Q knob: Q grows with the amount of boost/cut. Small
 * moves (±1…4 dB) give broad, gentle curves; large moves (±8…12 dB) give narrow,
 * precise ones. Boost and cut are symmetrical.
 *
 * ── Формула / Formula ────────────────────────────────────────────────────────
 *     Q(g) = Q0 + a·|g| + b·g²,   Q0 = 0.7,  a = 0.0375,  b = 0.009375
 *
 * Коэффициенты подобраны так, чтобы кривая проходила ТОЧНО через опорные точки ТЗ:
 * The coefficients make the curve pass EXACTLY through the reference points:
 *     g = 0 дБ  → Q = 0.70  (≈ 2 октавы / octaves)
 *     g = 4 дБ  → Q = 1.00  (≈ 1.39 октавы)
 *     g = 12 дБ → Q = 2.50  (≈ 0.57 октавы)
 * Решение системы / solving:  4a + 16b = 0.3 ;  12a + 144b = 1.8  →  b = 0.9/96, a = 0.075 − 4b.
 * Квадратичная форма (а не линейная 0.7 + |g|·0.15) держит «широкий» характер
 * до ±4 дБ и резко сужает полосу ближе к ±12 дБ — именно так ведёт себя 560-й.
 * The quadratic (rather than linear 0.7 + |g|·0.15) keeps curves wide up to ±4 dB
 * and narrows them sharply towards ±12 dB — the way the 560 behaves.
 * Функция монотонна и гладкая (нет скачков Q при движении фейдера).
 * The function is monotonic and smooth (no Q jumps while moving a fader).
 */

export const LITE_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const LITE_LABELS = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const GAIN_MAX = 12;

const Q0 = 0.7, QA = 0.0375, QB = 0.009375;

/** Добротность по усилению (Proportional Q) / Q from gain. */
export function proportionalQ(gainDb) {
  const g = Math.min(GAIN_MAX, Math.abs(gainDb));
  return Q0 + QA * g + QB * g * g;
}

/** Ширина полосы в октавах для Q (по определению RBJ) / bandwidth in octaves for Q. */
export function qToOctaves(q) {
  return (2 / Math.LN2) * Math.asinh(1 / (2 * q));
}

/* ------------------------------------------------------------------ *
 * Шкала фейдера с повышенной точностью в зоне ±4 дБ.
 * Fader scale with extra resolution in the ±4 dB zone.
 *   позиция p ∈ [−1, 1]; |p| ≤ 0.5 → |g| = 8·|p|  (±4 дБ занимают ПОЛОВИНУ хода)
 *                         |p| > 0.5 → |g| = 4 + 16·(|p| − 0.5)  (4…12 дБ — вторая половина)
 * p ∈ [−1, 1]: ±4 dB take HALF of the fader travel, 4…12 dB the other half.
 * ------------------------------------------------------------------ */
export function posToGain(p) {
  const a = Math.min(1, Math.abs(p));
  const g = a <= 0.5 ? 8 * a : 4 + 16 * (a - 0.5);
  return Math.sign(p) * g;
}
export function gainToPos(g) {
  const a = Math.min(GAIN_MAX, Math.abs(g));
  const p = a <= 4 ? a / 8 : 0.5 + (a - 4) / 16;
  return Math.sign(g) * p;
}

/** Фиксация в 0 дБ (центральный детент) / centre detent. */
export const DETENT_DB = 0.35;
export function applyDetent(g) { return Math.abs(g) < DETENT_DB ? 0 : g; }

/* ------------------------------------------------------------------ *
 * Отклик / Response (RBJ peaking = то же, что BiquadFilterNode 'peaking')
 * ------------------------------------------------------------------ */

/** Коэффициенты peaking-биквада / peaking biquad coefficients. */
export function peakingCoefs(f0, gainDb, q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const al = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + al / A;
  return { b0: (1 + al * A) / a0, b1: (-2 * c) / a0, b2: (1 - al * A) / a0, a1: (-2 * c) / a0, a2: (1 - al / A) / a0 };
}

/** АЧХ одной полосы в дБ на частоте f / band magnitude (dB) at f. */
export function bandDb(f0, gainDb, f, fs) {
  if (Math.abs(gainDb) < 1e-4) return 0;
  const c = peakingCoefs(f0, gainDb, proportionalQ(gainDb), fs);
  const w = (2 * Math.PI * Math.min(f, fs * 0.4999)) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di || 1e-30));
}

/** Суммарная АЧХ всех полос / total response (dB). */
export function totalDb(gains, f, fs) {
  let s = 0;
  for (let i = 0; i < LITE_FREQS.length; i++) s += bandDb(LITE_FREQS[i], gains[i], f, fs);
  return s;
}

/**
 * Автокомпенсация уровня (Gain Match): взвешенное среднее АЧХ 40 Гц–12 кГц с упором на
 * середину, где слух чувствительнее. Возвращает поправку, дБ.
 * Gain Match: mid-weighted mean response 40 Hz–12 kHz; returns the correction in dB.
 */
export function autoGainDb(gains, fs) {
  const N = 40;
  let sum = 0, w = 0;
  for (let i = 0; i < N; i++) {
    const f = 40 * Math.pow(12000 / 40, i / (N - 1));
    const lw = Math.exp(-Math.pow(Math.log2(f / 1500) / 3, 2));
    sum += totalDb(gains, f, fs) * lw;
    w += lw;
  }
  return Math.max(-18, Math.min(18, -(sum / w) * 0.9));
}
