#!/usr/bin/env bun
/**
 * STAGE 5 — the review. The deterministic half of an independent model review of the graph.
 *
 * After the skill has named the new nodes, it hands `review.mjs input` to a fresh model
 * instance that has seen nothing else. That reviewer returns a verdict: a list of proposals
 * to prune, merge, or edit nodes, each with a reason. `record` validates the verdict against
 * the ontology and stores it. Nothing is applied. A human runs `accept` or `dismiss`.
 *
 * The reviewer's stated goal is to prune candidates that are not worth building: too small,
 * not friction, not actionable, or duplicates of a stronger node.
 *
 * Ownership: `record` writes `review` only. `accept` applies one proposal through the same
 * functions a human would call (setStatus, mergeNodes, annotate). `dismiss` writes
 * `dismissedReviews`, which `record` filters against, so a dismissed proposal cannot come back.
 *
 * Usage:
 *   bun review.mjs input   [--workspace DIR]              # the reviewer's only input, JSON on stdout
 *   bun review.mjs record  --file verdict.json [--run YYYY-MM-DD] [--workspace DIR]
 *   bun review.mjs accept  <R001> [--workspace DIR]
 *   bun review.mjs dismiss <R001> [--workspace DIR]
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THRESHOLDS, TYPES, ANNOTATABLE, loadOntology, saveOntology, renderTo, paths,
  mergeProposals, annotate, setStatus, mergeNodes,
} from './ontology.mjs';

export const KINDS = ['prune', 'merge', 'edit'];
export const PRUNABLE_STATUSES = ['new'];       // a node a human has touched is never proposed for pruning
export const PROSE_FIELDS = ['summary', 'tool']; // free prose; forbidden on single-project nodes
export const MAX_REASON = 400;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const renderedFlow = (o) => o.flow.filter((e) => e.count >= THRESHOLDS.RENDER_FLOW_COUNT && e.sessions >= THRESHOLDS.RENDER_FLOW_SESSIONS);

/**
 * Everything the reviewer may see. Derived from ontology.json only, which carries no
 * transcript content. Motif, session, and project ids are left out: they are opaque hashes
 * and add nothing to a review.
 */
export function reviewInput(o) {
  const total = Object.values(o.nodes).reduce((a, n) => a + (n.stats.frictionMassMs ?? 0), 0) || 1;
  const nodes = Object.entries(o.nodes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, n]) => ({
    id, name: n.name, summary: n.summary, tool: n.tool, type: n.type, theme: n.theme,
    status: n.status, class: n.class, seed: n.seed, motifCount: n.motifs.length,
    stats: {
      occurrences: n.stats.occurrences ?? 0, distinctSessions: n.stats.distinctSessions ?? 0,
      distinctProjects: n.stats.distinctProjects ?? 0, crossProject: n.stats.crossProject ?? false,
      medianElapsedMs: n.stats.medianElapsedMs ?? 0, correctionRate: n.stats.correctionRate ?? 0,
      retryDepth: n.stats.retryDepth ?? 0, frictionMassMs: n.stats.frictionMassMs ?? 0,
      betweenness: n.stats.betweenness ?? 0, buildScore: n.stats.buildScore ?? 0,
    },
    frictionShare: Number(((n.stats.frictionMassMs ?? 0) / total).toFixed(4)),
    history: (n.history ?? []).map((h) => ({ run: h.run, occurrences: h.occurrences })),
  }));
  return {
    run: o.run,
    corpus: { ...o.corpus },
    thresholds: { seedProjects: THRESHOLDS.SEED_PROJECTS, seedOccurrences: THRESHOLDS.SEED_OCCURRENCES, merge: THRESHOLDS.MERGE },
    kinds: KINDS, types: TYPES, editableFields: ANNOTATABLE, proseFields: PROSE_FIELDS,
    nodes,
    flow: renderedFlow(o).map((e) => ({ from: e.from, to: e.to, count: e.count, sessions: e.sessions })),
    similarity: o.similarity.filter((e) => e.weight >= THRESHOLDS.RENDER_SIM).map((e) => ({ a: e.a, b: e.b, weight: e.weight })),
    mergeProposals: mergeProposals(o),
    dismissed: (o.dismissedReviews ?? []).map((d) => ({ ...d })),
    previousReview: o.review ? { run: o.review.run, proposals: o.review.proposals.map(({ id, ...p }) => p) } : null,
  };
}

// ---------------------------------------------------------------------------
// Validation and recording
// ---------------------------------------------------------------------------

const keyOf = (p) => (p.kind === 'merge' ? `merge|${p.node}|${p.into}` : `${p.kind}|${p.node}`);
const dismissKey = (p) => (p.kind === 'merge' ? { kind: 'merge', node: p.node, into: p.into } : { kind: p.kind, node: p.node });

const requireNode = (o, id, what = 'node') => { if (!o.nodes[id]) throw new Error(`unknown node ${id} (${what})`); return o.nodes[id]; };

function validateOne(o, p, i) {
  const at = `proposal ${i + 1}`;
  if (!p || typeof p !== 'object') throw new Error(`${at}: not an object`);
  if (!KINDS.includes(p.kind)) throw new Error(`${at}: kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(p.kind)}`);
  const node = requireNode(o, p.node, at);
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (!reason) throw new Error(`${at}: reason is required`);
  if (reason.length > MAX_REASON) throw new Error(`${at}: reason longer than ${MAX_REASON} characters`);
  const out = { kind: p.kind, node: p.node, reason };
  if (p.kind === 'prune') {
    if (!PRUNABLE_STATUSES.includes(node.status)) throw new Error(`${at}: ${p.node} has status ${node.status}; only ${PRUNABLE_STATUSES.join('/')} nodes may be pruned`);
  }
  if (p.kind === 'merge') {
    if (!p.into) throw new Error(`${at}: merge needs "into"`);
    if (p.into === p.node) throw new Error(`${at}: cannot merge ${p.node} into itself`);
    requireNode(o, p.into, `${at} into`);
    out.into = p.into;
  }
  if (p.kind === 'edit') {
    const fields = p.fields && typeof p.fields === 'object' ? p.fields : null;
    if (!fields || !Object.keys(fields).length) throw new Error(`${at}: edit needs a non-empty "fields" object`);
    for (const k of Object.keys(fields)) {
      if (!ANNOTATABLE.includes(k)) throw new Error(`${at}: ${k} is not editable; fields are ${ANNOTATABLE.join(', ')}`);
      if (typeof fields[k] !== 'string' || !fields[k].trim()) throw new Error(`${at}: ${k} must be a non-empty string`);
      if (PROSE_FIELDS.includes(k) && !node.stats.crossProject) throw new Error(`${at}: ${p.node} is a single-project node; ${k} may not be rewritten (prose tiering)`);
    }
    if (fields.type !== undefined && !TYPES.includes(fields.type)) throw new Error(`${at}: type must be one of ${TYPES.join(', ')}`);
    out.fields = { ...fields };
  }
  return out;
}

/**
 * Check a verdict against the ontology. Throws on the first malformed proposal, so a sloppy
 * reviewer writes nothing. Proposals a human already dismissed are dropped, not rejected.
 */
export function validateReview(o, doc) {
  if (!doc || !Array.isArray(doc.proposals)) throw new Error('verdict must be an object with a "proposals" array');
  const dismissed = new Set((o.dismissedReviews ?? []).map(keyOf));
  const seen = new Set();
  const proposals = []; const dropped = [];
  doc.proposals.forEach((raw, i) => {
    const p = validateOne(o, raw, i);
    const k = keyOf(p);
    if (seen.has(k)) throw new Error(`proposal ${i + 1}: duplicate of an earlier ${p.kind} on ${p.node}`);
    seen.add(k);
    if (dismissed.has(k)) dropped.push(p); else proposals.push(p);
  });
  return { proposals, dropped };
}

/** Store a validated verdict as this run's review, replacing the previous one. */
export function recordReview(o, doc, runDate) {
  const { proposals, dropped } = validateReview(o, doc);
  o.review = {
    run: runDate,
    proposals: proposals.map((p, i) => ({ id: `R${String(i + 1).padStart(3, '0')}`, ...p })),
  };
  return { recorded: o.review.proposals.length, dropped: dropped.length };
}

const takeProposal = (o, rid) => {
  const i = o.review?.proposals.findIndex((p) => p.id === rid) ?? -1;
  if (i < 0) throw new Error(`unknown proposal ${rid}`);
  return o.review.proposals.splice(i, 1)[0];
};

/** Apply one proposal through the human-owned mutations, then forget it. */
export function acceptReview(o, rid) {
  const p = takeProposal(o, rid);
  switch (p.kind) {
    case 'prune': setStatus(o, p.node, 'rejected'); return `${p.node} status -> rejected`;
    case 'merge': mergeNodes(o, p.into, p.node); return `${p.node} merged into ${p.into}`;
    case 'edit': annotate(o, p.node, p.fields); return `${p.node} ${Object.keys(p.fields).join(', ')} updated`;
    default: throw new Error(`unknown kind ${p.kind}`);
  }
}

/** Forget one proposal and refuse it in every future review. */
export function dismissReview(o, rid) {
  const p = takeProposal(o, rid);
  const key = dismissKey(p);
  o.dismissedReviews = o.dismissedReviews ?? [];
  if (!o.dismissedReviews.some((d) => keyOf(d) === keyOf(key))) o.dismissedReviews.push(key);
  return `${rid} dismissed`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const workspace = resolve(flags.workspace ?? process.env.COMB_WORKSPACE ?? process.cwd());
  const P = paths(workspace);
  const o = loadOntology(P.ontology);

  try {
    switch (cmd) {
      case 'input':
        process.stdout.write(`${JSON.stringify(reviewInput(o), null, 2)}\n`);
        return;
      case 'record': {
        if (!flags.file || flags.file === true) throw new Error('usage: record --file verdict.json [--run YYYY-MM-DD]');
        if (!existsSync(flags.file)) throw new Error(`no such file ${flags.file}`);
        const doc = JSON.parse(readFileSync(flags.file, 'utf8'));
        const runDate = flags.run ?? o.run ?? new Date().toISOString().slice(0, 10);
        const r = recordReview(o, doc, runDate);
        console.error(`review: ${r.recorded} proposal(s) recorded, ${r.dropped} dropped as previously dismissed`);
        break;
      }
      case 'accept': { const [rid] = rest; if (!rid) throw new Error('usage: accept <R001>'); console.error(acceptReview(o, rid)); break; }
      case 'dismiss': { const [rid] = rest; if (!rid) throw new Error('usage: dismiss <R001>'); console.error(dismissReview(o, rid)); break; }
      default:
        console.error('usage: review.mjs <input|record|accept|dismiss> ...'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(1); }

  saveOntology(P.ontology, o);
  renderTo(workspace, o);
  console.error(`ontology -> ${P.ontology}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
