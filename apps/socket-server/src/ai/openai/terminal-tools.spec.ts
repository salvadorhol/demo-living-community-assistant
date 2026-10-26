import {ToolCalls} from './tool-calls.ts';
import {createToolRegistry} from '../tools/registry.ts';
import type {TerminalAction, ToolDefinition} from '../tools/contracts.ts';
import {silentLogger} from '../../logger.ts';

function fixture() {
  let action: TerminalAction | undefined;
  let empty = false;
  const lookup = vi.fn(async () => {
    empty = true;
    return [];
  });
  const entry = (
    name: string,
    execute: ToolDefinition['execute'],
    terminal = false
  ): ToolDefinition => ({
    name,
    description: name,
    parameters: {type: 'object', properties: {}},
    validateArguments: () => true,
    execute,
    terminal,
    write: terminal,
  });
  const registry = createToolRegistry(
    [
      entry('lookup', lookup),
      entry(
        'simulate_sales_handoff',
        async () => {
          action = {
            reason: 'demo_sales_handoff',
            immediate: false,
            message: 'Demo goodbye',
          };
          return {};
        },
        true
      ),
      entry(
        'end_call',
        async () => {
          action = {reason: 'visitor_requested', immediate: true};
          return {};
        },
        true
      ),
    ],
    {
      terminalAction: () => action,
      toolChoice: () =>
        empty ? {type: 'function', name: 'simulate_sales_handoff'} : 'auto',
    }
  );
  const send = vi.fn();
  const onClosing = vi.fn();
  const fail = vi.fn();
  const tools = new ToolCalls({
    registry,
    uid: 'visitor',
    logger: () => silentLogger,
    canContinue: () => true,
    send,
    onClosing,
    fail,
  });
  const complete = (id: string, names: string[]) =>
    tools.complete({
      id,
      status: 'completed',
      output: names.map((name, i) => ({
        type: 'function_call',
        call_id: `${id}-${i}`,
        name,
        arguments: '{}',
      })),
    });
  return {complete, send, onClosing, fail, lookup};
}
it('reserves a terminal execution after four lookups and keeps forced handoff enabled', async () => {
  const f = fixture();
  f.complete('lookups', ['lookup', 'lookup', 'lookup', 'lookup']);
  await vi.waitFor(() =>
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({type: 'response.create'})
    )
  );
  expect(f.send.mock.calls.at(-1)?.[0].response.tool_choice).toEqual({
    type: 'function',
    name: 'simulate_sales_handoff',
  });
  f.complete('close', ['simulate_sales_handoff']);
  await vi.waitFor(() => expect(f.onClosing).toHaveBeenCalled());
  expect(f.send.mock.calls.at(-1)?.[0].response).toMatchObject({
    tool_choice: 'none',
    instructions: expect.stringContaining('Demo goodbye'),
  });
  expect(f.fail).not.toHaveBeenCalled();
});
it('prioritizes immediate stop and generates no closing response or later lookup', async () => {
  const f = fixture();
  f.complete('stop', ['lookup', 'end_call']);
  await vi.waitFor(() =>
    expect(f.onClosing).toHaveBeenCalledWith({
      reason: 'visitor_requested',
      immediate: true,
    })
  );
  expect(f.lookup).not.toHaveBeenCalled();
  expect(
    f.send.mock.calls.some(([event]) => event.type === 'response.create')
  ).toBe(false);
});
