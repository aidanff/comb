#!/usr/bin/env bun
/**
 * comb on a schedule. Installs a macOS launchd agent that runs the deterministic pipeline
 * (`comb.mjs`), commits the generated files, and pushes. No model runs unattended; new nodes
 * wait unnamed until the next `/comb`.
 *
 * The `comb` skill turns a sentence ("every weekday at 6pm") into the structured flags below.
 * Nothing here parses English.
 *
 * Usage:
 *   bun comb/schedule.mjs set --days <daily|mon-fri|mon,wed,fri> --at HH:MM [--until YYYY-MM-DD] [--workspace DIR]
 *   bun comb/schedule.mjs show   [--workspace DIR]
 *   bun comb/schedule.mjs remove [--workspace DIR]
 *   bun comb/schedule.mjs run    [--workspace DIR] [--no-commit]
 *
 * Per-machine state lives in state/ (gitignored): schedule.json, last-run.json, logs/.
 *
 * `--until` gives the schedule a last day (inclusive). launchd has no end date, so the job
 * enforces it: after the run on the last day it removes its own agent, and a stale agent
 * that fires later removes itself without running the pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const LABEL = 'com.pressw.comb';
export const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 'daily' | 'weekdays' | 'mon-fri' | 'mon,wed,fri' | 'sat-mon' (wraps) -> sorted-by-appearance day indexes. */
export function parseDays(spec) {
  const s = String(spec ?? '').trim().toLowerCase();
  if (s === 'daily' || s === 'everyday' || s === 'every day') return [0, 1, 2, 3, 4, 5, 6];
  if (s === 'weekdays') return [1, 2, 3, 4, 5];
  const out = [];
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((p) => p.trim().slice(0, 3));
    if (!(a in DAY_INDEX)) throw new Error(`unknown day "${a}"`);
    if (b === undefined) { out.push(DAY_INDEX[a]); continue; }
    if (!(b in DAY_INDEX)) throw new Error(`unknown day "${b}"`);
    let d = DAY_INDEX[a];
    out.push(d);
    while (d !== DAY_INDEX[b]) { d = (d + 1) % 7; out.push(d); }
  }
  return [...new Set(out)];
}

/** 'HH:MM' or 'H:MM', 24-hour. */
export function parseTime(spec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`time must be HH:MM in 24-hour form, got "${spec}"`);
  const hour = Number(m[1]); const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time out of range: "${spec}"`);
  return { hour, minute };
}

/** 'YYYY-MM-DD', a real calendar date. Returned as the same string. */
export function parseUntil(spec) {
  const str = String(spec ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) throw new Error(`until must be YYYY-MM-DD, got "${spec}"`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (localDate(d) !== str) throw new Error(`until is not a real date: "${spec}"`);
  return str;
}

/** The next Date at or after `now` that matches the spec, or null past `until` (inclusive last day). */
export function nextFire({ days, hour, minute, until }, now = new Date()) {
  for (let add = 0; add < 8; add++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, hour, minute, 0, 0);
    if (days.includes(d.getDay()) && d.getTime() > now.getTime()) return until && localDate(d) > until ? null : d;
  }
  return null;
}

export const describeDays = (days) => {
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '0,1,2,3,4,5,6') return 'daily';
  if (s === '1,2,3,4,5') return 'Mon to Fri';
  return days.map((d) => DAY_NAMES[d]).join(', ');
};

// bun's own directory first, then the usual places git and the gh credential helper live.
const PATH_ENV = (bunPath) => `${dirname(bunPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

/** A launchd property list that runs `schedule.mjs run` on the given days and time. */
export function buildPlist({ label, bunPath, scriptPath, workspace, days, hour, minute, logDir, home = homedir() }) {
  const entries = days.map((d) => `      <dict>
        <key>Weekday</key>
        <integer>${d}</integer>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
      </dict>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${bunPath}</string>
      <string>${scriptPath}</string>
      <string>run</string>
      <string>--workspace</string>
      <string>${workspace}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workspace}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH_ENV(bunPath)}</string>
      <key>HOME</key>
      <string>${home}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <array>
${entries}
    </array>
    <key>StandardOutPath</key>
    <string>${logDir}/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/launchd.err.log</string>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;
}

export function schedulePaths(workspace, env = process.env) {
  const plistDir = env.COMB_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
  return {
    config: join(workspace, 'state', 'schedule.json'),
    lastRun: join(workspace, 'state', 'last-run.json'),
    logDir: join(workspace, 'state', 'logs'),
    plistDir,
    plist: join(plistDir, `${LABEL}.plist`),
    label: LABEL,
  };
}

// ---------------------------------------------------------------------------
// The job body
// ---------------------------------------------------------------------------

/** Files a run regenerates. Only these are ever committed by the job. */
export const GENERATED = ['comb/ontology.json', 'candidates.md', 'comb/.work/skeletons.jsonl'];

/** Real exec: synchronous, captured output, never throws. */
export const realExec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : (r.stderr ?? '') };
};

/**
 * One scheduled run: pipeline, then commit and push the generated files if the tree was
 * clean before the run. Writes state/last-run.json and appends to state/logs/.
 */
export function runOnce({ workspace, exec = realExec, now = new Date(), commit = true, bunPath = process.execPath, env = process.env, uid = process.getuid?.() ?? 501 }) {
  const P = schedulePaths(workspace, env);
  mkdirSync(P.logDir, { recursive: true });
  const git = (...args) => exec('git', args, { cwd: workspace });
  const rec = { started: now.toISOString(), finished: null, exit: null, newNodes: 0, waiting: 0, committed: false, pushed: false, scheduleRemoved: false, error: null };
  const notes = [];
  const spec = readJson(P.config);
  const finish = () => {
    rec.finished = new Date().toISOString();
    writeFileSync(P.lastRun, `${JSON.stringify(rec, null, 2)}\n`);
    const line = `${rec.started} exit=${rec.exit} new=${rec.newNodes} waiting=${rec.waiting} committed=${rec.committed} pushed=${rec.pushed}${rec.scheduleRemoved ? ' scheduleRemoved=true' : ''}${rec.error ? ` error="${rec.error}"` : ''}${notes.length ? ` notes="${notes.join('; ')}"` : ''}\n`;
    appendFileSync(join(P.logDir, `comb-${localDate(now)}.log`), line);
    return rec;
  };

  // A stale agent firing after the last day: clean up, run nothing.
  if (spec?.until && localDate(now) > spec.until) {
    removeSchedule({ workspace, exec, env, uid });
    rec.exit = 0; rec.scheduleRemoved = true;
    notes.push(`schedule ended ${spec.until}; agent removed without a run`);
    return finish();
  }

  const cleanBefore = git('status', '--porcelain').stdout.trim() === '';
  if (!cleanBefore) notes.push('tree was dirty before the run; commit and push skipped');

  const run = exec(bunPath, [join(workspace, 'comb', 'comb.mjs'), '--workspace', workspace], { cwd: workspace });
  rec.exit = run.status;
  if (run.status !== 0) rec.error = `pipeline exited ${run.status}: ${run.stderr.trim().slice(-500)}`;
  else {
    try {
      const out = JSON.parse(run.stdout);
      rec.newNodes = out.unnamedNodes?.length ?? 0;
      rec.waiting = out.waiting ?? 0;
    } catch { notes.push('pipeline output was not JSON'); }
  }

  if (rec.exit === 0 && cleanBefore && commit) {
    const dirtyAfter = git('status', '--porcelain').stdout.trim() !== '';
    if (!dirtyAfter) notes.push('no changes to commit');
    else {
      git('add', '--', ...GENERATED);
      const msg = `comb: scheduled run ${localDate(now)} (${rec.newNodes} new nodes, ${rec.waiting} waiting)`;
      const c = git('commit', '-q', '-m', msg);
      rec.committed = c.status === 0;
      if (!rec.committed) rec.error = `commit failed: ${c.stderr.trim()}`;
      else {
        const p = git('push', '-q');
        rec.pushed = p.status === 0;
        if (!rec.pushed) rec.error = `push failed: ${p.stderr.trim()}`;
      }
    }
  }

  // The last scheduled run has happened: remove the agent so it never fires again.
  if (spec?.until && nextFire(spec, now) === null) {
    removeSchedule({ workspace, exec, env, uid });
    rec.scheduleRemoved = true;
    notes.push(`schedule ended ${spec.until}; agent removed after the last run`);
  }

  return finish();
}

// ---------------------------------------------------------------------------
// Install, inspect, remove
// ---------------------------------------------------------------------------

const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) => `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * Write the config and plist, then (re)load the agent. `days` and `at` are the structured
 * flags the skill produced; nothing here parses a sentence.
 */
export function setSchedule({ workspace, days, at, until, exec = realExec, env = process.env, platform = process.platform, bunPath = process.execPath, uid = process.getuid?.() ?? 501, now = new Date() }) {
  if (platform !== 'darwin') throw new Error('scheduling uses launchd and works on macOS only; cron support is not built');
  const spec = { days: parseDays(days), ...parseTime(at), label: LABEL, set: now.toISOString() };
  if (until !== undefined) {
    spec.until = parseUntil(until);
    if (spec.until < localDate(now)) throw new Error(`until ${spec.until} is already past`);
  }
  const P = schedulePaths(workspace, env);
  mkdirSync(dirname(P.config), { recursive: true });
  mkdirSync(P.logDir, { recursive: true });
  mkdirSync(P.plistDir, { recursive: true });
  writeFileSync(P.config, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(P.plist, buildPlist({
    label: LABEL, bunPath, scriptPath: fileURLToPath(import.meta.url), workspace: resolve(workspace),
    days: spec.days, hour: spec.hour, minute: spec.minute, logDir: P.logDir,
  }));
  exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);          // ignored when nothing is loaded
  const r = exec('launchctl', ['bootstrap', `gui/${uid}`, P.plist]);
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  return spec;
}

export function removeSchedule({ workspace, exec = realExec, env = process.env, uid = process.getuid?.() ?? 501 }) {
  const P = schedulePaths(workspace, env);
  exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  rmSync(P.plist, { force: true });
  rmSync(P.config, { force: true });
}

export function showSchedule({ workspace, env = process.env, now = new Date() }) {
  const P = schedulePaths(workspace, env);
  const spec = readJson(P.config);
  const last = readJson(P.lastRun);
  const lines = [];
  if (!spec) lines.push('no schedule is set');
  else {
    const next = nextFire(spec, now);
    lines.push(`Schedule: ${describeDays(spec.days)} at ${pad2(spec.hour)}:${pad2(spec.minute)}`);
    if (spec.until) lines.push(`Ends: ${spec.until} (the agent removes itself after that day's run)`);
    lines.push(`Agent: ${P.plist}${existsSync(P.plist) ? '' : ' (plist missing; run set again)'}`);
    lines.push(`Next run: ${next ? fmtLocal(next) : 'none'}`);
  }
  if (!last) lines.push('Last run: never');
  else {
    lines.push(`Last run: ${last.started} exit=${last.exit} new nodes=${last.newNodes} waiting=${last.waiting} committed=${last.committed} pushed=${last.pushed}`);
    if (last.error) lines.push(`Last error: ${last.error}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-commit') a.noCommit = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
    else a.positional.push(k);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const workspace = resolve(a.workspace ?? process.env.COMB_WORKSPACE ?? process.cwd());
  const [cmd] = a.positional;
  try {
    switch (cmd) {
      case 'set': {
        if (!a.days || !a.at) throw new Error('usage: set --days <daily|mon-fri|mon,wed,fri> --at HH:MM [--until YYYY-MM-DD]');
        const spec = setSchedule({ workspace, days: a.days, at: a.at, until: a.until });
        console.log(`comb runs ${describeDays(spec.days)} at ${pad2(spec.hour)}:${pad2(spec.minute)}${spec.until ? ` until ${spec.until}` : ''}.`);
        console.log(showSchedule({ workspace }));
        break;
      }
      case 'show': console.log(showSchedule({ workspace })); break;
      case 'remove': removeSchedule({ workspace }); console.log('schedule removed'); break;
      case 'run': {
        const rec = runOnce({ workspace, commit: !a.noCommit });
        console.log(JSON.stringify(rec, null, 2));
        process.exit(rec.exit === 0 ? 0 : 1);
        break;
      }
      default:
        console.error('usage: schedule.mjs <set|show|remove|run> [--workspace DIR] [--days D] [--at HH:MM] [--until YYYY-MM-DD] [--no-commit]');
        process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
