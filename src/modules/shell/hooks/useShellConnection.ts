import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession, ShellConnectOptions, ShellDisconnectOptions } from '@/shared/types';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '@/modules/shell/utils/socket';
import { readSelectedProvider } from '@/shared/selectedProvider';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  bypassPermissionsRef: MutableRefObject<boolean>;
  isDarkModeRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  claudeLaunchColorScheme: 'light' | 'dark' | null;
  closeSocket: () => void;
  connectToShell: (options?: ShellConnectOptions) => void;
  disconnectFromShell: (options?: ShellDisconnectOptions) => void;
};

/** Used by the Shell runtime to attach terminals without implicitly starting competing Codex writers. */
export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  bypassPermissionsRef,
  isDarkModeRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  // The theme the server says the Claude CLI in this pty was launched for. Only
  // the server knows it: a reconnect can reattach to a CLI started in another
  // theme. Null when the pty runs anything else or no socket is open.
  const [claudeLaunchColorScheme, setClaudeLaunchColorScheme] = useState<'light' | 'dark' | null>(null);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'session_unavailable' || message.type === 'session_exited') {
        // An unavailable/finished Codex terminal needs an explicit Connect.
        // Keep exit output visible, and prevent an automatic cold-start loop.
        suppressAutoConnectRef.current = true;
        closeSocket();
        setIsConnected(false);
        setIsConnecting(false);
        setClaudeLaunchColorScheme(null);
        connectingRef.current = false;
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'error') {
        // The server sends this instead of spawning a PTY, then keeps the
        // socket open — so without writing it out the terminal just stays
        // blank forever under a green "connected" dot. Deliberately not
        // closing the socket: `onclose` clears the screen and would erase
        // the very message being surfaced here.
        const detail = typeof message.message === 'string' && message.message
          ? message.message
          : 'Shell error';
        terminalRef.current?.write(`\r\n\x1b[31m${detail}\x1b[0m\r\n`);
        return;
      }

      if (message.type === 'claude_theme') {
        const { colorScheme } = message;
        setClaudeLaunchColorScheme(colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : null);
      }
    },
    [closeSocket, handleProcessCompletion, onOutputRef, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false, automatic = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (wsRef.current !== socket) return;
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
            if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || readSelectedProvider()),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceRestart,
              attachOnly: automatic && !isPlainShellRef.current &&
                (selectedSessionRef.current?.__provider || readSelectedProvider()) === 'codex',
              // Launch-time flag: bypass mode can only join the CLI's
              // shift+tab cycle when claude starts with it.
              bypassPermissions: bypassPermissionsRef.current,
              // Launch-time too: a CLI picks its colours when it starts.
              colorScheme: isDarkModeRef.current ? 'dark' : 'light',
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (wsRef.current !== socket) return;
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (wsRef.current !== socket) return;
          wsRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
          setClaudeLaunchColorScheme(null);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (wsRef.current !== socket) return;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      bypassPermissionsRef,
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isDarkModeRef,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: ShellConnectOptions) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: ShellDisconnectOptions) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    if (options?.terminate) sendSocketMessage(wsRef.current, { type: 'terminate' });
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    setClaudeLaunchColorScheme(null);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket, wsRef]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true, true);
  }, [autoConnect, connectWebSocket, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    claudeLaunchColorScheme,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
