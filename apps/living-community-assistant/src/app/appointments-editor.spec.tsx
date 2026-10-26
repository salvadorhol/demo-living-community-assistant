import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppointmentsEditor } from './appointments-editor';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => undefined),
}));
vi.mock('./api/appointments', () => ({
  loadAppointments: mocks.load,
  saveAppointments: mocks.save,
}));
const config = {
  slots: [{ date: '2099-11-02', time: '10:00' }],
  revision: 2,
  updatedAt: { toMillis: () => 0 },
  updatedBy: 'admin',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.load.mockReset().mockResolvedValue(config);
});
it('rejects invalid JSON and duplicate slots without writing', async () => {
  render(<AppointmentsEditor onDirty={vi.fn()} onBusy={vi.fn()} />);
  const editor = await screen.findByLabelText('Appointments JSON');
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Appointments JSON') as HTMLTextAreaElement).value,
    ).toBe(JSON.stringify(config.slots, null, 2)),
  );
  fireEvent.change(editor, { target: { value: '{' } });
  expect(
    (
      screen.getByRole('button', {
        name: 'Save appointments',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(editor, {
    target: { value: JSON.stringify([config.slots[0], config.slots[0]]) },
  });
  expect(screen.getByRole('alert').textContent).toContain('Duplicate');
  expect(mocks.save).not.toHaveBeenCalled();
});
it('preserves the JSON draft when another admin has changed the revision', async () => {
  mocks.save.mockRejectedValueOnce(
    new Error(
      'Another admin changed the appointments. Your draft is preserved.',
    ),
  );
  render(<AppointmentsEditor onDirty={vi.fn()} onBusy={vi.fn()} />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Appointments JSON') as HTMLTextAreaElement).value,
    ).toBe(JSON.stringify(config.slots, null, 2)),
  );
  fireEvent.change(screen.getByLabelText('Appointments JSON'), {
    target: { value: '[]' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save appointments' }));
  await screen.findByRole('alert');
  expect(screen.getByDisplayValue('[]')).toBeTruthy();
  expect(mocks.save).toHaveBeenCalledWith('[]', 2);
});
it('allows explicit creation of an empty schedule', async () => {
  mocks.load
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...config, slots: [], revision: 1 });
  render(<AppointmentsEditor onDirty={vi.fn()} onBusy={vi.fn()} />);
  await screen.findByText(/No configuration is saved/);
  fireEvent.click(screen.getByRole('button', { name: 'Save appointments' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('[]', 0));
  await screen.findByText(/Appointments saved/);
});
