// Bounded mono capture; loaded from the same origin under the research CSP.
class ResearchCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(1024); this.used = 0; this.active = true;
    this.port.onmessage = event => {
      if (event.data === 'finish' && this.active) {
        if (this.used) { const tail = this.samples.slice(0, this.used); this.port.postMessage(tail, [tail.buffer]); this.used = 0; }
        this.active = false; this.port.postMessage({ type: 'flushed' });
      } else if (event.data === 'stop') this.active = false;
    };
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sum = 0; for (const channel of channels) sum += channel[i] || 0;
      this.samples[this.used++] = sum / channels.length;
      if (this.used === this.samples.length) { this.port.postMessage(this.samples, [this.samples.buffer]); this.samples = new Float32Array(1024); this.used = 0; }
    }
    return true;
  }
}
registerProcessor('research-capture', ResearchCapture);
