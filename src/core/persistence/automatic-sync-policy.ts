import { sourceConfigHasRemoteUrl } from '../sources-load.ts';
import type { SqlEngine } from './model.ts';
import { getWorktreeBinding, readManagedMode } from './ownership.ts';

/**
 * Whether an automatic sync (autopilot freshness or per-source fanout) may
 * request a Git pull for `source`. It needs a remote URL plus positive proof of
 * an unmanaged source: exactly one boolean persistence state that is off, and
 * no worktree binding. A managed brain or a claimed source syncs local HEAD
 * without pulling; missing or malformed persistence metadata refuses instead of
 * granting a pull. Explicit `gbrain sync` intent is resolved elsewhere.
 */
export async function automaticSyncPull(engine: SqlEngine, source: { id: string; config: unknown }): Promise<boolean> {
  if (!sourceConfigHasRemoteUrl(source.config)) return false;
  // #6482: the shared fail-closed predicate (`storage_error` on a missing, duplicated or non-boolean singleton) lives in ownership.ts.
  if (await readManagedMode(engine, { refusal: { subject: 'Automatic sync',
    consequence: `automatic sync of ${source.id} is not queued rather than risk a Git pull over it; it resumes on the next tick once the state is repaired` } })) return false;
  return await getWorktreeBinding(engine, source.id, null) === null;
}
