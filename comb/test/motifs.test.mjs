import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSequences, findCycles, findRituals, collapseSubsumed, analyze, motifId } from '../motifs.mjs';

const step = (s, o = {}) => ({ step: s, session: o.session ?? 's1', project: o.project ?? 'p1', sidechain: false, ts: o.ts ?? null });
const seqOf = (tokens, o = {}) => tokens.map((t, i) => step(t, { ...o, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));

describe('buildSequences', () => {
  test('drops scaffolding and low-signal inspection verbs', () => {
    const steps = seqOf(['Bash(ls)', 'Bash(git)', 'Bash(cat)', 'Bash(noise)', 'Bash(pytest)']);
    const [seq] = buildSequences(steps);
    assert.deepEqual(seq.steps.map((s) => s.step), ['Bash(git)', 'Bash(pytest)']);
  });

  test('separates sidechain from main-chain work', () => {
    const steps = [step('Bash(git)'), { ...step('Bash(git)'), sidechain: true }];
    assert.equal((buildSequences(steps)).length, 2);
  });

  test('orders by timestamp when present', () => {
    const steps = [
      step('Bash(pytest)', { ts: '2026-01-01T00:00:05Z' }),
      step('Bash(git)', { ts: '2026-01-01T00:00:01Z' }),
    ];
    const [seq] = buildSequences(steps);
    assert.deepEqual(seq.steps.map((s) => s.step), ['Bash(git)', 'Bash(pytest)']);
  });
});

describe('findCycles', () => {
  test('detects an (A B)+ trial-and-error loop', () => {
    const toks = ['Bash(terraform)', 'Edit(.tf)', 'Bash(terraform)', 'Edit(.tf)', 'Bash(terraform)', 'Edit(.tf)'];
    const cycles = [...findCycles(buildSequences(seqOf(toks)), 3).values()];
    const m = cycles.find((c) => c.sequence.join('>') === 'Bash(terraform)>Edit(.tf)');
    assert.notEqual(m, undefined);
    assert.equal(m.occurrences, 3);
  });

  test('ignores runs shorter than the repeat threshold', () => {
    const cycles = [...findCycles(buildSequences(seqOf(['Bash(git)', 'Edit(.py)', 'Bash(git)', 'Edit(.py)'])), 3).values()];
    assert.equal((cycles).length, 0);
  });

  test('consecutive human turns are never a cycle', () => {
    const cycles = [...findCycles(buildSequences(seqOf(['User', 'User', 'User', 'User'])), 3).values()];
    assert.equal((cycles).length, 0);
  });
});

describe('findRituals', () => {
  test('requires recurrence across distinct sessions', () => {
    const a = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'a' });
    const b = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'b' });
    const one = [...findRituals(buildSequences(a), 2).values()];
    const two = [...findRituals(buildSequences([...a, ...b]), 2).values()];
    assert.equal((one).length, 0);
    assert.ok((two.length) > 0);
  });
});

describe('collapseSubsumed', () => {
  test('drops a shorter motif fully contained in a longer one with equal support', () => {
    const long = { id: 'L', kind: 'ritual', sequence: ['A', 'B', 'C'], occurrences: 5 };
    const short = { id: 'S', kind: 'ritual', sequence: ['A', 'B'], occurrences: 5 };
    assert.deepEqual(collapseSubsumed([long, short]).map((m) => m.id), ['L']);
  });

  test('keeps a shorter motif that occurs more often than the longer one', () => {
    const long = { id: 'L', kind: 'ritual', sequence: ['A', 'B', 'C'], occurrences: 5 };
    const short = { id: 'S', kind: 'ritual', sequence: ['A', 'B'], occurrences: 9 };
    assert.deepEqual(collapseSubsumed([long, short]).map((m) => m.id).sort(), ['L', 'S']);
  });
});

describe('analyze', () => {
  test('flags cross-project motifs for prose tiering', () => {
    const a = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'a', project: 'p1' });
    const b = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'b', project: 'p2' });
    const single = seqOf(['Bash(uv)', 'Bash(ruff)'], { session: 'c', project: 'p3' })
      .concat(seqOf(['Bash(uv)', 'Bash(ruff)'], { session: 'd', project: 'p3' }));

    const { motifs } = analyze([...a, ...b, ...single], { minSessions: 2 });
    const cross = motifs.find((m) => m.sequence.join('>') === 'Bash(git)>Bash(pytest)');
    const same = motifs.find((m) => m.sequence.join('>') === 'Bash(uv)>Bash(ruff)');
    assert.equal(cross.crossProject, true);
    assert.equal(same.crossProject, false);
  });

  test('motif ids are stable across runs', () => {
    assert.equal(motifId(['Bash(git)', 'Edit(.py)']), motifId(['Bash(git)', 'Edit(.py)']));
  });

  test('respects the emitted-motif cap while reporting the true total', () => {
    // Distinct pairs, each recurring in two sessions -> three separable motifs.
    const pairs = [['Bash(git)', 'Bash(pytest)'], ['Bash(uv)', 'Bash(docker)'], ['Bash(make)', 'Bash(terraform)']];
    const steps = [];
    pairs.forEach((pair, i) => {
      steps.push(...seqOf(pair, { session: `s${i}a`, project: `p${i}a` }));
      steps.push(...seqOf(pair, { session: `s${i}b`, project: `p${i}b` }));
    });
    const r = analyze(steps, { minSessions: 2, maxMotifs: 2 });
    assert.equal((r.motifs).length, 2);
    assert.equal(r.motifsFound, 3);
  });
});

describe('correction and retry signals', () => {
  const at = (tokens, secondsList, o = {}) => tokens.map((t, i) => step(t, { ...o, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, secondsList[i])).toISOString() }));

  test('correctionRate counts a User step 2s or more after the motif, not a same-instant one', () => {
    // Session a: motif then User 3s later (counts). Session b: motif then User at the same
    // instant (does not). Session c: no User, so the pair outnumbers the 3-gram and survives
    // collapseSubsumed.
    const a = at(['Bash(git)', 'Bash(pytest)', 'User'], [0, 1, 4], { session: 'a' });
    const b = at(['Bash(git)', 'Bash(pytest)', 'User'], [0, 1, 1], { session: 'b' });
    const c = at(['Bash(git)', 'Bash(pytest)'], [0, 1], { session: 'c' });
    const { motifs } = analyze([...a, ...b, ...c], { minSessions: 2 });
    const m = motifs.find((x) => x.sequence.join('>') === 'Bash(git)>Bash(pytest)');
    assert.equal(m.correctionRate, 0.333);
  });

  test('retryDepth is the longest back-to-back repeat in one session', () => {
    const toks = ['Bash(uv)', 'Bash(uv)', 'Bash(uv)', 'Bash(uv)', 'Edit(.py)', 'Bash(uv)', 'Bash(uv)'];
    const { motifs } = analyze(seqOf(toks, { session: 'a' }).concat(seqOf(toks, { session: 'b' })), { minSessions: 2, minCycles: 2 });
    const m = motifs.find((x) => x.kind === 'cycle' && x.sequence.join('>') === 'Bash(uv)');
    assert.equal(m.retryDepth, 4);
  });

  test('emits session and project id arrays', () => {
    const a = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'a', project: 'p1' });
    const b = seqOf(['Bash(git)', 'Bash(pytest)'], { session: 'b', project: 'p2' });
    const { motifs } = analyze([...a, ...b], { minSessions: 2 });
    const m = motifs.find((x) => x.sequence.join('>') === 'Bash(git)>Bash(pytest)');
    assert.deepEqual(m.sessions.sort(), ['a', 'b']);
    assert.deepEqual(m.projects.sort(), ['p1', 'p2']);
  });

  test('default cap is 300', () => {
    assert.equal(analyze([], {}).thresholds.maxMotifs, 300);
  });
});
