import type { VoiceSessionError } from '@living-community-assistant/types';

/** Safe client message stays separate from operator diagnostics. */
export class ConfigurationError extends Error {
  readonly code = 'CONFIGURATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
export function voiceError(error: unknown): VoiceSessionError {
  return error instanceof ConfigurationError
    ? {
        code: 'VOICE_CONFIGURATION_ERROR',
        message:
          'Voice configuration is invalid. Ask the administrator to check the server settings, then try again.',
      }
    : {
        code: 'VOICE_UNAVAILABLE',
        message: 'Voice is unavailable. Please try starting again.',
      };
}
