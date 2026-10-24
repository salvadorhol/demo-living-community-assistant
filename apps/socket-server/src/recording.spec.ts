import { readFileSync, existsSync } from 'node:fs';
import { CallRecording } from './recording.ts';
it('mixes both speakers without clipping, preserves gaps, and trims cleared playback', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const recording = new CallRecording();
  try {
    const loud = Buffer.alloc(4800);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(30000, i);
    recording.append('mic', loud, true);
    const assistant = Buffer.alloc(4800);
    for (let i = 0; i < assistant.length; i += 2)
      assistant.writeInt16LE(10000, i);
    recording.append('assistant', assistant);
    recording.progress('assistant', 50);
    recording.clear('assistant');
    recording.progress('assistant', 60); // Final clear acknowledgement can refine the cutoff.
    recording.progress('assistant', 110); // Beyond delivered bytes is ignored.
    now = 200;
    await recording.finish();
    await recording.finish();
    const wav = readFileSync(recording.path);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + 9600);
    expect(wav.readInt16LE(44 + 100)).toBe(20000);
    expect(wav.readInt16LE(44 + 2600)).toBe(20000);
    expect(wav.readInt16LE(44 + 3500)).toBe(30000);
    expect(wav.readInt16LE(44 + 6000)).toBe(0);
  } finally {
    recording.cleanup();
    clock.mockRestore();
  }
  expect(existsSync(recording.directory)).toBe(false);
});
