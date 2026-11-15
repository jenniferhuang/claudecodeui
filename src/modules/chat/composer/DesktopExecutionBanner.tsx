import { useTranslation } from 'react-i18next';

import type { DesktopExecution } from '@/shared/types';

/** Used by ChatComposer to describe native owner execution without promising a fixed owner. */
export default function DesktopExecutionBanner({ execution, onCheckStatus }: {
  execution: DesktopExecution;
  onCheckStatus?: () => void;
}) {
  const { t } = useTranslation('chat');
  if (execution.state === 'completed' || execution.state === 'failed') return null;
  const heading = execution.state === 'uncertain'
    ? t('desktopExecution.uncertain', { defaultValue: 'Execution status is uncertain. The request may still run; do not resend.' })
    : execution.state === 'queued'
      ? t('desktopExecution.queued', { defaultValue: 'Queued for the native session owner.' })
      : t('desktopExecution.running', { defaultValue: 'Running through the native session owner.' });
  return (
    <div
      role="status"
      aria-label={t('desktopExecution.label', { defaultValue: 'Native session execution' })}
      className="mx-auto mb-3 flex max-w-[54.25rem] flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t('desktopExecution.lastVerified', { defaultValue: 'Native queue · Desktop last verified' })}</p>
        <p className="mt-1 text-muted-foreground">
          {heading}
          {' '}
          {t('desktopExecution.permissions', { defaultValue: 'The native session owner uses its own permissions and settings. Web settings do not apply.' })}
          {' '}
          {t('desktopExecution.limits', { defaultValue: 'The owner may change after queuing. Handle approvals and stopping in the owning app. Completed output syncs here.' })}
        </p>
      </div>
      {onCheckStatus && (
        <button type="button" onClick={onCheckStatus} className="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-muted">
          {t('desktopExecution.checkStatus', { defaultValue: 'Check status' })}
        </button>
      )}
    </div>
  );
}
