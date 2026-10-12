/**
 * The owner-only search-mode coaching notice: a brain running `tokenmax`
 * because the install picker chose it (no `search.mode_source: operator`)
 * sees one `search_mode_coaching` notice per brain, on the CLI or the stdio
 * MCP pipe, whichever comes first, and never over HTTP. A fresh brain, an
 * operator's tokenmax, any other mode and a muted code see nothing.
 *
 * Serial: the CLI case spawns the real binary against a PGLite brain in a
 * temp home.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { NoticeLedger, __resetProcessNoticeLedgerForTests, setNoticeMuted } from '../src/core/notice-ledger.ts';
import { __resetBehaviorNoticeForTests } from '../src/core/behavior-change-notice.ts';
import { _resetDbPlaneMergeMemoForTests } from '../src/core/config-db-merge.ts';
import {
  SEARCH_MODE_COACHING_CODE,
  __resetSearchModeCoachingForTests,
  takeSearchModeCoachingNotice,
} from '../src/core/search/mode-coaching.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

const PREFIX = `[gbrain notice ${SEARCH_MODE_COACHING_CODE} kind=coaching]`;
const QUIET = { GBRAIN_NO_ONBOARD_NUDGE: '1', GBRAIN_CHAT_FALLBACK_CHAIN: undefined };
let seq = 0;
const config = (): GBrainConfig => ({ engine: 'pglite', database_path: join(tmpdir(), `coaching-brain-${process.pid}-${++seq}`) } as GBrainConfig);
const freshHome = () => mkdtempSync(join(tmpdir(), 'gbrain-coaching-home-'));

function coachingBlocks(res: { content: Array<{ text: string }> }): string[] {
  return res.content.map(c => c.text).filter(t => t.startsWith(PREFIX));
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  __resetSearchModeCoachingForTests();
  __resetBehaviorNoticeForTests();
  __resetProcessNoticeLedgerForTests();
  _resetDbPlaneMergeMemoForTests();
  await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.mode', 'search.mode_source')`);
});

async function pickerTokenmax(): Promise<void> {
  await engine.setConfig('search.mode', 'tokenmax');
}

const stdio = (cfg: GBrainConfig) => ({ remote: true, transport: 'stdio' as const, sourceId: 'default', config: cfg });

describe('search_mode_coaching', () => {
  test('stdio: an upgraded brain on picker-chosen tokenmax sees it once, with the switch as an ask_user fix', async () => {
    await pickerTokenmax();
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      const cfg = config();
      const first = await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg));
      const blocks = coachingBlocks(first);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('gbrain config set search.mode balanced');
      expect(blocks[0]).toContain('next: ask_user');
      expect(blocks[0]).toContain('451 of 470');
      expect(blocks[0]).toContain('nightly');
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg)))).toHaveLength(0);

      // A new process (looks reset) on the same brain: the per-brain marker holds.
      __resetSearchModeCoachingForTests();
      __resetProcessNoticeLedgerForTests();
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg)))).toHaveLength(0);
      // The CLI channel shares the marker: shown on stdio means shown.
      __resetSearchModeCoachingForTests();
      expect(await takeSearchModeCoachingNotice(engine, { cfg })).toBeNull();
    });
  }, 60_000);

  test('CLI then stdio: once per brain across channels; another brain gets its own', async () => {
    await pickerTokenmax();
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      const cfg = config();
      const notice = await takeSearchModeCoachingNotice(engine, { cfg });
      expect(notice?.code).toBe(SEARCH_MODE_COACHING_CODE);
      expect(notice?.kind).toBe('coaching');
      expect(notice?.fix).toMatchObject({ ask_user: true, argv: ['gbrain', 'config', 'set', 'search.mode', 'balanced'], verify: { argv: ['gbrain', 'search', 'modes', '--json'] } });
      __resetSearchModeCoachingForTests();
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg)))).toHaveLength(0);

      __resetSearchModeCoachingForTests();
      expect(await takeSearchModeCoachingNotice(engine, { cfg: config() })).not.toBeNull();
    });
  }, 60_000);

  test('HTTP never shows it, and does not use up the owner\'s one showing', async () => {
    await pickerTokenmax();
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      const cfg = config();
      const ledger = new NoticeLedger();
      const http = { remote: true, transport: 'http' as const, sourceId: 'default', config: cfg, noticeLedger: ledger,
        auth: { token: 't', clientId: 'http-a', clientName: 'http-a', scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } as never };
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, http))).toHaveLength(0);
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, http))).toHaveLength(0);
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg)))).toHaveLength(1);
    });
  }, 60_000);

  test('nothing for an operator\'s tokenmax, for balanced, conservative, or a fresh brain with no mode', async () => {
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      const cases: Array<[string | null, string | null]> = [['tokenmax', 'operator'], ['balanced', 'auto'], ['balanced', null], ['conservative', 'auto'], [null, null]];
      for (const [mode, source] of cases) {
        await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.mode', 'search.mode_source')`);
        if (mode) await engine.setConfig('search.mode', mode);
        if (source) await engine.setConfig('search.mode_source', source);
        __resetSearchModeCoachingForTests();
        expect(await takeSearchModeCoachingNotice(engine, { cfg: config() })).toBeNull();
      }
    });
  }, 60_000);

  test('a picker tokenmax recorded as auto still gets it', async () => {
    await pickerTokenmax();
    await engine.setConfig('search.mode_source', 'auto');
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      expect(await takeSearchModeCoachingNotice(engine, { cfg: config() })).not.toBeNull();
    });
  });

  test('muted by the owner (gbrain notices mute) or on the stdio pipe (mute_notice), it stays silent and unclaimed', async () => {
    await pickerTokenmax();
    await withEnv({ GBRAIN_HOME: freshHome(), ...QUIET }, async () => {
      const cfg = config();
      setNoticeMuted(SEARCH_MODE_COACHING_CODE, true);
      expect(await takeSearchModeCoachingNotice(engine, { cfg })).toBeNull();
      setNoticeMuted(SEARCH_MODE_COACHING_CODE, false);
      setNoticeMuted(SEARCH_MODE_COACHING_CODE, true, 'stdio');
      __resetSearchModeCoachingForTests();
      expect(coachingBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, stdio(cfg)))).toHaveLength(0);
      setNoticeMuted(SEARCH_MODE_COACHING_CODE, false, 'stdio');
      __resetSearchModeCoachingForTests();
      expect(await takeSearchModeCoachingNotice(engine, { cfg })).not.toBeNull();
    });
  }, 60_000);

  test('the real CLI prints it once on stderr for a picker-tokenmax brain, and `config set search.mode` records operator', async () => {
    const home = freshHome();
    const env = { ...QUIET, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined };
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, env, timeoutMs: 180_000 });
    expect(init.exitCode).toBe(0);
    // Simulate a brain the old picker put on tokenmax (no mode_source).
    const brain = new PGLiteEngine();
    await brain.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    try {
      await brain.setConfig('search.mode', 'tokenmax');
      await brain.unsetConfig('search.mode_source');
    } finally { await brain.disconnect(); }

    const first = await runCli(['config', 'get', 'search.mode'], { home, env });
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(`[${SEARCH_MODE_COACHING_CODE}]`);
    expect(first.stderr).toContain('next: ask_user: gbrain config set search.mode balanced');
    const second = await runCli(['config', 'get', 'search.mode'], { home, env });
    expect(second.stderr).not.toContain(SEARCH_MODE_COACHING_CODE);

    const set = await runCli(['config', 'set', 'search.mode', 'balanced'], { home, env });
    expect(set.exitCode).toBe(0);
    const source = await runCli(['config', 'get', 'search.mode_source'], { home, env });
    expect(source.stdout.trim()).toBe('operator');
  }, 300_000);
});
