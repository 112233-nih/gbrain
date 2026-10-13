#!/usr/bin/env bun
/**
 * Run one CI setup command with a per-attempt bound and one retry.
 *
 * A network-bound setup step (`bun install`, Playwright's browser and OS
 * dependency install) normally takes seconds, and on a bad registry, mirror or
 * CDN connection it can crawl until the job timeout cancels it, with nothing
 * naming the cause (.195's 805 s `bun install` on darwin-x64; .204's 12-minute
 * `playwright install --with-deps chromium` on admin-browser). This runs the
 * command in its own process group, ends an attempt still running at its
 * bound (SIGTERM to the group, so `sudo apt-get` under it is relayed the
 * signal, then SIGKILL after a grace period), retries once after a pause, and
 * on a second failure stops with a named `::error::`. A failure that is not a
 * stall is retried once too and then reported with the command's exit code;
 * its output is inherited unchanged. No dependency: it runs before they are
 * installed.
 *
 * Usage: bun scripts/ci-bounded-run.ts --attempt-s <n> [--retry-s <n>] [--hint <text>] -- <command> [args...]
 */
import { spawn } from 'node:child_process';

export interface BoundedRun {
  argv: string[];
  /** The command as the annotations name it. */
  label: string;
  attemptSeconds: number;
  retrySeconds: number;
  /** Why a stall is unusual for this command, appended to the stall line. */
  hint?: string;
  graceSeconds?: number;
}

const ATTEMPTS = 2;

function attempt(run: BoundedRun): Promise<{ code: number | null; stalled: boolean }> {
  const grouped = process.platform !== 'win32';
  const child = spawn(run.argv[0]!, run.argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], detached: grouped });
  const signal = (name: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* the group is gone */ }
  };
  let stalled = false, kill: ReturnType<typeof setTimeout> | undefined;
  const bound = setTimeout(() => {
    stalled = true;
    signal('SIGTERM');
    kill = setTimeout(() => signal('SIGKILL'), (run.graceSeconds ?? 10) * 1000);
  }, run.attemptSeconds * 1000);
  return new Promise(resolve => {
    child.once('error', () => { clearTimeout(bound); clearTimeout(kill); resolve({ code: 127, stalled }); });
    child.once('exit', code => { clearTimeout(bound); clearTimeout(kill); if (stalled) signal('SIGKILL'); resolve({ code, stalled }); });
  });
}

export async function runBounded(run: BoundedRun): Promise<number> {
  for (let n = 1; ; n++) {
    const started = Date.now();
    const { code, stalled } = await attempt(run);
    if (code === 0 && !stalled) return 0;
    const why = stalled
      ? `stalled: no result after ${run.attemptSeconds}s${run.hint ? ` (${run.hint})` : ''}`
      : `exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`;
    if (n >= ATTEMPTS) {
      console.error(`::error::${run.label} ${why} on attempt ${n} of ${ATTEMPTS}; giving up`);
      return 1;
    }
    console.error(`::warning::${run.label} attempt ${n} ${why}; retrying in ${run.retrySeconds}s`);
    await Bun.sleep(run.retrySeconds * 1000);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2), split = args.indexOf('--');
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 && i < split ? args[i + 1] : undefined; };
  const argv = split >= 0 ? args.slice(split + 1) : [];
  const attemptSeconds = Number(option('--attempt-s'));
  if (!argv.length || !(attemptSeconds > 0)) {
    console.error('usage: bun scripts/ci-bounded-run.ts --attempt-s <n> [--retry-s <n>] [--hint <text>] -- <command> [args...]');
    process.exit(2);
  }
  process.exit(await runBounded({ argv, label: argv.join(' '), attemptSeconds, retrySeconds: Number(option('--retry-s') ?? 10), hint: option('--hint') }));
}
