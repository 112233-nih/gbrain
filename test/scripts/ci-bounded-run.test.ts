/**
 * scripts/ci-bounded-run.ts: a CI setup command runs in its own process group,
 * an attempt still running at its bound is ended (SIGTERM to the group, then
 * SIGKILL after the grace period), retried once, and a second failure stops
 * with a named `::error::`. Each case runs a real command that really stalls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { runBounded } from '../../scripts/ci-bounded-run.ts';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-bounded-run.ts');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === 'win32')('scripts/ci-bounded-run.ts', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-ci-bounded-')); dirs.push(dir); return dir; };

  /** A command whose attempts follow `plan` (stall, fail or ok), leaving a backgrounded grandchild on a stall. */
  function stub(dir: string, plan: string[]): string {
    writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
    const path = join(dir, 'setup');
    writeFileSync(path, `#!/bin/sh
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
case "$(sed -n "\${n}p" '${dir}/plan')" in
  stall) sleep 60 & echo $! >> '${dir}/grandchildren'; sleep 60 ;;
  fail) echo 'E: Unable to fetch some archives' >&2; exit 100 ;;
  *) echo 'done'; exit 0 ;;
esac
`);
    chmodSync(path, 0o755);
    return path;
  }

  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr, annotations: stderr.split('\n').filter(line => /^::(warning|error)::/.test(line)) };
  }

  test('a stalled attempt is ended with its whole process group, named, and the retry succeeds', async () => {
    const dir = scratch();
    const r = await cli(['--attempt-s', '1', '--retry-s', '0', '--hint', 'normally seconds', '--', stub(dir, ['stall', 'ok'])]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('done');
    expect(r.annotations).toEqual([`::warning::${join(dir, 'setup')} attempt 1 stalled: no result after 1s (normally seconds); retrying in 0s`]);
    const [grandchild] = readFileSync(join(dir, 'grandchildren'), 'utf8').trim().split('\n').map(Number);
    expect(alive(grandchild!)).toBe(false);
  }, 30_000);

  test('two stalls stop with a named error; a failure that is not a stall keeps its exit code', async () => {
    const stalls = scratch();
    const r = await cli(['--attempt-s', '1', '--retry-s', '0', '--', stub(stalls, ['stall', 'stall'])]);
    expect(r.exitCode).toBe(1);
    expect(r.annotations.at(-1)).toBe(`::error::${join(stalls, 'setup')} stalled: no result after 1s on attempt 2 of 2; giving up`);
    for (const pid of readFileSync(join(stalls, 'grandchildren'), 'utf8').trim().split('\n').map(Number)) expect(alive(pid)).toBe(false);
    const fails = scratch();
    const f = await cli(['--attempt-s', '5', '--retry-s', '0', '--', stub(fails, ['fail', 'fail'])]);
    expect(f.exitCode).toBe(1);
    expect(f.stderr).toContain('E: Unable to fetch some archives');
    expect(f.annotations[1]).toMatch(/exited 100 after \d+s on attempt 2 of 2; giving up$/);
  }, 30_000);

  test('a child that ignores SIGTERM is killed after the grace period', async () => {
    const dir = scratch();
    const path = join(dir, 'stubborn');
    writeFileSync(path, `#!/bin/sh\ntrap '' TERM\necho $$ >> '${dir}/pids'\nwhile :; do sleep 1; done\n`);
    chmodSync(path, 0o755);
    const started = Date.now();
    const code = await runBounded({ argv: [path], label: 'stubborn', attemptSeconds: 1, retrySeconds: 0, graceSeconds: 1 });
    expect(code).toBe(1);
    expect((Date.now() - started) / 1000).toBeLessThan(10);
    for (const pid of readFileSync(join(dir, 'pids'), 'utf8').trim().split('\n').map(Number)) expect(alive(pid)).toBe(false);
  }, 30_000);

  test('usage errors exit 2 without running anything', async () => {
    expect((await cli(['--', 'true'])).exitCode).toBe(2);
    expect((await cli(['--attempt-s', '5'])).exitCode).toBe(2);
  });
});

test('the Playwright install is bounded, and its step cap covers both attempts', () => {
  const doc = load(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, { 'timeout-minutes': number; steps: Array<{ run?: string; 'timeout-minutes'?: number }> }> };
  const job = doc.jobs['admin-browser']!;
  const step = job.steps.find(entry => entry.run?.includes('playwright install'))!;
  const match = /^bun scripts\/ci-bounded-run\.ts --attempt-s (\d+) --retry-s (\d+) .*-- bunx playwright install --with-deps chromium$/.exec(step.run!);
  expect(match).not.toBeNull();
  const worst = 2 * Number(match![1]) + Number(match![2]) + 2 * 10;
  expect(step['timeout-minutes']! * 60).toBeGreaterThan(worst);
  expect(job['timeout-minutes']).toBe(12);
  expect(existsSync(join(ROOT, 'scripts/ci-bounded-run.ts'))).toBe(true);
});
