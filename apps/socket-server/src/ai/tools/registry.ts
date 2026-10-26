import { ConfigurationError } from '../../configuration-error.ts';
import {
  ToolError,
  type ToolContext,
  type ToolDefinition,
  type TerminalAction,
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

export function createToolRegistry(
  definitions: readonly ToolDefinition[],
  lifecycle: {
    bootstrap?(signal: AbortSignal): Promise<void>;
    onUserTurn?(): void;
    greeting?(): string;
    terminalAction?(): TerminalAction | undefined;
    toolAllowed?(name: string): boolean;
    toolCourtesy?: boolean;
    toolChoice?(): 'auto' | { type: 'function'; name: string };
  } = {},
) {
  const entries = new Map<string, ToolDefinition>();
  let writeTail: Promise<unknown> = Promise.resolve();
  for (const entry of definitions) {
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0)
    )
      throw new ConfigurationError(
        'Tool timeout must be a positive finite number.',
      );
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(entry.name) ||
      entries.has(entry.name)
    )
      throw new ConfigurationError('Tool names must be valid and unique.');
    entries.set(entry.name, entry);
  }
  return {
    ...lifecycle,
    isTerminal: (name: string) => entries.get(name)?.terminal === true,
    isWrite: (name: string) => entries.get(name)?.write === true,
    get definitions() {
      if (lifecycle.terminalAction?.()) return [];
      return definitions
        .filter(
          (entry) =>
            (!lifecycle.toolAllowed || lifecycle.toolAllowed(entry.name)) &&
            (!entry.enabled || entry.enabled()),
        )
        .map(({ name, description, parameters }) => ({
          type: 'function' as const,
          name,
          description:
            lifecycle.toolCourtesy && name !== 'end_call'
              ? `Before calling, say a short warm please-wait notice in the visitor's language. Invoke immediately without waiting for a reply or adding a pause. Never speak the tool name. ${description}`
              : description,
          parameters,
        }));
    },
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
        if (
          lifecycle.terminalAction?.() ||
          !definition ||
          (lifecycle.toolAllowed && !lifecycle.toolAllowed(call.name)) ||
          (definition.enabled && !definition.enabled())
        )
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
            definition.timeoutMs ?? TOOL_LIMITS.timeoutMs,
          );
        });
        log.info({ event: 'tool.started' }, 'Invoking voice tool');
        const result = await Promise.race([
          expired,
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            const execute = () => {
              signal.throwIfAborted();
              if (
                lifecycle.terminalAction?.() ||
                (lifecycle.toolAllowed && !lifecycle.toolAllowed(call.name))
              )
                throw new ToolError(
                  'UNKNOWN_TOOL',
                  'That tool is not available.',
                );
              return definition.execute(args as Record<string, unknown>, {
                ...context,
                toolCallId: call.call_id,
                signal,
                logger: log,
              });
            };
            if (!definition.write) return execute();
            const pendingWrite = writeTail.then(execute);
            writeTail = Promise.race([pendingWrite, expired]).catch(
              () => undefined,
            );
            return pendingWrite;
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
        const uncertainWrite =
          entries.get(call.name)?.write &&
          !entries.get(call.name)?.terminal &&
          [
            'UPSTREAM_ERROR',
            'TOOL_TIMEOUT',
            'TOOL_FAILED',
            'INVALID_RESULT',
          ].includes(failure.code);
        const message = uncertainWrite
          ? 'The confirmed write may have completed, but its outcome could not be verified. Retry with the same confirmation token; do not prepare unchanged values again or claim the write definitely failed.'
          : failure.message;
        log.warn(
          {
            event: 'tool.failed',
            code: failure.code,
            status: failure.status,
            durationMs: Date.now() - started,
          },
          'Voice tool failed',
        );
        return toolFailure(failure.code, message);
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
        owner.abort();
      }
    },
  };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
