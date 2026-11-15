import { useEffect, useRef } from 'react';

type NativeExecutionReconciliationOptions = {
  sessionId: string | null;
  enabled: boolean;
  reconcile: (isCurrent: () => boolean) => Promise<void>;
};

/** Used by ChatInterface to recover native completion without a manual status control. */
export function useNativeExecutionReconciliation({ sessionId, enabled, reconcile }: NativeExecutionReconciliationOptions) {
  // Activity refreshes can replace the callback without postponing this timer.
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  // A pending history refresh remains exclusive across session/visibility changes.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    const check = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        await reconcileRef.current(() => !cancelled);
      } catch {
        // A failed status refresh cannot establish completion; retry next tick.
      } finally {
        inFlightRef.current = false;
      }
    };
    const timer = window.setInterval(() => { void check(); }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, sessionId]);
}
