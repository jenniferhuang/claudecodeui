import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';

test('Desktop lifecycle transitions update the activity even when its status text is unchanged', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => result.current.markSessionProcessing('desktop-session', {
    statusText: 'Desktop execution', canInterrupt: false,
    desktopExecution: { state: 'queued', requestId: 'r1', queueItemId: 'q1', turnId: null },
  }));
  act(() => result.current.markSessionProcessing('desktop-session', {
    statusText: 'Desktop execution', canInterrupt: false,
    desktopExecution: { state: 'running', requestId: 'r1', queueItemId: 'q1', turnId: 't1' },
  }));
  assert.equal(result.current.getSessionActivity('desktop-session')?.desktopExecution?.state, 'running');

  act(() => result.current.syncProcessingSessions([{
    sessionId: 'desktop-session', canInterrupt: false,
    desktopExecution: { state: 'uncertain', requestId: 'r1', queueItemId: 'q1', turnId: 't1' },
  }]));
  assert.equal(result.current.getSessionActivity('desktop-session')?.desktopExecution?.state, 'uncertain');
  assert.equal(result.current.getSessionActivity('other-session'), undefined);
});

test('absence from a poll does not claim that a Desktop request completed or was cancelled', () => {
  const { result } = renderHook(() => useSessionProtection());
  act(() => result.current.syncProcessingSessions([{
    sessionId: 'desktop-session', startedAt: 1, canInterrupt: false,
    desktopExecution: { state: 'running', requestId: 'r1', queueItemId: 'q1', turnId: 't1' },
  }]));
  act(() => result.current.syncProcessingSessions([]));
  assert.equal(result.current.getSessionActivity('desktop-session')?.desktopExecution?.state, 'uncertain');
  assert.equal(result.current.getSessionActivity('desktop-session')?.canInterrupt, false);
  act(() => result.current.markSessionIdle('desktop-session'));
  assert.equal(result.current.getSessionActivity('desktop-session'), undefined);
});
