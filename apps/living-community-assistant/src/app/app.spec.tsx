import { act, fireEvent, render, screen } from '@testing-library/react';
import { checkHealth } from './api/health';
import App from './app';
import { startSocket, type ConnectionStatus } from './api/socket';

vi.mock('./api/socket', () => ({ startSocket: vi.fn(() => () => undefined) }));

vi.mock('./api/health', () => ({ checkHealth: vi.fn() }));

describe('backend connectivity', () => {
  afterEach(() => vi.resetAllMocks());

  it('shows pending and successful health results', async () => {
    let finish!: (value: { status: 'ok'; time: number }) => void;
    vi.mocked(checkHealth).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Check backend' }));
    expect(
      screen.getByRole('status', { name: 'Backend health status' }).textContent,
    ).toContain('Checking');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish({ status: 'ok', time: 1234 }));
    expect(
      screen.getByRole('status', { name: 'Backend health status' }).textContent,
    ).toContain('Backend ok');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows a recoverable failure', async () => {
    vi.mocked(checkHealth).mockRejectedValue(new Error('offline'));
    render(<App />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Check backend' })),
    );
    expect(
      screen.getByRole('status', { name: 'Backend health status' }).textContent,
    ).toContain('Backend unavailable');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

it('shows socket state changes and offers a fresh connection after failure', () => {
  let update!: (status: ConnectionStatus) => void;
  const stop = vi.fn();
  vi.mocked(startSocket).mockImplementation((callback) => {
    update = callback;
    return stop;
  });
  const view = render(<App />);
  const indicator = screen.getByRole('status', {
    name: 'Socket connection status',
  });
  expect(indicator.textContent).toContain('connecting');
  act(() => update({ state: 'connected' }));
  expect(indicator.textContent).toContain('Socket connected');
  act(() =>
    update({ state: 'disconnected', error: 'Sign-in failed. Please retry.' }),
  );
  expect(indicator.textContent).toContain('Socket disconnected');
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(startSocket).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(2);
});
