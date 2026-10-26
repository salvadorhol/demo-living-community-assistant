import type { TerminalAction } from '../tools/contracts.ts';
import { randomUUID } from 'node:crypto';
import type { AppLogger } from '../../logger.ts';
import {
  createToolRegistry,
  TOOL_LIMITS,
  toolFailure,
  type FunctionCall,
  type ToolRegistry,
  type ToolResult,
} from '../tools/registry.ts';

interface CompletedResponse {
  id: string;
  status: string;
  output?: unknown[];
}
interface ToolCallsOptions {
  registry?: ToolRegistry;
  uid: string;
  callId?: string;
  logger(): AppLogger;
  canContinue(): boolean;
  send(event: object): void;
  fail(error: unknown): void;
  toolsChanged?(): void;
  onClosing?(action: TerminalAction): void;
}
const isCall = (value: unknown): value is FunctionCall => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    item.call_id.length > 0 &&
    item.call_id.length <= 512 &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  );
};
/** Own tool work and its single continuation, independently of audio and caption transport. */
export class ToolCalls {
  private options: ToolCallsOptions;
  private registry: ToolRegistry;
  private pending?: AbortController;
  private responseId?: string;
  private continuation?: string;
  private acceptedContinuation?: string;
  private used = 0;
  private terminalReserveUsed = false;
  private handled = new Set<string>();
  private seen = new Set<string>();
  constructor(options: ToolCallsOptions) {
    this.options = options;
    this.registry = options.registry ?? createToolRegistry([]);
  }
  get definitions() {
    return this.registry.definitions;
  }
  get pendingResponseId() {
    return this.responseId;
  }
  invalidate(resetBudget = false) {
    this.pending?.abort();
    this.pending = undefined;
    this.responseId = undefined;
    this.continuation = undefined;
    this.acceptedContinuation = undefined;
    if (resetBudget) {
      this.used = 0;
      this.terminalReserveUsed = false;
    }
  }
  acceptResponse(id: string, metadata?: Record<string, string>): boolean {
    if (metadata?.toolCycleId) {
      if (
        metadata.toolCycleId !== this.continuation ||
        (this.acceptedContinuation && this.acceptedContinuation !== id)
      )
        return false;
      this.acceptedContinuation = id;
      return true;
    }
    this.invalidate();
    return true;
  }
  complete(response: CompletedResponse) {
    if (response.status !== 'completed' || this.handled.has(response.id))
      return;
    this.handled.add(response.id);
    const calls = (response.output ?? []).filter(isCall).filter((call) => {
      if (this.seen.has(call.call_id)) return false;
      this.seen.add(call.call_id);
      return true;
    });
    // Explicit termination has priority over other actions in the same response.
    calls.sort(
      (a, b) => Number(b.name === 'end_call') - Number(a.name === 'end_call'),
    );
    if (!calls.length || !this.options.canContinue()) return;
    this.pending?.abort();
    const owner = new AbortController();
    this.pending = owner;
    this.responseId = response.id;
    const active = () =>
      !owner.signal.aborted &&
      this.pending === owner &&
      this.options.canContinue();
    void (async () => {
      const results: ToolResult[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < calls.length && active()) {
          const index = cursor++;
          const call = calls[index];
          if (this.used >= TOOL_LIMITS.maxCallsPerTurn) {
            if (
              !this.terminalReserveUsed &&
              this.registry.isTerminal(call.name)
            ) {
              this.terminalReserveUsed = true;
            } else {
              results[index] = toolFailure(
                'TOOL_BUDGET_EXCEEDED',
                'The lookup limit for this turn was reached.',
              );
              continue;
            }
          } else this.used++;
          results[index] = await this.registry.execute(call, {
            uid: this.options.uid,
            callId: this.options.callId,
            signal: owner.signal,
            logger: this.options.logger(),
          });
        }
      };
      await Promise.all(
        Array.from(
          {
            length: calls.some((call) => this.registry.isWrite(call.name))
              ? 1
              : Math.min(TOOL_LIMITS.concurrency, calls.length),
          },
          worker,
        ),
      );
      if (!active()) return;
      for (let index = 0; index < calls.length; index++) {
        if (!active()) return;
        this.options.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: calls[index].call_id,
            output: JSON.stringify(results[index]),
          },
        });
      }
      if (!active()) return;
      this.options.toolsChanged?.();
      this.continuation = randomUUID();
      this.acceptedContinuation = undefined;
      const terminal = this.registry.terminalAction?.();
      if (terminal) this.options.onClosing?.(terminal);
      if (terminal?.immediate) return;
      const closingMessage = terminal?.message;
      const choice = this.registry.toolChoice?.() ?? 'auto';
      const reservedChoice =
        typeof choice === 'object' &&
        this.registry.isTerminal(choice.name) &&
        !this.terminalReserveUsed;
      this.options.send({
        type: 'response.create',
        response: {
          metadata: { toolCycleId: this.continuation },
          ...(closingMessage
            ? {
                tool_choice: 'none',
                instructions: `Speak exactly this JSON string as the server-owned closing message. Do not call tools or ask any questions.\n${JSON.stringify(closingMessage)}`,
              }
            : this.used >= TOOL_LIMITS.maxCallsPerTurn && !reservedChoice
              ? { tool_choice: 'none' }
              : { tool_choice: this.registry.toolChoice?.() ?? 'auto' }),
        },
      });
    })()
      .catch((error) => {
        if (!owner.signal.aborted) this.options.fail(error);
      })
      .finally(() => {
        owner.abort();
        if (this.pending === owner) {
          this.pending = undefined;
          this.responseId = undefined;
        }
      });
  }
}
