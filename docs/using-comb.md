# Using comb

This guide tells you how to use the `comb` skill in Claude Code, how to read its output, and
how to make it run on a schedule.

## Before you start

| Requirement | How to check |
|---|---|
| Bun is installed | `bun --version` prints a version |
| You are in the comb repository | `pwd` ends in `/comb` |
| The team key is set | `echo $COMB_TEAM_KEY` prints a value. Get the value from the shared secret store. |
| Claude Code is open in this repository | `/comb` appears when you type `/` |

## Legend

Read these terms before you read `candidates.md`.

| Term | Meaning |
|---|---|
| Transcript | A raw Claude Code session file. Only the projector reads it. No model reads it. |
| Corpus | The redacted record of every session. Each step is one constant from a closed list. |
| Motif | A short action sequence that repeats. Example: `Bash(grep) → Bash(sed)`. |
| Node | One candidate workflow. A node holds one or more motifs. |
| Seed | The motif that opened a node. It gives the node its first description. |
| Theme | A short label the skill gives a node. Example: `editing`. |
| Similarity edge | Two nodes use the same tools. Weight runs from 0 to 1. |
| Flow edge | An operator moved from one node to the other inside a session. Count and median gap. |
| Occurrences | How many times the motifs of a node appeared. |
| Distinct projects | How many engagements a node appeared in. This is a count. No engagement name appears. |
| Correction rate | The share of occurrences where a human stepped in 2 seconds or more later. |
| Friction mass | Occurrences multiplied by median time. An estimate of the time a node costs. |
| Build score | Friction mass, raised for nodes that sit between other nodes in the flow graph. |
| Class | `tool`, `doc`, or `unclassified`. The machine sets it. |
| Type | `hook`, `skill`, `script`, `mcp`, or `harness`. The skill sets it. |
| Status | `new`, `building`, `built`, or `rejected`. A human sets it. No run changes it. |
| Waiting | Motifs that are too small to open a node. They join a node later or open one when they grow. |

## Run the skill

1. Open Claude Code in the comb repository.
2. Type `/comb`, or say "run comb".
3. Wait. The skill runs the pipeline, names new nodes, and reports.

The report lists the nodes named this run, the merge proposals, the top three of the build
order, and the signals since the last run. Read `candidates.md` for the full table.

## Say what you want

The skill understands plain sentences. Use these forms.

| Say | The skill does |
|---|---|
| "run comb" | Runs the pipeline and names new nodes |
| "what should I automate" | Same as "run comb", then explains the top three |
| "update the ontology" | Same as "run comb" |
| "run comb every weekday at 6pm" | Installs a schedule. See "Schedule comb" below. |
| "when does comb run" | Shows the schedule and the last run |
| "stop the schedule" | Removes the schedule |
| "run it now" | Runs one scheduled-style run at once |

## Set a status

The skill never sets `Status`. You set it with the CLI.

```sh
bun comb/ontology.mjs status N007 building   # you started work on this node
bun comb/ontology.mjs status N007 built      # the tool exists
bun comb/ontology.mjs status N004 rejected   # not worth building
```

After you set a status, the next run reports the effect. A `built` node whose rate falls by
half or more is a confirmed win. A `rejected` node whose rate rises by half or more is a
re-open signal.

## Accept or dismiss a merge

The skill proposes merges. It never applies them. The proposal names two nodes and a weight.

```sh
bun comb/ontology.mjs merge N001 N004             # keep N001, fold N004 into it
bun comb/ontology.mjs merge --dismiss N002 N005   # never propose this pair again
```

## Schedule comb

A schedule makes comb run on its own. The scheduled run does three things: it runs the
pipeline, it commits the generated files, and it pushes. It runs no model. New nodes wait
unnamed until you run `/comb`.

### What you need

| Requirement | Reason |
|---|---|
| macOS | The schedule uses launchd. The CLI refuses on other systems. |
| A clean git tree at run time | The job commits only when the tree was clean before the run. A dirty tree makes the job run but not commit. |
| Push access from the terminal | The job pushes with your normal git credentials. Test with `git push` before you schedule. |
| The laptop awake, or asleep | launchd runs a missed job when the machine wakes. |

### Install a schedule with the skill

1. Open Claude Code in the comb repository.
2. Type `/comb`.
3. Say the days and the time. Use a 24-hour time or an am/pm time. Examples:
   - "run comb every weekday at 6pm"
   - "run comb daily at 07:00"
   - "run comb on Monday, Wednesday and Friday at noon"
4. If you did not say a time, the skill asks "What time?". Answer with a time.
5. Read the confirmation. It shows the days, the time, and the next run.
6. On the first install on a machine, the skill also runs the job once without git writes and
   reports `exit`, `newNodes`, and `error`. If `exit` is not `0`, stop. Read "If the job fails"
   below.

### Install a schedule with the CLI

Use the CLI when you are not in Claude Code.

```sh
bun comb/schedule.mjs set --days mon-fri --at 18:00
```

| Flag | Values |
|---|---|
| `--days` | `daily`, `weekdays`, a range such as `mon-fri`, or a list such as `mon,wed,fri` |
| `--at` | A 24-hour time such as `18:00` or `7:05` |

A second `set` replaces the first schedule. You do not need to remove the old one.

### Check the schedule

```sh
bun comb/schedule.mjs show
```

The output shows the days, the time, the next run, and the last run. The last run shows the
exit code, the number of new nodes, the number of waiting motifs, and whether the job
committed and pushed.

### Run the job once by hand

WARNING: without `--no-commit`, this command commits and pushes when the tree is clean.

```sh
bun comb/schedule.mjs run --no-commit   # safe check: pipeline only
bun comb/schedule.mjs run               # the full job, as launchd runs it
```

### Remove the schedule

```sh
bun comb/schedule.mjs remove
```

Or say "stop the schedule" in `/comb`. The agent unloads and the schedule files are deleted.

### If the job fails

1. Run `bun comb/schedule.mjs show`. Read the `Last error` line.
2. Open `state/last-run.json` for the full record.
3. Open the newest file in `state/logs/`. launchd writes its own output to
   `state/logs/launchd.out.log` and `state/logs/launchd.err.log`.

| Error text | Cause | Fix |
|---|---|---|
| `pipeline exited 1` | The projector or the miner failed | Run `bun comb/comb.mjs` by hand and read the message |
| `tree was dirty before the run` | Uncommitted changes in the repository | Commit or stash them. The job commits only from a clean tree. |
| `push failed` | No credentials, or the remote moved | Run `git push` in a terminal. Fix what it reports. The commit stays; the next run pushes it. |
| `launchctl bootstrap failed` | The agent is loaded twice, or the plist is invalid | Run `bun comb/schedule.mjs remove`, then `set` again |
| `works on macOS only` | Not a Mac | Use `bun comb/comb.mjs` by hand, or cron. comb does not install cron jobs. |

### Where the schedule lives

| File | Purpose | Committed |
|---|---|---|
| `~/Library/LaunchAgents/com.pressw.comb.plist` | The launchd agent | No |
| `state/schedule.json` | The days and the time | No |
| `state/last-run.json` | The last run record | No |
| `state/logs/` | One log line per run, plus launchd output | No |

The schedule is per machine. A teammate who wants a schedule installs one on their own
machine.

## Rules the skill follows

- It never reads a transcript.
- It never writes `Status`.
- It never edits `candidates.md` or `comb/ontology.json` by hand. It uses the CLI.
- It never applies a merge. It proposes.
- It describes a node seen in one project in mechanical terms only.
