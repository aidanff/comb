# RnD

Internal R&D for PressW MSP-division developer tooling.

## automation-spotter

Mines past Claude Code sessions for recurring action patterns and maintains a ranked list
of automation candidates in [`candidates.md`](./candidates.md).

```sh
bun automation-spotter/project.mjs    # transcripts -> redacted action skeletons
bun automation-spotter/motifs.mjs     # skeletons  -> ranked motifs
bun test automation-spotter/          # includes the redaction audit
```

Then run the `automation-spotter` skill to interpret the motifs and update `candidates.md`.

### How the redaction works

The projector **never copies bytes** from a transcript into its output. Transcript
content is used only to *select* a constant from the tables in `vocabulary.mjs`; anything
unrecognized selects a fallback constant. The set of strings the projector can emit is
therefore finite and enumerable (currently 525), which turns "did we leak anything?" into
a mechanical assertion:

> `test/projection.test.mjs` runs the projector over the entire real transcript corpus and
> asserts every emitted token is a member of the closed vocabulary.

That test is the security control. No model ever sees raw transcript data — the skill's
inputs are the projected motifs only.

### The corpus is committed

`automation-spotter/.work/skeletons.jsonl` is checked in. It is safe by construction —
every token in it is a member of the closed vocabulary, and session/project identifiers
are salted hashes whose salt lives only in the gitignored `state/`. Committing it makes
the corpus durable: it survives transcript pruning by Claude Code, machine changes, and
can be pooled across the team. Motif output is regenerated on each run and stays ignored.

Design: [`docs/superpowers/specs/2026-08-25-automation-spotter-design.md`](./docs/superpowers/specs/2026-08-25-automation-spotter-design.md)
