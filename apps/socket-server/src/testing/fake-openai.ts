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
    let forcedTool: string | undefined;
    let lookupStarted = false;
    // Scripted visitor turns only for the empty-appointments browser scenario.
    let callbackStep = 0;
    let callbackReadyAt = 0;
    const results = new Map<
      string,
      {
        ok?: boolean;
        result?: {
          confirmationToken?: string;
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
        const toolResult = JSON.parse(event.item.output);
        if (!toolResult.ok)
          console.warn('Fixture tool error', toolResult.error);
        results.set(event.item.call_id, toolResult);
        return;
      }
      if (
        options.toolCalls &&
        active &&
        event.type === 'input_audio_buffer.append' &&
        callbackStep > 0 &&
        callbackStep < 5 &&
        Date.now() >= callbackReadyAt
      ) {
        callbackReadyAt = Number.POSITIVE_INFINITY;
        socket.send(
          JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
        );
        socket.send(
          JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }),
        );
        const token = [...results.values()]
          .reverse()
          .find((value) => value.result?.confirmationToken)
          ?.result?.confirmationToken;
        const steps = [
          {
            name: 'prepare_contact_information',
            args: { profile: { phone: '7045550100' } },
          },
          {
            name: 'save_contact_information',
            args: { confirmationToken: token, confirmed: true },
          },
          { name: 'prepare_follow_up_request', args: { kind: 'callback' } },
          {
            name: 'create_follow_up_request',
            args: { confirmationToken: token, confirmed: true },
          },
        ];
        const step = steps[callbackStep - 1];
        callbackStep++;
        const id = `fixture-callback-${++turn}`;
        socket.send(
          JSON.stringify({ type: 'response.created', response: { id } }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: {
              id,
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  call_id: id,
                  name: step.name,
                  arguments: JSON.stringify(step.args),
                },
              ],
            },
          }),
        );
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
        lookupStarted = true;
        const names = forcedTool
          ? [forcedTool]
          : toolNames.filter((name) =>
              [
                'get_available_floor_plans',
                'get_available_appointments',
              ].includes(name),
            );
        if (
          !names.length &&
          toolNames.includes('check_sales_director_availability')
        )
          names.push('check_sales_director_availability');
        const calls = names.map((name, index) => ({
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
        if (Object.hasOwn(event.session, 'tool_choice'))
          forcedTool =
            typeof event.session.tool_choice === 'object'
              ? event.session.tool_choice.name
              : undefined;
        if (
          event.session.audio?.input &&
          Object.hasOwn(event.session.audio.input, 'turn_detection')
        ) {
          active = Boolean(event.session.audio.input.turn_detection);
          if (active) responded = false;
        }
        socket.send(JSON.stringify({ type: 'session.updated' }));
      }
      if (
        options.toolCalls &&
        lookupStarted &&
        event.type === 'response.create' &&
        event.response?.metadata?.toolCycleId &&
        results.size === 1 &&
        [...results.values()].some((v) => v.result?.available === false)
      ) {
        const id = `fixture-details-${++turn}`;
        const names = [
          'get_available_floor_plans',
          'get_available_appointments',
        ].filter((name) => toolNames.includes(name));
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id, metadata: event.response.metadata },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: {
              id,
              status: 'completed',
              output: names.map((name, index) => ({
                type: 'function_call',
                call_id: `${id}-${index}`,
                name,
                arguments: '{}',
              })),
            },
          }),
        );
        return;
      }
      const closingDisclosure =
        typeof event.response?.instructions === 'string' &&
        event.response.instructions.startsWith(
          'Speak exactly this JSON string as the server-owned closing message.',
        );
      if (
        (active || closingDisclosure) &&
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
        const greeting = event.response?.instructions?.includes(
          'Greeting only:',
        )
          ? (JSON.parse(
              event.response.instructions.split('\n').at(-1),
            ) as string)
          : undefined;
        const closingText = closingDisclosure
          ? (JSON.parse(
              event.response.instructions.split('\n').at(-1),
            ) as string)
          : undefined;
        const emptyAppointments = [...results.values()].some(
          (value) =>
            Array.isArray(value.result?.appointments) &&
            value.result.appointments.length === 0,
        );
        if (!greeting && emptyAppointments && callbackStep === 0)
          callbackStep = 1;
        const callbackText = [
          '',
          'No tour appointments are available right now. Would you like a sales representative to call you back as soon as one is available during normal operating hours?',
          'Your phone number is 7 0 4 5 5 5 0 1 0 0. Is that correct?',
          'Your phone number is saved. Would you like me to prepare your callback request?',
          'A sales representative will call as soon as one is available during normal operating hours. Shall I submit that callback request?',
          'Your callback request is saved. One of our sales representatives will call you as soon as they become available during normal operating hours.',
        ][callbackStep];
        const text =
          closingText ??
          greeting ??
          (callbackStep ? callbackText : undefined) ??
          'Hello! How can I help?' +
            (options.toolCalls
              ? ` Available floor plans: ${floorPlans.map((plan) => plan.name).join(', ')}. Available tour slots: ${appointments.map((slot) => slot.startsAt).join(', ')}.${[...results.values()].some((value) => value.ok && value.result?.available === false) ? ' No sales director is available.' : ''}`
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
        if (callbackStep) callbackReadyAt = Date.now() + 600;
        if (greeting) responded = false;
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
