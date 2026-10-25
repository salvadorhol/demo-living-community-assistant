import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/** Local deterministic provider for browser tests; never contacts OpenAI. */
export async function createFakeOpenAI(options: { toolCalls?: boolean } = {}) {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  upstream.on('connection', (socket) => {
    let turn = 0;
    let transcription = false;
    let transcribing = false;
    let active = false;
    let responded = false;
    let toolNames: string[] = [];
    const results = new Map<
      string,
      {
        ok?: boolean;
        result?: {
          available?: boolean;
          floorPlans?: { name: string }[];
          appointments?: { startsAt: string }[];
        };
      }
    >();
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (
        event.type === 'session.update' &&
        event.session.type === 'transcription'
      ) {
        transcription = true;
        socket.send(JSON.stringify({ type: 'session.updated' }));
        return;
      }
      if (transcription) {
        if (event.type === 'input_audio_buffer.append' && !transcribing) {
          transcribing = true;
          turn++;
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.delta',
              item_id: `user-${turn}`,
              content_index: 0,
              delta: 'Hello from the resident.',
            }),
          );
        }
        if (event.type === 'input_audio_buffer.commit' && transcribing) {
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: `user-${turn}`,
              content_index: 0,
              transcript: 'Hello from the resident.',
            }),
          );
          transcribing = false;
        }
        return;
      }
      if (
        event.type === 'conversation.item.create' &&
        event.item?.type === 'function_call_output'
      ) {
        results.set(event.item.call_id, JSON.parse(event.item.output));
        return;
      }
      if (
        options.toolCalls &&
        event.type === 'input_audio_buffer.append' &&
        active &&
        !responded &&
        toolNames.length
      ) {
        responded = true;
        results.clear();
        const id = `fixture-tools-${++turn}`;
        const calls = toolNames.map((name, index) => ({
          type: 'function_call',
          call_id: `${id}-${index}`,
          name,
          arguments: '{}',
        }));
        socket.send(
          JSON.stringify({ type: 'response.created', response: { id } }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: { id, status: 'completed', output: calls },
          }),
        );
        return;
      }
      if (event.type === 'response.cancel') {
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: event.response_id, status: 'cancelled' },
          }),
        );
        return;
      }
      if (event.type === 'conversation.item.truncate') {
        socket.send(
          JSON.stringify({
            type: 'conversation.item.truncated',
            item_id: event.item_id,
            content_index: event.content_index,
            audio_end_ms: event.audio_end_ms,
          }),
        );
        return;
      }
      if (event.type === 'session.update') {
        if (event.session.tools)
          toolNames = event.session.tools.map(
            (tool: { name: string }) => tool.name,
          );
        active = Boolean(event.session.audio?.input?.turn_detection);
        if (active) responded = false;
        socket.send(JSON.stringify({ type: 'session.updated' }));
      }
      if (
        active &&
        ((event.type === 'input_audio_buffer.append' && !responded) ||
          event.type === 'response.create')
      ) {
        responded = true;
        const id = `fixture-${++turn}`;
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id, metadata: event.response?.metadata },
          }),
        );
        const floorPlans = [...results.values()].flatMap(
          (value) => value.result?.floorPlans ?? [],
        );
        const appointments = [...results.values()].flatMap(
          (value) => value.result?.appointments ?? [],
        );
        const text =
          'Hello! How can I help?' +
          (options.toolCalls
            ? ` Sample availability: ${floorPlans.map((plan) => plan.name).join(', ')}. Sample tour slots: ${appointments.map((slot) => slot.startsAt).join(', ')}.${[...results.values()].some((value) => value.ok && value.result?.available === false) ? ' No sales director is available in this demo.' : ''}`
            : '');
        for (const type of [
          'response.output_audio_transcript.delta',
          'response.output_audio_transcript.done',
        ])
          socket.send(
            JSON.stringify({
              type,
              response_id: id,
              item_id: id,
              content_index: 0,
              delta: text,
              transcript: text,
            }),
          );
        // A short audible tone tests real browser scheduling without cloud calls.
        const pcm = Buffer.alloc(19200);
        for (let i = 0; i < pcm.length / 2; i++)
          pcm.writeInt16LE(
            Math.round(Math.sin((i * 2 * Math.PI * 440) / 24000) * 2000),
            i * 2,
          );
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.delta',
            response_id: id,
            item_id: id,
            content_index: 0,
            delta: pcm.toString('base64'),
          }),
        );
        socket.send(
          JSON.stringify({ type: 'response.output_audio.done', item_id: id }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: { id, status: 'completed' },
          }),
        );
      }
    });
  });
  const connect = () =>
    new WebSocket(`ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  return {
    connect,
    close: () =>
      new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
