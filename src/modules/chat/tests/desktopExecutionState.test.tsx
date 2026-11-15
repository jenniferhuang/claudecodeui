import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { ProjectSession, ServerEvent } from '@/shared/types';

const desktopExecution = {
  state: 'uncertain', requestId: 'request-a', queueItemId: 'queue-a', turnId: null,
} as const;

const renderDesktopSession = () => {
  let listener: ((event: ServerEvent) => void) | undefined;
  const refresh = vi.fn(async () => {});
  const sessionStore = {
    appendRealtime: () => {}, getMessages: () => [], updateStreaming: () => {}, finalizeStreaming: () => {},
  } as unknown as SessionStore;
  const hook = renderHook(({ sessionId }: { sessionId: string }) => {
    const activity = useSessionProtection();
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; },
      provider: 'codex', selectedSession: { id: sessionId } as ProjectSession, currentSessionId: sessionId,
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' },
      lastSeqRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: activity.markSessionProcessing, onSessionIdle: activity.markSessionIdle,
      onSessionBackground: activity.markSessionBackground, getSessionActivity: activity.getSessionActivity,
      requestLatestMessages: refresh, sessionStore,
    });
    return activity;
  }, { initialProps: { sessionId: 'session-a' } });
  return { ...hook, refresh, dispatch: (event: ServerEvent) => act(() => listener?.(event)) };
};

test('Desktop execution status stays scoped to its session across switching and reconnect acknowledgement', () => {
  const { result, dispatch, rerender } = renderDesktopSession();
  dispatch({ kind: 'status', sessionId: 'session-a', text: 'Desktop is executing with its own permissions', canInterrupt: false, desktopExecution });
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);

  rerender({ sessionId: 'session-b' });
  dispatch({ kind: 'chat_subscribed', sessionId: 'session-b', isProcessing: true });
  assert.equal(result.current.getSessionActivity('session-b')?.desktopExecution, undefined);
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);

  dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: true, canInterrupt: false, desktopExecution });
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);
  assert.equal(result.current.getSessionActivity('session-b')?.desktopExecution, undefined);
});

test('a fresh subscription restores Desktop execution and completion refreshes only the viewed history', () => {
  const { result, dispatch, refresh } = renderDesktopSession();
  dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: true, canInterrupt: false, desktopExecution });
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);

  act(() => {
    dispatch({ kind: 'status', sessionId: 'session-a', canInterrupt: false,
      desktopExecution: { ...desktopExecution, state: 'completed', turnId: 'native-turn-a' } });
    dispatch({ kind: 'complete', sessionId: 'session-a', success: true });
  });
  assert.equal(result.current.getSessionActivity('session-a'), undefined);
  assert.deepEqual(refresh.mock.calls, [['session-a', true]]);
});

test('an observer timeout complete cannot clear the uncertain native request or allow resend', () => {
  const { result, dispatch, refresh } = renderDesktopSession();
  dispatch({ kind: 'status', sessionId: 'session-a', text: 'Native execution uncertain', canInterrupt: false, desktopExecution });
  dispatch({ kind: 'complete', sessionId: 'session-a', success: false, exitCode: 1 });
  assert.equal(result.current.getSessionActivity('session-a')?.desktopExecution?.state, 'uncertain');
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);
  assert.deepEqual(refresh.mock.calls, [['session-a', true]]);
});

test('observer completion without correlated native terminal state remains uncertain even if success is true', () => {
  const { result, dispatch } = renderDesktopSession();
  dispatch({ kind: 'status', sessionId: 'session-a', canInterrupt: false,
    desktopExecution: { ...desktopExecution, state: 'running', turnId: 'native-turn-a' } });
  dispatch({ kind: 'complete', sessionId: 'session-a', success: true });
  assert.equal(result.current.getSessionActivity('session-a')?.desktopExecution?.state, 'uncertain');
});

test('an unscoped Desktop status cannot mark the currently viewed session as externally executing', () => {
  const { result, dispatch } = renderDesktopSession();
  dispatch({ kind: 'status', text: 'Desktop ownership unknown', canInterrupt: false, desktopExecution });
  assert.equal(result.current.getSessionActivity('session-a'), undefined);
});

test('a rejected web action cannot clear an uncertain Desktop request', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result, dispatch } = renderDesktopSession();
  dispatch({ kind: 'status', sessionId: 'session-a', text: 'Desktop execution uncertain', canInterrupt: false, desktopExecution });
  dispatch({ kind: 'protocol_error', sessionId: 'session-a', code: 'RUN_IN_PROGRESS', error: 'Request is already tracked' });
  assert.equal(result.current.getSessionActivity('session-a')?.desktopExecution?.state, 'uncertain');
});

test('delivery-unconfirmed refusal restores native execution before a fresh tab receives subscription state', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result, dispatch, rerender } = renderDesktopSession();
  act(() => result.current.markSessionProcessing('session-a', { statusText: null, canInterrupt: true }));
  dispatch({
    kind: 'protocol_error', sessionId: 'session-a', code: 'DESKTOP_DELIVERY_UNCONFIRMED',
    error: 'An earlier request may still execute. Check its status before sending again.',
    canInterrupt: false, desktopExecution,
  });
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);
  assert.equal(result.current.isSessionProcessing('session-a'), true);

  rerender({ sessionId: 'session-b' });
  assert.equal(result.current.getSessionActivity('session-b'), undefined);
  assert.deepEqual(result.current.getSessionActivity('session-a')?.desktopExecution, desktopExecution);
});

test('native refusal metadata restores pending activity even without any local processing entry', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result, dispatch } = renderDesktopSession();
  dispatch({
    kind: 'protocol_error', sessionId: 'session-a', code: 'DESKTOP_DELIVERY_UNCONFIRMED',
    error: 'The native session owner has outstanding work.', canInterrupt: false,
    desktopExecution: { ...desktopExecution, state: 'queued' },
  });
  assert.equal(result.current.getSessionActivity('session-a')?.desktopExecution?.state, 'queued');
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);
});

test('a pre-ledger native Stop refusal keeps optimistic processing and disables Stop until admission settles', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result, dispatch } = renderDesktopSession();
  act(() => result.current.markSessionProcessing('session-a', { statusText: null, canInterrupt: true }));
  dispatch({
    kind: 'protocol_error', sessionId: 'session-a', code: 'DESKTOP_STOP_UNAVAILABLE',
    error: 'Native owner admission is in progress. Stop is unavailable from the website.',
    canInterrupt: false,
  });
  assert.equal(result.current.isSessionProcessing('session-a'), true);
  assert.equal(result.current.getSessionActivity('session-a')?.canInterrupt, false);
  assert.equal(result.current.getSessionActivity('session-a')?.desktopExecution, undefined);
});
