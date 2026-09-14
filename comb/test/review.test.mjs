import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { emptyOntology, upsert, render, setStatus, mergeNodes } from '../ontology.mjs';
import { reviewInput, validateReview, recordReview, acceptReview, dismissReview, KINDS } from '../review.mjs';

const motif = (id, sequence, o = {}) => ({
  id, kind: o.kind ?? 'ritual', sequence, length: sequence.length,
  occurrences: o.occurrences ?? 20, distinctSessions: o.sessions?.length ?? 2,
  distinctProjects: o.projects?.length ?? 3, sidechain: false,
  crossProject: (o.projects?.length ?? 3) >= 2, medianElapsedMs: o.median ?? 1000,
  rank: o.rank ?? 10, correctionRate: o.correctionRate ?? 0, retryDepth: o.retryDepth ?? 1,
  sessions: o.sessions ?? ['s1', 's2'], projects: o.projects ?? ['p1', 'p2', 'p3'],
});
const stepAt = (step, sec, o = {}) => ({ session: o.session ?? 's1', project: o.project ?? 'p1', step, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() });

/** Three nodes: N001 big and corrected, N002 medium, N003 single-project and tiny. */
const populated = () => {
  const o = emptyOntology();
  const ms = [
    motif('M1', ['Bash(grep)', 'Bash(sed)'], { rank: 30, occurrences: 40, median: 5000, correctionRate: 0.3 }),
    motif('M2', ['ToolSearch', 'Mcp(linear)'], { rank: 20, occurrences: 100, median: 4000 }),
    motif('M3', ['Skill', 'User'], { rank: 10, occurrences: 16, median: 100, projects: ['p1', 'p1', 'p1'] }),
  ];
  const steps = [];
  for (let s = 0; s < 5; s++) {
    steps.push(stepAt('Bash(grep)', 0, { session: `s${s}` }), stepAt('Bash(sed)', 1, { session: `s${s}` }),
      stepAt('ToolSearch', 10, { session: `s${s}` }), stepAt('Mcp(linear)', 11, { session: `s${s}` }));
  }
  upsert(o, ms, steps, '2026-09-14');
  o.nodes.N001.name = 'search then rewrite'; o.nodes.N002.name = 'linear lookups';
  return o;
};

const verdict = (proposals) => ({ run: '2026-09-14', proposals });

describe('reviewInput', () => {
  test('lists every node with its descriptive fields, stats, and friction share summing to 1', () => {
    const o = populated();
    const inp = reviewInput(o);
    assert.equal(inp.run, '2026-09-14');
    assert.deepEqual(inp.nodes.map((n) => n.id), ['N001', 'N002', 'N003']);
    const n1 = inp.nodes[0];
    for (const k of ['name', 'summary', 'tool', 'type', 'theme', 'status', 'class', 'seed', 'motifCount', 'stats', 'frictionShare']) assert.ok(k in n1, `missing ${k}`);
    assert.equal(n1.motifCount, 1);
    const total = inp.nodes.reduce((a, n) => a + n.frictionShare, 0);
    assert.ok(Math.abs(total - 1) < 0.01, `shares sum to ${total}`);
    assert.ok(Array.isArray(inp.flow) && Array.isArray(inp.similarity) && Array.isArray(inp.mergeProposals));
    assert.deepEqual(inp.dismissed, []);
    assert.ok(Array.isArray(inp.kinds));
  });
  test('carries no motif ids, session ids, or project ids', () => {
    const text = JSON.stringify(reviewInput(populated()));
    for (const leak of ['"M1"', '"s1"', '"p1"', '"sessions":[', '"projects":[', '"motifs":[']) assert.equal(text.includes(leak), false, `leaked ${leak}`);
  });
});

describe('validateReview', () => {
  test('accepts a well-formed verdict of every kind', () => {
    const o = populated();
    const v = verdict([
      { kind: 'prune', node: 'N003', reason: 'one motif, 16 occurrences, 0% correction: a mandated skill load, not friction' },
      { kind: 'merge', node: 'N002', into: 'N001', reason: 'same operator loop' },
      { kind: 'edit', node: 'N001', fields: { name: 'guarded rewrite', type: 'skill' }, reason: 'names the workflow' },
    ]);
    const r = validateReview(o, v);
    assert.equal(r.proposals.length, 3);
    assert.deepEqual(r.dropped, []);
  });
  test('rejects unknown kinds, unknown nodes, and empty reasons', () => {
    const o = populated();
    assert.throws(() => validateReview(o, verdict([{ kind: 'delete', node: 'N001', reason: 'x' }])), /kind/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'prune', node: 'N999', reason: 'x' }])), /unknown node/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'prune', node: 'N001', reason: '' }])), /reason/);
    assert.throws(() => validateReview(o, { proposals: 'nope' }), /proposals/);
  });
  test('rejects a prune of any node a human has touched', () => {
    const o = populated();
    for (const s of ['building', 'built', 'rejected']) {
      setStatus(o, 'N001', s);
      assert.throws(() => validateReview(o, verdict([{ kind: 'prune', node: 'N001', reason: 'x' }])), new RegExp(s));
    }
  });
  test('rejects a merge into itself or into an unknown node', () => {
    const o = populated();
    assert.throws(() => validateReview(o, verdict([{ kind: 'merge', node: 'N001', into: 'N001', reason: 'x' }])), /itself/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'merge', node: 'N001', into: 'N999', reason: 'x' }])), /unknown node/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'merge', node: 'N001', reason: 'x' }])), /into/);
  });
  test('rejects edits outside the annotatable fields, bad types, and prose on single-project nodes', () => {
    const o = populated();
    assert.throws(() => validateReview(o, verdict([{ kind: 'edit', node: 'N001', fields: { status: 'built' }, reason: 'x' }])), /status/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'edit', node: 'N001', fields: { type: 'rocket' }, reason: 'x' }])), /type/);
    assert.throws(() => validateReview(o, verdict([{ kind: 'edit', node: 'N001', fields: {}, reason: 'x' }])), /fields/);
    assert.equal(o.nodes.N003.stats.crossProject, false);
    assert.throws(() => validateReview(o, verdict([{ kind: 'edit', node: 'N003', fields: { summary: 'some client thing' }, reason: 'x' }])), /single-project/);
    // name, type, and theme are fine on a single-project node
    assert.equal(validateReview(o, verdict([{ kind: 'edit', node: 'N003', fields: { name: 'skill load', theme: 'harness' }, reason: 'x' }])).proposals.length, 1);
  });
  test('rejects two proposals for the same node and kind', () => {
    const o = populated();
    assert.throws(() => validateReview(o, verdict([
      { kind: 'prune', node: 'N003', reason: 'a' }, { kind: 'prune', node: 'N003', reason: 'b' },
    ])), /duplicate/);
  });
  test('silently drops proposals a human already dismissed', () => {
    const o = populated();
    o.dismissedReviews = [{ kind: 'prune', node: 'N003' }, { kind: 'merge', node: 'N002', into: 'N001' }];
    const r = validateReview(o, verdict([
      { kind: 'prune', node: 'N003', reason: 'x' },
      { kind: 'merge', node: 'N002', into: 'N001', reason: 'x' },
      { kind: 'merge', node: 'N001', into: 'N002', reason: 'other direction is not dismissed' },
    ]));
    assert.equal(r.proposals.length, 1);
    assert.equal(r.dropped.length, 2);
  });
});

describe('recordReview, acceptReview, dismissReview', () => {
  const recorded = () => {
    const o = populated();
    recordReview(o, verdict([
      { kind: 'prune', node: 'N003', reason: 'tiny' },
      { kind: 'merge', node: 'N002', into: 'N001', reason: 'same loop' },
      { kind: 'edit', node: 'N001', fields: { theme: 'editing' }, reason: 'family' },
    ]), '2026-09-14');
    return o;
  };
  test('record replaces the previous review and numbers proposals R001..', () => {
    const o = recorded();
    assert.equal(o.review.run, '2026-09-14');
    assert.deepEqual(o.review.proposals.map((p) => p.id), ['R001', 'R002', 'R003']);
    recordReview(o, verdict([{ kind: 'prune', node: 'N003', reason: 'still tiny' }]), '2026-09-15');
    assert.deepEqual(o.review.proposals.map((p) => p.id), ['R001']);
    assert.equal(o.review.run, '2026-09-15');
  });
  test('record never touches status, names, or assignments', () => {
    const o = recorded();
    assert.equal(o.nodes.N003.status, 'new');
    assert.equal(o.nodes.N001.theme, null);
    assert.equal(o.nodes.N002 !== undefined, true);
  });
  test('accept prune sets status rejected; accept merge folds; accept edit annotates; each removes its proposal', () => {
    const o = recorded();
    acceptReview(o, 'R001');
    assert.equal(o.nodes.N003.status, 'rejected');
    acceptReview(o, 'R003');
    assert.equal(o.nodes.N001.theme, 'editing');
    acceptReview(o, 'R002');
    assert.equal(o.nodes.N002, undefined);
    assert.equal(o.assignments.M2, 'N001');
    assert.deepEqual(o.review.proposals, []);
    assert.throws(() => acceptReview(o, 'R001'), /unknown proposal/);
  });
  test('dismiss records the key and removes the proposal', () => {
    const o = recorded();
    dismissReview(o, 'R002');
    assert.deepEqual(o.dismissedReviews, [{ kind: 'merge', node: 'N002', into: 'N001' }]);
    assert.deepEqual(o.review.proposals.map((p) => p.id), ['R001', 'R003']);
    dismissReview(o, 'R001');
    assert.deepEqual(o.dismissedReviews[1], { kind: 'prune', node: 'N003' });
  });
  test('a merge through the ontology CLI drops proposals that point at the vanished node', () => {
    const o = recorded();
    mergeNodes(o, 'N001', 'N002');
    assert.deepEqual(o.review.proposals.map((p) => p.id), ['R001', 'R003']);
  });
  test('render shows the review section between merge proposals and since last run', () => {
    const o = recorded();
    const md = render(o);
    const i = md.indexOf('## Merge proposals'); const j = md.indexOf('## Review'); const k = md.indexOf('## Since last run');
    assert.ok(i < j && j < k, 'section order');
    assert.ok(md.includes('`R001`'));
    assert.ok(md.includes('prune'));
    assert.ok(md.includes('bun comb/review.mjs accept'));
    assert.equal(render(o), render(o));
    assert.ok(render(populated()).includes('No review recorded'));
  });
  test('KINDS is the closed list', () => { assert.deepEqual(KINDS, ['prune', 'merge', 'edit']); });
});
