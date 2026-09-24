/**
 * spectrogram.js — водопад-спектрограмма (время → вправо, частота ↑, лог-шкала), как в RX.
 * spectrogram.js — waterfall spectrogram (time →, frequency ↑ on a log scale), RX-style.
 *
 * Каждый кадр: изображение сдвигается на 1–2 px влево (drawImage самого себя), справа
 * дорисовывается новый столбец через ImageData — без перерисовки всей картинки.
 * Each frame the image shifts left by 1–2 px (self drawImage) and one new column is
 * written via ImageData — the whole picture is never redrawn.
 */
import { canvasDpr, releaseCanvas } from './touch.js';

/** Палитра: чёрный → бирюзовый → жёлтый → белый / colormap. */
function makeLut() {
  const stops = [[0, [10, 10, 14]], [0.35, [0, 90, 110]], [0.6, [0, 180, 216]], [0.8, [255, 200, 60]], [1, [255, 255, 255]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let j = 0; while (j < stops.length - 2 && x > stops[j + 1][0]) j++;
    const [x0, c0] = stops[j], [x1, c1] = stops[j + 1];
    const t = (x - x0) / (x1 - x0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * t;
  }
  return lut;
}

export class Spectrogram {
  constructor(canvas, { fMin = 20, fMax = 20000, floorDb = -110, ceilDb = -10 } = {}) {
    this.cv = canvas;
    this.fMin = fMin; this.fMax = fMax;
    this.floorDb = floorDb; this.ceilDb = ceilDb;
    this.lut = makeLut();
    this.buf = null;
    this.w = 0; this.h = 0;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(canvasDpr(), 1.5); // спектрограмме хватит 1.5× / 1.5× is enough here
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w === this.w && h === this.h) return;
    this.w = this.cv.width = w;
    this.h = this.cv.height = h;
    this.ctx = this.cv.getContext('2d');
    this.ctx.fillStyle = '#0a0a0e';
    this.ctx.fillRect(0, 0, w, h);
    this.col = this.ctx.createImageData(1, h);
    this.rowBin = null;
  }

  release() { releaseCanvas(this.cv); this.w = this.h = 0; }

  /** Добавить столбец из AnalyserNode / push a column from an AnalyserNode. */
  push(analyser, fs, step = 2) {
    if (!this.w) this.resize();
    if (!this.w || this.h < 4) return;
    const n = analyser.frequencyBinCount;
    if (!this.buf || this.buf.length !== n) { this.buf = new Float32Array(n); this.rowBin = null; }
    analyser.getFloatFrequencyData(this.buf);
    const { w, h, ctx } = this;
    if (!this.rowBin || this.rowBin.length !== h) {
      // Строка → бин (лог-шкала, внизу низкие частоты) / row → bin (log scale)
      this.rowBin = new Uint16Array(h);
      for (let y = 0; y < h; y++) {
        const f = this.fMin * Math.pow(this.fMax / this.fMin, 1 - y / (h - 1));
        this.rowBin[y] = Math.min(n - 1, Math.round((f / (fs / 2)) * n));
      }
    }
    ctx.drawImage(this.cv, step, 0, w - step, h, 0, 0, w - step, h);
    const d = this.col.data, lut = this.lut, span = this.ceilDb - this.floorDb;
    for (let y = 0; y < h; y++) {
      const v = this.buf[this.rowBin[y]];
      let i = Math.round(((v - this.floorDb) / span) * 255);
      i = i < 0 ? 0 : i > 255 ? 255 : i;
      d[y * 4] = lut[i * 3]; d[y * 4 + 1] = lut[i * 3 + 1]; d[y * 4 + 2] = lut[i * 3 + 2]; d[y * 4 + 3] = 255;
    }
    for (let x = w - step; x < w; x++) ctx.putImageData(this.col, x, 0);
  }
}
