/**
 * W5 — `search.page_rank_budget_ratio`: with `return_unit: "page"` and a
 * caller budget, ranking cuts its hits to min(mode cut, ratio x budget)
 * instead of the mode's `search.tokenBudget` alone.
 *
 * Protects: the key unset (or invalid) leaves query/search/recall exactly as
 * before; on, the cut is ratio x caller budget under tokenmax (no mode cut)
 * and the smaller of the two under conservative; a page call without a
 * budget and a chunk-unit call never engage it; `page_rank_cut` reports
 * ratio, caller budget, mode cut, applied cut, candidates and kept.
 * Forced probe: with the key off, two caller budgets give the same ranking
 * cut (the old path ignored the caller); on, the cut follows the budget.
 * Seams: query/search run keyword-only (embeddings off), so no model call;
 * recall's hybrid page arm runs on a fixture embed transport (the keyword-only
 * recall arm is a direct keyword read with no ranking cut to replace).
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { applyPageRankCut, PAGE_RANK_BUDGET_RATIO_KEY, resolvePageRankCut } from '../../src/core/search/page-rank-cut.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { resolveSearchMode } from '../../src/core/search/mode.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const QUERY = 'garden tomato harvest';

describe('page rank cut: min() with the mode cut', () => {
  test('applyPageRankCut takes the smaller cut and reports both', () => {
    const conservative = resolveSearchMode({ mode: 'conservative' });
    const tokenmax = resolveSearchMode({ mode: 'tokenmax' });
    expect(conservative.tokenBudget).toBe(4000);
    expect(tokenmax.tokenBudget).toBeUndefined();
    expect(applyPageRankCut(conservative, undefined)).toEqual({ knobs: conservative });
    const cut = { ratio: 0.5, caller_budget: 8100, tokens: 4050 };
    expect(applyPageRankCut(tokenmax, cut).knobs.tokenBudget).toBe(4050);
    expect(applyPageRankCut(tokenmax, cut).meta).toEqual({ ratio: 0.5, caller_budget: 8100, mode_cut: null, applied_cut: 4050 });
    expect(applyPageRankCut(conservative, cut).meta).toEqual({ ratio: 0.5, caller_budget: 8100, mode_cut: 4000, applied_cut: 4000 });
    expect(applyPageRankCut(conservative, { ratio: 0.5, caller_budget: 2000, tokens: 1000 }).knobs.tokenBudget).toBe(1000);
  });

});

for (const backend of testBackends()) {
  describe(`${backend}: page rank cut through query, search and recall`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    let meta: Record<string, any> | null = null;
    let embeddingDisabled = true;
    const ctx = () => ({ engine, config: { engine: backend, embedding_disabled: embeddingDisabled }, remote: false, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      emitResponseMeta: (k: string, v: unknown) => { if (k === 'retrieval') meta = v as Record<string, any>; } }) as unknown as OperationContext;
    const call = async (name: string, params: Record<string, unknown>) => {
      meta = null;
      const out = await op(name).handler(ctx(), { expand: false, ...params });
      return { out: out as any, meta: meta as Record<string, any> | null };
    };
    const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);
    const ratio = async (value: string | null) => {
      if (value === null) await engine.unsetConfig(PAGE_RANK_BUDGET_RATIO_KEY);
      else await engine.setConfig(PAGE_RANK_BUDGET_RATIO_KEY, value);
    };

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      }
      for (let i = 0; i < 40; i++) {
        await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: `notes/garden-${i}`,
          content: `---\ntype: note\ntitle: Garden note ${i}\n---\nThe garden tomato harvest note ${i}. ` + 'We planted tomatoes and basil in the garden beds this season. '.repeat(20) } });
      }
    }, 180_000);

    afterAll(async () => {
      resetGateway();
      await disposePersistenceConsumer(engine);
      await close();
    });

    test('an unset, non-numeric, zero or negative ratio is off', async () => {
      await ratio(null);
      expect(await resolvePageRankCut(engine, 8100)).toBeUndefined();
      for (const bad of ['', 'half', '0', '-0.5', 'Infinity']) {
        await ratio(bad);
        expect(await resolvePageRankCut(engine, 8100)).toBeUndefined();
      }
      await ratio('0.5');
      expect(await resolvePageRankCut(engine, 8100)).toEqual({ ratio: 0.5, caller_budget: 8100, tokens: 4050 });
    });

    test('off: the key unset or invalid changes nothing, and the caller budget never reaches ranking (forced probe)', async () => {
      await ratio(null);
      const base = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'conservative' });
      expect(base.meta!.page_rank_cut).toBeUndefined();
      expect(base.meta!.token_budget.budget).toBe(4000);
      const small = await call('query', { query: QUERY, return_unit: 'page', token_budget: 2000, mode: 'conservative' });
      expect(small.meta!.token_budget.budget).toBe(4000);
      const tm = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'tokenmax' });
      expect(tm.meta!.token_budget).toBeUndefined();
      expect(tm.meta!.page_rank_cut).toBeUndefined();
      await ratio('not-a-number');
      const invalid = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'conservative' });
      expect(slugs(invalid.out)).toEqual(slugs(base.out));
      expect(invalid.meta!.page_rank_cut).toBeUndefined();
      expect(invalid.meta!.token_budget).toEqual(base.meta!.token_budget);
    });

    test('on: tokenmax cuts to ratio x caller budget and reports candidates and kept', async () => {
      await ratio(null);
      const off = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'tokenmax' });
      await ratio('0.5');
      const on = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'tokenmax' });
      const cut = on.meta!.page_rank_cut;
      expect(cut).toMatchObject({ ratio: 0.5, caller_budget: 8100, mode_cut: null, applied_cut: 4050 });
      expect(on.meta!.token_budget.budget).toBe(4050);
      expect(cut.kept).toBe(on.meta!.token_budget.kept);
      expect(cut.candidates).toBeGreaterThan(cut.kept);
      expect(on.out.length).toBeLessThan(off.out.length);
      expect(slugs(on.out)).toEqual(slugs(off.out).slice(0, on.out.length));
    });

    test('on: conservative keeps the smaller of its own cut and ratio x budget', async () => {
      await ratio('0.5');
      const big = await call('query', { query: QUERY, return_unit: 'page', token_budget: 8100, mode: 'conservative' });
      expect(big.meta!.page_rank_cut).toMatchObject({ mode_cut: 4000, applied_cut: 4000 });
      const small = await call('query', { query: QUERY, return_unit: 'page', token_budget: 2000, mode: 'conservative' });
      expect(small.meta!.page_rank_cut).toMatchObject({ caller_budget: 2000, mode_cut: 4000, applied_cut: 1000 });
      expect(small.meta!.token_budget.budget).toBe(1000);
    });

    test('on: no caller budget, or the chunk unit, is unchanged', async () => {
      await ratio(null);
      const pageOff = await call('query', { query: QUERY, return_unit: 'page', mode: 'conservative' });
      const chunkOff = await call('query', { query: QUERY, token_budget: 3000, mode: 'conservative' });
      await ratio('0.5');
      const pageOn = await call('query', { query: QUERY, return_unit: 'page', mode: 'conservative' });
      const chunkOn = await call('query', { query: QUERY, token_budget: 3000, mode: 'conservative' });
      expect(pageOn.meta!.page_rank_cut).toBeUndefined();
      expect(chunkOn.meta!.page_rank_cut).toBeUndefined();
      expect(slugs(pageOn.out)).toEqual(slugs(pageOff.out));
      expect(slugs(chunkOn.out)).toEqual(slugs(chunkOff.out));
      expect(chunkOn.meta!.token_budget).toEqual(chunkOff.meta!.token_budget);
    });

    test('on: search and recall page paths take the same cut', async () => {
      await ratio('0.5');
      const s = await call('search', { query: QUERY, return_unit: 'page', token_budget: 2000, mode: 'conservative' });
      expect(s.meta!.page_rank_cut).toMatchObject({ caller_budget: 2000, mode_cut: 4000, applied_cut: 1000 });
      embeddingDisabled = false;
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'fixture-key' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) =>
        ({ embeddings: values.map(() => [1, ...Array(LEGACY_EMBEDDING_CONFIG.embedding_dimensions - 1).fill(0)]) })) as never);
      try {
        const r = await call('recall', { query: QUERY, return_unit: 'page', budget_tokens: 2000 });
        expect(r.out.search_degraded).toBeUndefined();
        expect(r.out.page_rank_cut).toMatchObject({ ratio: 0.5, caller_budget: 2000, applied_cut: 1000 });
        await ratio(null);
        const rOff = await call('recall', { query: QUERY, return_unit: 'page', budget_tokens: 2000 });
        expect(rOff.out.page_rank_cut).toBeUndefined();
      } finally {
        embeddingDisabled = true;
        __setEmbedTransportForTests(null);
        resetGateway();
      }
    });
  });
}
