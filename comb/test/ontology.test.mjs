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
