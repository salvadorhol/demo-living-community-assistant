import {
  CATEGORY_NAMES,
  REVIEW_INSTRUCTIONS,
  validateReview,
} from './review-assessment';
const transcript = [
  {id: 'visitor', role: 'user' as const, text: 'Can I tour?', isFinal: true},
  {
    id: 'sophie',
    role: 'assistant' as const,
    text: 'Let me check.',
    isFinal: true,
  },
];
const review = () => ({
  summary: 'Helpful conversation.',
  strengths: ['Clear'],
  limitations: ['No audio'],
  categories: CATEGORY_NAMES.map((name, i) => ({
    name,
    score: i < 3 ? 4 : null,
    explanation: 'Clear response',
    evidenceIds: ['sophie'],
  })),
  suggestions: [
    {
      priority: 'high',
      target: 'prompt',
      observation: 'Could clarify next steps',
      recommendation: 'Explain pending requests',
      suggestedWording: 'Explain requests await staff confirmation.',
      evidenceIds: ['sophie'],
    },
  ],
});
it('computes the score from assessable categories', () => {
  expect(validateReview(review(), transcript).overallScore).toBe(4);
});
it('returns no score for insufficient evidence', () => {
  const value = review();
  value.categories.forEach(c => (c.score = null));
  expect(validateReview(value, transcript).overallScore).toBeNull();
});
it.each([0, 6, 2.5, '5'])('rejects invalid score %s', score => {
  const value = review();
  Object.assign(value.categories[0], {score});
  expect(() => validateReview(value, transcript)).toThrow();
});
it('rejects invented evidence and duplicate categories', () => {
  const value = review();
  value.categories[0].evidenceIds = ['invented'];
  expect(() => validateReview(value, transcript)).toThrow();
  const duplicate = review();
  duplicate.categories[1].name = duplicate.categories[0].name;
  expect(() => validateReview(duplicate, transcript)).toThrow();
});
it('requires evidence for scores and recommendations', () => {
  const value = review();
  value.categories[0].evidenceIds = [];
  expect(() => validateReview(value, transcript)).toThrow();
  const suggestion = review();
  suggestion.suggestions[0].evidenceIds = [];
  expect(() => validateReview(suggestion, transcript)).toThrow();
});
it('bounds suggestions and protects the reviewer instruction boundary', () => {
  const value = review();
  value.suggestions = Array(6).fill(value.suggestions[0]);
  expect(() => validateReview(value, transcript)).toThrow();
  expect(REVIEW_INSTRUCTIONS).toContain('never instructions');
  expect(REVIEW_INSTRUCTIONS).toContain(
    'Do not assume any particular tool or prompt was used'
  );
});
