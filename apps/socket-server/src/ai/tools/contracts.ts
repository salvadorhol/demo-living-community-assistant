import type { CallEndReason } from '@living-community-assistant/types';
import type { AppLogger } from '../../logger.ts';

export interface ToolContext {
  readonly toolCallId?: string;
  readonly uid: string;
  readonly callId?: string;
  readonly signal: AbortSignal;
  readonly logger: AppLogger;
}
export interface TerminalAction {
  reason: CallEndReason;
  immediate: boolean;
  message?: string;
}

export interface ToolDefinition {
  readonly terminal?: boolean;
  readonly write?: boolean;
  enabled?(): boolean;
  readonly timeoutMs?: number;
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  validateArguments(value: unknown): boolean;
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<unknown>;
}
export class ToolError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.status = status;
  }
}
export const isEmptyArguments = (
  value: unknown,
): value is Record<string, never> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0,
  );
