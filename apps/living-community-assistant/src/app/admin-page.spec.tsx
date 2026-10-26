import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AdminPage } from './admin-page';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => undefined),
  lock: vi.fn(async () => undefined),
}));
vi.mock('./api/prompt', () => ({
  loadPrompt: mocks.load,
  savePrompt: mocks.save,
}));
vi.mock('./api/appointments', () => ({
  loadAppointments: vi.fn(async () => null),
  saveAppointments: vi.fn(),
}));
vi.mock('./api/session', () => ({ lockApp: mocks.lock }));
const saved = {
  content: 'Original prompt',
  revision: 2,
  updatedAt: { toMillis: () => 0 },
  updatedBy: 'admin',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(saved);
});
it('loads and saves an edited prompt with its base revision', async () => {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/admin/*', element: <AdminPage /> }],
        {
          initialEntries: ['/admin'],
        },
      )}
    />,
  );
  await screen.findByDisplayValue('Original prompt');
  fireEvent.change(screen.getByLabelText('Sophie’s prompt'), {
    target: { value: 'Changed prompt' },
  });
  mocks.load.mockResolvedValue({
    ...saved,
    content: 'Changed prompt',
    revision: 3,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('Changed prompt', 2),
  );
  await screen.findByText(/Prompt saved/);
  expect(screen.getByDisplayValue('Changed prompt')).toBeTruthy();
});
it('keeps the draft when a conflicting save fails', async () => {
  mocks.save.mockRejectedValueOnce(
    new Error('Another admin changed this prompt. Your draft is preserved.'),
  );
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/admin/*', element: <AdminPage /> }],
        {
          initialEntries: ['/admin'],
        },
      )}
    />,
  );
  await screen.findByDisplayValue('Original prompt');
  fireEvent.change(screen.getByLabelText('Sophie’s prompt'), {
    target: { value: 'My unsaved draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));
  await screen.findByRole('alert');
  expect(screen.getByDisplayValue('My unsaved draft')).toBeTruthy();
});
it('allows creation when no prompt exists', async () => {
  mocks.load.mockResolvedValue(null);
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/admin/*', element: <AdminPage /> }],
        {
          initialEntries: ['/admin'],
        },
      )}
    />,
  );
  await screen.findByText(/No prompt is saved/);
  expect(
    (screen.getByRole('button', { name: 'Save prompt' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('redirects to configuration and opens a blank review page without loading editors', async () => {
  const router = createMemoryRouter(
    [{ path: '/admin/*', element: <AdminPage /> }],
    { initialEntries: ['/admin'] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByDisplayValue('Original prompt');
  expect(router.state.location.pathname).toBe('/admin/configuration');
  fireEvent.click(screen.getByRole('link', { name: 'Review' }));
  await screen.findByRole('region', { name: 'Review' });
  expect(screen.queryByLabelText('Sophie’s prompt')).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Review' }).getAttribute('aria-current'),
  ).toBe('page');
});

it('protects unsaved appointment changes when switching to review', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(
      <RouterProvider
        router={createMemoryRouter(
          [{ path: '/admin/*', element: <AdminPage /> }],
          { initialEntries: ['/admin/configuration'] },
        )}
      />,
    );
    const editor = await screen.findByLabelText('Appointments JSON');
    fireEvent.change(editor, {
      target: { value: '[{"date":"2026-11-02","time":"10:00"}]' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'Review' }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        'Discard your unsaved configuration changes?',
      ),
    );
    expect(screen.getByLabelText('Appointments JSON')).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('link', { name: 'Review' }));
    await screen.findByRole('region', { name: 'Review' });
  } finally {
    confirm.mockRestore();
  }
});

it('opens review directly without fetching configuration', async () => {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/admin/*', element: <AdminPage /> }],
        {
          initialEntries: ['/admin/review'],
        },
      )}
    />,
  );
  await screen.findByRole('region', { name: 'Review' });
  expect(mocks.load).not.toHaveBeenCalled();
});
