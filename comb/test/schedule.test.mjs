import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDays, parseTime, nextFire, buildPlist, schedulePaths } from '../schedule.mjs';

describe('parseDays', () => {
  test('daily, ranges, lists, and wrap-around', () => {
    assert.deepEqual(parseDays('daily'), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(parseDays('mon-fri'), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseDays('mon,wed,fri'), [1, 3, 5]);
    assert.deepEqual(parseDays('sat-mon'), [6, 0, 1]);
    assert.deepEqual(parseDays('Weekdays'), [1, 2, 3, 4, 5]);
  });
  test('rejects unknown tokens', () => {
    assert.throws(() => parseDays('mon,funday'), /unknown day/);
  });
});

describe('parseTime', () => {
  test('accepts HH:MM and H:MM', () => {
    assert.deepEqual(parseTime('18:00'), { hour: 18, minute: 0 });
    assert.deepEqual(parseTime('7:05'), { hour: 7, minute: 5 });
  });
  test('rejects out-of-range and non-24h forms', () => {
    assert.throws(() => parseTime('24:00'), /time/);
    assert.throws(() => parseTime('6pm'), /time/);
  });
});

describe('nextFire', () => {
  const spec = { days: [1, 2, 3, 4, 5], hour: 18, minute: 0 };
  test('same day when the time is still ahead', () => {
    const mon1700 = new Date(2026, 8, 14, 17, 0);   // 2026-09-14 is a Monday
    assert.equal(nextFire(spec, mon1700).getTime(), new Date(2026, 8, 14, 18, 0).getTime());
  });
  test('skips the weekend', () => {
    const fri1900 = new Date(2026, 8, 18, 19, 0);
    assert.equal(nextFire(spec, fri1900).getTime(), new Date(2026, 8, 21, 18, 0).getTime());
  });
});

describe('buildPlist', () => {
  const xml = buildPlist({
    label: 'com.pressw.comb', bunPath: '/Users/x/.bun/bin/bun', scriptPath: '/Users/x/dev/comb/comb/schedule.mjs',
    workspace: '/Users/x/dev/comb', days: [1, 2, 3, 4, 5], hour: 18, minute: 0, logDir: '/Users/x/dev/comb/state/logs',
  });
  test('names the agent, the program, and the run command', () => {
    assert.ok(xml.includes('<string>com.pressw.comb</string>'));
    assert.ok(xml.includes('<string>/Users/x/.bun/bin/bun</string>'));
    assert.ok(xml.includes('schedule.mjs</string>'));
    assert.ok(xml.includes('<string>run</string>'));
    assert.ok(xml.includes('<string>--workspace</string>'));
  });
  test('has one calendar entry per weekday and the right hour', () => {
    assert.equal((xml.match(/<key>Weekday<\/key>/g) ?? []).length, 5);
    assert.ok(xml.includes('<key>Hour</key>\n        <integer>18</integer>'));
  });
  test('logs to the state directory and puts bun on PATH', () => {
    assert.ok(xml.includes('/Users/x/dev/comb/state/logs/launchd.out.log'));
    assert.ok(xml.includes('/Users/x/dev/comb/state/logs/launchd.err.log'));
    assert.ok(xml.includes('/Users/x/.bun/bin:/opt/homebrew/bin'));
  });
});

describe('schedulePaths', () => {
  test('resolves under the workspace and honors COMB_LAUNCH_AGENTS_DIR', () => {
    const ws = mkdtempSync(join(tmpdir(), 'comb-sched-'));
    const p = schedulePaths(ws, { COMB_LAUNCH_AGENTS_DIR: '/tmp/agents' });
    assert.equal(p.config, join(ws, 'state', 'schedule.json'));
    assert.equal(p.lastRun, join(ws, 'state', 'last-run.json'));
    assert.equal(p.logDir, join(ws, 'state', 'logs'));
    assert.equal(p.plist, '/tmp/agents/com.pressw.comb.plist');
    assert.equal(p.label, 'com.pressw.comb');
  });
});

import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { runOnce } from '../schedule.mjs';

/** A scripted exec: matches on `${cmd} ${args[0]} ${args[1]}` prefixes, records every call. */
const fakeExec = (script) => {
  const calls = [];
  const exec = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    for (const [prefix, res] of script) if (key.startsWith(prefix)) return typeof res === 'function' ? res() : res;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
};
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const PIPE_JSON = JSON.stringify({ run: '2026-09-14', unnamedNodes: [{ id: 'N040' }, { id: 'N041' }], proposals: [], buildOrder: [], waiting: 7 });

describe('runOnce', () => {
  const ws = () => { const d = mkdtempSync(join(tmpdir(), 'comb-run-')); mkdirSync(join(d, 'state'), { recursive: true }); return d; };
  const now = new Date(2026, 8, 14, 18, 0, 0);

  test('clean tree: runs the pipeline, commits the generated files, pushes, records the run', () => {
    let statusCalls = 0;
    const { exec, calls } = fakeExec([
      ['git status --porcelain', () => ok(statusCalls++ === 0 ? '' : ' M candidates.md\n')],
      ['/bun', ok(PIPE_JSON)],
    ]);
    const w = ws();
    const rec = runOnce({ workspace: w, exec, now, bunPath: '/bun' });
    assert.equal(rec.exit, 0);
    assert.equal(rec.newNodes, 2);
    assert.equal(rec.waiting, 7);
    assert.equal(rec.committed, true);
    assert.equal(rec.pushed, true);
    assert.ok(calls.some((c) => c.startsWith('git add')));
    assert.ok(calls.some((c) => c.includes('git commit') && c.includes('scheduled run 2026-09-14 (2 new nodes, 7 waiting)')));
    assert.ok(calls.some((c) => c.startsWith('git push')));
    assert.ok(existsSync(join(w, 'state', 'last-run.json')));
    assert.equal(JSON.parse(readFileSync(join(w, 'state', 'last-run.json'), 'utf8')).committed, true);
    assert.ok(readdirSync(join(w, 'state', 'logs')).some((f) => f === 'comb-2026-09-14.log'));
  });

  test('dirty tree before the run: pipeline runs, nothing is committed, the log says dirty', () => {
    const { exec, calls } = fakeExec([['git status --porcelain', ok(' M README.md\n')], ['/bun', ok(PIPE_JSON)]]);
    const w = ws();
    const rec = runOnce({ workspace: w, exec, now, bunPath: '/bun' });
    assert.equal(rec.exit, 0);
    assert.equal(rec.committed, false);
    assert.equal(rec.pushed, false);
    assert.equal(calls.some((c) => c.startsWith('git add') || c.startsWith('git commit') || c.startsWith('git push')), false);
    assert.ok(readFileSync(join(w, 'state', 'logs', 'comb-2026-09-14.log'), 'utf8').includes('dirty'));
  });

  test('pipeline failure: exit code recorded, no commit', () => {
    const { exec, calls } = fakeExec([['/bun', { status: 1, stdout: '', stderr: 'boom' }]]);
    const rec = runOnce({ workspace: ws(), exec, now, bunPath: '/bun' });
    assert.equal(rec.exit, 1);
    assert.equal(rec.committed, false);
    assert.match(rec.error, /boom/);
    assert.equal(calls.some((c) => c.startsWith('git commit')), false);
  });

  test('commit: false skips git writes even on a clean tree', () => {
    let n = 0;
    const { exec, calls } = fakeExec([['git status --porcelain', () => ok(n++ === 0 ? '' : ' M x\n')], ['/bun', ok(PIPE_JSON)]]);
    const rec = runOnce({ workspace: ws(), exec, now, bunPath: '/bun', commit: false });
    assert.equal(rec.committed, false);
    assert.equal(calls.some((c) => c.startsWith('git commit')), false);
  });

  test('push failure is recorded, commit stands', () => {
    let n = 0;
    const { exec } = fakeExec([
      ['git status --porcelain', () => ok(n++ === 0 ? '' : ' M x\n')], ['/bun', ok(PIPE_JSON)],
      ['git push', { status: 1, stdout: '', stderr: 'rejected' }],
    ]);
    const rec = runOnce({ workspace: ws(), exec, now, bunPath: '/bun' });
    assert.equal(rec.committed, true);
    assert.equal(rec.pushed, false);
    assert.match(rec.error, /push/);
  });
});

import { setSchedule, removeSchedule, showSchedule } from '../schedule.mjs';

describe('setSchedule / removeSchedule / showSchedule', () => {
  const env = (ws) => ({ COMB_LAUNCH_AGENTS_DIR: join(ws, 'agents') });
  const ws = () => mkdtempSync(join(tmpdir(), 'comb-set-'));

  test('set writes the config and plist and (re)loads the agent', () => {
    const w = ws(); const { exec, calls } = fakeExec([]);
    const spec = setSchedule({ workspace: w, days: 'mon-fri', at: '18:00', exec, env: env(w), platform: 'darwin', bunPath: '/bun', uid: 501 });
    assert.deepEqual(spec.days, [1, 2, 3, 4, 5]);
    assert.equal(spec.hour, 18);
    assert.ok(existsSync(join(w, 'state', 'schedule.json')));
    assert.ok(existsSync(join(w, 'agents', 'com.pressw.comb.plist')));
    const lc = calls.filter((c) => c.startsWith('launchctl'));
    assert.equal(lc.length, 2);
    assert.ok(lc[0].startsWith('launchctl bootout gui/501/com.pressw.comb'));
    assert.ok(lc[1].startsWith('launchctl bootstrap gui/501'));
  });

  test('set refuses off macOS', () => {
    const w = ws(); const { exec } = fakeExec([]);
    assert.throws(() => setSchedule({ workspace: w, days: 'daily', at: '07:00', exec, env: env(w), platform: 'linux' }), /launchd/);
  });

  test('remove unloads the agent and deletes both files', () => {
    const w = ws(); const { exec, calls } = fakeExec([]);
    setSchedule({ workspace: w, days: 'daily', at: '07:00', exec, env: env(w), platform: 'darwin', bunPath: '/bun', uid: 501 });
    removeSchedule({ workspace: w, exec, env: env(w), uid: 501 });
    assert.equal(existsSync(join(w, 'state', 'schedule.json')), false);
    assert.equal(existsSync(join(w, 'agents', 'com.pressw.comb.plist')), false);
    assert.ok(calls.filter((c) => c.startsWith('launchctl bootout')).length >= 2);
  });

  test('show reports no schedule, then the schedule with the next run', () => {
    const w = ws(); const { exec } = fakeExec([]);
    assert.match(showSchedule({ workspace: w, env: env(w) }), /no schedule/);
    setSchedule({ workspace: w, days: 'mon-fri', at: '18:00', exec, env: env(w), platform: 'darwin', bunPath: '/bun', uid: 501 });
    const s = showSchedule({ workspace: w, env: env(w), now: new Date(2026, 8, 14, 17, 0) });
    assert.match(s, /Mon to Fri at 18:00/);
    assert.match(s, /Next run: 2026-09-14 18:00/);
    assert.match(s, /Last run: never/);
  });
});
