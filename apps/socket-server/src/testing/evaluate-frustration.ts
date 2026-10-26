import {createInjectionGuardrail} from '../ai/openai/injection-check.ts';
import {readOpenAIKey} from '../config.ts';
import {frustrationCases} from './frustration-cases.ts';

// Explicit CLI only; never imported by production or automated offline tests.
if (!readOpenAIKey())
  throw new Error(
    'OPENAI_API_KEY is required for the live Decisions evaluation.'
  );
const threshold = Number(process.env.FRUSTRATION_THRESHOLD ?? 0.8);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
  throw new Error('Invalid FRUSTRATION_THRESHOLD');
const checker = createInjectionGuardrail({
  threshold: 0.8,
  frustrationThreshold: threshold,
  timeoutMs: 10000,
});
let failures = 0;
for (const example of frustrationCases) {
  try {
    const result = await checker.check(
      example.text,
      example.history,
      AbortSignal.timeout(checker.timeoutMs)
    );
    const passed =
      result.frustrationProbability >= threshold === example.frustrated &&
      result.promptInjectionProbability >= checker.threshold ===
        example.injection &&
      result.language === example.language;
    if (!passed) failures++;
    // Synthetic case names and scores only; never print credentials/provider error bodies.
    console.log(JSON.stringify({case: example.name, passed, ...result}));
  } catch {
    failures++;
    console.log(
      JSON.stringify({
        case: example.name,
        passed: false,
        error: 'Decisions unavailable',
      })
    );
  }
}
console.log(
  JSON.stringify({cases: frustrationCases.length, failures, threshold})
);
if (failures) process.exitCode = 1;
