import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, similarity, emptyOntology, indexMotifs, assignMotifs, nodeTokens,
  computeStats, classify,
} from '../ontology.mjs';

const motif = (id, sequence, o = {}) => ({
  id, kind: o.kind ?? 'ritual', sequence, length: sequence.length,
  occurrences: o.occurrences ?? 20, distinctSessions: o.sessions?.length ?? 2,
  distinctProjects: o.projects?.length ?? 3, sidechain: false,
  crossProject: (o.projects?.length ?? 3) >= 2, medianElapsedMs: o.median ?? 1000,
  rank: o.rank ?? 10, correctionRate: o.correctionRate ?? 0, retryDepth: o.retryDepth ?? 1,
  sessions: o.sessions ?? ['s1', 's2'], projects: o.projects ?? ['p1', 'p2', 'p3'],
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

  test('a new motif joins the existing node it matches at or above JOIN, and seeds a node below it', () => {
    const o = emptyOntology();
    const base = [motif('M1', ['A', 'B', 'C'])];
    indexMotifs(o, base); assignMotifs(o, base, '2026-09-14');
    // {A,B,C,D} vs {A,B,C}: 3/4 = 0.75 joins. {A,B,X,Y} vs {A,B,C}: 2/5 = 0.4 seeds (JOIN is 0.5).
    const next = [...base, motif('M2', ['A', 'B', 'C', 'D']), motif('M3', ['A', 'B', 'X', 'Y'])];
    indexMotifs(o, next);
    const { created } = assignMotifs(o, next, '2026-09-15');
    assert.equal(o.assignments.M2, 'N001');
    assert.equal(o.assignments.M3, 'N002');
    assert.deepEqual(created, ['N002']);
  });

  test('a motif below the seed floor waits in unassigned, then joins a node it matches later', () => {
    const o = emptyOntology();
    const small = [motif('M1', ['A', 'B'], { occurrences: 5, projects: ['p1', 'p2'] })];
    indexMotifs(o, small);
    assert.deepEqual(assignMotifs(o, small, '2026-09-14').created, []);
    assert.deepEqual(o.unassigned, ['M1']);
    const later = [motif('M2', ['A', 'B', 'C'], { rank: 50 }), ...small];
    indexMotifs(o, later);
    assert.deepEqual(assignMotifs(o, later, '2026-09-15').created, ['N001']);
    assert.equal(o.assignments.M1, 'N001');   // {A,B} vs {A,B,C} = 0.667 >= JOIN
    assert.deepEqual(o.unassigned, []);
  });

  test('no transitive chaining: a motif joins only if it matches the seed itself', () => {
    const o = emptyOntology();
    // M1 seeds. M2 matches M1 (0.75). M3 matches M2 (0.75) but not M1 (0.5 < ... equal to JOIN, so it joins);
    // use M3 = {C,D,E,F}: vs M1 {A,B,C,D} = 2/6 = 0.333, vs M2 {A,B,C,D,E} = 3/6 = 0.5.
    const ms = [motif('M1', ['A', 'B', 'C', 'D'], { rank: 30 }), motif('M2', ['A', 'B', 'C', 'D', 'E'], { rank: 20 }), motif('M3', ['C', 'D', 'E', 'F'], { rank: 10 })];
    indexMotifs(o, ms);
    const { created } = assignMotifs(o, ms, '2026-09-14');
    assert.deepEqual(created, ['N001', 'N002']);
    assert.equal(o.assignments.M2, 'N001');
    assert.equal(o.assignments.M3, 'N002');
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

describe('computeStats and classify', () => {
  test('aggregates member motifs', () => {
    const o = emptyOntology();
    const ms = [
      motif('M1', ['A', 'B'], { occurrences: 10, median: 1000, correctionRate: 0.4, retryDepth: 1, sessions: ['s1', 's2'], projects: ['p1', 'p2', 'p3'] }),
      motif('M2', ['B', 'A', 'B'], { occurrences: 30, median: 3000, correctionRate: 0.2, retryDepth: 5, sessions: ['s2', 's3'], projects: ['p2', 'p3', 'p4'], rank: 50 }),
    ];
    indexMotifs(o, ms); assignMotifs(o, ms, '2026-09-14');
    computeStats(o, new Map(ms.map((m) => [m.id, m])));
    const s = o.nodes.N001.stats;
    assert.equal(s.occurrences, 40);
    assert.equal(s.distinctSessions, 3);
    assert.equal(s.distinctProjects, 4);
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
      { from: 'N001', to: 'N002', count: 6, sessions: 3, medianGapMs: 0 },
      { from: 'N002', to: 'N003', count: 5, sessions: 3, medianGapMs: 0 },
      { from: 'N003', to: 'N001', count: 2, sessions: 1, medianGapMs: 0 },   // below render threshold, ignored
    ];
    computeCentrality(o);
    assert.equal(o.nodes.N002.stats.betweenness, 1);
    assert.equal(o.nodes.N001.stats.betweenness, 0);
    assert.equal(o.nodes.N002.stats.weightedDegree, 11);
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
    o.nodes.N001.theme = 'editing'; o.dismissedMerges = [['N001', 'N002']];
    const before = structuredClone(o);
    upsert(o, ms, steps, '2026-09-15');
    for (const f of ['name', 'summary', 'tool', 'type', 'theme', 'status', 'mergedFrom']) assert.deepEqual(o.nodes.N001[f], before.nodes.N001[f]);
    assert.equal(o.nodes.N001.theme, 'editing');
    assert.deepEqual(o.dismissedMerges, [['N001', 'N002']]);
    assert.equal(o.run, '2026-09-15');
    assert.equal(o.corpus.steps, 3);
  });
});

import { render, annotate, setStatus, mergeNodes, dismissMerge, moveMotif } from '../ontology.mjs';

const populated = () => {
  const o = emptyOntology();
  const ms = [
    motif('M1', ['Bash(grep)', 'Bash(sed)'], { rank: 30, occurrences: 40, median: 5000, correctionRate: 0.3 }),
    motif('M2', ['Bash(sed)', 'Bash(grep)'], { rank: 20, occurrences: 20, median: 7000 }),
    motif('M3', ['ToolSearch', 'Mcp(linear)'], { rank: 10, occurrences: 100, median: 4000 }),
  ];
  const steps = [];
  for (let s = 0; s < 5; s++) {
    steps.push(stepAt('Bash(grep)', 0, { session: `s${s}` }), stepAt('Bash(sed)', 1, { session: `s${s}` }),
      stepAt('ToolSearch', 10, { session: `s${s}` }), stepAt('Mcp(linear)', 11, { session: `s${s}` }));
  }
  upsert(o, ms, steps, '2026-09-14');
  return o;
};

describe('render', () => {
  test('is deterministic and contains every section in order', () => {
    const o = populated();
    const a = render(o); const b = render(o);
    assert.equal(a, b);
    const heads = ['# Automation Candidates', '## Themes', '## Candidates', '## Build order', '## Flow', '## Network', '## Similarity', '## Merge proposals', '## Since last run'];
    let pos = -1;
    for (const h of heads) { const i = a.indexOf(h); assert.ok(i > pos, `missing or misordered: ${h}`); pos = i; }
  });
  test('shows the seed for an unnamed node and the name once annotated', () => {
    const o = populated();
    assert.ok(render(o).includes('`Bash(grep) → Bash(sed)`'));
    annotate(o, 'N001', { name: 'guarded batch edit' });
    assert.ok(render(o).includes('| guarded batch edit |'));
  });
  test('renders a mermaid flow graph and "no window yet" on a first run', () => {
    const md = render(populated());
    assert.ok(md.includes('```mermaid\ngraph LR'));
    assert.ok(md.includes('N001 -->|5| N002'));
    assert.ok(md.includes('no window yet'));
  });
});

describe('CLI mutations', () => {
  test('annotate sets only the four descriptive fields and validates type', () => {
    const o = populated();
    annotate(o, 'N001', { name: 'x', summary: 'y', tool: 'z', type: 'skill' });
    assert.equal(o.nodes.N001.type, 'skill');
    assert.throws(() => annotate(o, 'N001', { type: 'rocket' }), /type/);
    assert.throws(() => annotate(o, 'N001', { status: 'built' }), /not annotatable/);
    annotate(o, 'N001', { theme: 'editing' });
    assert.equal(o.nodes.N001.theme, 'editing');
  });
  test('status validates its value', () => {
    const o = populated();
    setStatus(o, 'N001', 'built');
    assert.equal(o.nodes.N001.status, 'built');
    assert.throws(() => setStatus(o, 'N001', 'done'), /status/);
    assert.throws(() => setStatus(o, 'N999', 'built'), /unknown node/);
  });
  test('merge moves motifs, records mergedFrom, deletes the dropped node, redirects assignments', () => {
    const o = populated();
    mergeNodes(o, 'N001', 'N002');
    assert.equal(o.nodes.N002, undefined);
    assert.deepEqual(o.nodes.N001.motifs, ['M1', 'M2', 'M3']);
    assert.deepEqual(o.nodes.N001.mergedFrom, ['N002']);
    assert.equal(o.assignments.M3, 'N001');
    assert.equal(o.flow.some((e) => e.from === 'N002' || e.to === 'N002'), false);
  });
  test('dismiss records a sorted pair once', () => {
    const o = populated();
    dismissMerge(o, 'N002', 'N001'); dismissMerge(o, 'N001', 'N002');
    assert.deepEqual(o.dismissedMerges, [['N001', 'N002']]);
  });
  test('move reassigns one motif', () => {
    const o = populated();
    moveMotif(o, 'M2', 'N002');
    assert.equal(o.assignments.M2, 'N002');
    assert.deepEqual(o.nodes.N001.motifs, ['M1']);
    assert.deepEqual(o.nodes.N002.motifs, ['M2', 'M3']);
    assert.throws(() => moveMotif(o, 'M2', 'N999'), /unknown node/);
  });
});
