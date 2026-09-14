# comb: a networked ontology of candidate workflows

**Date:** 2026-09-14
**Status:** Approved for planning
**Repo:** `~/dev/comb` (`github.com/aidanff/comb`, private), branch `feat/comb-ontology`.
Cloned from `~/dev/RnD` so the earlier history is kept.
**Supersedes:** the deliverable and stage-3 sections of
`2026-08-25-comb-design.md`, and phases 1 and 2 of
`2026-09-10-comb-tools-docs-plugins.md`. Phases 3 and 4 of that spec stay deferred.

## Summary

The tool is named `comb`. The projector and the miner stay. A new ontology
stage sits above the miner. It groups motifs into candidate nodes, connects the nodes with
similarity edges and flow edges, computes a build order, and records per-run history so the
team can see whether a built tool removed the friction it targeted. `candidates.md` becomes
a rendered view of `comb/ontology.json`, which is the source of truth.

## Goals

1. The deliverable is a **network of candidate workflows** that grows by deepening existing
   nodes, not by adding rows. A new node appears only when a new kind of workflow appears.
2. Grouping, scoring, ranking, and history are **deterministic** and tested. The model names
   nodes and writes prose. It never decides membership.
3. The redaction invariant is unchanged: no model reads a transcript, and every token in the
   corpus is a member of the closed vocabulary.
4. The gaps found in the 2026-09-14 review are closed. They are listed in "Gaps closed".

## Non-goals

- Frequent-subgraph mining over the raw token transition graph. The n-gram miner finds the
  motifs; the graph layer above it delivers the value.
- `inventory.mjs` and `docsmap.mjs` (the `plugin` and `doc` classes from the 2026-09-10
  spec). They need an internal-repo allowlist decision that is still open. The `class` field
  exists now so they slot in later.
- Mining subagent and workflow transcripts. See "Corpus scope".
- A marketplace mirror. The README claim is deleted; a mirror is a separate decision.
- Scheduling. `comb.mjs` is one command; `/schedule` or `/loop` can call it later.

## Corpus scope

comb mines the **main chain only**. Claude Code stores subagent and workflow transcripts in
nested directories (`<session>/subagents/agent-*.jsonl`, `wf_*/`). On 2026-09-14 those were
1,238 of 1,464 transcript files. The projector lists one directory level per project and
does not descend. This is now the documented rule, with a test.

Reason: comb measures operator friction. Delegated work is the behavior of the factory and
the delivery loop. Mixed in, it fills the network with agent-internal loops. The 2026-08-25
claim that subagent steps are "tagged and counted separately" is withdrawn.

## Repository and layout

comb gets its own repository. `~/dev/RnD` is cloned to `~/dev/comb`, so every
earlier commit stays in the history. The remote is `aidanff/comb`, private.

What stays in RnD: `docs/2026-08-25-automation-ideas-roman-1on1.md` (a business menu, not
comb) and `docs/runbooks/testing-plugins.md` (about the marketplace). RnD's README gains a
pointer to the comb repo, and its copy of the comb code is deleted on the
`feat/comb-ontology` branch there.

The directory, skill, and spec renames landed on 2026-09-14. Final layout:

| Path | Committed | Role |
|---|---|---|
| `comb/` | yes | projector, miner, ontology stage, driver, tests |
| `.claude/skills/comb/` | yes | the skill, named `comb` |
| `comb/.work/skeletons.jsonl` | yes | the corpus |
| `comb/.work/motifs.json` | no | regenerated each run |
| `comb/ontology.json` | yes | new; source of truth |
| `candidates.md` | yes | rendered view, never hand-edited |
| `state/processed.json` | no | team key, watermarks, `excludeDirs` |
| `docs/superpowers/specs/2026-08-25-comb-design.md`, `2026-09-10-comb-tools-docs-plugins.md` | yes | history |

Environment variables are `COMB_WORKSPACE` and `COMB_TEAM_KEY`. New files this spec adds:
`comb/ontology.mjs`, `comb/comb.mjs`, `comb/test/ontology.test.mjs`, `comb/test/comb.test.mjs`.

`.gitignore` changes: `comb/.work/*` ignored, `!comb/.work/skeletons.jsonl` kept.

**Self-exclusion after the move.** The projector skips the workspace directory by name.
The workspace is now `~/dev/comb`, so sessions run in `~/dev/RnD` (which discussed this
tool for three weeks) would enter the corpus. `project.mjs` gains `--exclude NAME`,
repeatable. Names are stored in `state/processed.json` under `excludeDirs` and applied on
every later run. The migration adds the RnD directory name once. The state file is
gitignored and per-machine, so no path is committed.

## Pipeline

```
~/.claude/projects/<project>/*.jsonl           (top level only)
        |
        v
[1] comb/project.mjs     deterministic    -> comb/.work/skeletons.jsonl   (committed)
        |
        v
[2] comb/motifs.mjs      deterministic    -> comb/.work/motifs.json       (ignored)
        |
        v
[3] comb/ontology.mjs    deterministic    -> comb/ontology.json           (committed)
        |                                 -> candidates.md                (committed, rendered)
        v
[4] .claude/skills/comb/SKILL.md   the model: names nodes and themes, writes prose
```

`bun comb/comb.mjs [--all]` runs stages 1 to 3 in order and prints the skill's input:
unnamed nodes, unnamed themes, and merge proposals.

## Stage 1: projector changes

File: `comb/project.mjs`, `comb/vocabulary.mjs`.

Every change below selects a constant. No byte from a transcript reaches the output. The
closure test enumerates the new constants through `buildVocabulary()`.

| Change | Rule | Constant emitted |
|---|---|---|
| Path-like head | head contains `/` | `Bash(script)` |
| Internal script | path-like head whose basename is in `INTERNAL_SCRIPTS` | `Bash(script:validate-all.sh)` |
| Runner second token | head in `RUNNER_VERBS` and second token in `SECOND_TOKENS` | `Bash(uv:run)` |
| Python shape | head is `python` or `python3` | `Bash(python3:-c)`, `Bash(python3:-m)`, `Bash(python3:stdin)`, `Bash(python3:file)` |
| Nested directories | never descended | none; tested |

Seed lists:

- `INTERNAL_SCRIPTS`: `validate-all.sh`, `run_checks.sh`, `guard-tests.sh`,
  `agent-checks.sh`, `connector-checks.sh`, `skill-budget-checks.sh`, `delivery.sh`.
- `RUNNER_VERBS`: `uv`, `uvx`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `deno`, `cargo`, `go`,
  `make`, `just`, `task`, `poetry`, `docker`.
- `SECOND_TOKENS`: `run`, `test`, `check`, `lint`, `build`, `install`.

Python shape rule, in order: second token `-c` gives `:-c`; second token `-m` gives `:-m`;
second token `-` or the command contains `<<` gives `:stdin`; any other second token gives
`:file`; no second token gives the bare `Bash(python3)`.

A client script that shares a basename with an `INTERNAL_SCRIPTS` entry is attributed to us.
That is an analysis error, not a disclosure, because the emitted string is our constant.

Test fix: the `{ timeout: 120000 }` option moves from `recognizes a plain verb` to the AUDIT
closure test in `comb/test/projection.test.mjs`. The audit runs about 16 seconds.

## Stage 2: miner changes

File: `comb/motifs.mjs`.

| Field | Definition |
|---|---|
| `correctionRate` | Share of the motif's occurrences whose next step is `User` **and** at least 2,000 ms later. The floor removes the skill-body artifact (`M45638`, 19 ms median). |
| `retryDepth` | Longest run of back-to-back repeats of the motif in one session. |
| `sessions` | Array of the motif's session IDs (keyed hashes). Needed by stage 3 for flow and stats. |
| `projects` | Array of the motif's project IDs (keyed hashes). Needed for node-level distinct counts. |

`maxMotifs` default rises from 60 to 300, with `--max-motifs N`. The network absorbs volume;
the table no longer shows motifs.

`buildSequences` is exported unchanged. Stage 3 imports it.

## Stage 3: ontology

File: `comb/ontology.mjs`. Inputs: `comb/.work/motifs.json`, `comb/.work/skeletons.jsonl`,
`comb/ontology.json`. Outputs: `comb/ontology.json`, `candidates.md`.

### Data model

```json
{
  "version": 1,
  "run": "2026-09-14",
  "nextNode": 13,
  "nextTheme": 5,
  "nodes": {
    "N001": {
      "name": "guarded batch edit",
      "summary": "...",
      "tool": "...",
      "type": "skill",
      "status": "new",
      "class": "tool",
      "theme": "T01",
      "motifs": ["M015DF", "M643B3"],
      "seed": ["Bash(grep)", "Bash(sed)"],
      "created": "2026-09-14",
      "mergedFrom": [],
      "stats": { "occurrences": 0, "distinctSessions": 0, "distinctProjects": 0,
                 "medianElapsedMs": 0, "correctionRate": 0, "retryDepth": 0,
                 "frictionMassMs": 0, "crossProject": true,
                 "weightedDegree": 0, "betweenness": 0, "buildScore": 0 },
      "history": [ { "run": "2026-09-14", "occurrences": 0, "distinctSessions": 0 } ]
    }
  },
  "themes": { "T01": { "name": "editing", "nodes": ["N001", "N004"] } },
  "assignments": { "M015DF": "N001" },
  "similarity": [ { "a": "N001", "b": "N004", "weight": 0.5 } ],
  "flow": [ { "from": "N001", "to": "N007", "count": 12, "sessions": 6, "medianGapMs": 40000 } ],
  "dismissedMerges": [ ["N002", "N005"] ]
}
```

Field ownership:

| Owner | Fields | Written by |
|---|---|---|
| `upsert` | `run`, `nextNode`, `nextTheme`, `motifs`, `seed`, `created`, `class`, `theme`, `stats`, `history`, `themes.*.nodes`, `assignments`, `similarity`, `flow` | every run |
| the skill | `name`, `summary`, `tool`, `type`, `themes.*.name` | `annotate` |
| a human | `status`, `mergedFrom`, `dismissedMerges`, assignment overrides | `status`, `merge`, `move` |

`upsert` never writes a skill-owned or human-owned field. A test asserts this by running
`upsert` twice over a fixture with every such field set and diffing.

### Similarity score

`similarity(a, b)` for two motifs, or two nodes, is weighted Jaccard over distinct tokens.

- Token weight: `User` is 0.5. Every other token is 1.0.
- Repeat counts are ignored. `Mcp(linear) ×4 → User` and `Mcp(linear) → User` score 1.0.
- A node's token set is the union of its member motifs' tokens.

Contextual co-occurrence (shared sessions) is **not** part of this score. Flow edges carry
that signal directly and more precisely.

Constants, in one object at the top of `ontology.mjs`:

| Name | Value | Use |
|---|---|---|
| `JOIN` | 0.7 | a motif joins a node, and new motifs form a node, at or above this |
| `THEME` | 0.3 | node-level components at or above this form a theme |
| `MERGE` | 0.7 | node pairs at or above this are proposed for merge |
| `RENDER_SIM` | 0.3 | node-level similarity edges shown |
| `RENDER_FLOW_COUNT` | 3 | flow edges shown need this many transitions |
| `RENDER_FLOW_SESSIONS` | 2 | and this many distinct sessions |
| `CORRECTION_FLOOR_MS` | 2000 | lives in the miner; listed here for reference |

### Node formation

Order of operations on each `upsert`:

1. Load `motifs.json`. Motifs already in `assignments` keep their node. Sticky rule.
2. Sort unassigned motifs by `rank` descending, then by `id`.
3. For each unassigned motif, compute `similarity` to every existing node. If the best is at
   or above `JOIN`, assign to that node. Ties break toward the node with more occurrences,
   then the lower node ID.
4. Motifs still unassigned form the vertices of a graph whose edges are pairs at or above
   `JOIN`. Each connected component becomes a new node. Node IDs come from `nextNode`,
   zero-padded to three digits. `seed` is the sequence of the component's highest-ranked
   motif. `created` is the run date.
5. A motif absent from `motifs.json` keeps its assignment. Nothing is deleted.

### Themes

Themes are recomputed each run as connected components over the node-level similarity graph
at `THEME`. Theme names must persist, so components are matched to existing themes by
largest member overlap. A component with no overlap gets a new ID from `nextTheme`. A theme
whose every node moved elsewhere is deleted; its name is lost, and the report says so.

### Node stats

Recomputed each run from member motifs and the sequences.

| Stat | Definition |
|---|---|
| `occurrences` | sum over members |
| `distinctSessions` | size of the union of member session sets |
| `distinctProjects` | size of the union of member project sets |
| `crossProject` | `distinctProjects >= 2` |
| `medianElapsedMs` | occurrence-weighted median of member medians |
| `correctionRate` | occurrence-weighted mean of member rates |
| `retryDepth` | max over members |
| `frictionMassMs` | sum over members of `occurrences × medianElapsedMs` |
| `class` | `tool` if `correctionRate >= 0.25` or `retryDepth >= 3`; else `doc` if `correctionRate < 0.1` and `crossProject` and `occurrences >= 20`; else `unclassified`. `plugin` is reserved for the inventory phase. |

Friction mass is additive across nodes because motifs partition into nodes. Overlapping
n-grams inside one session make it an over-estimate. The report calls it an estimate.

### Flow edges

For each session sequence from `buildSequences`:

1. Find every occurrence of every member motif of every node. Record `(start, end, node)`.
2. Sort by `start`, then by `end`.
3. Collapse consecutive occurrences of the same node.
4. Each consecutive pair with different nodes is one transition `from → to`. Its gap is
   `ts(to.start) − ts(from.end)`, clamped at 0.

Edge fields: `count`, `sessions` (distinct), `medianGapMs`. Rendered when `count` is at or
above `RENDER_FLOW_COUNT` and `sessions` at or above `RENDER_FLOW_SESSIONS`. All edges are
stored.

### Centrality and build order

The flow graph, undirected and unweighted, restricted to rendered edges:

| Measure | Computation |
|---|---|
| `weightedDegree` | sum of `count` over incident flow edges, in and out |
| `betweenness` | Brandes' algorithm, exact, normalized to [0, 1] by the maximum in the graph |
| `buildScore` | `frictionMassMs × (1 + betweenness)` |

Build order lists nodes with `status` in {`new`, `building`} by `buildScore` descending, with
cumulative share of total `frictionMassMs`. Nodes marked `built` or `rejected` are excluded.

### History and impact

`history` gets one entry per run date. Re-running on the same date replaces that date's
entry. Entries hold cumulative `occurrences` and cumulative `distinctSessions`.

The corpus only grows, so cumulative counts never fall. Impact uses the **rate in the window
between two runs**: `Δoccurrences / Δsessions`, where `Δsessions` is the growth of the
corpus session count between the two runs. The report compares the latest window to the
one before it for every node with `status` `built` or `rejected`:

| Signal | Condition |
|---|---|
| confirmed win | `built`, and the window rate fell by 50% or more |
| displacement | `built`, and a flow successor's window rate rose by 20% or more |
| re-open | `rejected`, and the window rate rose by 50% or more |

With fewer than two history entries, the section says "no window yet".

### Merge proposals

Node pairs with node-level `similarity` at or above `MERGE`, not already merged, and not in
`dismissedMerges`, are listed as proposals. The skill reports them. A human accepts with
`merge` or dismisses with `merge --dismiss`.

### CLI

| Command | Owner | Effect |
|---|---|---|
| `bun comb/ontology.mjs upsert` | `comb.mjs` | steps above; never touches skill or human fields |
| `bun comb/ontology.mjs render` | `comb.mjs` | writes `candidates.md` |
| `bun comb/ontology.mjs annotate N001 --name .. --summary .. --tool .. --type ..` | the skill | any subset of the four fields |
| `bun comb/ontology.mjs annotate T01 --name ..` | the skill | theme name |
| `bun comb/ontology.mjs status N001 built` | human | `new`, `building`, `built`, `rejected` |
| `bun comb/ontology.mjs merge N001 N004` | human | moves N004's motifs into N001, appends to `mergedFrom`, deletes N004, redirects `assignments`; edges recompute on next `upsert` |
| `bun comb/ontology.mjs merge --dismiss N002 N005` | human | never propose again |
| `bun comb/ontology.mjs move M015DF N007` | human | one assignment override; sticky afterwards |

Every mutating command rewrites `ontology.json` with two-space indentation and sorted keys,
so diffs are reviewable. `render` runs automatically after `annotate`, `status`, `merge`,
and `move`, so `candidates.md` never lags the JSON.

## Rendered `candidates.md`

Sections in order:

1. **Header**: run date, corpus size (steps, sessions, projects), node count, theme count,
   flow edge count. The standing notes: `Status` is human-owned; `Distinct projects` is a
   count, never a name; the file is generated, edit `ontology.json` through the CLI.
2. **Themes**: ID, name, node count, friction share.
3. **Candidates**: one row per node. Columns: ID, name, theme, motifs, occurrences, distinct
   projects, median time, correction rate, class, type, status, candidate tool. Sorted by
   `buildScore`. An unnamed node shows its `seed` sequence in the name column.
4. **Build order**: top 10 by `buildScore` with cumulative friction share.
5. **Flow**: rendered flow edges, sorted by `count`. Columns: from, to, count, sessions,
   median gap.
6. **Network**: a Mermaid `graph LR` of the rendered flow edges. Node labels are names or
   IDs. Edge labels are counts.
7. **Similarity**: node pairs at or above `RENDER_SIM`.
8. **Merge proposals**: pairs at or above `MERGE`, if any.
9. **Since last run**: the impact signals, or "no window yet".

Cells are fragments or one short sentence. Prose lives in `summary` and is shown in the
candidate table's last column.

## Stage 4: the skill

File: `.claude/skills/comb/SKILL.md`. Name: `comb`. Triggers: "run comb", "comb the
sessions", "what should I automate", "update the ontology", "/comb".

Invariants, unchanged in substance:

- Never read a transcript. `~/.claude/projects/**` is off-limits. Inputs are the `comb.mjs`
  output and `comb/ontology.json`.
- Prose tiering: `crossProject: true` nodes may be described freely. Single-project nodes get
  a mechanical description of the `seed` sequence and the numbers.
- Never write `status`. Never edit `candidates.md` or `ontology.json` by hand. Use `annotate`.
- Never decide membership. Merge proposals are reported, not applied.

Workflow:

1. Run `bun comb/comb.mjs`. Add `--all` after a vocabulary change.
2. For each unnamed node in the output: read its `seed`, stats, and member motifs; pick a
   short lowercase name; write a two-sentence `summary`, a one-sentence `tool`, and a `type`
   from {`hook`, `skill`, `script`, `mcp`, `harness`}; run `annotate`.
3. For each unnamed theme: name it from its members; run `annotate`.
4. Report: nodes named this run, merge proposals with a one-line opinion each, the top three
   of the build order with reasoning, and the "since last run" signals. Do not restate the
   table.

## Migration

0. `git clone ~/dev/RnD ~/dev/comb`, check out `feat/comb-ontology`, point `origin` at
   `aidanff/comb`. Delete the two RnD-only docs from comb. Copy `state/processed.json` from
   RnD so the team key and watermarks carry over.
1. Rename the directory, the skill, and the two earlier specs. Done on 2026-09-14.
2. `bun test comb/` must pass before the rebuild, so the closure test covers the new constants.
3. `bun comb/comb.mjs --all --exclude -Users-aidan-dev-RnD` rebuilds the corpus under the new
   vocabulary and records the exclusion. The team key in `state/processed.json` is unchanged,
   so session and project IDs are stable.
4. The first `upsert` clusters every emitted motif from scratch. The 70 rows of per-motif
   prose in the current `candidates.md` are not carried over. All 70 are `Status: new`, so
   no triage is lost. The old file stays in git history.
5. Run the skill once to name the nodes and themes. Commit `ontology.json` and `candidates.md`.

## Docs

| File | Change |
|---|---|
| `README.md` (comb) | rewritten for comb: pipeline, one command, CLI table, corpus scope, redaction. Mirror claim deleted. |
| `README.md` (RnD) | comb section replaced by a pointer to `aidanff/comb` |
| `docs/runbooks/testing-plugins.md` (RnD) | mirror bullet under "Known gaps" deleted; references point to the comb repo |
| `docs/superpowers/specs/2026-08-25-comb-design.md` | one line at top: superseded in part by this spec |
| `docs/superpowers/specs/2026-09-10-comb-tools-docs-plugins.md` | one line at top: phases 1 and 2 land here; 3 and 4 deferred |
| `.claude/skills/comb/SKILL.md` | rewritten per stage 4 |

## Tests

All under `comb/test/`, run with `bun test comb/`.

| File | New assertions |
|---|---|
| `projection.test.mjs` | `Bash(script)`, `Bash(script:validate-all.sh)`, `Bash(uv:run)`, four python shapes, a client script basename emits plain `Bash(script)`, nested directories are not read (fixture with a `subagents/` dir), `--exclude` names are stored in state and skipped on the next run, every new constant is in `VOCABULARY`, AUDIT timeout is on the AUDIT test |
| `motifs.test.mjs` | `correctionRate` counts a 3 s gap and ignores a 19 ms gap; `retryDepth` on a known sequence; `sessions` and `projects` arrays emitted |
| `ontology.test.mjs` | weighted Jaccard values on hand-computed pairs; sticky assignment survives a re-run with a changed motif set; a new motif joins at 0.7 and seeds a node at 0.69; components form nodes; theme matching keeps a name across runs; flow edges from a fixture sequence with known gaps; betweenness on a path graph and a star graph; build order excludes `built`; history replaces same-date entries; impact signals on a fixture history; `upsert` twice preserves every skill and human field; `merge` moves motifs and redirects assignments; `render` is byte-identical on two runs over the same input |
| `comb.test.mjs` | driver runs stages in order against a temp workspace and prints unnamed nodes |

## Gaps closed

From the 2026-09-14 review of the previous version:

| # | Gap | Closed by |
|---|---|---|
| 1 | 85% of transcript files skipped, undocumented | "Corpus scope" and a test |
| 2 | motifs are not candidates; 70 rows for 9 families | node formation, themes, rendered view |
| 3 | every `→ User` motif read as a correction | `correctionRate` with the 2 s floor |
| 4 | `Bash(other)` and `Bash(python3)` opaque | stage 1 constants |
| 5 | false marketplace mirror claim | deleted from README and runbook |
| 6 | AUDIT test cannot pass | timeout moved |
| 7 | triage never started | `status` CLI, build order, impact section give triage a reason to happen |

## Revisions during implementation (2026-09-14)

The first run on the real corpus produced 81 nodes, 41 of them single-motif, and one theme
holding 76 nodes. Aidan restated the goal: grow a sufficiently large yet refined graph of
distinct candidates. Four changes followed. Each replaces the matching text above.

| Section | Change | Reason |
|---|---|---|
| Node formation, step 4 | **Seed-anchored grouping** replaces connected components. The highest-ranked pending motif opens a node; every pending motif at or above `JOIN` to that seed joins it. No transitive chaining. | Components chained motifs through shared tokens. At `JOIN` 0.5, six nodes held 290 motifs. |
| Node formation, new step | **Seed floor.** A motif may open a node only with `SEED_PROJECTS` (3) distinct projects and `SEED_OCCURRENCES` (15) occurrences. Smaller motifs that match nothing wait in `unassigned` and are retried every run. | Removes single-motif nodes without losing evidence. The graph grows as motifs cross the floor. |
| Themes | **Machine-computed themes are removed.** `theme` is a free-text label the skill sets with `annotate --theme`. The Themes table groups nodes by label. `themes`, `nextTheme`, and theme IDs leave the data model. | Single-linkage over token sets produced one giant theme at every threshold, because `git`, `sed`, `User`, and `Bash(other)` connect nearly every node. |
| Thresholds and rendering | `JOIN` 0.5 (was 0.7). `RENDER_FLOW_COUNT` 5 and `RENDER_FLOW_SESSIONS` 3 (were 3 and 2). New `GRAPH_EDGES` 40: the Mermaid graph draws the top 40 flow edges; the Flow table lists all rendered edges. | 0.5 with seed anchoring gave 39 distinct nodes on the 2026-09-14 corpus. A 352-edge Mermaid graph is unreadable. |

Measured on the 2026-09-14 corpus (10,417 steps, 216 sessions, 300 motifs):

| Settings | Nodes | Single-motif | Waiting |
|---|---|---|---|
| spec as written (0.7, components, no floor) | 81 | 41 | 0 |
| 0.6, seed-anchored, floor 3/15 | 52 | 13 | 22 |
| **0.5, seed-anchored, floor 3/15 (adopted)** | **39** | **8** | **16** |

Data model additions: `unassigned: string[]` (upsert-owned). `annotate` accepts `--theme`.

## Open questions

None block implementation. Deferred items are in "Non-goals".
