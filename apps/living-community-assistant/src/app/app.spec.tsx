import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TranscriptUpdate } from '@living-community-assistant/types';
import App from './app';
import type { ConnectionStatus } from './api/socket';
import type { VoiceStatus } from './audio/voice';

const mocks = vi.hoisted(() => ({
  supported: true,
  status: undefined as unknown as (status: ConnectionStatus) => void,
  transcript: undefined as unknown as (update: TranscriptUpdate) => void,
  voiceStatus: undefined as unknown as (status: VoiceStatus) => void,
  close: vi.fn(),
  unsubscribe: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  disconnect: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('./audio/capture', () => ({
  microphoneSupported: () => mocks.supported,
}));
vi.mock('./api/socket', () => ({
  startSocket: (callback: typeof mocks.status) => {
    mocks.status = callback;
    return Object.assign(mocks.close, {
      onTranscript: (listener: typeof mocks.transcript) => {
        mocks.transcript = listener;
        return mocks.unsubscribe;
      },
    });
  },
}));
vi.mock('./audio/voice', () => ({
  VoiceSession: class {
    constructor(_connection: unknown, status: typeof mocks.voiceStatus) {
      mocks.voiceStatus = status;
    }
    start = mocks.start;
    stop = mocks.stop;
    disconnect = mocks.disconnect;
    dispose = mocks.dispose;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.supported = true;
});

it('shows minimal socket states, retries, and cleans up the previous connection', () => {
  const view = render(<App />);
  const indicator = screen.getByRole('status', {
    name: 'Socket connection status',
  });
  expect(indicator.textContent).toContain('Connecting');
  act(() => mocks.status({ state: 'connected' }));
  expect(indicator.textContent).toContain('Socket on');
  act(() => mocks.status({ state: 'disconnected', error: 'Sign-in failed.' }));
  expect(indicator.textContent).toContain('Socket off');
  expect(screen.getByRole('alert').textContent).toContain('Sign-in failed');
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('starts and stops a session and keeps the actual microphone label', () => {
  render(<App />);
  expect(
    (screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  act(() => mocks.status({ state: 'connected' }));
  fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
  expect(mocks.start).toHaveBeenCalledOnce();
  act(() => mocks.voiceStatus({ state: 'requesting permission' }));
  expect(
    screen.getByRole('status', { name: 'Microphone status' }).textContent,
  ).toContain('permission');
  act(() =>
    mocks.voiceStatus({
      state: 'streaming',
      microphoneName: 'Studio microphone',
    }),
  );
  expect(screen.getByText('Studio microphone')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Stop session/ }));
  expect(mocks.stop).toHaveBeenCalledOnce();
  act(() => mocks.voiceStatus({ state: 'stopping' }));
  expect(
    (screen.getByRole('button', { name: /Stopping/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  act(() => mocks.voiceStatus({ state: 'idle' }));
  expect(screen.getByText('Studio microphone')).toBeTruthy();
});

it('shows permission failures and unsupported microphone guidance', () => {
  mocks.supported = false;
  render(<App />);
  expect(
    (screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/requires Web Audio/)).toBeTruthy();
  act(() => mocks.voiceStatus({ state: 'error', error: 'Permission denied' }));
  expect(screen.getByText('Permission denied')).toBeTruthy();
});

it('replaces partial transcripts, preserves order and finals, and resets on disconnect', () => {
  const view = render(<App />);
  const update = (value: TranscriptUpdate) =>
    act(() => mocks.transcript(value));
  update({ id: 'u', role: 'user', text: 'Hel', isFinal: false });
  update({ id: 'a', role: 'assistant', text: 'Hi', isFinal: true });
  update({ id: 'u', role: 'user', text: 'Hello', isFinal: true });
  update({ id: 'u', role: 'user', text: 'late', isFinal: false });
  expect(screen.queryByText('Hel')).toBeNull();
  expect(screen.queryByText('late')).toBeNull();
  expect(
    screen.getAllByRole('article').map((entry) => entry.textContent),
  ).toEqual(['YouHello', 'AssistantHi']);
  act(() => mocks.voiceStatus({ state: 'idle' }));
  expect(screen.getByText('Hello')).toBeTruthy();
  act(() => mocks.status({ state: 'disconnected' }));
  expect(screen.queryByRole('article')).toBeNull();
  const stale = mocks.transcript;
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  act(() => stale({ id: 'late', role: 'user', text: 'stale', isFinal: true }));
  expect(screen.queryByText('stale')).toBeNull();
  view.unmount();
});
