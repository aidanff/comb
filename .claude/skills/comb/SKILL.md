---
name: comb
description: Mine past Claude Code sessions into a networked ontology of automation candidates for the MSP division. Use when the user says "run comb", "comb the sessions", "what should I automate", "update the ontology", or "/comb". Reads only the projected corpus and comb/ontology.json, never a transcript.
---

# comb

Turn observed session behavior into a network of candidate workflows. The machine does the
grouping, scoring, and ranking. You name the nodes and write the prose.

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

### 3. Report

Tell the user, in this order:

1. Nodes named this run, one line each.
2. Merge proposals, with a one-line opinion on each. Do not apply them.
3. The top three of `buildOrder`, with your reasoning.
4. The "Since last run" signals from `candidates.md`, if any.

Do not restate the table. The user can read `candidates.md`.

## Tuning

- `bun comb/comb.mjs --min-sessions N --min-cycles N --max-motifs N` change the miner.
- `THRESHOLDS` in `comb/ontology.mjs` change grouping and rendering.
- `BASH_VERBS`, `INTERNAL_SCRIPTS`, `RUNNER_VERBS` in `comb/vocabulary.mjs` turn
  unrecognized commands into named signal. After any change there, run
  `bun test comb/`. The audit test asserts every emitted token is in the closed
  vocabulary. That test is the security control. Do not weaken it.
