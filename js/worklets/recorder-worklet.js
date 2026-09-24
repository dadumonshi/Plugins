/**
 * recorder-worklet.js — AudioWorklet: захват PCM без потерь в отдельном аудио-потоке.
 * recorder-worklet.js — AudioWorklet: lossless PCM capture on the audio thread.
 *
 * Буферизуем по 4096 кадров, чтобы не засыпать главный поток сообщениями (≈11 msg/s).
 * Batches 4096 frames so we don't flood the main thread (~11 msgs/s).
 */
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.size = 4096;
    this.reset();
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.reset(); this.recording = true; }
      else if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true }); }
    };
  }

  reset() {
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.pos = 0;
  }

  flush() {
    if (!this.pos) return;
    const l = this.bufL.slice(0, this.pos);
    const r = this.bufR.slice(0, this.pos);
    this.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recording && input && input.length) {
      const L = input[0];
      const R = input[1] || input[0];
      for (let i = 0; i < L.length; i++) {
        this.bufL[this.pos] = L[i];
        this.bufR[this.pos] = R[i];
        if (++this.pos === this.size) this.flush();
      }
    }
    return true; // держать узел живым / keep node alive
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
