import { ConfigurationError } from '../../configuration-error.ts';
import {
  ToolError,
  type ToolContext,
  type ToolDefinition,
} from './contracts.ts';

export const TOOL_LIMITS = {
  timeoutMs: 10_000,
  maxCallsPerTurn: 4,
  concurrency: 2,
  maxArgumentBytes: 8192,
} as const;
export interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}
export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };
export const toolFailure = (code: string, message: string): ToolResult => ({
  ok: false,
  error: { code, message },
});

export function createToolRegistry(definitions: readonly ToolDefinition[]) {
  const entries = new Map<string, ToolDefinition>();
  for (const entry of definitions) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(entry.name) ||
      entries.has(entry.name)
    )
      throw new ConfigurationError('Tool names must be valid and unique.');
    entries.set(entry.name, entry);
  }
  return {
    definitions: definitions.map(({ name, description, parameters }) => ({
      type: 'function' as const,
      name,
      description,
      parameters,
    })),
    async execute(
      call: FunctionCall,
      context: ToolContext,
    ): Promise<ToolResult> {
      const started = Date.now();
      const log = context.logger.child({
        toolName: call.name.slice(0, 64),
        toolCallId: call.call_id,
      });
      const owner = new AbortController();
      const signal = AbortSignal.any([context.signal, owner.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        const definition = entries.get(call.name);
        if (!definition)
          throw new ToolError('UNKNOWN_TOOL', 'That tool is not available.');
        if (Buffer.byteLength(call.arguments) > TOOL_LIMITS.maxArgumentBytes)
          throw new ToolError(
            'INVALID_ARGUMENT',
            'Tool arguments exceed the size limit.',
          );
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'Tool arguments must be valid JSON.',
          );
        }
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          !definition.validateArguments(args)
        )
          throw new ToolError('INVALID_ARGUMENT', 'Invalid tool arguments.');
        const expired = new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(
            () =>
              owner.abort(
                new ToolError(
                  'TOOL_TIMEOUT',
                  'Availability lookup timed out. Please try again.',
                ),
              ),
            TOOL_LIMITS.timeoutMs,
          );
        });
        log.info({ event: 'tool.started' }, 'Invoking voice tool');
        const result = await Promise.race([
          expired,
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return definition.execute(args as Record<string, unknown>, {
              ...context,
              signal,
              logger: log,
            });
          }),
        ]);
        signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result) ?? '') > 65536)
          throw new ToolError(
            'RESULT_TOO_LARGE',
            'Tool result exceeded the size limit.',
          );
        log.info(
          { event: 'tool.completed', durationMs: Date.now() - started },
          'Voice tool completed',
        );
        return { ok: true, result };
      } catch (error) {
        if (context.signal.aborted) {
          log.debug(
            { event: 'tool.cancelled', durationMs: Date.now() - started },
            'Voice tool cancelled',
          );
          throw error;
        }
        const failure =
          error instanceof ToolError
            ? error
            : new ToolError(
                'TOOL_FAILED',
                'Availability lookup failed. Please try again.',
              );
        log.warn(
          {
            event: 'tool.failed',
            code: failure.code,
            status: failure.status,
            durationMs: Date.now() - started,
          },
          'Voice tool failed',
        );
        return toolFailure(failure.code, failure.message);
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
        owner.abort();
      }
    },
  };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
