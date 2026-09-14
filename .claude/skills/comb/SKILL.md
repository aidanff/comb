---
name: comb
description: Mine past Claude Code sessions into a networked ontology of automation candidates for the MSP division. Use when the user says "run comb", "comb the sessions", "what should I automate", "update the ontology", "review the graph", or "/comb". Reads only the projected corpus and comb/ontology.json, never a transcript.
---

# comb

Turn observed session behavior into a network of candidate workflows. The machine does the
grouping, scoring, and ranking. You name the nodes and write the prose. A second, independent
model instance then reviews the graph and proposes what to prune.

## Invariants

**Never read a transcript.** Not with Read, not with Bash, not to check one thing.
`~/.claude/projects/**` is off-limits. Your inputs are the JSON that `comb.mjs` prints and
`comb/ontology.json`. Stage 1 exists so that no model sees client data.

**Prose tiering.** A node with `stats.crossProject: true` spans two or more engagements and
cannot be client-specific. Describe it freely. A node with `crossProject: false` gets a
mechanical description only: restate the `seed` sequence and the numbers. Never guess which
client, system, or domain a single-project node belongs to.

**Never write `status`.** It is human-owned. Never edit `candidates.md` or
`comb/ontology.json` by hand. Use `bun comb/ontology.mjs annotate`.

**Never decide membership.** Report merge proposals. A human accepts or dismisses them.

**Never apply a review proposal.** The reviewer proposes prunes, merges, and edits. You record
them with `bun comb/review.mjs record`. A human runs `accept` or `dismiss`. You do not, and you
do not act on a proposal by other means (no `annotate` to carry out an `edit`, for example).

**The reviewer is independent.** Dispatch it with the Agent tool as a fresh `general-purpose`
agent, never as a `fork`. It reads `reviewer.md` and the JSON from `review.mjs input` and
nothing else. It must not see this conversation, the naming you just did, or any other file.

## Workflow

### 1. Run the pipeline

```sh
bun comb/comb.mjs
```

Add `--all` after a change to `comb/vocabulary.mjs`. Run from the repo root. The command
prints one JSON object: `unnamedNodes`, `proposals`, `buildOrder`, and `waiting` (motifs
below the seed floor).

### 2. Name each unnamed node

For each entry in `unnamedNodes`, read `seed`, `stats`, `class`, and `motifs`. Then:

- Pick a short lowercase `name` (two to four words) that names the workflow, not the tool.
- Write a `summary` of two sentences: what the operator is doing, and why it costs time.
  Use the numbers: occurrences, median time, correction rate.
- Write a one-sentence `tool`: the concrete thing to build or change.
- Pick a `type`: `hook`, `skill`, `script`, `mcp`, or `harness` (a Claude Code
  configuration change).
- Pick a `theme`: a one-word or two-word label for the family this node belongs to.
  Reuse an existing label from `candidates.md` when one fits.

```sh
bun comb/ontology.mjs annotate N001 --name "guarded batch edit" \
  --summary "..." --tool "..." --type skill --theme editing
```

Rules of thumb:

- `cycle` motifs (repeats inside one session) are friction the operator felt. Rank them
  above rituals of similar size.
- A high `correctionRate` means the agent acted and the human stepped in. Those are the
  highest-value candidates.
- `Bash(other)` is an unrecognized command. Say "an unrecognized or custom command", never
  guess what it does. `Bash(script)` is a repo script whose name is not in
  `INTERNAL_SCRIPTS`; say "a repo script".

### 3. Review the graph

Run this every time, after every unnamed node has a name, even when no node was new this run.
The graph changes on every run (stats, edges, scores), so the review is never stale work.

1. Write the reviewer's input to your scratchpad directory (the one named in your system
   prompt; `$SCRATCH` below stands for that path):

   ```sh
   bun comb/review.mjs input > "$SCRATCH/review-input.json"
   ```

2. Dispatch one `general-purpose` agent (not a fork). Its whole prompt is this, with the two
   paths filled in:

   > You are the comb graph reviewer. Do exactly the following, in order, and nothing else.
   > 1. Read `<repo>/.claude/skills/comb/reviewer.md`. It is your brief. Follow it exactly.
   > 2. Read `$SCRATCH/review-input.json`. It is your only input.
   > 3. Write your verdict, in the exact JSON shape the brief specifies, to
   >    `$SCRATCH/review-verdict.json`.
   > 4. Reply with the single word: done.
   >
   > Do not read any other file. Do not run any command other than reading those two files
   > and writing the verdict. Do not explain your reasoning outside the reason fields.

   Do not summarize the input for it, add your opinion, or mention which nodes you named.

3. Record the verdict:

   ```sh
   bun comb/review.mjs record --file "$SCRATCH/review-verdict.json"
   ```

   The command validates every proposal. If it exits non-zero, read the error, tell the user
   which proposal was malformed, and do not retry the agent more than once. Nothing was written.

The reviewer's brief is to prune. Expect a short list of `prune` proposals and few edits. A
verdict with zero proposals is fine; record it anyway so `candidates.md` shows the run was
reviewed.

### 4. Report

Tell the user, in this order:

1. Nodes named this run, one line each.
2. Review proposals, grouped by kind, with the reviewer's reason and your one-line opinion on
   each (agree, disagree, or unsure). Do not apply them. Give the accept and dismiss commands
   once at the end of the group, not per row.
3. Merge proposals from the machine, with a one-line opinion on each. Do not apply them.
4. The top three of `buildOrder`, with your reasoning.
5. The "Since last run" signals from `candidates.md`, if any.

Do not restate the table. The user can read `candidates.md`.

## Scheduling

The user can ask for comb to run on its own. You turn the sentence into flags; the CLI
installs a macOS launchd agent. The agent runs the deterministic pipeline, commits the
generated files, and pushes. It runs no model: new nodes wait unnamed until the next `/comb`.

| The user says | You run |
|---|---|
| "run comb every weekday at 6pm" | `bun comb/schedule.mjs set --days mon-fri --at 18:00` |
| "run it daily at 7am" | `bun comb/schedule.mjs set --days daily --at 07:00` |
| "run it Monday, Wednesday and Friday at noon" | `bun comb/schedule.mjs set --days mon,wed,fri --at 12:00` |
| "when does comb run?" / "schedule status" | `bun comb/schedule.mjs show` |
| "stop the schedule" / "don't run comb automatically" | `bun comb/schedule.mjs remove` |
| "run it now" | `bun comb/schedule.mjs run` |
| "review the graph" / "what should we prune" | Steps 3 and 4 only, no pipeline run |
| "accept R003" / "dismiss R003" | Tell the user the command: `bun comb/review.mjs accept R003`. You do not run it. |

Rules:

- `--days` takes `daily`, `weekdays`, a range like `mon-fri`, or a list like `mon,wed,fri`.
  `--at` takes 24-hour `HH:MM`. Convert "6pm" to `18:00` yourself.
- If the sentence names no time, ask one question: "What time?" Do not guess.
- If the sentence names no days, use `weekdays` and say so in the confirmation.
- After `set`, repeat the CLI's confirmation to the user: the days, the time, and the next run.
- On the first `set` on a machine, also run `bun comb/schedule.mjs run --no-commit` once and
  report the `exit`, `newNodes`, and `error` fields. That proves the job body works before
  launchd is trusted with it.
- Never edit the plist or `state/schedule.json` by hand.

The scheduled job never runs the reviewer. Review proposals appear only after a `/comb`.

## Tuning

- `.claude/skills/comb/reviewer.md` is the reviewer's brief. Its "Prune when" table sets how
  aggressive the pruning is. `PRUNABLE_STATUSES` and `MAX_REASON` in `comb/review.mjs` are
  the hard limits the validator enforces regardless of the brief.
- `bun comb/comb.mjs --min-sessions N --min-cycles N --max-motifs N` change the miner.
- `THRESHOLDS` in `comb/ontology.mjs` change grouping and rendering.
- `BASH_VERBS`, `INTERNAL_SCRIPTS`, `RUNNER_VERBS` in `comb/vocabulary.mjs` turn
  unrecognized commands into named signal. After any change there, run
  `bun test comb/`. The audit test asserts every emitted token is in the closed
  vocabulary. That test is the security control. Do not weaken it.
