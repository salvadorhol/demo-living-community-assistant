import { readConfig } from './config.ts';

describe('server configuration', () => {
  it('works without cloud credentials or an environment file', () => {
    expect(
      readConfig({ FIREBASE_PROJECT_ID: 'demo-living-community-assistant' }),
    ).toEqual({
      firebaseProjectId: 'demo-living-community-assistant',
      storageBucket: 'demo-living-community-assistant-call-recordings',
      maxCallMs: 3600000,
      voiceOutputQueueMs: 60000,
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    });
  });

  it('accepts an explicit listener and browser origins', () => {
    expect(
      readConfig({
        FIREBASE_PROJECT_ID: 'demo-living-community-assistant',
        HOST: '0.0.0.0',
        PORT: '4001',
        CORS_ORIGINS: 'https://example.com, http://localhost:4200 ',
      }),
    ).toEqual({
      firebaseProjectId: 'demo-living-community-assistant',
      storageBucket: 'demo-living-community-assistant-call-recordings',
      maxCallMs: 3600000,
      voiceOutputQueueMs: 60000,
      host: '0.0.0.0',
      port: 4001,
      allowedOrigins: ['https://example.com', 'http://localhost:4200'],
    });
  });

  it.each([
    '',
    '0',
    '-1',
    '65536',
    '3.5',
    '3000abc',
    ' 3000',
    '1e3',
    'Infinity',
  ])('rejects invalid port %j', (value) =>
    expect(() => readConfig({ PORT: value })).toThrow(/PORT/),
  );

  it.each([
    '*',
    'https://example.com/path',
    'https://example.com/',
    'file:///tmp/example',
    'https://user:password@example.com',
    '',
    ',',
  ])('rejects invalid browser origin %j', (value) =>
    expect(() => readConfig({ CORS_ORIGINS: value })).toThrow(/CORS_ORIGINS/),
  );

  it('rejects an empty host', () =>
    expect(() => readConfig({ HOST: ' ' })).toThrow(/HOST/));
});

it('requires an explicit Firebase project', () =>
  expect(() => readConfig({})).toThrow(/FIREBASE_PROJECT_ID/));

it.each(['', '0', '-1', '999', '120001', 'NaN', '3.5'])(
  'rejects invalid output queue configuration %j as a configuration error',
  (value) => {
    expect(() =>
      readConfig({ FIREBASE_PROJECT_ID: 'demo', VOICE_OUTPUT_QUEUE_MS: value }),
    ).toThrow(/VOICE_OUTPUT_QUEUE_MS/);
  },
);
it('accepts an explicit output queue duration', () => {
  expect(
    readConfig({ FIREBASE_PROJECT_ID: 'demo', VOICE_OUTPUT_QUEUE_MS: '90000' })
      .voiceOutputQueueMs,
  ).toBe(90000);
});
