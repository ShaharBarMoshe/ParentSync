import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import SettingsPage from './SettingsPage';

vi.mock('../services/api', () => ({
  settingsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  authApi: {
    getStatus: vi.fn(),
    getConnectUrl: vi.fn(),
    disconnect: vi.fn(),
  },
  childrenApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  },
  whatsappApi: {
    getStatus: vi.fn(),
    reconnect: vi.fn(),
    getEventsUrl: vi.fn(),
  },
}));

import { settingsApi, authApi, childrenApi, whatsappApi } from '../services/api';

const mockSettingsApi = settingsApi as unknown as {
  getAll: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockAuthApi = authApi as unknown as {
  getStatus: ReturnType<typeof vi.fn>;
  getConnectUrl: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
const mockChildrenApi = childrenApi as unknown as {
  getAll: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
};
const mockWhatsappApi = whatsappApi as unknown as {
  getStatus: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  getEventsUrl: ReturnType<typeof vi.fn>;
};

function renderPage() {
  return render(
    <BrowserRouter>
      <SettingsPage />
    </BrowserRouter>,
  );
}

const mockChild = {
  id: 'child-1',
  name: 'Yoni',
  channelNames: 'Grade 3A Parents',
  teacherEmails: 'teacher@school.edu',
  calendarColor: '7',
  lastScanAt: null,
  order: 0,
  createdAt: '2026-03-20T10:00:00Z',
  updatedAt: '2026-03-20T10:00:00Z',
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsApi.getAll.mockResolvedValue([]);
    mockAuthApi.getStatus.mockResolvedValue({
      gmail: { authenticated: false },
      calendar: { authenticated: false },
    });
    mockChildrenApi.getAll.mockResolvedValue([]);
    mockWhatsappApi.getStatus.mockResolvedValue({ status: 'disconnected', connected: false });
  });

  it('renders settings form fields', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/check schedule/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    mockSettingsApi.getAll.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  it('shows error when API fails to load', async () => {
    mockSettingsApi.getAll.mockRejectedValue(new Error('fail'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
    });
  });

  it('loads settings from API on mount and shows selected hours', async () => {
    mockSettingsApi.getAll.mockResolvedValue([
      { id: '1', key: 'check_schedule', value: '9,14', updatedAt: '' },
    ]);
    renderPage();
    await waitFor(() => {
      const btn9 = screen.getByRole('button', { name: '9a' });
      expect(btn9).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('button', { name: '2p' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '3p' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('validates at least one hour selected on submit', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/check schedule/i)).toBeInTheDocument();
    });

    // Default has hours selected — deselect them all via "None" button
    await user.click(screen.getByRole('button', { name: /^none$/i }));

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(screen.getByText(/select at least one hour/i)).toBeInTheDocument();
    });
  });

  it('saves settings to backend', async () => {
    const user = userEvent.setup();
    mockSettingsApi.create.mockResolvedValue({ id: '1', key: 'test', value: 'test', updatedAt: '' });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/check schedule/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(mockSettingsApi.create).toHaveBeenCalled();
    });
    expect(screen.getByText(/settings saved/i)).toBeInTheDocument();
  });

  it('resets form to last saved state', async () => {
    const user = userEvent.setup();
    mockSettingsApi.getAll.mockResolvedValue([
      { id: '1', key: 'check_schedule', value: '9', updatedAt: '' },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '9a' })).toHaveAttribute('aria-pressed', 'true');
    });

    // Toggle hour 12 on
    await user.click(screen.getByRole('button', { name: '12p' }));
    expect(screen.getByRole('button', { name: '12p' })).toHaveAttribute('aria-pressed', 'true');

    // Reset
    await user.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByRole('button', { name: '12p' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '9a' })).toHaveAttribute('aria-pressed', 'true');
  });

  // Children tests
  describe('Children section', () => {
    it('shows empty state when no children', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByText(/add your first child/i)).toBeInTheDocument();
      });
    });

    it('renders children list from API', async () => {
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      renderPage();
      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });
    });

    it('adds a new child', async () => {
      const user = userEvent.setup();
      const newChild = { ...mockChild, id: 'new-1', name: 'New Child' };
      mockChildrenApi.create.mockResolvedValue(newChild);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/add your first child/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /add child/i }));

      await waitFor(() => {
        expect(mockChildrenApi.create).toHaveBeenCalledWith({ name: 'New Child' });
      });
      expect(screen.getByText('New Child')).toBeInTheDocument();
    });

    it('expands child card to show fields', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      // Click to expand
      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByLabelText(/child name/i)).toHaveValue('Yoni');
      });
      // WhatsApp channels are now rendered as chips, not an input with the channel value
      expect(screen.getByText('Grade 3A Parents')).toBeInTheDocument();
      expect(screen.getByLabelText(/teacher emails/i)).toHaveValue('teacher@school.edu');
    });

    it('saves child changes', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      const updatedChild = { ...mockChild, name: 'Yoni Updated' };
      mockChildrenApi.update.mockResolvedValue(updatedChild);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      // Expand card
      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByLabelText(/child name/i)).toBeInTheDocument();
      });

      // Modify name
      const nameInput = screen.getByLabelText(/child name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'Yoni Updated');

      // Save button should be enabled now (dirty)
      const saveBtn = screen.getByRole('button', { name: /^save$/i });
      expect(saveBtn).not.toBeDisabled();
      await user.click(saveBtn);

      await waitFor(() => {
        expect(mockChildrenApi.update).toHaveBeenCalledWith('child-1', expect.objectContaining({ name: 'Yoni Updated' }));
      });
    });

    it('validates child name is required', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByLabelText(/child name/i)).toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText(/child name/i);
      await user.clear(nameInput);

      const saveBtn = screen.getByRole('button', { name: /^save$/i });
      await user.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText(/child name is required/i)).toBeInTheDocument();
      });
      expect(mockChildrenApi.update).not.toHaveBeenCalled();
    });

    it('deletes a child with confirmation', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      mockChildrenApi.delete.mockResolvedValue({});
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      // Expand card
      await user.click(screen.getByText('Yoni'));

      // Wait for card to expand and find the Remove button (exact match to avoid matching chip remove buttons)
      const removeBtn = await waitFor(() => screen.getByRole('button', { name: /^remove$/i }));

      // Click remove
      await user.click(removeBtn);

      // Confirmation dialog should appear
      const confirmDialog = await waitFor(() => screen.getByRole('alertdialog'));
      expect(within(confirmDialog).getByText('Yoni')).toBeInTheDocument();

      // Confirm removal
      const confirmBtn = within(confirmDialog).getByRole('button', { name: /remove/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockChildrenApi.delete).toHaveBeenCalledWith('child-1');
      });
    });

    it('shows never scanned for child without lastScanAt', async () => {
      mockChildrenApi.getAll.mockResolvedValue([{ ...mockChild, lastScanAt: null }]);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/never scanned/i)).toBeInTheDocument();
      });
    });

    it('auto-saves when adding a WhatsApp channel', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      mockChildrenApi.update.mockResolvedValue({ ...mockChild, channelNames: 'Grade 3A Parents, Sports Club' });
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      // Expand card
      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByText('Grade 3A Parents')).toBeInTheDocument();
      });

      // Type a new channel name and press Enter
      const channelInput = screen.getByPlaceholderText(/type channel name/i);
      await user.type(channelInput, 'Sports Club');
      await user.keyboard('{Enter}');

      // Should immediately call update API without clicking Save
      await waitFor(() => {
        expect(mockChildrenApi.update).toHaveBeenCalledWith(
          'child-1',
          expect.objectContaining({ channelNames: 'Grade 3A Parents, Sports Club' }),
        );
      });
    });

    it('auto-saves when adding a channel via Add button', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      mockChildrenApi.update.mockResolvedValue({ ...mockChild, channelNames: 'Grade 3A Parents, Music' });
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByText('Grade 3A Parents')).toBeInTheDocument();
      });

      const channelInput = screen.getByPlaceholderText(/type channel name/i);
      await user.type(channelInput, 'Music');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => {
        expect(mockChildrenApi.update).toHaveBeenCalledWith(
          'child-1',
          expect.objectContaining({ channelNames: 'Grade 3A Parents, Music' }),
        );
      });
    });

    it('auto-saves when removing a WhatsApp channel', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([
        { ...mockChild, channelNames: 'Grade 3A Parents, Sports Club' },
      ]);
      mockChildrenApi.update.mockResolvedValue({ ...mockChild, channelNames: 'Grade 3A Parents' });
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByText('Sports Club')).toBeInTheDocument();
      });

      // Click the remove button on the "Sports Club" chip
      const removeBtn = screen.getByRole('button', { name: /remove sports club/i });
      await user.click(removeBtn);

      await waitFor(() => {
        expect(mockChildrenApi.update).toHaveBeenCalledWith(
          'child-1',
          expect.objectContaining({ channelNames: 'Grade 3A Parents' }),
        );
      });
    });

    it('saves dirty child changes when Save Settings is clicked', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      const updatedChild = { ...mockChild, teacherEmails: 'new@school.edu' };
      mockChildrenApi.update.mockResolvedValue(updatedChild);
      mockSettingsApi.create.mockResolvedValue({ id: '1', key: 'test', value: 'test', updatedAt: '' });
      mockSettingsApi.delete.mockResolvedValue(undefined);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      // Expand card and modify teacher emails (a non-channel field that doesn't auto-save)
      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByLabelText(/teacher emails/i)).toBeInTheDocument();
      });

      const emailInput = screen.getByLabelText(/teacher emails/i);
      await user.clear(emailInput);
      await user.type(emailInput, 'new@school.edu');

      // Don't click the child Save button — click Save Settings instead
      await user.click(screen.getByRole('button', { name: /save settings/i }));

      await waitFor(() => {
        expect(mockChildrenApi.update).toHaveBeenCalledWith(
          'child-1',
          expect.objectContaining({ teacherEmails: 'new@school.edu' }),
        );
      });
      // Settings should also have been saved
      expect(mockSettingsApi.create).toHaveBeenCalled();
    });

    it('renders color picker with calendar colors', async () => {
      const user = userEvent.setup();
      mockChildrenApi.getAll.mockResolvedValue([mockChild]);
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Yoni')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Yoni'));

      await waitFor(() => {
        expect(screen.getByRole('radiogroup', { name: /calendar color/i })).toBeInTheDocument();
      });

      // Should have 12 swatches (11 colors + default)
      const radiogroup = screen.getByRole('radiogroup', { name: /calendar color/i });
      const swatches = within(radiogroup).getAllByRole('radio');
      expect(swatches).toHaveLength(12);
    });
  });
});
