// Keep sample conversion in the audio thread. No microphone samples enter logs.
export const pcmWorkletSource = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.weight = 0;
    this.sum = 0;
    this.stopped = false;
    this.paused = false;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === "resume" && !this.stopped) {
        this.paused = false;
        this.port.postMessage({ type: "resumed" });
        return;
      }
      if (type !== "flush" && type !== "pause") return;
      this.stopped = type === "flush";
      this.paused = true;
      if (this.weight) this.samples.push(this.sum / this.weight);
      this.weight = 0;
      this.sum = 0;
      this.emit();
      this.port.postMessage({ type: this.stopped ? "flushed" : "paused" });
    };
  }
  emit() {
    if (!this.samples.length) return;
    const bytes = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(bytes);
    this.samples.forEach((value, i) => {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    });
    this.samples = [];
    this.port.postMessage(bytes, [bytes]);
  }
  process(inputs) {
    if (this.stopped) return false;
    if (this.paused) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const ratio = sampleRate / 24000;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= ratio - 1e-8) {
          this.samples.push(this.sum / this.weight);
          this.weight = 0;
          this.sum = 0;
          if (this.samples.length >= 4800) this.emit();
        }
      }
    }
    return true;
  }
}
registerProcessor("feedback-loop-pcm-capture", PcmCapture);
`;
