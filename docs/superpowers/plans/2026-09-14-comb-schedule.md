# comb Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `/comb` user describe a schedule in words and have a launchd agent run the deterministic pipeline, commit, and push on that schedule.

**Architecture:** One new module, `comb/schedule.mjs`, with pure functions (`parseDays`, `parseTime`, `nextFire`, `buildPlist`) and three effectful functions that take an injected `exec` (`runOnce`, `setSchedule`, `removeSchedule`). A CLI wraps them. The skill gains a "Scheduling" section that maps sentences to flags.

**Tech Stack:** Bun, `node:test`, launchd. No dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-comb-schedule-design.md`

## Global Constraints

- The scheduled job runs no model. It runs `bun comb/comb.mjs`, then git.
- `set` refuses when `process.platform !== 'darwin'`.
- Tests never call `launchctl` or `git`; they pass a fake `exec`.
- `exec(cmd, args, opts)` returns `{ status, stdout, stderr }` synchronously.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Pure functions

**Files:** Create `comb/schedule.mjs`; Test `comb/test/schedule.test.mjs`

**Produces:** `DAY_INDEX`, `parseDays(spec) -> number[]`, `parseTime('HH:MM') -> {hour, minute}`, `nextFire({days, hour, minute}, now) -> Date`, `buildPlist({label, bunPath, scriptPath, workspace, days, hour, minute, logDir}) -> string`, `schedulePaths(workspace, env) -> {config, lastRun, logDir, plistDir, plist, label}`.

- [ ] Write tests: `parseDays('daily')` is `[0..6]`; `'mon-fri'` is `[1..5]`; `'mon,wed,fri'` is `[1,3,5]`; `'sat-mon'` wraps to `[6,0,1]`; unknown token throws `/unknown day/`. `parseTime('18:00')` is `{18,0}`; `'7:05'` is `{7,5}`; `'24:00'` and `'6pm'` throw. `nextFire` from a Monday 17:00 with mon-fri 18:00 is the same day 18:00; from Friday 19:00 it is Monday 18:00. `buildPlist` output contains `<string>com.pressw.comb</string>`, the bun path, `schedule.mjs`, `run`, `--workspace`, five `<key>Weekday</key>` entries for mon-fri, `<integer>18</integer>`, the log paths, and `~/.bun/bin` in PATH. `schedulePaths` honors `COMB_LAUNCH_AGENTS_DIR`.
- [ ] Run, expect module-not-found.
- [ ] Implement.
- [ ] Run, expect pass. Commit: "Add schedule pure functions: days, time, next fire, plist".

### Task 2: `runOnce`

**Files:** Modify `comb/schedule.mjs`; Test `comb/test/schedule.test.mjs`

**Produces:** `runOnce({ workspace, exec, now, commit = true, bunPath })` returns the last-run record `{ started, finished, exit, newNodes, waiting, committed, pushed, error }`, writes `state/last-run.json`, appends to `state/logs/comb-YYYY-MM-DD.log`.

- [ ] Write tests with a fake `exec` that scripts responses by command prefix and records calls: clean tree, pipeline ok, dirty after → `git add`, `git commit`, `git push` called, `committed: true`, `pushed: true`, `newNodes` parsed from the pipeline JSON; dirty tree before → no git write calls, `committed: false`, log contains `dirty`; pipeline exit 1 → `exit: 1`, no commit; `commit: false` → no commit; push exit 1 → `pushed: false`, `error` mentions push. Assert `last-run.json` exists in the temp workspace.
- [ ] Run, expect fail. Implement. Run, expect pass. Commit: "Add runOnce: pipeline, conditional commit and push, last-run record".

### Task 3: `setSchedule`, `removeSchedule`, `showSchedule`, CLI

**Files:** Modify `comb/schedule.mjs`; Test `comb/test/schedule.test.mjs`

**Produces:** `setSchedule({ workspace, days, at, exec, env, platform })` writes config and plist, calls `launchctl bootout` then `bootstrap`, returns the spec. `removeSchedule({ workspace, exec, env })` calls bootout and deletes both files. `showSchedule({ workspace, env, now })` returns a string. CLI: `set`, `show`, `remove`, `run [--no-commit]`.

- [ ] Write tests: `setSchedule` writes both files and calls `launchctl` twice in order (`bootout`, `bootstrap`); throws `/launchd/` when `platform` is `linux`; `removeSchedule` deletes both and calls `bootout`; `showSchedule` returns `no schedule` when unset and includes `Next run` when set.
- [ ] Run, expect fail. Implement. Add `main()`. Run, expect pass. Commit: "Add set/show/remove and the schedule CLI".

### Task 4: Skill, README, verification

**Files:** Modify `.claude/skills/comb/SKILL.md`, `README.md`

- [ ] Add a "Scheduling" section to the skill: trigger phrases, the mapping table, the rule to ask when the time is missing, the confirmation format, and the `run --no-commit` check.
- [ ] Add a "Schedule" section to the README.
- [ ] Verify by hand: `bun comb/schedule.mjs run --no-commit` completes and writes `state/last-run.json`; `bun comb/schedule.mjs show` prints `no schedule`. Do not install a real schedule; that is the user's call through `/comb`.
- [ ] `bun test comb/` green. Commit: "Document scheduling in the skill and README". Push the branch.
