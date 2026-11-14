import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import type { Project, ProjectSession } from '@/shared/types';

vi.mock('@/modules/shell/utils/socket', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  constructor() { FakeSocket.instances.push(this); }
  send(payload: string) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function renderConnection(provider = 'codex') {
  const wsRef = ref<WebSocket | null>(null);
  const write = vi.fn();
  const clearTerminalScreen = vi.fn();
  const options = {
    wsRef,
    terminalRef: ref({ write, cols: 80, rows: 24 } as unknown as Terminal | null),
    fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
    selectedProjectRef: ref<Project | null | undefined>({ fullPath: '/tmp/project' } as Project),
    selectedSessionRef: ref<ProjectSession | null | undefined>({ id: 'app-session', __provider: provider } as ProjectSession),
    initialCommandRef: ref<string | null | undefined>(null),
    isPlainShellRef: ref(false), bypassPermissionsRef: ref(false), isDarkModeRef: ref(true),
    onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
    isInitialized: true, autoConnect: true,
    closeSocket: () => { const socket = wsRef.current; wsRef.current = null; socket?.close(); },
    clearTerminalScreen,
  };
  const hook = renderHook(() => useShellConnection(options));
  return { ...hook, wsRef, write, clearTerminalScreen };
}

describe('Codex Shell handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers(); FakeSocket.instances = []; vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('automatically reconnects only to an existing Codex terminal', () => {
    const view = renderConnection();
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); vi.runOnlyPendingTimers(); });
    expect(socket.sent[0]).toMatchObject({ type: 'init', attachOnly: true, sessionId: 'app-session' });
    view.unmount();
  });

  it('waits for an explicit launch when no retained Codex terminal exists', () => {
    const view = renderConnection();
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); vi.runOnlyPendingTimers(); });
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'session_unavailable' }) }); });
    expect(view.result.current.isConnected).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => { view.result.current.connectToShell(); });
    const explicit = FakeSocket.instances[1];
    act(() => { explicit.open(); vi.runOnlyPendingTimers(); });
    expect(explicit.sent[0]).toMatchObject({ type: 'init', attachOnly: false, forceRestart: false });
    view.unmount();
  });

  it.each(['CHAT_SESSION_ACTIVE', 'SHELL_SESSION_ACTIVE'])(
    'allows explicit Connect retry after %s rejects initialization without disrupting another provider',
    (code) => {
      const view = renderConnection();
      const automatic = FakeSocket.instances[0];
      act(() => { automatic.open(); vi.runOnlyPendingTimers(); });
      act(() => { automatic.onmessage?.({ data: JSON.stringify({ type: 'session_unavailable' }) }); });
      act(() => { view.result.current.connectToShell(); });
      const rejected = FakeSocket.instances[1];
      act(() => { rejected.open(); vi.runOnlyPendingTimers(); });
      expect(rejected.sent[0]).toMatchObject({ attachOnly: false, forceRestart: false });

      const otherView = renderConnection('opencode');
      const other = FakeSocket.instances[2];
      act(() => { other.open(); vi.runOnlyPendingTimers(); });
      view.clearTerminalScreen.mockClear();
      act(() => { rejected.onmessage?.({ data: JSON.stringify({
        type: 'error', code, message: 'Wait for this session to become available, then reconnect.',
      }) }); });

      expect(view.result.current.isConnected).toBe(false);
      expect(view.result.current.isConnecting).toBe(false);
      expect(view.wsRef.current).toBeNull();
      expect(rejected.readyState).toBe(3);
      expect(view.write.mock.calls.flat().join('')).toContain('then reconnect');
      expect(view.clearTerminalScreen).not.toHaveBeenCalled();
      expect(FakeSocket.instances).toHaveLength(3);
      expect(rejected.sent.some((frame) => frame.type === 'terminate')).toBe(false);
      expect(otherView.result.current.isConnected).toBe(true);
      expect(otherView.wsRef.current).toBe(other);
      expect(other.readyState).toBe(1);

      act(() => { view.result.current.connectToShell(); });
      const retry = FakeSocket.instances[3];
      act(() => { retry.open(); vi.runOnlyPendingTimers(); });
      expect(retry.sent[0]).toMatchObject({
        type: 'init', attachOnly: false, forceRestart: false, sessionId: 'app-session',
      });
      act(() => { rejected.onclose?.(); });
      expect(view.result.current.isConnected).toBe(true);
      expect(view.wsRef.current).toBe(retry);
      act(() => { other.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'unrelated output' }) }); });
      expect(otherView.write).toHaveBeenCalledWith('unrelated output');
      view.unmount();
      otherView.unmount();
    },
  );

  it('preserves attached terminal or observer sockets when an ordinary error is reported', () => {
    const view = renderConnection();
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); vi.runOnlyPendingTimers(); });
    act(() => { socket.onmessage?.({ data: JSON.stringify({
      type: 'error', message: 'This socket cannot control the current terminal.',
    }) }); });
    expect(view.result.current.isConnected).toBe(true);
    expect(view.wsRef.current).toBe(socket);
    expect(socket.readyState).toBe(1);
    expect(view.clearTerminalScreen).not.toHaveBeenCalled();
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'retained terminal' }) }); });
    expect(view.write).toHaveBeenCalledWith('retained terminal');
    view.unmount();
  });

  it('never sends a delayed init after the user disconnects', () => {
    const view = renderConnection();
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); });
    act(() => { view.result.current.disconnectFromShell({ suppressAutoConnect: true }); });
    act(() => { vi.runOnlyPendingTimers(); });
    expect(socket.sent).toHaveLength(0);
    view.unmount();
  });

  it('ignores an older connection closing after its replacement is connected', () => {
    const view = renderConnection();
    const old = FakeSocket.instances[0];
    act(() => { old.open(); vi.runOnlyPendingTimers(); });
    act(() => { view.result.current.disconnectFromShell({ suppressAutoConnect: true }); });
    act(() => { view.result.current.connectToShell(); });
    const current = FakeSocket.instances[1];
    act(() => { current.open(); vi.runOnlyPendingTimers(); });
    view.clearTerminalScreen.mockClear();
    act(() => { old.onclose?.(); });
    expect(view.result.current.isConnected).toBe(true);
    expect(view.wsRef.current).toBe(current);
    expect(view.clearTerminalScreen).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps normal automatic launches for other providers', () => {
    const view = renderConnection('claude');
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); vi.runOnlyPendingTimers(); });
    expect(socket.sent[0].attachOnly).not.toBe(true);
    view.unmount();
  });

  it('ends only on explicit request and does not reconnect after the process exits', () => {
    const view = renderConnection();
    const socket = FakeSocket.instances[0];
    act(() => { socket.open(); vi.runOnlyPendingTimers(); });
    act(() => { view.result.current.disconnectFromShell({ suppressAutoConnect: true, terminate: true }); });
    expect(socket.sent.at(-1)).toEqual({ type: 'terminate' });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => { view.result.current.connectToShell(); });
    const current = FakeSocket.instances[1];
    act(() => { current.open(); vi.runOnlyPendingTimers(); });
    act(() => { current.onmessage?.({ data: JSON.stringify({ type: 'session_exited' }) }); });
    expect(view.result.current.isConnected).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(current.sent.some((frame) => frame.type === 'terminate')).toBe(false);
    view.unmount();
  });

  it('ignores old output, errors, and delayed opens after a replacement connects', () => {
    const view = renderConnection();
    const old = FakeSocket.instances[0];
    act(() => { view.result.current.disconnectFromShell({ suppressAutoConnect: true }); });
    act(() => { view.result.current.connectToShell(); });
    const current = FakeSocket.instances[1];
    act(() => { current.open(); vi.runOnlyPendingTimers(); });
    act(() => {
      old.open();
      old.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'stale output' }) });
      old.onerror?.();
      vi.runOnlyPendingTimers();
    });
    expect(old.sent).toHaveLength(0);
    expect(view.write).not.toHaveBeenCalled();
    expect(view.result.current.isConnected).toBe(true);
    expect(view.wsRef.current).toBe(current);
    view.unmount();
  });
});
