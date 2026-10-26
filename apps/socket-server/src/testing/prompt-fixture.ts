import { sophieInstructions } from '../ai/sophie-prompt.ts';
export const testPrompt = {
  content: sophieInstructions,
  revision: 1,
  updatedBy: 'test',
  updatedAt: { toMillis: () => 0 },
};
export const loadTestPrompt = () => testPrompt;
