/**
 * One owner-only coaching notice for brains running `tokenmax` because the
 * install picker chose it (no `search.mode_source: operator`): gbrain now
 * recommends `balanced`. Delivered once per brain on the local channels (CLI
 * stderr and the stdio MCP pipe), through a per-brain marker file next to the
 * behavior-change markers; never on HTTP. It changes nothing and costs
 * nothing: the fix is the switch, asked of the user first. Muteable like any
 * coaching notice (`gbrain notices mute search_mode_coaching`).
 */
import type { Notice } from '../agent-output.ts';
import type { GBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { behaviorBrainKey, claimBrainNoticeMarker, currentBrainId } from '../behavior-change-notice.ts';
import { mutedNoticeCodes } from '../notice-ledger.ts';
import { SEARCH_MODE_KEY } from './mode.ts';
import { BALANCED_EVIDENCE, SEARCH_MODE_SOURCE_KEY } from './mode-advice.ts';

export const SEARCH_MODE_COACHING_CODE = 'search_mode_coaching';

export function searchModeCoachingNotice(): Notice {
  return {
    code: SEARCH_MODE_COACHING_CODE,
    kind: 'coaching',
    why: 'This brain runs search.mode tokenmax, which gbrain init chose automatically; gbrain now recommends balanced. ' +
      `${BALANCED_EVIDENCE} Switching to balanced changes: \`query\` returns 25 rows instead of 50, under a 12,000-token budget; ` +
      'the rerank pool is 25 instead of 50; `query` stops expanding by default (`expand: true` still does); new chunks are embedded ' +
      'with title context instead of per-chunk synopses (existing vectors keep serving until they are replaced); and the paid nightly ' +
      'conversation-parser probe stops (it runs in tokenmax, or when autopilot.conversation_parser_probe.enabled is true). ' +
      'Nothing changes unless the user agrees, and switching costs nothing.',
    fix: {
      ask_user: true,
      argv: ['gbrain', 'config', 'set', 'search.mode', 'balanced'],
      consent: [],
      actor: 'agent',
      requires_exclusive: false,
      why: 'Switches this brain to the recommended search mode.',
      user_message: 'gbrain recommends switching this brain\'s search mode from tokenmax (chosen automatically at install) to balanced: ' +
        'about half the retrieved text per query, and it scored higher in gbrain\'s retrieval benchmark. Switch to balanced?',
      verify: { argv: ['gbrain', 'search', 'modes', '--json'] },
      docs: 'docs/guides/search-modes.md',
    },
  };
}

/** Brains already looked at in this process: one look per process. */
const looked = new Set<string>();

/** Test seam: forget this process's looks. */
export function __resetSearchModeCoachingForTests(): void {
  looked.clear();
}

/**
 * The notice when this brain runs picker-chosen tokenmax and has not been
 * shown it on any local channel, else null. `principal` names the mute list
 * to honor (`stdio` for the MCP pipe; the owner's global list always
 * applies). Claims the per-brain marker only when it returns the notice.
 * Never throws.
 */
export async function takeSearchModeCoachingNotice(
  engine: BrainEngine,
  opts: { cfg: GBrainConfig | null; brainKey?: string; principal?: string },
): Promise<Notice | null> {
  try {
    const brainKey = opts.brainKey ?? behaviorBrainKey(opts.cfg, await currentBrainId());
    if (looked.has(brainKey)) return null;
    looked.add(brainKey);
    const [mode, source] = await Promise.all([engine.getConfig(SEARCH_MODE_KEY), engine.getConfig(SEARCH_MODE_SOURCE_KEY)]);
    if (mode !== 'tokenmax' || source === 'operator') return null;
    if (mutedNoticeCodes(opts.principal).has(SEARCH_MODE_COACHING_CODE)) return null;
    return claimBrainNoticeMarker(SEARCH_MODE_COACHING_CODE, brainKey) === 'shown' ? null : searchModeCoachingNotice();
  } catch {
    return null;
  }
}
