import { isConfigTruthy } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { sourceConfigHasRemoteUrl } from '../sources-load.ts';
import type { SqlEngine } from './model.ts';
import { getWorktreeBinding } from './ownership.ts';

/** #6451: brain-wide opt-out for the Git pull automatic sync requests (default on). */
export const AUTOPILOT_GIT_PULL_KEY = 'autopilot.git_pull';

type PolicyEngine = SqlEngine & Partial<Pick<BrainEngine, 'getConfig'>>;

/**
 * True when `autopilot.git_pull` is set to an explicit non-truthy value. Unset,
 * an engine without a config reader, or a config read failure keep the default
 * (pulls on), so a config-plane blip never changes sync behavior.
 */
export async function automaticGitPullDisabled(engine: PolicyEngine): Promise<boolean> {
  const raw = await engine.getConfig?.(AUTOPILOT_GIT_PULL_KEY).catch(() => null) ?? null;
  return raw != null && !isConfigTruthy(raw);
}

/**
 * Whether an automatic sync (autopilot freshness or per-source fanout) may
 * request a Git pull for `source`. It needs a remote URL plus positive proof of
 * an unmanaged source: exactly one boolean persistence state that is off, and
 * no worktree binding. A managed brain or a claimed source syncs local HEAD
 * without pulling; missing or malformed persistence metadata refuses instead of
 * granting a pull. `autopilot.git_pull=false` (#6451) turns the pull off for
 * every source before any of that is read. Explicit `gbrain sync` intent is
 * resolved elsewhere.
 */
export async function automaticSyncPull(engine: PolicyEngine, source: { id: string; config: unknown }): Promise<boolean> {
  if (await automaticGitPullDisabled(engine)) return false;
  if (!sourceConfigHasRemoteUrl(source.config)) return false;
  const rows = await engine.executeRaw<{ enabled: unknown }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (rows.length !== 1 || typeof rows[0]?.enabled !== 'boolean') {
    throw opError('storage_error', 'Automatic sync requires exactly one known boolean persistence state.',
      `Run the read-only probe in fix on the brain host and fix the persistence state it reports; automatic sync of ${source.id} resumes on the next tick.`, {
        why: `The persistence_brain singleton is missing, duplicated or not a boolean, so gbrain cannot tell whether ${source.id} is a managed canonical checkout; automatic sync is not queued rather than risk a Git pull over it.`,
        fix: { ...readFix('Shows the brain\'s persistence mode and each source\'s writer binding without changing anything.',
          { argv: ['gbrain', 'sources', 'writer', 'status', '--probe', '--json'] }), verify: { argv: ['gbrain', 'doctor', '--json'] } },
      });
  }
  if (rows[0].enabled) return false;
  return await getWorktreeBinding(engine, source.id, null) === null;
}
