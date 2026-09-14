# Extending comb to tools, docs, and plugins

> Phases 1 and 2 landed through `2026-09-14-comb-ontology-design.md`. Phases 3 and 4 (`inventory.mjs`, `docsmap.mjs`) stay deferred behind the internal-repo allowlist decision.

Status: design, not built. 2026-09-10.
Source: conversation with Roman on 2026-09-10. Companion to
`2026-08-25-comb-design.md` and `docs/runbooks/testing-plugins.md`.

## What changes

comb produces one kind of answer today: build a tool. Roman asked for three,
because two of them are cheaper than building anything.

| Class | The finding | The output |
|---|---|---|
| `tool` | The workflow gets this wrong unaided, or the operator retries it. | A hook, skill, script, MCP server, or harness change. Today's `candidates.md` row. |
| `doc` | People do this correctly every time, and re-derive it from scratch every time. | A runbook under `docs/runbooks/`, a `DICTIONARY.md` entry, or a `CLAUDE.md` rule. |
| `plugin` | A plugin or skill that should own this already exists, and it did not fire. | An extension to that plugin, or a fix to its trigger description. |

Nothing about the corpus changes for the first two classes. The same motif data
answers all three questions once the miner records two more fields.

## Why the current design can only say "tool"

Three reasons, all fixable in the existing files.

1. **The miner records no correction signal.** A motif carries `occurrences`,
   `distinctSessions`, `distinctProjects`, and `medianElapsedMs`. Whether the human
   had to step in is visible only when `User` happens to sit inside the n-gram.
   Without a correction rate, a smooth ritual and a broken loop look alike.
2. **Repo scripts are indistinguishable from unknown commands.** `projectBash` fails
   closed on any path-like head, so `./scripts/validate-all.sh` and an unrecognized
   client script both emit `Bash(other)`. That token carries 865 of 8,975 steps and
   is the top candidate row. The entire test workflow hides inside it. See the
   appendix of `docs/runbooks/testing-plugins.md` for the measurement.

   Measured on 2026-09-10, this is now proven rather than suspected. All twelve
   plausible test-runner verbs are already members of `BASH_VERBS`, and `pytest`,
   `npm`, `npx`, `just` and `python` score zero steps each, while `uv` (68), `bun`
   (18), `node` (11), `uvx` (5) and `make` (2) fall below the miner's thresholds. So
   widening the verb allowlist cannot surface the test workflow. Only the path-head
   projection can.
3. **The tool has no inventory of what already exists.** It cannot propose "extend
   this plugin" because it does not know which plugins, skills, hooks, or agents the
   marketplace holds, nor which of them ever fired in a session.

## The discriminator

Two axes split a motif into one of the three classes. Both are computable from the
existing per-session step sequences.

- `correctionRate`: the fraction of a motif's occurrences whose next step is `User`,
  counting only those where at least two seconds separate the two records.
- `retryDepth`: the longest run of back-to-back repeats of the motif in one session.

The latency floor is not optional. The 2026-09-10 run emitted `M45638`
(`Skill(other) → User`, 51 occurrences across 28 engagements) with a 19ms median,
and the skill's report called it the widest-spread correction in the corpus. It is
not a correction at all: a `Skill` call is followed by a same-instant `user` record
because the skill body arrives as a user-role message, and `projectLines` counts any
non-tool-result user record as `User`. Without a floor, `correctionRate` would rank
every skill invocation in the corpus as friction.

| Condition | Class | Reasoning |
|---|---|---|
| `correctionRate` high, or `retryDepth` at 3 or more | `tool` | The agent cannot finish this unaided. Friction the operator felt. |
| `correctionRate` near zero, `crossProject: true`, high `occurrences` | `doc` | Repeated, correct, and re-derived. Write it down instead of building it. |
| The motif contains or sits beside a `Skill(...)`, `Task(...)`, or `Mcp(...)` token that already owns the work | `plugin` | Extend the owner. A new tool would duplicate it. |
| A skill exists for the work but appears in no motif | `plugin` | Trigger failure, not a missing capability. Fix the description. |

The last row is the one that needs the new inventory input. The first three need
only the two new fields.

## Two new inputs, kept out of the closed corpus

The redaction guarantee holds because every string in `skeletons.jsonl` is a member
of an enumerable vocabulary, and `test/projection.test.mjs` asserts that over the
whole corpus. Repo-derived strings (script names, skill names, doc headings) are
real bytes from real files, so mixing them into the skeleton corpus would break that
assertion and weaken the security control.

So they stay in a separate file that the skill reads alongside `motifs.json`:

- `inventory.mjs` reads the marketplace and produces `.work/inventory.json`: every
  plugin, skill, hook, agent, connector, and its trigger description. The plugin
  input.
- `docsmap.mjs` reads an internal repo and produces `.work/docsmap.json`: every
  command named in `scripts/`, `Makefile`, `package.json`, CI workflows, and
  existing runbooks. The docs input.

**Scope rule, non-negotiable.** Both scripts run against an explicit allowlist of
PressW-internal repositories only. A client repository's script and directory names
are client data. Scanning one would put client-identifying strings into a file that
sits next to the safe corpus, which is exactly the leak the projector exists to
prevent. The allowlist lives in the script, not in an environment variable.

The docs input answers two questions by set difference:

- A command sessions run that no doc names is a runbook gap.
- A command a doc names that no session runs is a dead instruction.

## Changes by file

| File | Change |
|---|---|
| `vocabulary.mjs` | Add one constant, `Bash(script)`, and emit it for a path-like head instead of `Bash(other)`. The token is a constant, so the closure property is unchanged. This alone splits the largest noise bucket into "our own script" and "genuinely unknown". |
| `vocabulary.mjs` | Add an `INTERNAL_SCRIPTS` allowlist of our own script basenames (`validate-all.sh`, `run_checks.sh`, `guard-tests.sh`, `agent-checks.sh`, `connector-checks.sh`, `skill-budget-checks.sh`, `delivery.sh`) and emit `Bash(script:validate-all.sh)` when a path-like head's basename matches an entry. This is the same match-and-emit-a-constant pattern as `BASH_VERBS`: no basename is ever sliced out of the input, so a client script name can never be emitted. A client repo whose script happens to share one of these names would be mis-attributed to us, which is an analysis error and not a disclosure. Without this entry, `Bash(script)` says a repo script ran but never which one, and the test question stays unanswerable. |
| `vocabulary.mjs` | Add a small second-token allowlist (`run`, `test`, `check`, `lint`, `build`, `install`) so `uv run pytest` emits `Bash(uv:run)`. Second tokens are matched against the allowlist and emitted as constants, never sliced from input. |
| `motifs.mjs` | Record `correctionRate` and `retryDepth` per motif. Both come from the sequences already built in `buildSequences`. |
| `motifs.mjs` | Emit a `class` field of `tool`, `doc`, or `plugin` from the discriminator table above. |
| `candidates.md` | Add a `Class` column. Keep `Type` as the tool subtype it already is. Existing rows default to `tool`. |
| `.claude/skills/comb/SKILL.md` | Three upsert sections instead of one table. A `doc` candidate must land as a runbook stub under `docs/runbooks/`, named and empty, rather than as a table row that no one can act on. |
| `test/projection.test.mjs` | No change. The new tokens are constants, so the closure assertion covers them once `buildVocabulary` lists them. |

## Phases

Ordered so that each phase is useful on its own and none blocks on the next.

1. **Split `Bash(other)`.** Add `Bash(script)`, the `INTERNAL_SCRIPTS` basename
   allowlist, and the second-token allowlist, then
   `bun comb/project.mjs --all` and re-run the miner. This is a
   one-file change that unblocks the top three candidate rows (`MFF42D`, `M4EB84`,
   `M01E0B`), all of which are currently blocked on naming the command. Do this
   first, and run `bun test comb/` before the rebuild so the closure
   assertion covers the new constants.
2. **Add the two signals.** `correctionRate` and `retryDepth` in the miner, plus the
   `Class` column. Re-rank and re-triage `candidates.md`.
3. **Add the plugin inventory.** `inventory.mjs`, then the join at report time. This
   is what turns "build a tool" into "extend `delivery-loop`" or "fix this skill's
   trigger".
4. **Add the docs map.** `docsmap.mjs` and the set difference. Output is a list of
   runbook stubs, which is what Roman asked for.

Phases 1 and 2 are internal to this repo and need no allowlist decision. Phases 3
and 4 read other repositories, so the scope rule above must be settled before
either lands.

## Open questions

- Which repositories go on the internal allowlist for phases 3 and 4? The
  marketplace and this repo are obvious. Nothing else is decided.
- Does a `doc` candidate get written by the skill, or only proposed? Writing an
  empty stub is safe. Writing the body means the skill authors documentation from
  motif data alone, which it cannot verify.
- Should the second-token allowlist include bare `pytest` and `test`? It would name
  the work precisely and costs one constant each, but each addition widens the
  vocabulary that the closure test has to enumerate.
