import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, similarity, emptyOntology, indexMotifs, assignMotifs, nodeTokens,
  computeThemes, computeStats, classify,
} from '../ontology.mjs';

const motif = (id, sequence, o = {}) => ({
  id, kind: o.kind ?? 'ritual', sequence, length: sequence.length,
  occurrences: o.occurrences ?? 10, distinctSessions: o.sessions?.length ?? 2,
  distinctProjects: o.projects?.length ?? 2, sidechain: false,
  crossProject: (o.projects?.length ?? 2) >= 2, medianElapsedMs: o.median ?? 1000,
  rank: o.rank ?? 10, correctionRate: o.correctionRate ?? 0, retryDepth: o.retryDepth ?? 1,
  sessions: o.sessions ?? ['s1', 's2'], projects: o.projects ?? ['p1', 'p2'],
});

describe('similarity — weighted Jaccard', () => {
  test('identical sets score 1, disjoint sets score 0', () => {
    assert.equal(similarity(new Set(['A', 'B']), new Set(['B', 'A'])), 1);
    assert.equal(similarity(new Set(['A']), new Set(['B'])), 0);
  });
  test('User weighs half', () => {
    // {sed, User} vs {git, User}: intersection 0.5, union 2.5
    assert.equal(similarity(new Set(['Bash(sed)', 'User']), new Set(['Bash(git)', 'User'])), 0.2);
    // {python3, User} vs {python3}: 1 / 1.5
    assert.equal(Number(similarity(new Set(['Bash(python3)', 'User']), new Set(['Bash(python3)'])).toFixed(3)), 0.667);
  });
  test('repeat counts do not matter because inputs are sets', () => {
    assert.equal(similarity(new Set(['Mcp(linear)', 'User']), new Set(['Mcp(linear)', 'User'])), 1);
  });
});

describe('assignMotifs — sticky node formation', () => {
  test('motifs at or above JOIN share a node; below it they seed separate nodes', () => {
    const o = emptyOntology();
    const ms = [
      motif('M1', ['Bash(grep)', 'Bash(sed)'], { rank: 30 }),
      motif('M2', ['Bash(sed)', 'Bash(grep)', 'Bash(sed)'], { rank: 20 }),   // 1.0 to M1
      motif('M3', ['ToolSearch', 'Mcp(linear)'], { rank: 10 }),               // 0 to both
    ];
    indexMotifs(o, ms);
    const { created } = assignMotifs(o, ms, '2026-09-14');
    assert.deepEqual(created, ['N001', 'N002']);
    assert.equal(o.assignments.M1, 'N001');
    assert.equal(o.assignments.M2, 'N001');
    assert.equal(o.assignments.M3, 'N002');
    assert.deepEqual(o.nodes.N001.seed, ['Bash(grep)', 'Bash(sed)']);
    assert.equal(o.nodes.N001.created, '2026-09-14');
  });

  test('existing assignments never move, even when a better node appears later', () => {
    const o = emptyOntology();
    const first = [motif('M1', ['Bash(grep)', 'Bash(sed)'])];
    indexMotifs(o, first); assignMotifs(o, first, '2026-09-14');
    o.assignments.M1 = 'N001';
    const second = [motif('M1', ['Bash(grep)', 'Bash(sed)']), motif('M9', ['Bash(grep)', 'Bash(sed)', 'Bash(grep)'])];
    indexMotifs(o, second);
    const { created } = assignMotifs(o, second, '2026-09-15');
    assert.deepEqual(created, []);
    assert.equal(o.assignments.M9, 'N001');
    assert.equal(o.assignments.M1, 'N001');
  });

  test('a new motif joins the existing node it matches at 0.7, and seeds a node at 0.69', () => {
    const o = emptyOntology();
    const base = [motif('M1', ['A', 'B', 'C'])];
    indexMotifs(o, base); assignMotifs(o, base, '2026-09-14');
    // {A,B,C,D} vs {A,B,C}: 3/4 = 0.75 joins. {A,B,X,Y} vs {A,B,C}: 2/5 = 0.4 seeds.
    const next = [...base, motif('M2', ['A', 'B', 'C', 'D']), motif('M3', ['A', 'B', 'X', 'Y'])];
    indexMotifs(o, next);
    const { created } = assignMotifs(o, next, '2026-09-15');
    assert.equal(o.assignments.M2, 'N001');
    assert.equal(o.assignments.M3, 'N002');
    assert.deepEqual(created, ['N002']);
  });

  test('a motif absent from the new motif set keeps its assignment and its tokens', () => {
    const o = emptyOntology();
    const base = [motif('M1', ['A', 'B'])];
    indexMotifs(o, base); assignMotifs(o, base, '2026-09-14');
    indexMotifs(o, []); assignMotifs(o, [], '2026-09-15');
    assert.equal(o.assignments.M1, 'N001');
    assert.deepEqual([...nodeTokens(o, 'N001')].sort(), ['A', 'B']);
  });
});

describe('computeThemes', () => {
  test('nodes at or above THEME share a theme; names persist across runs by member overlap', () => {
    const o = emptyOntology();
    const ms = [
      motif('M1', ['Bash(grep)', 'Bash(sed)'], { rank: 40 }),
      motif('M2', ['Bash(sed)', 'Bash(python3)'], { rank: 30 }),        // 1/3 = 0.33 to N001 -> same theme
      motif('M3', ['ToolSearch', 'Mcp(linear)'], { rank: 20 }),          // 0 -> other theme
    ];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeThemes(o);
    assert.equal(Object.keys(o.themes).length, 2);
    assert.equal(o.nodes.N001.theme, o.nodes.N002.theme);
    assert.notEqual(o.nodes.N001.theme, o.nodes.N003.theme);
    const tid = o.nodes.N001.theme;
    o.themes[tid].name = 'editing';
    computeThemes(o);
    assert.equal(o.themes[tid].name, 'editing');
    assert.equal(o.nodes.N001.theme, tid);
  });
});

describe('computeStats and classify', () => {
  test('aggregates member motifs', () => {
    const o = emptyOntology();
    const ms = [
      motif('M1', ['A', 'B'], { occurrences: 10, median: 1000, correctionRate: 0.4, retryDepth: 1, sessions: ['s1', 's2'], projects: ['p1'] }),
      motif('M2', ['B', 'A', 'B'], { occurrences: 30, median: 3000, correctionRate: 0.2, retryDepth: 5, sessions: ['s2', 's3'], projects: ['p2'] }),
    ];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeStats(o, new Map(ms.map((m) => [m.id, m])));
    const s = o.nodes.N001.stats;
    assert.equal(s.occurrences, 40);
    assert.equal(s.distinctSessions, 3);
    assert.equal(s.distinctProjects, 2);
    assert.equal(s.crossProject, true);
    assert.equal(s.medianElapsedMs, 3000);            // occurrence-weighted median of {1000 x10, 3000 x30}
    assert.equal(s.correctionRate, 0.25);             // (0.4*10 + 0.2*30) / 40
    assert.equal(s.retryDepth, 5);
    assert.equal(s.frictionMassMs, 10 * 1000 + 30 * 3000);
    assert.equal(o.nodes.N001.class, 'tool');
  });
  test('classify follows the discriminator table', () => {
    assert.equal(classify({ correctionRate: 0.3, retryDepth: 1, crossProject: false, occurrences: 5 }), 'tool');
    assert.equal(classify({ correctionRate: 0.0, retryDepth: 3, crossProject: false, occurrences: 5 }), 'tool');
    assert.equal(classify({ correctionRate: 0.05, retryDepth: 1, crossProject: true, occurrences: 25 }), 'doc');
    assert.equal(classify({ correctionRate: 0.15, retryDepth: 1, crossProject: true, occurrences: 25 }), 'unclassified');
  });
});

import { computeFlow, computeSimilarityEdges, computeCentrality, recordHistory, impactSignals, mergeProposals, upsert } from '../ontology.mjs';
import { buildSequences } from '../motifs.mjs';

const stepAt = (s, sec, o = {}) => ({ step: s, session: o.session ?? 's1', project: o.project ?? 'p1', sidechain: false, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() });

describe('computeFlow', () => {
  test('counts transitions between nodes inside a session, with the gap between them', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B'], { rank: 20 }), motif('M2', ['X', 'Y'], { rank: 10 })];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    // A B (end t=1) ... X Y (start t=41) -> gap 40s. Then A B again -> X Y -> A B.
    const steps = [
      stepAt('A', 0), stepAt('B', 1), stepAt('X', 41), stepAt('Y', 42),
      stepAt('A', 50), stepAt('B', 51), stepAt('X', 60), stepAt('Y', 61), stepAt('A', 70), stepAt('B', 71),
      stepAt('A', 0, { session: 's2' }), stepAt('B', 1, { session: 's2' }), stepAt('X', 5, { session: 's2' }), stepAt('Y', 6, { session: 's2' }),
    ];
    computeFlow(o, buildSequences(steps));
    const ab = o.flow.find((e) => e.from === 'N001' && e.to === 'N002');
    const ba = o.flow.find((e) => e.from === 'N002' && e.to === 'N001');
    assert.equal(ab.count, 3);
    assert.equal(ab.sessions, 2);
    assert.equal(ab.medianGapMs, 9000);   // gaps 40000, 9000, 4000 -> median 9000
    assert.equal(ba.count, 2);
    assert.equal(ba.sessions, 1);
  });
  test('consecutive occurrences of the same node collapse', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B'])];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeFlow(o, buildSequences([stepAt('A', 0), stepAt('B', 1), stepAt('A', 2), stepAt('B', 3)]));
    assert.deepEqual(o.flow, []);
  });
});

describe('computeSimilarityEdges', () => {
  test('stores node pairs with weight above zero, sorted by weight', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B'], { rank: 30 }), motif('M2', ['B', 'C'], { rank: 20 }), motif('M3', ['X'], { rank: 10 })];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeSimilarityEdges(o);
    assert.deepEqual(o.similarity, [{ a: 'N001', b: 'N002', weight: 0.333 }]);
  });
});

describe('computeCentrality', () => {
  test('betweenness on a path: the middle node is 1, ends are 0; degree sums counts', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A'], { rank: 30 }), motif('M2', ['B'], { rank: 20 }), motif('M3', ['C'], { rank: 10 })];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeStats(o, new Map(ms.map((m) => [m.id, m])));
    o.flow = [
      { from: 'N001', to: 'N002', count: 5, sessions: 3, medianGapMs: 0 },
      { from: 'N002', to: 'N003', count: 4, sessions: 2, medianGapMs: 0 },
      { from: 'N003', to: 'N001', count: 1, sessions: 1, medianGapMs: 0 },   // below render threshold, ignored
    ];
    computeCentrality(o);
    assert.equal(o.nodes.N002.stats.betweenness, 1);
    assert.equal(o.nodes.N001.stats.betweenness, 0);
    assert.equal(o.nodes.N002.stats.weightedDegree, 9);
    assert.equal(o.nodes.N002.stats.buildScore, o.nodes.N002.stats.frictionMassMs * 2);
    assert.equal(o.nodes.N001.stats.buildScore, o.nodes.N001.stats.frictionMassMs);
  });
});

describe('recordHistory and impactSignals', () => {
  const seeded = () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B'], { rank: 20 }), motif('M2', ['X'], { rank: 10 })];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    return o;
  };
  test('one entry per run date; same date replaces', () => {
    const o = seeded();
    o.nodes.N001.stats = { occurrences: 10, distinctSessions: 4 }; o.corpus.sessions = 100;
    recordHistory(o, '2026-09-14');
    o.nodes.N001.stats = { occurrences: 12, distinctSessions: 5 };
    recordHistory(o, '2026-09-14');
    assert.deepEqual(o.nodes.N001.history, [{ run: '2026-09-14', occurrences: 12, distinctSessions: 5 }]);
    assert.deepEqual(o.runs, [{ run: '2026-09-14', sessions: 100 }]);
  });
  test('no window with fewer than two runs', () => {
    const o = seeded();
    o.nodes.N001.stats = { occurrences: 10, distinctSessions: 4 }; o.corpus.sessions = 100;
    recordHistory(o, '2026-09-14');
    assert.deepEqual(impactSignals(o), { window: null, signals: [] });
  });
  test('confirmed win, displacement, and re-open', () => {
    const o = seeded();
    o.nodes.N001.status = 'built'; o.nodes.N002.status = 'rejected';
    o.flow = [{ from: 'N001', to: 'N002', count: 5, sessions: 3, medianGapMs: 0 }];
    // Run 1: 100 sessions. N001 50 occ (0.5/session), N002 10 occ (0.1/session).
    o.corpus.sessions = 100; o.nodes.N001.stats = { occurrences: 50 }; o.nodes.N002.stats = { occurrences: 10 };
    recordHistory(o, '2026-09-14');
    // Run 2: +20 sessions. N001 +2 (0.1/session, down 80%). N002 +10 (0.5/session, up 400%).
    o.corpus.sessions = 120; o.nodes.N001.stats = { occurrences: 52 }; o.nodes.N002.stats = { occurrences: 20 };
    recordHistory(o, '2026-09-15');
    const { window, signals } = impactSignals(o);
    assert.deepEqual(window, { from: '2026-09-14', to: '2026-09-15', sessions: 20 });
    const kinds = signals.map((s) => `${s.kind}:${s.node}`).sort();
    assert.deepEqual(kinds, ['confirmed-win:N001', 'displacement:N001', 're-open:N002']);
  });
});

describe('mergeProposals', () => {
  test('proposes node pairs at or above MERGE unless dismissed', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B', 'C'], { rank: 20 })];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    // Force a second node with near-identical tokens (as a human `move` could produce).
    o.nodes.N002 = { ...structuredClone(o.nodes.N001), motifs: ['M2'], seed: ['A', 'B', 'C', 'D'] };
    o.motifIndex.M2 = { sequence: ['A', 'B', 'C', 'D'], kind: 'ritual' }; o.assignments.M2 = 'N002';
    assert.deepEqual(mergeProposals(o), [{ a: 'N001', b: 'N002', weight: 0.75 }]);
    o.dismissedMerges.push(['N001', 'N002']);
    assert.deepEqual(mergeProposals(o), []);
  });
});

describe('upsert — ownership', () => {
  test('never writes skill-owned or human-owned fields', () => {
    const o = emptyOntology();
    const ms = [motif('M1', ['A', 'B'], { rank: 20 }), motif('M2', ['X'], { rank: 10 })];
    const steps = [stepAt('A', 0), stepAt('B', 1), stepAt('X', 5)];
    upsert(o, ms, steps, '2026-09-14');
    o.nodes.N001.name = 'batch edit'; o.nodes.N001.summary = 's'; o.nodes.N001.tool = 't'; o.nodes.N001.type = 'skill';
    o.nodes.N001.status = 'built'; o.nodes.N001.mergedFrom = ['N009'];
    o.themes[o.nodes.N001.theme].name = 'editing'; o.dismissedMerges = [['N001', 'N002']];
    const before = structuredClone(o);
    upsert(o, ms, steps, '2026-09-15');
    for (const f of ['name', 'summary', 'tool', 'type', 'status', 'mergedFrom']) assert.deepEqual(o.nodes.N001[f], before.nodes.N001[f]);
    assert.equal(o.themes[o.nodes.N001.theme].name, 'editing');
    assert.deepEqual(o.dismissedMerges, [['N001', 'N002']]);
    assert.equal(o.run, '2026-09-15');
    assert.equal(o.corpus.steps, 3);
  });
});
