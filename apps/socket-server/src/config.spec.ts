import { readConfig } from './config.ts';

describe('server configuration', () => {
  it('works without cloud credentials or an environment file', () => {
    expect(readConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    });
  });

  it('accepts an explicit listener and browser origins', () => {
    expect(
      readConfig({
        HOST: '0.0.0.0',
        PORT: '4001',
        CORS_ORIGINS: 'https://example.com, http://localhost:4200 ',
      }),
    ).toEqual({
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
