/**
 * learn.js — обучение и хранение профиля шума (noise print) Movexe DeNoise.
 * learn.js — Movexe DeNoise noise-print learning and storage.
 *
 * Профиль / Profile:
 *   { id?, name, sampleRate, fftSize, bins: number[] (дБ по бинам, 0 дБ = синус 0 дБFS) }
 *
 * Источники профиля / profile sources:
 *   • Learn в реальном времени (AudioWorklet, 2–5 с «тишины» с шумом);
 *   • аудиофайл с шумом (анализ здесь, в основном потоке, через fft.js);
 *   • JSON-файл профиля (экспорт/импорт), сервер (PHP /api/noise-profiles).
 */
import { FFT, hann } from './fft.js';

export const LEARN_FFT = 2048;

/**
 * Средний спектр мощности аудиобуфера (первые `seconds` секунд после `start`).
 * Average power spectrum of an AudioBuffer (first `seconds` after `start`).
 * @returns {{name:string,sampleRate:number,fftSize:number,bins:Float32Array}}
 */
export function learnFromBuffer(buffer, { seconds = 5, start = 0, name = 'Профиль из файла', fftSize = LEARN_FFT } = {}) {
  const fs = buffer.sampleRate, n = fftSize, hop = n / 4;
  const fft = new FFT(n), w = hann(n);
  const chs = [...Array(buffer.numberOfChannels).keys()].map((c) => buffer.getChannelData(c));
  const s0 = Math.floor(start * fs);
  const s1 = Math.min(buffer.length, s0 + Math.floor(seconds * fs));
  if (s1 - s0 < n) throw new Error('Фрагмент слишком короткий для анализа (нужно ≥ 0,1 с)');
  const bins = n / 2 + 1;
  const sum = new Float64Array(bins);
  const re = new Float64Array(n), im = new Float64Array(n);
  let frames = 0;
  for (let pos = s0; pos + n <= s1; pos += hop) {
    for (const d of chs) {
      for (let i = 0; i < n; i++) { re[i] = d[pos + i] * w[i]; im[i] = 0; }
      fft.forward(re, im);
      for (let k = 0; k < bins; k++) sum[k] += (re[k] * re[k] + im[k] * im[k]) / chs.length;
    }
    frames++;
  }
  const ref = (n / 4) * (n / 4);
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) out[k] = 10 * Math.log10(sum[k] / frames / ref + 1e-16);
  return { name, sampleRate: fs, fftSize: n, bins: out };
}

/** Профиль → JSON (округление до 0,1 дБ — в 4 раза меньше файл) / profile → JSON. */
export function profileToJSON(p) {
  return {
    format: 'movexe-noise-print', version: 1,
    name: p.name || 'Профиль шума',
    sampleRate: p.sampleRate, fftSize: p.fftSize,
    bins: Array.from(p.bins, (v) => Math.round(Math.max(-160, v) * 10) / 10),
    created: p.created || new Date().toISOString()
  };
}

/** JSON → профиль с проверкой / JSON → profile with validation. */
export function profileFromJSON(o) {
  if (!o || !Array.isArray(o.bins)) throw new Error('Это не файл профиля шума');
  const n = Number(o.fftSize), fs = Number(o.sampleRate);
  if (!(n >= 256 && n <= 32768 && !(n & (n - 1)))) throw new Error('Неверный размер FFT в профиле');
  if (o.bins.length !== n / 2 + 1) throw new Error('Число бинов не совпадает с размером FFT');
  if (!(fs >= 8000 && fs <= 192000)) throw new Error('Неверная частота дискретизации профиля');
  const bins = Float32Array.from(o.bins, (v) => (Number.isFinite(Number(v)) ? Math.max(-160, Math.min(40, Number(v))) : -160));
  return { id: o.id, name: String(o.name || 'Профиль шума').slice(0, 64), sampleRate: fs, fftSize: n, bins, factory: !!o.factory };
}

/** Уровень профиля (дБ) на частоте f / profile level (dB) at frequency f. */
export function profileAt(p, f) {
  if (!p) return -140;
  const x = (f / p.sampleRate) * p.fftSize;
  const i = Math.max(0, Math.min(p.bins.length - 1, Math.floor(x)));
  const j = Math.min(p.bins.length - 1, i + 1), t = Math.min(1, Math.max(0, x - i));
  return p.bins[i] + (p.bins[j] - p.bins[i]) * t;
}
