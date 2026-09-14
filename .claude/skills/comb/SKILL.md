---
name: comb
description: Mine past Claude Code sessions for recurring action patterns and maintain a ranked list of internal developer-tool candidates for the MSP division. Use when the user says "comb the sessions", "spot automations", "what should I automate", "run comb", "update candidates", or "/comb". Reads only client-redacted action skeletons, never raw transcripts.
---

# comb

Turn observed session behavior into a ranked list of automation candidates in `candidates.md`.

## Non-negotiable invariants

**Never read a transcript directly.** Not with Read, not with Bash, not "just to check
something". `~/.claude/projects/**` is off-limits to you. Your only inputs are
`comb/.work/motifs.json` and the existing `candidates.md`. Stage 1
(`project.mjs`) exists precisely so that no model ever sees client data; reading around
it defeats the entire design.

**Prose tiering.** A motif with `crossProject: true` appears at two or more distinct
engagements and therefore cannot be client-specific — describe it freely. A motif with
`crossProject: false` occurred at a single engagement: give it a mechanical description
only (restate the sequence and the numbers). Never speculate about which client, what
system, or what domain a single-project motif belongs to. You do not know, and guessing
is exactly the leak this tool is built to prevent.

**Never overwrite the `Status` column.** It is human-owned. Same for a `Candidate tool`
cell a human has clearly rewritten — preserve their wording and update only the numbers.

## Workflow

### 1. Refresh the data

```sh
bun comb/project.mjs      # transcripts -> skeletons (incremental)
bun comb/motifs.mjs       # skeletons -> ranked motifs
```

Add `--all` to `project.mjs` to rebuild from scratch, ignoring watermarks. Useful after
changing the projection vocabulary, since old skeletons were built with the old tables.
Run from the repo root: paths resolve against the current directory. `COMB_TEAM_KEY`
should be set to the team key so pooled skeletons hash consistently; a changed key
is refused unless `--all` is passed.

### 2. Read the motifs

Read `comb/.work/motifs.json`. Each motif has: `id`, `kind`
(`cycle` = trial-and-error loop within one session, `ritual` = sequence recurring across
sessions), `sequence`, `occurrences`, `distinctSessions`, `distinctProjects`,
`crossProject`, `medianElapsedMs`, and `rank`.

Prioritize by judgment, not by rank alone:

- **`cycle` motifs outrank `ritual` motifs of similar size.** A loop is friction you
  actually felt; a ritual may just be how work is shaped.
- **High `medianElapsedMs` is the ROI signal.** A motif occurring 12 times at 200s each
  is worth more than one occurring 40 times at 3s each.
- **`Bash(other)` means an unrecognized command.** It is a real signal — usually a custom
  script — but you cannot say which. Describe it as "an unrecognized/custom command",
  never guess what it does. If `Bash(other)` dominates the table, say so in the summary:
  it means the allowlist in `vocabulary.mjs` needs new verbs.
- **A motif ending in `User` is a correction.** The agent acted, then the human
  intervened. These are the highest-value candidates — they mark where the current
  workflow gets things wrong unaided.
- **Ignore motifs where `sidechain: true`** unless nothing else is interesting. That is
  subagent behavior, not the operator's.

### 3. Upsert `candidates.md`

Read the existing `candidates.md`. For each motif you judge worth listing:

- **ID already present** → update `Occurrences`, `Distinct projects`, `Median time`.
  Leave `Status` and any human-edited `Candidate tool` text alone.
- **ID absent** → append a new row with `Status: new`.
- **Row present but motif no longer in the data** → leave it. Never delete rows; a
  candidate someone triaged should not silently vanish because thresholds moved.

Row format:

| ID | Motif | Occurrences | Distinct projects | Median time | Candidate tool | Type | Status |
|---|---|---|---|---|---|---|---|
| `M015DF` | `Bash(grep) → Bash(sed)` | 18 | 10 | 4s | in-place refactor helper that greps and rewrites in one step | skill | new |

`Type` is one of `hook`, `skill`, `script`, `mcp`, or `harness` (a Claude Code config
change rather than a tool). `Distinct projects` is a **count** — never engagement names.

### 4. Report

Tell the user how many rows were added versus updated, and name the two or three
candidates you think are actually worth building, with your reasoning. Do not restate
the whole table — they can read it.

## Tuning

If the table is thin or dominated by noise, adjust and re-run:

- `--min-sessions N` (default 2) — how many distinct sessions a ritual must span.
- `--min-cycles N` (default 3) — how many repeats make a cycle.
- `LOW_SIGNAL_VERBS` in `vocabulary.mjs` — inspection verbs filtered out of motifs.
- `BASH_VERBS` in `vocabulary.mjs` — add verbs here to convert `Bash(other)` noise into
  named signal. This is the highest-leverage tuning knob.

After editing `vocabulary.mjs`, run `bun test comb/` — the audit test
asserts that every token emitted across the entire real corpus is a member of the closed
vocabulary. That test is the security control. Do not weaken it.
