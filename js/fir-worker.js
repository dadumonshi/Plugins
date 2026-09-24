/**
 * fir-worker.js — Web Worker для тяжёлого расчёта FIR (Natural / Linear Phase).
 * fir-worker.js — Web Worker for heavy FIR design (Natural / Linear Phase).
 *
 * Выносим FFT из основного потока, чтобы жесты на телефоне не подтормаживали.
 * FFT runs off the main thread so touch gestures stay smooth on phones.
 */
import { designFir } from './dsp.js';

self.onmessage = (e) => {
  const { id, bands, fs, size, mode } = e.data;
  try {
    const res = designFir(bands, { fs, size, mode });
    // Transferable: передаём буферы без копирования / zero-copy transfer.
    self.postMessage({ id, ...res }, res.irs.map((ir) => ir.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
