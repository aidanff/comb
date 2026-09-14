# comb: scheduled runs

**Date:** 2026-09-14
**Status:** Approved for planning
**Repo:** `~/dev/comb`, branch `feat/comb-schedule` (stacked on `feat/comb-ontology`)

## Goal

A user of the `comb` skill describes a schedule in plain words. The skill turns the words into
structured flags and calls `comb/schedule.mjs`, which installs a macOS launchd agent. The agent
runs the deterministic pipeline, commits the generated files, and pushes. No model runs
unattended.

## What the user experiences

| Says, inside `/comb` | The skill runs | Result |
|---|---|---|
| "run comb every weekday at 6pm" | `bun comb/schedule.mjs set --days mon-fri --at 18:00` | Agent installed and loaded. The skill confirms days, time, and next fire. |
| "run it daily at 7am" | `set --days daily --at 07:00` | Replaces the previous schedule. |
| "when does comb run?" | `bun comb/schedule.mjs show` | Days, time, last run, next fire. |
| "stop running comb on a schedule" | `bun comb/schedule.mjs remove` | Agent unloaded, plist and config deleted. |
| "run it now" | `bun comb/schedule.mjs run` | One immediate run through the same path. |

The skill does the language work and asks one question when the time is missing. The CLI takes
only structured flags.

## The module: `comb/schedule.mjs`

| Command | Effect |
|---|---|
| `set --days <daily\|mon-fri\|mon,wed,fri> --at HH:MM` | Writes `state/schedule.json` and `~/Library/LaunchAgents/com.pressw.comb.plist`. `launchctl bootout` of the old agent (ignored if none), then `launchctl bootstrap gui/<uid> <plist>`. Refuses on non-macOS. |
| `show` | Prints the config, `state/last-run.json`, and the next fire time. |
| `remove` | Bootout, delete the plist, delete the config. |
| `run [--no-commit]` | The job body, below. |

`run`, in order:

1. Record whether the git tree is clean (`git status --porcelain` is empty).
2. Run `bun comb/comb.mjs --workspace <ws>`. Capture the JSON it prints.
3. If the tree was clean, `--no-commit` is absent, and the tree is now dirty: `git add` the
   generated paths, `git commit -m "comb: scheduled run <date> (<N> new nodes, <W> waiting)"`,
   `git push`. If the tree was dirty before the run: skip commit and push, log a warning.
4. Write `state/last-run.json` (started, finished, exit, newNodes, waiting, committed, pushed,
   error) and append one line to `state/logs/comb-<date>.log`.

The plist calls `bun` and `schedule.mjs` by absolute path, sets `PATH` to
`~/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, uses `StartCalendarInterval` with
one entry per weekday, and writes stdout and stderr to `state/logs/`.

## Files

| File | Committed | Role |
|---|---|---|
| `comb/schedule.mjs` | yes | the module |
| `comb/test/schedule.test.mjs` | yes | tests |
| `state/schedule.json`, `state/last-run.json`, `state/logs/` | no | per-machine |
| `~/Library/LaunchAgents/com.pressw.comb.plist` | no | generated |
| `.claude/skills/comb/SKILL.md` | yes | "Scheduling" section |
| `README.md` | yes | "Schedule" section |

## Testing

Pure functions carry the logic. `parseDays`, `parseTime`, `nextFire`, and `buildPlist` are
tested directly. `runOnce`, `setSchedule`, and `removeSchedule` take an injected `exec` so tests
never call launchd or git: clean tree commits and pushes; dirty tree does neither and logs a
warning; a failed pipeline records the exit code and does not commit. The LaunchAgents
directory is overridable through `COMB_LAUNCH_AGENTS_DIR` for tests.

## Risks

| Risk | Handling |
|---|---|
| `git push` under launchd has no ssh-agent | The remote is HTTPS with the `gh` credential helper. Verify once with `launchctl kickstart` and read `last-run.json`. |
| Laptop asleep at fire time | launchd runs a missed calendar job at wake. |
| Two machines push | The job does not pull. A rejected push is logged, never forced. |
| Non-macOS | `set` refuses. cron is not built. |
