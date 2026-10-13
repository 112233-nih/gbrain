#!/usr/bin/env bun
/**
 * CI's `bun install`, bounded and retried once.
 *
 * Bun normally installs this repository in 4-14 s. On .195's master Test run
 * one macos-26-intel runner's install sat for 805 s, a registry or network stall,
 * and the job's 15-minute budget cancelled it a minute short of finishing, with
 * nothing naming the cause. This wrapper ends a stalled attempt after
 * GBRAIN_CI_INSTALL_ATTEMPT_S, retries once after a short pause, and on a
 * second failure stops with a named `::error::`. Anything else it leaves as Bun
 * printed it: the output is inherited, and a failure that is not a stall (a
 * frozen-lockfile mismatch, an unreachable registry) is retried once and then
 * reported with Bun's exit code. It uses no dependency, because it runs before
 * they are installed, and spawns asynchronously, so it behaves the same on
 * Linux, macOS and Windows.
 *
 * Usage: bun scripts/ci-bun-install.ts [bun install flags...]
 * Environment (defaults are the CI values; the test overrides them):
 *   GBRAIN_CI_INSTALL_ATTEMPT_S      per-attempt bound in seconds, default 180
 *   GBRAIN_CI_INSTALL_RETRY_SLEEP_S  pause before the retry in seconds, default 10
 *   GBRAIN_CI_INSTALL_BUN            the Bun executable to run, default this one
 */
const ATTEMPTS = 2;
const flags = process.argv.slice(2);
const attemptSeconds = Number(process.env.GBRAIN_CI_INSTALL_ATTEMPT_S ?? 180);
const retrySeconds = Number(process.env.GBRAIN_CI_INSTALL_RETRY_SLEEP_S ?? 10);
const bun = process.env.GBRAIN_CI_INSTALL_BUN || process.execPath;
const command = ['bun', 'install', ...flags].join(' ');

for (let attempt = 1; ; attempt++) {
  const started = Date.now();
  const child = Bun.spawn([bun, 'install', ...flags], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  let stalled = false;
  const timer = setTimeout(() => { stalled = true; child.kill('SIGKILL'); }, attemptSeconds * 1000);
  const code = await child.exited;
  clearTimeout(timer);
  if (code === 0 && !stalled) process.exit(0);
  const why = stalled
    ? `stalled: no result after ${attemptSeconds}s (a registry or network stall; the install normally takes seconds)`
    : `exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`;
  if (attempt >= ATTEMPTS) {
    console.error(`::error::${command} ${why} on attempt ${attempt} of ${ATTEMPTS}; giving up`);
    process.exit(1);
  }
  console.error(`::warning::${command} attempt ${attempt} ${why}; retrying in ${retrySeconds}s`);
  await Bun.sleep(retrySeconds * 1000);
}
