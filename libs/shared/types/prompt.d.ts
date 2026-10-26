export interface SophiePrompt {
  content: string;
  revision: number;
  updatedAt: {toMillis(): number};
  updatedBy: string;
}
export const SOPHIE_PROMPT_PATH: 'appConfig/sophiePrompt';
export const MAX_PROMPT_LENGTH: 50000;
export function validPromptContent(content: unknown): content is string;
export function validSophiePrompt(value: unknown): value is SophiePrompt;
