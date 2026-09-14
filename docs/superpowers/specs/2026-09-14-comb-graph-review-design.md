# comb graph review: an independent pruning stage

Date: 2026-09-14. Branch: `feat/graph-review`. Extends
[`2026-09-14-comb-ontology-design.md`](2026-09-14-comb-ontology-design.md).

## Summary

After the skill names new nodes, a second model instance with no memory of that work reviews
the whole graph and proposes changes. Its explicit goal is to prune candidates that are not
worth building. The deterministic half (`comb/review.mjs`) prints the reviewer's input,
validates its verdict, stores it, and applies or dismisses single proposals on a human's
command. The model half is a brief (`.claude/skills/comb/reviewer.md`) and a dispatch rule
in the skill.

## Why

Node formation is sticky and additive. Once a motif clears the seed floor it opens a node
that only a human `merge` or `status rejected` can remove. The 2026-09-14 corpus has 39
nodes; 8 hold a single motif and several carry a friction share below 0.1%. The naming
model is poorly placed to prune: it just wrote the prose, and its instructions push it to
describe, not to judge. A fresh instance whose only brief is "make this smaller" has no such
bias and no context to be anchored by.

## Goals

- Every `/comb` run ends with a reviewed graph and a short list of prune proposals.
- The reviewer is independent: a fresh agent, input from one CLI command, nothing else.
- Proposals are validated by code before anything is stored. A malformed verdict writes nothing.
- Nothing is applied by a model. `status` stays human-owned.
- A dismissed proposal never comes back.

## Non-goals

- Running the reviewer from the scheduled launchd job. The job runs no model.
- Letting the reviewer see motif, session, or project ids, or any transcript content.
- Automatic acceptance thresholds. A human accepts every prune.
- Pruning by deleting nodes. A prune is `status: rejected`, so the node keeps its history and
  the impact section can produce a re-open signal.

## Pipeline

| Stage | File | Reads | Writes | Model |
|---|---|---|---|---|
| 5. Review | `comb/review.mjs`, `.claude/skills/comb/reviewer.md` | `ontology.json` via `review.mjs input` | `review`, `dismissedReviews` in `ontology.json`; `candidates.md` | a second instance |

Order inside `/comb`: pipeline, name unnamed nodes, review, report.

## Data model

Two fields on the ontology document, both defaulted by `emptyOntology`:

```json
"review": {
  "run": "2026-09-14",
  "proposals": [
    { "id": "R001", "kind": "prune", "node": "N025", "reason": "..." },
    { "id": "R002", "kind": "merge", "node": "N039", "into": "N006", "reason": "..." },
    { "id": "R003", "kind": "edit",  "node": "N031", "fields": { "type": "mcp" }, "reason": "..." }
  ]
},
"dismissedReviews": [ { "kind": "prune", "node": "N025" }, { "kind": "merge", "node": "N039", "into": "N006" } ]
```

`review` is replaced whole on every `record`. Proposal ids restart at `R001` each time.
`upsert` never touches either field. `mergeNodes` drops proposals that name the vanished node.

## The reviewer's input

`review.mjs input` prints one JSON object derived from `ontology.json` only:

- `run`, `corpus`, the seed and merge thresholds, the closed lists (`kinds`, `types`,
  `editableFields`, `proseFields`).
- `nodes`: id, the five descriptive fields, `status`, `class`, `seed`, `motifCount`, the
  stats, `frictionShare` (share of total friction mass, four decimals), and per-run
  `history` of occurrences.
- `flow` at render thresholds, `similarity` at `RENDER_SIM`, `mergeProposals`.
- `dismissed`, and the previous review's proposals without ids.

No motif ids, session ids, or project ids. The test asserts their absence.

## Validation

`validateReview` throws on the first defect so nothing partial is stored:

| Rule | Error |
|---|---|
| `kind` not in `prune`, `merge`, `edit` | kind |
| `node` or `into` not in the ontology | unknown node |
| `reason` empty or over 400 characters | reason |
| `prune` of a node whose status is not `new` | names the status |
| `merge` without `into`, or into itself | into / itself |
| `edit` with no fields, a field outside `ANNOTATABLE`, a bad `type`, or a non-string value | the field |
| `edit` of `summary` or `tool` on a `crossProject: false` node | single-project |
| Two proposals with the same kind and node (and `into` for merge) | duplicate |

A proposal whose key appears in `dismissedReviews` is dropped silently and counted. The key
is `kind|node` for prune and edit, and `merge|node|into` for merge. Dismissing one edit
therefore blocks every later edit on that node: the human is saying "leave this description
alone", not rejecting one wording.

## Human commands

| Command | Effect |
|---|---|
| `review.mjs accept R001` | `prune` calls `setStatus(node, 'rejected')`; `merge` calls `mergeNodes(into, node)`; `edit` calls `annotate(node, fields)`. The proposal is removed. |
| `review.mjs dismiss R001` | The proposal's key is appended to `dismissedReviews` and the proposal is removed. |

Both go through the same functions a human already uses, so no new mutation path exists.

## The skill

Step 3 of the workflow. The skill writes `review.mjs input` to its scratchpad, dispatches one
`general-purpose` agent (never a `fork`, which would inherit the naming context) with
`reviewer.md`, the output path, and the input JSON as its whole prompt, then runs
`review.mjs record --file`. On a validation error it reports the proposal and retries the
agent at most once. The report lists review proposals before machine merge proposals, with
the skill's one-line opinion on each.

The brief tells the reviewer to prune when a node is trivial (friction share below 0.005
and under 40 occurrences), not friction (correction rate below 0.05 on a mandated step), not
actionable, shadowed by a stronger node, or stale; and to keep any node with correction rate
at or above 0.2, retry depth at or above 3, or betweenness at or above 0.3. Those numbers
live in the brief, not in code, so the team can tune aggressiveness without a release. The
hard limits (`PRUNABLE_STATUSES`, `MAX_REASON`, prose tiering) live in code.

## Rendered `candidates.md`

A "Review" section between "Merge proposals" and "Since last run": the run reviewed, the
accept and dismiss commands, and a table of id, kind, node, detail, reason. With no review
recorded it says so.

## Tests

`comb/test/review.test.mjs`: input shape and friction shares summing to 1; no id leakage;
every validation rule above; dismissed filtering; `record` numbering and replacement;
`record` touching no status, name, or assignment; `accept` for each kind; `dismiss`
recording the key; `mergeNodes` cleaning dangling proposals; render section order and
determinism. `comb.test.mjs` asserts `reviewPending` in the driver output.

## Open questions

- Whether to feed the reviewer the previous verdict's accepted proposals as positive
  examples. Deferred until a few runs show whether its calibration drifts.
