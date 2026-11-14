import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/index.js';

type IndexedSessionName = {
  latestName: string;
  historicalNames: Set<string>;
};

const UNTITLED_CODEX_SESSION = 'Untitled Codex Session';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');
  private nameSynchronization: Promise<void> = Promise.resolve();
  private pendingNameChanges = new Set<string>();

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await this.readSessionNameIndex();
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    // A rename may arrive while transcript metadata is being read. Reconcile
    // from a fresh index after all writes, even on an incremental empty scan.
    await this.queueNameSynchronization();
    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await this.readSessionNameIndex();
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const sessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
    await this.queueNameSynchronization();
    return sessionId;
  }

  /**
   * Used by the providers watcher and incremental scans to refresh imported
   * titles without changing session activity or archive state. Queue reads so
   * an older index snapshot cannot finish after a newer name refresh.
   */
  async synchronizeNames(): Promise<string[]> {
    await this.queueNameSynchronization();
    // A transcript scan can discover a rename before the index watcher runs.
    // Keep its changed ids until this notification path can announce them.
    const changedSessionIds = [...this.pendingNameChanges];
    this.pendingNameChanges.clear();
    return changedSessionIds;
  }

  private queueNameSynchronization(): Promise<void> {
    const synchronization = this.nameSynchronization.then(async () => {
      for (const sessionId of await this.refreshSessionNames()) {
        this.pendingNameChanges.add(sessionId);
      }
    });
    this.nameSynchronization = synchronization.catch(() => undefined);
    return synchronization;
  }

  private async refreshSessionNames(): Promise<string[]> {
    const nameMap = await this.readSessionNameIndex();
    const updates: Parameters<typeof sessionsDb.applyNativeProviderSessionNames>[1] = [];

    for (const session of sessionsDb.getNativeSessionsByProvider(this.provider)) {
      const indexedName = nameMap.get(session.session_id);
      if (!indexedName || session.custom_name_source === 'user') {
        continue;
      }

      const savedName = normalizeSessionName(session.custom_name ?? undefined, '');
      // Old versions did not record title provenance. A cached historical Codex
      // label can safely follow the index; an unknown label may be a user's
      // CloudCLI rename and is kept as an explicit override.
      const isLegacyOverride = session.custom_name_source === null
        && savedName !== ''
        && savedName !== UNTITLED_CODEX_SESSION
        && !indexedName.historicalNames.has(savedName);
      updates.push({
        sessionId: session.session_id,
        customName: isLegacyOverride ? session.custom_name! : indexedName.latestName,
        source: isLegacyOverride ? 'user' : 'provider',
      });
    }

    return sessionsDb.applyNativeProviderSessionNames(this.provider, updates);
  }

  private async readSessionNameIndex(): Promise<Map<string, IndexedSessionName>> {
    const names = new Map<string, IndexedSessionName>();
    let content: string;
    try {
      content = await readFile(path.join(this.codexHome, 'session_index.jsonl'), 'utf8');
    } catch {
      return names;
    }

    for (const line of content.split(/\r?\n/)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // An append in progress may leave a partial final row. Earlier valid
        // names remain available and the next watcher event will retry it.
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        continue;
      }
      const row = parsed as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.thread_name !== 'string') {
        continue;
      }
      const title = normalizeSessionName(row.thread_name, '');
      if (!title) {
        continue;
      }
      const existing = names.get(row.id);
      if (existing) {
        existing.latestName = title;
        existing.historicalNames.add(title);
      } else {
        names.set(row.id, { latestName: title, historicalNames: new Set([title]) });
      }
    }
    return names;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, IndexedSessionName>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && (existingSession.custom_name_source === 'user' || existingSessionName !== UNTITLED_CODEX_SESSION)) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId)?.latestName;
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
