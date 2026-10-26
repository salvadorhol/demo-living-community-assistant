import { GoogleAuth } from 'google-auth-library';
import { ConfigurationError } from '../../configuration-error.ts';
import { ToolError } from './contracts.ts';

export interface FirebaseToolConfig {
  projectId: string;
  region: string;
  emulatorHost?: string;
}
export type RequestHeaders = NonNullable<
  ConstructorParameters<typeof Headers>[0]
>;
export type GetHeaders = (audience: string) => Promise<RequestHeaders>;
const auth = new GoogleAuth();
async function googleHeaders(audience: string): Promise<RequestHeaders> {
  const client = await auth.getIdTokenClient(audience);
  return (await client.getRequestHeaders()) as RequestHeaders;
}
export function readFirebaseToolConfig(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): FirebaseToolConfig {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId))
    throw new ConfigurationError(
      'Invalid Firebase project for tool functions.',
    );
  const region = env.FIREBASE_FUNCTIONS_REGION?.trim() || 'us-central1';
  if (!/^[a-z]+-[a-z]+\d+$/.test(region))
    throw new ConfigurationError('Invalid FIREBASE_FUNCTIONS_REGION.');
  const emulatorHost = env.FIREBASE_FUNCTIONS_EMULATOR_HOST?.trim();
  if (emulatorHost) {
    let url: URL;
    try {
      url = new URL(`http://${emulatorHost}`);
    } catch {
      throw new ConfigurationError('Invalid FIREBASE_FUNCTIONS_EMULATOR_HOST.');
    }
    if (
      !projectId.startsWith('demo-') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port ||
      url.host !== emulatorHost ||
      url.username ||
      url.password ||
      url.pathname !== '/'
    )
      throw new ConfigurationError(
        'Functions emulator tools require a demo project and a loopback host:port.',
      );
  }
  return { projectId, region, ...(emulatorHost ? { emulatorHost } : {}) };
}
async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ToolError('INVALID_RESULT', 'Tool returned no JSON result.');
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536)
        throw new ToolError(
          'RESULT_TOO_LARGE',
          'Tool result exceeded the size limit.',
        );
      buffers.push(chunk.value);
    }
    try {
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch {
      throw new ToolError('INVALID_RESULT', 'Tool did not return valid JSON.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function createFirebaseInvoker(
  config: FirebaseToolConfig,
  dependencies: { fetch?: typeof fetch; getHeaders?: GetHeaders } = {},
) {
  // Revalidate even when callers construct config without the environment parser.
  readFirebaseToolConfig(config.projectId, {
    FIREBASE_FUNCTIONS_REGION: config.region,
    FIREBASE_FUNCTIONS_EMULATOR_HOST: config.emulatorHost,
  });
  const request = dependencies.fetch ?? fetch;
  const getHeaders = dependencies.getHeaders ?? googleHeaders;
  return async (
    functionName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(functionName))
      throw new ConfigurationError(
        'Invalid registered Firebase function name.',
      );
    const url = config.emulatorHost
      ? `http://${config.emulatorHost}/${config.projectId}/${config.region}/${functionName}`
      : `https://${config.region}-${config.projectId}.cloudfunctions.net/${functionName}`;
    signal.throwIfAborted();
    let authorization: RequestHeaders = {};
    if (!config.emulatorHost) {
      try {
        authorization = await getHeaders(url);
      } catch {
        signal.throwIfAborted();
        throw new ToolError(
          'AUTHENTICATION_FAILED',
          'Availability service authentication failed.',
        );
      }
    }
    const headers = new Headers(authorization);
    signal.throwIfAborted();
    headers.set('Content-Type', 'application/json');
    const response = await request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      if (
        response.status === 409 &&
        response.headers.get('content-type')?.includes('application/json')
      ) {
        const value = await readBoundedJson(response);
        const code = (value as { error?: { code?: string } } | null)?.error
          ?.code;
        const messages: Record<string, string> = {
          SLOT_UNAVAILABLE:
            'That tour slot is no longer available. Look up new slots before preparing another request.',
          CONTACT_REQUIRED:
            'Save a confirmed email or phone before requesting follow-up.',
          CONFLICT:
            'This confirmation token was already used for different values. Prepare and confirm the corrected values again.',
        };
        if (code && Object.hasOwn(messages, code))
          throw new ToolError(code, messages[code], 409);
        throw new ToolError(
          'UPSTREAM_ERROR',
          'The service could not complete this request. Please try again.',
          409,
        );
      }
      await response.body?.cancel();
      throw new ToolError(
        'UPSTREAM_ERROR',
        'Availability service is unavailable. Please try again.',
        response.status,
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new ToolError(
        'INVALID_RESULT',
        'Availability service returned an invalid result.',
      );
    }
    return readBoundedJson(response);
  };
}
