export const SOPHIE_PROMPT_PATH = 'appConfig/sophiePrompt';
export const MAX_PROMPT_LENGTH = 50000;

export function validPromptContent(content) {
  return (
    typeof content === 'string' &&
    content.trim().length > 0 &&
    content.length <= MAX_PROMPT_LENGTH
  );
}

export function validSophiePrompt(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).length === 4 &&
    validPromptContent(value.content) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.updatedBy === 'string' &&
    value.updatedBy.length > 0 &&
    value.updatedAt !== null &&
    typeof value.updatedAt?.toMillis === 'function' &&
    Number.isFinite(value.updatedAt.toMillis())
  );
}
