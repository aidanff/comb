# comb

comb reads past Claude Code sessions and builds a network of automation candidates for
the PressW MSP division. Each node is a recurring workflow. Each edge is a measured
relation between two workflows. The team uses the network to pick the next internal tool
to build, and to check whether a built tool removed the friction it targeted.

No model reads a transcript. See "Redaction".

## Run it

```sh
bun comb/comb.mjs            # project, mine, update the ontology, render candidates.md
bun comb/comb.mjs --all      # rebuild the corpus after a vocabulary change
bun test comb/               # unit tests and the redaction audit
```

Then run the `comb` skill. It names and labels new nodes and reports the build order.

Run from the repo root. Set `COMB_TEAM_KEY` from the shared secret store before the first
run. The key makes session and project IDs identical on every machine, so the team can
pool one corpus. A changed key needs `--all`.

## Pipeline

| Stage | File | Reads | Writes | Model? |
|---|---|---|---|---|
| 1. Projector | `comb/project.mjs` | `~/.claude/projects/*/*.jsonl` | `comb/.work/skeletons.jsonl` | No |
| 2. Miner | `comb/motifs.mjs` | skeletons | `comb/.work/motifs.json` | No |
| 3. Ontology | `comb/ontology.mjs` | motifs, skeletons, `comb/ontology.json` | `comb/ontology.json`, `candidates.md` | No |
| 4. Skill | `.claude/skills/comb/SKILL.md` | the driver's output | node names and prose, through the CLI | Yes |

Stage 1 is the trust boundary. It is the only stage that opens a transcript.

The projector reads the top-level session files only. It skips the nested subagent and
workflow transcripts on purpose. comb measures operator friction, not delegated work.

## Files

| File | Committed | Role |
|---|---|---|
| `comb/ontology.json` | Yes | The source of truth: nodes, edges, themes, assignments, history |
| `candidates.md` | Yes | Rendered from the ontology on every run. Do not edit it by hand |
| `comb/.work/skeletons.jsonl` | Yes | The redacted corpus. Safe by construction |
| `comb/.work/motifs.json` | No | Regenerated each run |
| `state/processed.json` | No | The team key, watermarks, and excluded directories |

## The ontology

A **motif** is a short action sequence that the miner found in two or more sessions, or a
loop inside one session. A **node** is a group of motifs that score 0.5 or more against the
node's seed motif. A motif may open a new node only after it appears in 3 projects and 15
times; smaller motifs wait and are retried every run. A **theme** is a label the skill gives
a node.

Two edge types connect nodes:

| Edge | Direction | Meaning |
|---|---|---|
| Similarity | none | The two nodes use the same tools |
| Flow | from, to | An operator moved from one node to the other inside a session |

Each node carries stats: occurrences, distinct projects, median time, correction rate,
friction mass, and a build score. The build score ranks nodes by friction mass. Nodes that
sit between other nodes in the flow graph score higher.

Assignments are sticky. A motif joins a node once and stays there. A human moves it with
the CLI. The network grows by deepening nodes, not by adding rows.

## CLI

| Command | Who runs it | Effect |
|---|---|---|
| `bun comb/ontology.mjs annotate N001 --name .. --summary .. --tool .. --type .. --theme ..` | the skill | Set the descriptive fields |
| `bun comb/ontology.mjs status N001 built` | a human | `new`, `building`, `built`, or `rejected` |
| `bun comb/ontology.mjs merge N001 N004` | a human | Fold N004 into N001 |
| `bun comb/ontology.mjs merge --dismiss N002 N005` | a human | Stop proposing this merge |
| `bun comb/ontology.mjs move M015DF N007` | a human | Reassign one motif |

Every command rewrites `ontology.json` with sorted keys and re-renders `candidates.md`.

## Schedule

comb can run on its own through a macOS launchd agent. Ask the skill in plain words ("run
comb every weekday at 6pm") or use the CLI:

```sh
bun comb/schedule.mjs set --days mon-fri --at 18:00   # install or replace the schedule
bun comb/schedule.mjs show                           # days, time, last run, next run
bun comb/schedule.mjs run --no-commit                # one run now, without git writes
bun comb/schedule.mjs remove                         # unload and delete the schedule
```

A scheduled run executes `bun comb/comb.mjs`, then commits `comb/ontology.json`,
`candidates.md`, and the corpus and pushes, but only when the tree was clean before the run.
It runs no model. New nodes wait unnamed until the next `/comb`. Per-machine state lives in
`state/schedule.json`, `state/last-run.json`, and `state/logs/`.

## Redaction

The projector never copies a byte from a transcript. It uses transcript content only to
select a constant from the tables in `comb/vocabulary.mjs`. Unknown input selects a
fallback constant. The set of strings the projector can emit is finite.

`comb/test/projection.test.mjs` runs the projector over the whole local transcript corpus
and asserts that every emitted token is in that set. That test is the security control.
Run it after every change to `vocabulary.mjs`.

Two more rules protect the output:

- `Distinct projects` is a count. No engagement name reaches an output file.
- A node seen in one project gets a mechanical description. The skill writes free prose
  only for nodes seen in two or more projects.

## Docs

- Design: [`docs/superpowers/specs/2026-09-14-comb-ontology-design.md`](docs/superpowers/specs/2026-09-14-comb-ontology-design.md)
- History: the two earlier specs in the same directory
