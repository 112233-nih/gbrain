/**
 * #5429: `divergenceSafePull`'s documented contract is "never auto-stashes",
 * but the pull it ran honoured a repository or user `rebase.autoStash=true`,
 * so an edit made between the dirty check and the pull was stashed and
 * replayed onto the rebased tree. The pull now carries `--no-autostash` in
 * every mode.
 *
 * Local file transport is enabled via GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 (the
 * durable SSRF flags refuse it otherwise); the spy sits on node:child_process,
 * which the launch seam looks up at call time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { divergenceSafePull } from '../src/core/git-remote.ts';

const { execFileSync } = childProcess;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

let root: string;

/** A bare origin + a working clone with one commit on `main`. */
function makePair(): { bare: string; work: string } {
  const bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const work = secondClone(bare, 'work-');
  writeFileSync(join(work, 'README.md'), 'init\n');
  writeFileSync(join(work, 'page.md'), 'v1\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  return { bare, work };
}

function secondClone(bare: string, prefix = 'work2-'): string {
  const work = mkdtempSync(join(root, prefix));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  return work;
}

function commitFile(work: string, name: string, body: string, message: string): string {
  writeFileSync(join(work, name), body);
  git(work, 'add', name);
  git(work, 'commit', '-qm', message);
  return git(work, 'rev-parse', 'HEAD');
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gd-5429-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('--no-autostash (#5429, bug fix)', () => {
  test('the pull git runs carries --no-autostash', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    commitFile(other, 'remote.txt', 'r\n', 'remote');
    git(other, 'push', '-q', 'origin', 'main');
    const pulls: string[][] = [];
    const spy = spyOn(childProcess, 'execFileSync');
    try {
      divergenceSafePull(work, 'main');
    } finally {
      for (const call of spy.mock.calls) {
        const args = call[1] as string[] | undefined;
        if (call[0] === 'git' && Array.isArray(args) && args.includes('pull')) pulls.push(args);
      }
      spy.mockRestore();
    }
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.slice(pulls[0]!.indexOf('pull'))).toContain('--no-autostash');
    expect(pulls[0]!.slice(pulls[0]!.indexOf('pull'))).toContain('--rebase');
  });

  test('git itself: with rebase.autoStash=true the old argv stashes and replays a dirty edit; --no-autostash refuses and leaves the stash list empty', () => {
    for (const noAutostash of [false, true]) {
      const { bare, work } = makePair();
      const other = secondClone(bare);
      commitFile(other, 'remote.txt', 'r\n', 'remote');
      git(other, 'push', '-q', 'origin', 'main');
      git(work, 'config', 'rebase.autoStash', 'true');
      writeFileSync(join(work, 'README.md'), 'edited between the dirty check and the pull\n');
      git(work, 'fetch', '-q', 'origin', 'main');
      let exit = 0;
      try { git(work, 'pull', '--rebase', ...(noAutostash ? ['--no-autostash'] : []), 'origin', 'main'); }
      catch (error) { exit = (error as { status: number }).status; }
      expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('edited between the dirty check and the pull\n');
      expect(git(work, 'stash', 'list')).toBe('');
      if (noAutostash) {
        expect(exit).not.toBe(0);
        expect(existsSync(join(work, 'remote.txt'))).toBe(false);
      } else {
        // The hole: git stashed the edit, rebased and replayed it, so the pull "succeeded" on a dirty tree.
        expect(exit).toBe(0);
        expect(existsSync(join(work, 'remote.txt'))).toBe(true);
      }
    }
  });

  test('a dirty tree with rebase.autoStash=true is skipped_dirty, nothing stashed', () => {
    const { work } = makePair();
    git(work, 'config', 'rebase.autoStash', 'true');
    writeFileSync(join(work, 'README.md'), 'dirty\n');
    expect(divergenceSafePull(work, 'main')).toEqual({ status: 'skipped_dirty' });
    expect(git(work, 'stash', 'list')).toBe('');
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('dirty\n');
  });
});
