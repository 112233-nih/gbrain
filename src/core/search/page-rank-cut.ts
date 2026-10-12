/**
 * W5 (memory proof wave 2): page-unit ranking cut from the caller's budget.
 *
 * With `return_unit: "page"` and a caller `token_budget`, delivery packs whole
 * pages into that budget, but ranking still cut its hits to the mode's
 * `search.tokenBudget` (4000 conservative, none under tokenmax). Under tokenmax
 * delivery was handed far more pages than it could deliver whole, and each
 * arrived as a sliver. `search.page_rank_budget_ratio` (default off) cuts the
 * ranked hits to `ratio x caller budget`, or to the mode's cut when that is
 * smaller. Chunk-unit calls and calls without a caller budget never engage it.
 */
import type { BrainEngine } from '../engine.ts';
import type { ResolvedSearchKnobs } from './mode.ts';

export const PAGE_RANK_BUDGET_RATIO_KEY = 'search.page_rank_budget_ratio';

/** The cut a page-unit plan asks ranking to apply (resolved once per call). */
export interface PageRankCut {
  ratio: number;
  caller_budget: number;
  tokens: number;
}

/** `meta.page_rank_cut`: the applied cut, plus the hits before and after it. */
export interface PageRankCutMeta {
  ratio: number;
  caller_budget: number;
  /** The mode's `search.tokenBudget`; null when the mode has none (tokenmax). */
  mode_cut: number | null;
  applied_cut: number;
  candidates?: number;
  kept?: number;
}

/** Null when the key is unset, not a positive finite number, or unreadable (off). */
export async function readPageRankBudgetRatio(engine: BrainEngine): Promise<number | null> {
  try {
    const raw = await engine.getConfig(PAGE_RANK_BUDGET_RATIO_KEY);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function resolvePageRankCut(engine: BrainEngine, callerBudget: number): Promise<PageRankCut | undefined> {
  const ratio = await readPageRankBudgetRatio(engine);
  if (ratio === null) return undefined;
  return { ratio, caller_budget: callerBudget, tokens: Math.max(1, Math.floor(ratio * callerBudget)) };
}

/** min(mode cut, ratio x caller budget) folded into the resolved knobs' tokenBudget. */
export function applyPageRankCut(knobs: ResolvedSearchKnobs, cut: PageRankCut | undefined): { knobs: ResolvedSearchKnobs; meta?: PageRankCutMeta } {
  if (!cut) return { knobs };
  const modeCut = typeof knobs.tokenBudget === 'number' && knobs.tokenBudget > 0 ? knobs.tokenBudget : null;
  const applied = modeCut === null ? cut.tokens : Math.min(modeCut, cut.tokens);
  return {
    knobs: { ...knobs, tokenBudget: applied },
    meta: { ratio: cut.ratio, caller_budget: cut.caller_budget, mode_cut: modeCut, applied_cut: applied },
  };
}
