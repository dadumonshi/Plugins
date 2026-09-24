/**
 * fft.js — быстрое преобразование Фурье (радикс-2) с заранее посчитанными таблицами.
 * fft.js — radix-2 FFT with precomputed tables.
 *
 * Используется в AudioWorklet шумоподавителя (STFT каждые 512 сэмплов) и в основном
 * потоке (обучение профиля шума по аудиофайлу). Таблицы cos/sin и перестановки битов
 * считаются один раз — в реальном времени только умножения и сложения.
 * Used by the denoiser AudioWorklet (STFT every 512 samples) and on the main thread
 * (learning a noise profile from a file). Tables are computed once.
 */
export class FFT {
  /** @param {number} n размер, степень двойки / size, power of two */
  constructor(n) {
    if (n & (n - 1)) throw new Error('Размер FFT должен быть степенью двойки');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  _transform(re, im, inv) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const s = inv ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cos[t], wi = s * this.sin[t];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  forward(re, im) { this._transform(re, im, false); }
  inverse(re, im) { this._transform(re, im, true); }
}

/** Окно Ханна (периодическое — идеальная сумма при перекрытии 75 %). Periodic Hann window. */
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
