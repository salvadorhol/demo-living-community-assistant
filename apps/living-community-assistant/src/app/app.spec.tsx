import { act, fireEvent, render, screen } from '@testing-library/react';
import { checkHealth } from './api/health';
import App from './app';

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
    expect(screen.getByRole('status').textContent).toContain('Checking');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish({ status: 'ok', time: 1234 }));
    expect(screen.getByRole('status').textContent).toContain('Backend ok');
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
    expect(screen.getByRole('status').textContent).toContain(
      'Backend unavailable',
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
