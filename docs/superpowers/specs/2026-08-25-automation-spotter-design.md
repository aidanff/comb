# Automation Spotter — Design

**Date:** 2026-08-25
**Status:** Approved for planning
**Repo:** `~/dev/RnD`

## Problem

MSP division development work contains recurring, mechanical action sequences —
trial-and-error loops, setup rituals, repeated verification passes. These are the
raw material for internal developer tooling, but they are invisible: they happen
across dozens of sessions in many client repos, and no one is counting.

The goal is a ranked, durable reference list of **automation candidates** derived
from what actually happened in past Claude Code sessions, not from static analysis
of any codebase.

## Non-negotiable invariant

**The agent never sees client data.**

Redaction is achieved by *projection*, not by scrubbing. A deterministic,
model-free stage reduces each transcript to an action skeleton containing no
arguments, paths, file contents, or prose. Only that skeleton proceeds. The agent
is not trusted to redact correctly — it is never handed anything to redact.

A second, reinforcing rule: a motif observed across two or more distinct project
directories cannot be client-specific by construction. Prose freedom is tiered on
this basis (see "Prose tiering").

Nothing is ever written back to a client repository.

## Existing tools surveyed

| Tool | Why it does not cover this |
|---|---|
| `claude-code-setup:claude-automation-recommender` | Static codebase analysis; never observes actual behavior |
| `session-report` (official) | Same data source, but reports tokens/cost, not repetition |
| `pressw-tools:reflect` | Only improves skills already invoked; blind to unskilled work |
| `msp-artifact-workspace:runbook-miner` | Mines Slack, not sessions. Its ledger + invariant structure is borrowed here. |

## Architecture

Three stages with a hard trust boundary between 1 and 3.

```
~/.claude/projects/**/*.jsonl
        |
        v
  [1] project.mjs      deterministic, no LLM  <-- ONLY stage touching raw data
        |
        v  skeletons (no client content)
  [2] motifs.mjs       deterministic, no LLM
        |
        v  motifs.json (counts, timings, ranks)
  [3] SKILL.md         the agent
        |
        v
  candidates.md  +  state/processed.json
```

### Stage 1 — `project.mjs` (trust boundary)

Reads transcript JSONL and emits an action skeleton.

Transcript format (verified 2026-08-25): newline-delimited JSON with mixed record
types (`assistant`, `user`, `attachment`, `system`, `mode`, `permission-mode`,
`last-prompt`, `ai-title`, `atis-latch`, `file-history-snapshot`). Only `assistant`
and `user` records are relevant; all others are skipped. Message records carry
`cwd`, `timestamp`, `uuid`, `parentUuid`, and `isSidechain`. Assistant records
carry `message.content[]`, whose `tool_use` blocks have `name` and `input`.

**Robustness:** parse per line inside try/catch. A malformed or incomplete trailing
line is discarded silently, never fatal — transcripts are appended live and may be
read mid-write while a session is still running.

**L1 projection vocabulary** — each action becomes exactly one token:

| Source | Skeleton step | Notes |
|---|---|---|
| `Bash` | `Bash(pytest)` | first token of command, against an allowlist |
| `Bash` (unrecognized) | `Bash(other)` | fails closed on the long tail |
| `Edit` / `Write` / `Read` | `Edit(.py)` | file extension only |
| `Grep` / `Glob` / `WebFetch` | `Grep` | bare tool name |
| `Skill` / `Task` | `Skill(reflect)` | names are PressW-internal or public |
| user turn | `User` | marks human intervention — a friction signal |

Bash allowlist seeds with known dev tooling (`git`, `gh`, `pytest`, `uv`, `npm`,
`pnpm`, `node`, `terraform`, `docker`, `make`, `ruff`, `tsc`, `cargo`, `psql`, …).
Anything not on it collapses to `Bash(other)`.

**Discarded unconditionally:** all tool `input` values, all tool results, all
thinking blocks, all message text, all file paths and basenames, all file contents.

**Retained per step:** session id, hashed project id, `isSidechain` flag, timestamp,
`uuid`.

`isSidechain` steps are tagged and counted separately — subagent behavior is not
the operator's behavior and should not be conflated in the motif counts.

**Self-exclusion:** the RnD project directory is skipped by default (overridable),
so the spotter does not recommend automating itself.

### Stage 2 — `motifs.mjs`

Consumes skeletons, emits ranked motifs. No model involvement.

- **Adjacent cycles:** `(A B)+` repeating >= 3 times within one session. Highest-value
  signal — this is trial-and-error.
- **Cross-session n-grams:** 2..6-grams appearing in >= 3 distinct sessions. This is ritual.
- **Rank:** `occurrences * motif_length * distinct_projects`.
- **ROI column:** median elapsed wall-time per occurrence, derived from timestamps.

Overlapping n-grams are collapsed to the longest form meeting the threshold to avoid
flooding the table with sub-motifs.

### Stage 3 — `.claude/skills/automation-spotter/SKILL.md`

The agent reads **only** `motifs.json`. Its job is interpretation, not extraction:
name each motif, propose a concrete tool, classify it (hook / skill / script / MCP),
and upsert into `candidates.md`.

**Prose tiering:**
- Motif spans >= 2 distinct project dirs → agent may write free natural-language prose.
- Motif confined to one project dir → mechanical description only, no prose.

### Deliverable — `candidates.md`

Upsert keyed on a stable motif ID, with an occurrence counter. **Not** an append log:
without upsert, twenty transcripts produce twenty rows saying "edit-test loop" and
the artifact becomes a diary rather than a ranked reference list.

| ID | Motif (skeleton) | Occurrences | Distinct projects (count) | Median time | Candidate tool | Type | Status |
|---|---|---|---|---|---|---|---|
| `M007` | `Bash(terraform) -> Edit(.tfvars) -> Bash(terraform)` x4 | 23 | 3 | 4m12s | pre-apply tfvars validator | hook | new |

The `Distinct projects` column is a **count**, never engagement names. Project
identity is carried internally as a salted hash so that stage 2 can compare across
projects and stage 3 can apply prose tiering, without any client name reaching
`candidates.md`.

`Status` is human-owned (`new` / `building` / `built` / `rejected`) and must never be
overwritten by the agent on re-run.

### State — `state/processed.json`

Per session file: a `uuid` watermark, not a done-flag. A session that has grown since
the last run is topped up from its watermark. This makes runs idempotent and
incremental, and makes it safe to run the spotter while a client session is still open.

## Operating model

The spotter runs from `~/dev/RnD`, never inside a client repo. It reads
`~/.claude/projects/` globally and post-hoc. There is no ritual attached to any
individual session — the user works normally in client repos and runs the skill
whenever convenient. It may be run concurrently with an active client session.

First run processes the entire existing backlog (~42 project directories) and yields
a populated ranked table immediately. Subsequent runs are incremental top-ups.

## Layout

```
RnD/
  .claude/skills/automation-spotter/
    SKILL.md              # registered as a project-level skill
  automation-spotter/
    project.mjs
    motifs.mjs
    vocabulary.mjs
    test/
  candidates.md
  state/processed.json
  docs/superpowers/specs/2026-08-25-automation-spotter-design.md
```

## Out of scope for MVP

- In-session capture (stop-hooks, live observation)
- L2 projection fidelity (normalized argument shapes)
- Generating the candidate tools themselves
- HTML reporting
- Lockfile for concurrent spotter runs
- Any writeback to a client repository

## Implementation notes (added 2026-08-25, post-build)

- **Runtime is `bun`**, not node — node is not installed on the target machine.
- **Signal tiering was added to stage 2.** The first run's top motifs were `ls`, `cat`,
  and `echo` — the agent looking around, not the work. `LOW_SIGNAL_VERBS` in
  `vocabulary.mjs` lists inspection verbs that stay in the skeleton (stage 1 remains
  maximally faithful) but are filtered out of motif sequences. Search verbs
  (`grep`/`rg`/`find`/`fd`) are deliberately NOT low-signal: repetition of them is real
  flailing signal.
- **Unrecognized skills collapse to `Skill(other)`**, not `Skill(client-marketplace)` —
  an unknown skill is not necessarily from a client marketplace, and the more accurate
  label avoids asserting something the projector cannot know.
- **`Bash(noise)` vs `Bash(other)` are distinct.** Scaffolding (`cd`, `export`) is noise;
  an unrecognized or path-like payload (`./scripts/foo.sh`) is `other`. Conflating them
  would make a repeated custom script indistinguishable from a `cd`.
- **Corpus reality:** 1781 tool calls + 398 human turns across 81 transcripts. Transcript
  file size is dominated by `attachment` records and tool results, not tool calls, so the
  corpus is far smaller than byte counts suggest. `minSessions` defaults to 2 (not 3)
  and emitted motifs are capped at 60 to keep the table tractable.

## Open decisions deferred to implementation

- Exact seed contents of the Bash allowlist
- n-gram thresholds (>= 3 sessions, 2..6 length) may need tuning against the real backlog
- Motif ID stability scheme (content hash of the skeleton sequence)
