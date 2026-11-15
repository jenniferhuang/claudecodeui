import { getConnection } from '@/modules/database/connection.js';
import type { CodexDesktopSubmission } from '@/shared/types.js';

type SubmissionRow = { payload: string };
function read(row: SubmissionRow | undefined): CodexDesktopSubmission | null {
  return row ? JSON.parse(row.payload) as CodexDesktopSubmission : null;
}

/** Providers persist intent before native delivery and recover its observation state after restart. */
export const codexDesktopSubmissionsDb = {
  createIntent(record: CodexDesktopSubmission): boolean {
    return getConnection().prepare(`
      INSERT OR IGNORE INTO codex_desktop_submissions
        (request_id, app_session_id, state, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.requestId, record.appSessionId, record.state, record.createdAt, record.updatedAt, JSON.stringify(record)).changes > 0;
  },
  getByRequestId(requestId: string): CodexDesktopSubmission | null {
    return read(getConnection().prepare('SELECT payload FROM codex_desktop_submissions WHERE request_id = ?')
      .get(requestId) as SubmissionRow | undefined);
  },
  getActiveForSession(appSessionId: string): CodexDesktopSubmission | null {
    return read(getConnection().prepare(`SELECT payload FROM codex_desktop_submissions
      WHERE app_session_id = ? AND state IN ('queued', 'running', 'uncertain')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(appSessionId) as SubmissionRow | undefined);
  },
  listActive(): CodexDesktopSubmission[] {
    const rows = getConnection().prepare(`SELECT payload FROM codex_desktop_submissions
      WHERE state IN ('queued', 'running', 'uncertain') ORDER BY created_at DESC, rowid DESC`).all() as SubmissionRow[];
    return rows.map(row => read(row)!);
  },
  update(requestId: string, patch: Partial<Pick<CodexDesktopSubmission,
    'state' | 'queueItemId' | 'turnId' | 'transcriptOffset' | 'updatedAt' | 'error'>>): void {
    const connection = getConnection();
    connection.transaction(() => {
      const previous = codexDesktopSubmissionsDb.getByRequestId(requestId);
      if (!previous) throw new Error('Desktop submission intent is missing.');
      const next = { ...previous, ...patch };
      connection.prepare(`UPDATE codex_desktop_submissions SET state = ?, updated_at = ?, payload = ? WHERE request_id = ?`)
        .run(next.state, next.updatedAt, JSON.stringify(next), requestId);
    })();
  },
};
