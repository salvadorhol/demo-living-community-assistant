import { PcmEncoder } from './pcm';
it('encodes clipped signed PCM16 little endian and flushes a partial frame', () => {
  const chunks: Uint8Array[] = [];
  const encoder = new PcmEncoder(24000, (data) => chunks.push(data));
  encoder.push([new Float32Array([-2, -0.5, 0, 0.5, 2])]);
  encoder.flush();
  const view = new DataView(chunks[0].buffer);
  expect(
    Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)),
  ).toEqual([-32768, -16384, 0, 16384, 32767]);
});
it.each([24000, 44100, 48000])(
  'preserves one second and 40ms chunk boundaries at %i Hz',
  (rate) => {
    const chunks: Uint8Array[] = [];
    const encoder = new PcmEncoder(rate, (data) => chunks.push(data));
    const samples = new Float32Array(rate).fill(0.5);
    for (let i = 0; i < rate; i += 128)
      encoder.push([samples.slice(i, i + 128)]);
    encoder.flush();
    expect(chunks.reduce((n, chunk) => n + chunk.byteLength, 0)).toBe(48000);
    expect(chunks).toHaveLength(25);
    expect(chunks.every((chunk) => chunk.byteLength === 1920)).toBe(true);
  },
);
it('downmixes channels before resampling without changing values across block boundaries', () => {
  const chunks: Uint8Array[] = [];
  const encoder = new PcmEncoder(48000, (data) => chunks.push(data));
  for (let i = 0; i < 10; i++)
    encoder.push([
      new Float32Array(128).fill(1),
      new Float32Array(128).fill(-1),
    ]);
  encoder.flush();
  expect(
    chunks.flatMap((chunk) => [...chunk]).every((byte) => byte === 0),
  ).toBe(true);
});
