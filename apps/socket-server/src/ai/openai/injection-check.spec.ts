import {createInjectionGuardrail} from './injection-check.ts';

const validAnswers = (language = 'en', injection = 0.1, frustration = 0.9) => [
  {name: 'prompt_injection', type: 'predicate', probability: injection},
  {name: 'user_frustrated', type: 'predicate', probability: frustration},
  {name: 'caller_language', type: 'choice', choice: language},
];
const options = {threshold: 0.8, frustrationThreshold: 0.8, timeoutMs: 2000};
it.each(['en', 'es'] as const)(
  'checks injection, frustration and %s language in one request with untrusted evidence separate',
  async language => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({answers: validAnswers(language)}))
      );
    const checker = createInjectionGuardrail(options, request, 'test');
    const signal = new AbortController().signal;
    expect(
      await checker.check(
        'This is frustrating',
        [{role: 'assistant', text: 'Hello'}],
        signal
      )
    ).toEqual({
      promptInjectionProbability: 0.1,
      frustrationProbability: 0.9,
      language,
    });
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input[0].content[0].data).toEqual({
      latest_utterance: 'This is frustrating',
      preceding_utterances: [{role: 'assistant', text: 'Hello'}],
    });
    expect(body.questions.map((q: {name: string}) => q.name)).toEqual([
      'prompt_injection',
      'user_frustrated',
      'caller_language',
    ]);
    expect(body.questions[1].instructions).not.toContain('Hello');
    expect(request.mock.calls[0][1]?.signal).toBe(signal);
  }
);
it.each([
  {},
  {answers: []},
  {answers: validAnswers().slice(0, 1)},
  {answers: validAnswers('fr')},
  {answers: validAnswers('en', 2)},
  {answers: validAnswers('en', 0.1, -1)},
  {answers: [...validAnswers(), validAnswers()[1]]},
  {
    answers: [
      validAnswers()[0],
      {name: 'user_frustrated', type: 'refusal'},
      validAnswers()[2],
    ],
  },
])('rejects malformed verdicts', async body => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body)));
  await expect(
    createInjectionGuardrail(options, request, 'test').check(
      'hello',
      [],
      new AbortController().signal
    )
  ).rejects.toThrow();
});
it('rejects HTTP failures', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('', {status: 429}));
  await expect(
    createInjectionGuardrail(options, request, 'test').check(
      'hello',
      [],
      new AbortController().signal
    )
  ).rejects.toThrow('429');
});
