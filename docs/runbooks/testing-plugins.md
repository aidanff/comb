# Runbook: testing a plugin after you build it

Scope: plugins in the `pressw-marketplace` monorepo (`~/.claude/plugins/marketplaces/pressw-marketplace`).
Last verified 2026-09-10 against that repo's `.github/workflows/validate.yml`,
`.pre-commit-config.yaml`, and `scripts/`.

## Install the gates once per clone

```sh
uv tool install pre-commit          # or: pipx install pre-commit
pre-commit install --install-hooks -t pre-commit -t pre-push
```

Without this step the commit and push gates never fire locally, and the first
signal you get is a red CI run.

## The four gates

| Gate | Command | Covers |
|---|---|---|
| Local full suite | `scripts/validate-all.sh` (`--all` also tests every connector) | Everything CI runs, in one pass |
| Commit hooks | automatic on `git commit` | Marketplace manifest, markdownlint, connector lint (ruff) |
| Push hooks | automatic on `git push` | Connector `pytest` and `fastmcp inspect`, agent type-check, Skill Atlas sync gate, deal-process docs gate |
| CI | `.github/workflows/validate.yml` on push to `main` and every PR | Six jobs: marketplace, connectors matrix, agents, skill-atlas, deal-process-docs, and pre-commit over all files at both stages |

`scripts/validate-all.sh` is the one command to remember. It mirrors CI on
purpose, so a green local run means a green pipeline.

## Steps after building or changing a plugin

1. If you added, renamed, or moved a plugin, run `node scripts/validate-marketplace.mjs`
   first. A broken manifest makes every later check meaningless.
2. Run `scripts/validate-all.sh` and read the summary block at the end.
3. If the plugin ships a guard hook, add its suite at
   `plugins/<domain>/<plugin>/tests/<name>.test.sh`. `scripts/hooks/guard-tests.sh`
   discovers it by glob, so no registration step exists. The suite must exit
   non-zero on failure.
4. If the plugin ships assets (templates, tokens, scripts), add a deterministic
   check under `plugins/<domain>/<plugin>/evals/` and run it by hand. Warning:
   nothing runs that directory for you. See "What is not covered" below.
5. Run `bunx markdownlint-cli2` if you touched any markdown. The commit hook
   runs it, but only on staged files.
6. If you changed a skill's name, description, or the set of skills in a plugin,
   update `docs/skill-atlas/` in the same commit. The push gate fails otherwise.
7. Before submitting to the marketplace, run the `skill-validator` plugin's
   `vet-and-submit-skill` skill. It runs the duplicate, portability, quality, and
   security gates that CI does not.

## What is covered, and what is not

| Surface | Convention | Runs automatically? |
|---|---|---|
| Guard-hook suites | `plugins/*/*/tests/*.test.sh` | Yes. `guard-tests.sh`, from both `validate-all.sh` and CI |
| Connectors | `connectors/*/` with ruff, pytest, `fastmcp inspect` | Yes. Push hook and CI matrix |
| Agents | `agents/<runtime>/<name>/` | Yes. Type-check on push and in CI |
| Skill budgets | `scripts/hooks/skill-budget-checks.sh` | Yes. `validate-all.sh` and CI |
| Plugin asset evals | `plugins/*/*/evals/` | No. Manual only |
| Plugin behavior | `claude plugin eval` cases | No cases exist |

Two eval directories exist today, and both are hand-run:

```sh
plugins/communication/pressw-artifacts/evals/run_checks.sh    # palette, self-containment, map anchors, scaffolder
python3 plugins/engineering/make-it-better/evals/run_trigger_eval.py
python3 plugins/engineering/make-it-better/evals/run_verdict_eval.py
```

## Behavioral evals are available but unadopted

`claude plugin eval <target>` runs case-based behavioral evals from
`evals/**/case.yaml` plus `graders/*.md`, and it can add a no-plugin baseline arm
with `--ablation with-without` to report the score delta the plugin actually
causes. The CLI is present and working in this environment.

The marketplace contains zero cases and no `case.yaml` files, so no plugin's
behavior is tested anywhere today. Adopting this harness is an open decision, not
a step in this runbook.

## Known gaps, 2026-09-10

- 16 of 21 plugins have no `tests/` or `evals/` directory at all.
- No aggregate runner executes `plugins/*/*/evals/`, so those checks pass or fail
  only when a human remembers them.
- No `claude plugin eval` cases exist, so prose and trigger behavior are unguarded.
- The spotter scripts in the `RnD` repo are mirrored into
  `plugins/toolcraft/automation-spotter/skills/automation-spotter/scripts/`. The
  mirror is manual and nothing fails when the two copies drift.

## Appendix: how tests actually get run in sessions

Evidence source: the `automation-spotter` skill, run on 2026-09-10. Corpus after
that run: 8,975 steps across 194 sessions and 65 project directories, 1,998 motifs
found, top 60 emitted. Figures below come from the emitted motifs plus counts over
the committed redacted corpus, `automation-spotter/.work/skeletons.jsonl`. No
transcript was read at any point.

What the corpus shows:

| Measure | Value |
|---|---|
| Runner steps | 1,641 |
| Sessions containing at least one runner step | 139 of 194 main-chain sessions |
| `Bash(pytest)`, `Bash(npm)`, `Bash(npx)`, `Bash(just)`, `Bash(python)` | 0 occurrences each |
| Tokens the runs actually appear as | `Bash(other)` 865, `Bash(python3)` 672, `Bash(uv)` 68, `Bash(bun)` 18, `Bash(node)` 11, `Bash(uvx)` 5, `Bash(make)` 2 |
| Back-to-back re-run streaks of length 2 or more | 311 total: 101 pairs of `Bash(other)`, 69 pairs of `Bash(python3)`, 37 triples of `Bash(other)`, 33 triples of `Bash(python3)`, with a tail out to seven in a row |
| A run followed immediately by a human turn | 139 times |
| A run started immediately after a human turn | 136 times |

The same pattern in the skill's own ranked output, with median wall-clock per
occurrence:

| Motif | Sequence | Occurrences | Engagements | Median |
|---|---|---|---|---|
| `MFF42D` | `Bash(other) → User` | 113 | 26 | 183s |
| `M4EB84` | `Bash(other)` repeated (cycle) | 326 | 22 | 16s |
| `M82C6C` | `Bash(python3)` repeated (cycle) | 319 | 23 | 14s |
| `M8E6CC` | `Bash(other) → User → Bash(other)` | 35 | 13 | 212s |
| `M01E0B` | `Bash(other) → Bash(other) → User` | 29 | 13 | 208s |
| `M5D78D` | `Bash(python3) → User` | 54 | 19 | 183s |

Four readings, in order of consequence:

1. **The test workflow is invisible to the spotter, and widening the verb allowlist
   cannot fix it.** All twelve candidate runner verbs are already members of
   `BASH_VERBS`, so a zero is a genuine absence rather than an unrecognized-command
   collapse. Every test command in these repos is either a path invocation
   (`scripts/validate-all.sh`, `evals/run_checks.sh`, `scripts/hooks/guard-tests.sh`)
   or a wrapper (`uv run pytest`, `python3 evals/check_palette.py`). `projectBash`
   reads the head token only and fails closed on any path, so the whole testing loop
   lands in `Bash(other)` or under the interpreter name. This disproves the advice
   the spotter itself wrote against `MFF42D` in an earlier run, and that row is now
   corrected. The fix is a projection change: see
   `docs/superpowers/specs/2026-09-10-spotter-tools-docs-plugins.md`.
2. **The real runner in these sessions is `python3`, not a test framework.** The
   eval scripts are python and get run one file at a time. That matches the gap
   above: no aggregate runner exists, so the loop is manual by construction.
3. **Runs repeat back to back constantly.** More than 290 observed runs are part
   of a re-run streak of two or more. That is the edit-run-edit loop, and it is
   the strongest argument for one aggregate command plus this runbook.
4. **The operator interprets failures, not the harness.** A run is followed by a
   human turn 139 times, and `MFF42D` puts the median gap at 183 seconds. A pass or
   fail summary that a human has to read and translate is the current interface.

One caution on reading the correction motifs. `M45638` (`Skill(other) → User`, 51
occurrences across 28 engagements) has a 19ms median, which is below human reaction
time. A `Skill` call is followed by a same-instant `user` record because the skill
body arrives as a user-role message, and `projectLines` counts any non-tool-result
user record as `User`. It is a measurement artifact, not a correction, and the
candidates row now says so.
