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
