import { PcmEncoder } from './pcm';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private running = true;
  private encoder = new PcmEncoder(sampleRate, (data) =>
    this.port.postMessage({ type: 'chunk', data }, [data.buffer]),
  );
  constructor() {
    super();
    this.port.onmessage = () => {
      if (!this.running) return;
      this.running = false;
      this.encoder.flush();
      this.port.postMessage({ type: 'stopped' });
    };
  }
  process(inputs: Float32Array[][]) {
    if (this.running && inputs[0]?.length) this.encoder.push(inputs[0]);
    return this.running;
  }
}
registerProcessor('pcm-capture', CaptureProcessor);
