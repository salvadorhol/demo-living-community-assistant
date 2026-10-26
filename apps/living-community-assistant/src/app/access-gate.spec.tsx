import { useEffect } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { AccessGate } from './access-gate';
const mocks = vi.hoisted(() => ({
  listener: undefined as unknown as (user: unknown, error?: string) => void,
  unlock: vi.fn(async () => undefined),
  stop: vi.fn(),
  mounted: vi.fn(),
  disposed: vi.fn(),
}));
vi.mock('./api/session', () => ({
  observeAccess: (listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return mocks.stop;
  },
  unlockApp: mocks.unlock,
}));
function Workspace() {
  useEffect(() => {
    mocks.mounted();
    return mocks.disposed;
  }, []);
  return <p>Workspace</p>;
}
beforeEach(() => vi.clearAllMocks());
it('never mounts the workspace before authorization and disposes it on sign-out', () => {
  const view = render(
    <AccessGate>
      <Workspace />
    </AccessGate>,
  );
  expect(screen.getByRole('status').textContent).toContain('Checking access');
  expect(mocks.mounted).not.toHaveBeenCalled();
  act(() => mocks.listener(null));
  expect(screen.getByLabelText('Password')).toBeTruthy();
  expect(mocks.mounted).not.toHaveBeenCalled();
  act(() => mocks.listener({ uid: 'visitor' }));
  expect(screen.getByText('Workspace')).toBeTruthy();
  expect(mocks.mounted).toHaveBeenCalledOnce();
  act(() => mocks.listener(null));
  expect(mocks.disposed).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Password')).toBeTruthy();
  view.unmount();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it('clears the password, displays errors, and permits a second submission', async () => {
  mocks.unlock.mockRejectedValueOnce({ code: 'functions/permission-denied' });
  render(
    <AccessGate>
      <Workspace />
    </AccessGate>,
  );
  act(() => mocks.listener(null));
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'wrong' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
    '',
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'Incorrect password',
    ),
  );
  expect(mocks.mounted).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'correct' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() =>
    expect(mocks.unlock).toHaveBeenLastCalledWith('correct', false),
  );
});
