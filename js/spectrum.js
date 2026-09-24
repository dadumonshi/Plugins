/**
 * spectrum.js — спектр-анализатор для графиков: отображение бинов FFT на лог-шкалу,
 * наклон 4.5 дБ/окт, баллистика спада, отрисовка серо-зелёным градиентом.
 * spectrum.js — spectrum analyser for graphs: FFT bins → log axis, 4.5 dB/oct tilt,
 * fall-off ballistics, grey-green gradient rendering.
 */

export class SpectrumAnalyzer {
  /**
   * @param {object} o
   * @param {(x:number)=>number} o.xToFreq  экран → частота / screen → frequency
   * @param {(db:number)=>number} o.dbToY   дБ → экран / dB → screen
   */
  constructor({ xToFreq, dbToY, tilt = 4.5, decay = 1.2 } = {}) {
    this.xToFreq = xToFreq;
    this.dbToY = dbToY;
    this.tilt = tilt;
    this.decay = decay; // дБ за кадр / dB per frame
    this.buf = null;
    this.vals = null;
    this.step = 2;
  }

  reset() { this.vals = null; }

  /**
   * Прочитать анализатор и обновить значения по столбцам.
   * Read the analyser and update per-column values.
   * @returns {Float32Array} dB по столбцам шириной `step` px
   */
  update(analyser, width, fs, step = 2) {
    const n = analyser.frequencyBinCount;
    if (!this.buf || this.buf.length !== n) this.buf = new Float32Array(n);
    analyser.getFloatFrequencyData(this.buf);
    const cols = Math.ceil(width / step) + 1;
    if (!this.vals || this.vals.length !== cols || this.step !== step) {
      this.vals = new Float32Array(cols).fill(-140);
      this.step = step;
    }
    const binHz = fs / analyser.fftSize;
    const buf = this.buf, vals = this.vals;
    for (let i = 0; i < cols; i++) {
      const x = i * step;
      const f0 = this.xToFreq(x), f1 = this.xToFreq(x + step);
      const k0 = f0 / binHz, k1 = f1 / binHz;
      let db;
      if (k1 - k0 < 1) { // НЧ: интерполяция / lows: interpolate
        const k = Math.floor(k0), fr = k0 - k;
        const a = buf[Math.min(k, n - 1)], b = buf[Math.min(k + 1, n - 1)];
        db = a + (b - a) * fr;
      } else { // ВЧ: максимум по бинам / highs: max over bins
        db = -200;
        const e = Math.min(Math.ceil(k1), n);
        for (let k = Math.floor(k0); k < e; k++) if (buf[k] > db) db = buf[k];
      }
      if (!Number.isFinite(db) || f0 > fs / 2) db = -200;
      db += this.tilt * Math.log2(Math.max(f0, 1) / 1000);
      vals[i] = db > vals[i] - this.decay ? db : vals[i] - this.decay;
    }
    return vals;
  }

  /** Нарисовать залитый спектр / draw filled spectrum. */
  draw(c, h, { top = 'rgba(120,200,150,0.38)', line = 'rgba(160,215,180,0.75)', fill = true } = {}) {
    const v = this.vals;
    if (!v) return;
    const step = this.step;
    c.beginPath();
    c.moveTo(0, h);
    for (let i = 0; i < v.length; i++) c.lineTo(i * step, Math.min(h, this.dbToY(v[i])));
    c.lineTo((v.length - 1) * step, h);
    c.closePath();
    if (fill) {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, top);
      g.addColorStop(1, 'rgba(90,110,100,0.04)');
      c.fillStyle = g;
      c.fill();
    }
    c.beginPath();
    for (let i = 0; i < v.length; i++) {
      const y = Math.min(h, this.dbToY(v[i]));
      i ? c.lineTo(i * step, y) : c.moveTo(0, y);
    }
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.stroke();
  }
}
