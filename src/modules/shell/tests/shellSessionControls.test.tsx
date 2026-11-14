import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Shell from '@/modules/shell/Shell';
import type { Project, ProjectSession } from '@/shared/types';

const runtime = vi.hoisted(() => ({
  terminalContainerRef: { current: null }, terminalRef: { current: null }, wsRef: { current: null },
  isConnected: false, isInitialized: true, isConnecting: false, isClaudeThemeOutdated: false,
  connectToShell: vi.fn(), disconnectFromShell: vi.fn(),
}));
vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({ useShellRuntime: () => runtime }));
vi.mock('@/modules/chat', () => ({ getClaudeSettings: () => ({ skipPermissions: false }) }));
vi.mock('@/modules/shell/TerminalShortcutsPanel', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function renderShell(provider = 'codex') {
  return render(<Shell
    selectedProject={{ fullPath: '/tmp/project', displayName: 'Project' } as Project}
    selectedSession={{ id: 'session', __provider: provider } as ProjectSession}
  />);
}

describe('Shell session controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.isConnected = false;
  });

  it('Connect attaches without requesting a destructive restart', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'shell.actions.connect' }));
    expect(runtime.connectToShell).toHaveBeenCalledExactlyOnceWith();
    expect(runtime.disconnectFromShell).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'shell.actions.restart' })).toBeNull();
  });

  it('explicitly labels and ends the current Codex runtime', () => {
    runtime.isConnected = true;
    renderShell();
    const end = screen.getByRole('button', { name: 'shell.actions.endCodex' });
    expect(end.getAttribute('title')).toBe('shell.actions.endCodexTitle');
    fireEvent.click(end);
    expect(runtime.disconnectFromShell).toHaveBeenCalledWith({ suppressAutoConnect: true, terminate: true });
  });

  it('preserves ordinary Disconnect and Restart for other providers', () => {
    runtime.isConnected = true;
    renderShell('claude');
    expect(screen.queryByRole('button', { name: 'shell.actions.restart' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'shell.actions.disconnect' }));
    expect(runtime.disconnectFromShell).toHaveBeenCalledWith({ suppressAutoConnect: true, terminate: false });
  });
});
