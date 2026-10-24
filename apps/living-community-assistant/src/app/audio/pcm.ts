/** Stateful resampling keeps the fractional source position across render quanta. */
export class PcmEncoder {
  private samples: number[] = [];
  private position = 0;
  private frame: number[] = [];
  constructor(
    private inputRate: number,
    private emit: (data: Uint8Array) => void,
  ) {}

  push(channels: Float32Array[]) {
    if (!channels.length) return;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.samples.push(sample);
    }
    const step = this.inputRate / 24000;
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample =
        this.samples[index] * (1 - fraction) +
        this.samples[index + 1] * fraction;
      this.frame.push(sample);
      if (this.frame.length === 960) this.flushFrame();
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    this.samples.splice(0, consumed);
    this.position -= consumed;
  }
  flush() {
    // Include the last source sample when its output position has not been rendered.
    while (this.position < this.samples.length) {
      this.frame.push(this.samples[Math.floor(this.position)]);
      this.position += this.inputRate / 24000;
      if (this.frame.length === 960) this.flushFrame();
    }
    this.flushFrame();
    this.samples = [];
    this.position = 0;
  }
  private flushFrame() {
    if (!this.frame.length) return;
    const data = new Uint8Array(this.frame.length * 2);
    const view = new DataView(data.buffer);
    this.frame.forEach((value, index) => {
      const sample = Math.max(
        -1,
        Math.min(1, Number.isFinite(value) ? value : 0),
      );
      view.setInt16(
        index * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
    });
    this.frame = [];
    this.emit(data);
  }
}
