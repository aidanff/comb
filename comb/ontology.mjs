#!/usr/bin/env bun
/**
 * STAGE 3 — the ontology. Deterministic, no model.
 *
 * Groups motifs into candidate nodes, connects nodes with similarity and flow edges,
 * groups nodes into themes, ranks nodes by friction and centrality, keeps per-run
 * history, and renders candidates.md. comb/ontology.json is the source of truth.
 *
 * Ownership: `upsert` writes machine fields only. The skill writes name, summary, tool,
 * type, and theme through `annotate`. A human writes status, merges, moves, and
 * dismissals. `upsert` never touches those fields. The independent reviewer's proposals
 * live in `review` and are written by review.mjs; `upsert` leaves them alone too.
 *
 * Usage:
 *   bun ontology.mjs upsert  [--workspace DIR] [--run YYYY-MM-DD]
 *   bun ontology.mjs render  [--workspace DIR]
 *   bun ontology.mjs annotate <N001> [--name S] [--summary S] [--tool S] [--type S] [--theme S]
 *   bun ontology.mjs status <N001> <new|building|built|rejected>
 *   bun ontology.mjs merge <keep> <drop>
 *   bun ontology.mjs merge --dismiss <A> <B>
 *   bun ontology.mjs move <M015DF> <N007>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSequences } from './motifs.mjs';

export const THRESHOLDS = {
  JOIN: 0.5,                 // a motif joins a node, or a seed's group, at or above this
  SEED_PROJECTS: 3,          // a motif may open a new node only with this many distinct projects
  SEED_OCCURRENCES: 15,      // ...and this many occurrences; smaller motifs wait in `unassigned`
  MERGE: 0.7,                // node pairs at or above this are proposed for merge
  RENDER_SIM: 0.3,           // node-level similarity edges shown
  RENDER_FLOW_COUNT: 5,      // flow edges shown need this many transitions
  RENDER_FLOW_SESSIONS: 3,   // ...across this many distinct sessions
  GRAPH_EDGES: 40,           // the Mermaid graph draws the top N flow edges by count
};

export const STATUSES = ['new', 'building', 'built', 'rejected'];
export const TYPES = ['hook', 'skill', 'script', 'mcp', 'harness'];

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

const weight = (token) => (token === 'User' ? 0.5 : 1);

/** Weighted Jaccard over two token Sets. `User` weighs half. */
export function similarity(a, b) {
  let inter = 0; let union = 0;
  for (const t of a) { union += weight(t); if (b.has(t)) inter += weight(t); }
  for (const t of b) if (!a.has(t)) union += weight(t);
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Ontology document
// ---------------------------------------------------------------------------

export function emptyOntology() {
  return {
    version: 1, run: null, nextNode: 1,
    corpus: { steps: 0, sessions: 0, projects: 0 }, runs: [],
    nodes: {}, assignments: {}, unassigned: [], motifIndex: {},
    similarity: [], flow: [], dismissedMerges: [],
    review: null, dismissedReviews: [],
  };
}

export function loadOntology(path) {
  if (!existsSync(path)) return emptyOntology();
  return { ...emptyOntology(), ...JSON.parse(readFileSync(path, 'utf8')) };
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

export function saveOntology(path, o) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortKeys(o), null, 2)}\n`);
}

const nodeId = (n) => `N${String(n).padStart(3, '0')}`;

/** Remember each motif's sequence so a motif that drops out of motifs.json keeps its tokens. */
export function indexMotifs(o, motifs) {
  for (const m of motifs) o.motifIndex[m.id] = { sequence: m.sequence, kind: m.kind };
}

const tokensOf = (o, motifId) => new Set(o.motifIndex[motifId]?.sequence ?? []);

export function nodeTokens(o, id) {
  const s = new Set();
  for (const m of o.nodes[id].motifs) for (const t of tokensOf(o, m)) s.add(t);
  return s;
}

function newNode(o, seedMotifId, runDate) {
  const id = nodeId(o.nextNode++);
  o.nodes[id] = {
    name: null, summary: null, tool: null, type: null, status: 'new', class: 'unclassified',
    theme: null, motifs: [], seed: o.motifIndex[seedMotifId]?.sequence ?? [], created: runDate,
    mergedFrom: [], stats: {}, history: [],
  };
  return id;
}

/**
 * Sticky assignment. Already-assigned motifs stay. Each new motif joins the best existing
 * node at or above JOIN. The rest are grouped by seed: the highest-ranked pending motif
 * that clears the seed floor opens a node, and every pending motif at or above JOIN to
 * that SEED joins it. No transitive chaining, so one node cannot swallow the corpus.
 * Motifs below the floor that match nothing wait in `unassigned` until they grow.
 */
export function assignMotifs(o, motifs, runDate) {
  const created = [];
  const fresh = motifs
    .filter((m) => !o.assignments[m.id])
    .sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));

  // Rebuild membership from assignments so the two never disagree.
  for (const n of Object.values(o.nodes)) n.motifs = [];
  for (const [mid, nid] of Object.entries(o.assignments)) o.nodes[nid]?.motifs.push(mid);

  const pending = [];
  for (const m of fresh) {
    let best = null; let bestScore = 0;
    for (const [nid, node] of Object.entries(o.nodes)) {
      const s = similarity(new Set(m.sequence), nodeTokens(o, nid));
      if (s < THRESHOLDS.JOIN) continue;
      const occ = node.stats.occurrences ?? 0;
      const bestOcc = best ? (o.nodes[best].stats.occurrences ?? 0) : -1;
      const better = !best || s > bestScore || (s === bestScore && (occ > bestOcc || (occ === bestOcc && nid < best)));
      if (better) { best = nid; bestScore = s; }
    }
    if (best) { o.assignments[m.id] = best; o.nodes[best].motifs.push(m.id); }
    else pending.push(m);
  }

  // Seed-anchored grouping among the pending motifs.
  const seen = new Set();
  const clearsFloor = (m) => m.distinctProjects >= THRESHOLDS.SEED_PROJECTS && m.occurrences >= THRESHOLDS.SEED_OCCURRENCES;
  const unassigned = [];
  for (const m of pending) {
    if (seen.has(m.id)) continue;
    if (!clearsFloor(m)) { unassigned.push(m.id); continue; }
    seen.add(m.id);
    const seedToks = new Set(m.sequence);
    const group = [m];
    for (const other of pending) {
      if (seen.has(other.id)) continue;
      if (similarity(seedToks, new Set(other.sequence)) >= THRESHOLDS.JOIN) { group.push(other); seen.add(other.id); }
    }
    const id = newNode(o, m.id, runDate);
    for (const g of group) { o.assignments[g.id] = id; o.nodes[id].motifs.push(g.id); }
    created.push(id);
  }
  o.unassigned = unassigned.sort();
  for (const n of Object.values(o.nodes)) n.motifs.sort();
  return { created };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function classify(s) {
  if (s.correctionRate >= 0.25 || s.retryDepth >= 3) return 'tool';
  if (s.correctionRate < 0.1 && s.crossProject && s.occurrences >= 20) return 'doc';
  return 'unclassified';
}

const weightedMedian = (pairs) => {
  const sorted = pairs.filter(([v]) => v !== null && v !== undefined).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((acc, [, w]) => acc + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) { acc += w; if (acc >= total / 2) return v; }
  return sorted.length ? sorted[sorted.length - 1][0] : 0;
};

/** Recompute every node's stats from its member motifs. Members absent from motifsById contribute nothing this run. */
export function computeStats(o, motifsById) {
  for (const node of Object.values(o.nodes)) {
    const members = node.motifs.map((id) => motifsById.get(id)).filter(Boolean);
    const occ = members.reduce((a, m) => a + m.occurrences, 0);
    const sessions = new Set(members.flatMap((m) => m.sessions ?? []));
    const projects = new Set(members.flatMap((m) => m.projects ?? []));
    const prev = node.stats ?? {};
    const s = {
      occurrences: occ,
      distinctSessions: sessions.size,
      distinctProjects: projects.size,
      crossProject: projects.size >= 2,
      medianElapsedMs: weightedMedian(members.map((m) => [m.medianElapsedMs ?? 0, m.occurrences])),
      correctionRate: occ ? Number((members.reduce((a, m) => a + (m.correctionRate ?? 0) * m.occurrences, 0) / occ).toFixed(3)) : 0,
      retryDepth: members.reduce((a, m) => Math.max(a, m.retryDepth ?? 1), 0),
      frictionMassMs: members.reduce((a, m) => a + m.occurrences * (m.medianElapsedMs ?? 0), 0),
      weightedDegree: prev.weightedDegree ?? 0, betweenness: prev.betweenness ?? 0, buildScore: prev.buildScore ?? 0,
    };
    node.stats = s;
    node.class = classify(s);
  }
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Every (start, end, node) occurrence of any member motif inside one token sequence. */
function nodeOccurrences(o, toks) {
  const occ = [];
  for (const [nid, node] of Object.entries(o.nodes)) {
    for (const mid of node.motifs) {
      const seq = o.motifIndex[mid]?.sequence; if (!seq?.length) continue;
      for (let i = 0; i + seq.length <= toks.length; i++) {
        let ok = true;
        for (let k = 0; k < seq.length; k++) if (toks[i + k] !== seq[k]) { ok = false; break; }
        if (ok) occ.push({ start: i, end: i + seq.length - 1, node: nid });
      }
    }
  }
  return occ.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.node < b.node ? -1 : 1));
}

/** Directed transitions between nodes inside each session. */
export function computeFlow(o, sequences) {
  const edges = new Map();
  for (const seq of sequences) {
    const toks = seq.steps.map((s) => s.step);
    const occ = nodeOccurrences(o, toks);
    const collapsed = [];
    for (const x of occ) if (!collapsed.length || collapsed[collapsed.length - 1].node !== x.node) collapsed.push(x);
    for (let i = 1; i < collapsed.length; i++) {
      const a = collapsed[i - 1]; const b = collapsed[i];
      const key = `${a.node}>${b.node}`;
      if (!edges.has(key)) edges.set(key, { from: a.node, to: b.node, count: 0, sessionSet: new Set(), gaps: [] });
      const e = edges.get(key);
      e.count++; e.sessionSet.add(seq.session);
      const ta = seq.steps[a.end]?.ts ? Date.parse(seq.steps[a.end].ts) : NaN;
      const tb = seq.steps[b.start]?.ts ? Date.parse(seq.steps[b.start].ts) : NaN;
      if (Number.isFinite(ta) && Number.isFinite(tb)) e.gaps.push(Math.max(0, tb - ta));
    }
  }
  o.flow = [...edges.values()]
    .map((e) => ({ from: e.from, to: e.to, count: e.count, sessions: e.sessionSet.size, medianGapMs: median(e.gaps) }))
    .sort((a, b) => (b.count - a.count) || (a.from < b.from ? -1 : 1) || (a.to < b.to ? -1 : 1));
}

/** Undirected node-level similarity edges, weight rounded to 3 places, zero-weight pairs dropped. */
export function computeSimilarityEdges(o) {
  const ids = Object.keys(o.nodes).sort();
  const toks = new Map(ids.map((id) => [id, nodeTokens(o, id)]));
  const out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const w = Number(similarity(toks.get(ids[i]), toks.get(ids[j])).toFixed(3));
    if (w > 0) out.push({ a: ids[i], b: ids[j], weight: w });
  }
  o.similarity = out.sort((x, y) => (y.weight - x.weight) || (x.a < y.a ? -1 : 1) || (x.b < y.b ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Centrality and build score
// ---------------------------------------------------------------------------

const renderedFlow = (o) => o.flow.filter((e) => e.count >= THRESHOLDS.RENDER_FLOW_COUNT && e.sessions >= THRESHOLDS.RENDER_FLOW_SESSIONS);

/** Brandes betweenness on the undirected, unweighted rendered flow graph; normalized by the max. */
export function computeCentrality(o) {
  const ids = Object.keys(o.nodes).sort();
  const adj = new Map(ids.map((id) => [id, new Set()]));
  const degree = new Map(ids.map((id) => [id, 0]));
  for (const e of renderedFlow(o)) {
    adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from);
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.count);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.count);
  }
  const bc = new Map(ids.map((id) => [id, 0]));
  for (const s of ids) {
    const stack = []; const pred = new Map(ids.map((id) => [id, []]));
    const sigma = new Map(ids.map((id) => [id, 0])); sigma.set(s, 1);
    const dist = new Map(ids.map((id) => [id, -1])); dist.set(s, 0);
    const queue = [s];
    while (queue.length) {
      const v = queue.shift(); stack.push(v);
      for (const w of adj.get(v)) {
        if (dist.get(w) < 0) { dist.set(w, dist.get(v) + 1); queue.push(w); }
        if (dist.get(w) === dist.get(v) + 1) { sigma.set(w, sigma.get(w) + sigma.get(v)); pred.get(w).push(v); }
      }
    }
    const delta = new Map(ids.map((id) => [id, 0]));
    while (stack.length) {
      const w = stack.pop();
      for (const v of pred.get(w)) delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      if (w !== s) bc.set(w, bc.get(w) + delta.get(w));
    }
  }
  const max = Math.max(0, ...bc.values());
  for (const id of ids) {
    const s = o.nodes[id].stats;
    s.weightedDegree = degree.get(id);
    s.betweenness = max ? Number((bc.get(id) / max).toFixed(3)) : 0;
    s.buildScore = Math.round((s.frictionMassMs ?? 0) * (1 + s.betweenness));
  }
}

/** Nodes still worth building, by buildScore, with cumulative share of total friction. */
export function buildOrder(o) {
  const total = Object.values(o.nodes).reduce((a, n) => a + (n.stats.frictionMassMs ?? 0), 0) || 1;
  let acc = 0;
  return Object.entries(o.nodes)
    .filter(([, n]) => n.status === 'new' || n.status === 'building')
    .sort(([ia, a], [ib, b]) => (b.stats.buildScore - a.stats.buildScore) || (ia < ib ? -1 : 1))
    .map(([id, n]) => { acc += n.stats.frictionMassMs ?? 0; return { id, buildScore: n.stats.buildScore, cumulativeShare: Number((acc / total).toFixed(3)) }; });
}

// ---------------------------------------------------------------------------
// History and impact
// ---------------------------------------------------------------------------

export function recordHistory(o, runDate) {
  o.runs = o.runs.filter((r) => r.run !== runDate).concat([{ run: runDate, sessions: o.corpus.sessions }]).sort((a, b) => (a.run < b.run ? -1 : 1));
  for (const n of Object.values(o.nodes)) {
    const entry = { run: runDate, occurrences: n.stats.occurrences ?? 0, distinctSessions: n.stats.distinctSessions ?? 0 };
    n.history = (n.history ?? []).filter((h) => h.run !== runDate).concat([entry]).sort((a, b) => (a.run < b.run ? -1 : 1));
  }
}

const rateIn = (node, fromRun, toRun) => {
  const h0 = node.history.find((h) => h.run === fromRun.run); const h1 = node.history.find((h) => h.run === toRun.run);
  const ds = toRun.sessions - fromRun.sessions;
  if (!h0 || !h1 || ds <= 0) return null;
  return (h1.occurrences - h0.occurrences) / ds;
};
const baselineRate = (node, run) => {
  const h = node.history.find((x) => x.run === run.run);
  return h && run.sessions ? h.occurrences / run.sessions : null;
};

/**
 * Compare each built/rejected node's rate in the latest window (occurrences per new
 * session between the last two runs) against its cumulative rate before that window.
 */
export function impactSignals(o) {
  if (o.runs.length < 2) return { window: null, signals: [] };
  const from = o.runs[o.runs.length - 2]; const to = o.runs[o.runs.length - 1];
  const window = { from: from.run, to: to.run, sessions: to.sessions - from.sessions };
  const signals = [];
  const change = (node) => {
    const base = baselineRate(node, from); const now = rateIn(node, from, to);
    if (base === null || now === null || base === 0) return null;
    return (now - base) / base;
  };
  for (const [id, node] of Object.entries(o.nodes)) {
    const c = change(node); if (c === null) continue;
    if (node.status === 'built' && c <= -0.5) signals.push({ kind: 'confirmed-win', node: id, change: Number(c.toFixed(2)) });
    if (node.status === 'rejected' && c >= 0.5) signals.push({ kind: 're-open', node: id, change: Number(c.toFixed(2)) });
    if (node.status === 'built') {
      for (const e of o.flow.filter((f) => f.from === id)) {
        const cs = change(o.nodes[e.to]);
        if (cs !== null && cs >= 0.2) signals.push({ kind: 'displacement', node: id, successor: e.to, change: Number(cs.toFixed(2)) });
      }
    }
  }
  return { window, signals };
}

// ---------------------------------------------------------------------------
// Merge proposals and upsert
// ---------------------------------------------------------------------------

export function mergeProposals(o) {
  const dismissed = new Set(o.dismissedMerges.map(([a, b]) => [a, b].sort().join('|')));
  const ids = Object.keys(o.nodes).sort();
  const toks = new Map(ids.map((id) => [id, nodeTokens(o, id)]));
  const out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (dismissed.has(`${ids[i]}|${ids[j]}`)) continue;
    const w = Number(similarity(toks.get(ids[i]), toks.get(ids[j])).toFixed(3));
    if (w >= THRESHOLDS.MERGE) out.push({ a: ids[i], b: ids[j], weight: w });
  }
  return out.sort((x, y) => y.weight - x.weight);
}

/** The whole machine-owned update, in order. */
export function upsert(o, motifs, steps, runDate) {
  const sequences = buildSequences(steps);
  o.run = runDate;
  o.corpus = {
    steps: steps.length,
    sessions: new Set(sequences.map((s) => s.session)).size,
    projects: new Set(sequences.map((s) => s.project)).size,
  };
  indexMotifs(o, motifs);
  const { created } = assignMotifs(o, motifs, runDate);
  computeStats(o, new Map(motifs.map((m) => [m.id, m])));
  computeFlow(o, sequences);
  computeSimilarityEdges(o);
  computeCentrality(o);
  recordHistory(o, runDate);
  return { created, proposals: mergeProposals(o) };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const fmtSecs = (ms) => (ms == null ? '' : `${Math.round(ms / 1000)}s`);
const fmtPct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const label = (o, id) => o.nodes[id]?.name ?? id;
const seedText = (node) => `\`${node.seed.join(' → ')}\``;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function render(o) {
  const L = [];
  const nodes = Object.entries(o.nodes);
  const flow = renderedFlow(o);
  L.push('# Automation Candidates', '',
    'A network of candidate workflows for internal MSP developer tooling, derived from observed',
    'Claude Code session behavior. Generated by `comb/`; see',
    '`docs/superpowers/specs/2026-09-14-comb-ontology-design.md`.', '',
    '**This file is generated.** Edit `comb/ontology.json` through the CLI, never by hand:',
    '`bun comb/ontology.mjs status N001 built`. `Status` is human-owned and survives every run.', '',
    '**`Distinct projects` is a count, never engagement names.** Nodes seen in one project get a',
    'mechanical description only.', '',
    `_Last run: ${o.run} · corpus: ${o.corpus.steps} steps / ${o.corpus.sessions} sessions / ${o.corpus.projects} project dirs · ${nodes.length} nodes · ${flow.length} flow edges · ${o.unassigned.length} motifs waiting_`, '');

  const totalMass = nodes.reduce((a, [, n]) => a + (n.stats.frictionMassMs ?? 0), 0) || 1;
  L.push('## Themes', '', 'Labels the skill assigns per node with `annotate --theme`.', '', '| Theme | Nodes | Friction share |', '|---|---|---|');
  const byTheme = new Map();
  for (const [, n] of nodes) {
    const t = n.theme ?? '(unlabeled)';
    if (!byTheme.has(t)) byTheme.set(t, { count: 0, mass: 0 });
    byTheme.get(t).count++; byTheme.get(t).mass += n.stats.frictionMassMs ?? 0;
  }
  for (const [t, v] of [...byTheme.entries()].sort((a, b) => b[1].mass - a[1].mass)) L.push(`| ${cell(t)} | ${v.count} | ${fmtPct(v.mass / totalMass)} |`);
  L.push('');

  L.push('## Candidates', '',
    '| ID | Name | Theme | Motifs | Occurrences | Distinct projects | Median time | Correction | Class | Type | Status | Candidate tool |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  const byScore = [...nodes].sort(([ia, a], [ib, b]) => (b.stats.buildScore - a.stats.buildScore) || (ia < ib ? -1 : 1));
  for (const [id, n] of byScore) {
    const s = n.stats;
    L.push(`| \`${id}\` | ${n.name ? cell(n.name) : seedText(n)} | ${cell(n.theme ?? '')} | ${n.motifs.length} | ${s.occurrences} | ${s.distinctProjects} | ${fmtSecs(s.medianElapsedMs)} | ${fmtPct(s.correctionRate)} | ${n.class} | ${n.type ?? ''} | ${n.status} | ${cell(n.tool ?? n.summary ?? '')} |`);
  }
  L.push('');

  L.push('## Build order', '', 'By `buildScore` = friction mass × (1 + betweenness). Friction mass is an estimate: overlapping motifs inside one session are counted more than once.', '',
    '| # | Node | Build score | Cumulative friction |', '|---|---|---|---|');
  buildOrder(o).slice(0, 10).forEach((r, i) => L.push(`| ${i + 1} | \`${r.id}\` ${cell(label(o, r.id))} | ${r.buildScore} | ${fmtPct(r.cumulativeShare)} |`));
  L.push('');

  L.push('## Flow', '', `Transitions between nodes inside a session. Shown when count ≥ ${THRESHOLDS.RENDER_FLOW_COUNT} and sessions ≥ ${THRESHOLDS.RENDER_FLOW_SESSIONS}.`, '',
    '| From | To | Count | Sessions | Median gap |', '|---|---|---|---|---|');
  for (const e of flow) L.push(`| \`${e.from}\` ${cell(label(o, e.from))} | \`${e.to}\` ${cell(label(o, e.to))} | ${e.count} | ${e.sessions} | ${fmtSecs(e.medianGapMs)} |`);
  L.push('');

  const graphEdges = flow.slice(0, THRESHOLDS.GRAPH_EDGES);
  L.push('## Network', '', `The top ${graphEdges.length} flow edges by count. The full list is in "Flow".`, '', '```mermaid', 'graph LR');
  const inGraph = new Set(graphEdges.flatMap((e) => [e.from, e.to]));
  for (const id of [...inGraph].sort()) L.push(`  ${id}["${cell(label(o, id)).replace(/"/g, "'")}"]`);
  for (const e of graphEdges) L.push(`  ${e.from} -->|${e.count}| ${e.to}`);
  L.push('```', '');

  L.push('## Similarity', '', `Node pairs with weighted Jaccard ≥ ${THRESHOLDS.RENDER_SIM}.`, '', '| A | B | Weight |', '|---|---|---|');
  for (const e of o.similarity.filter((x) => x.weight >= THRESHOLDS.RENDER_SIM)) L.push(`| \`${e.a}\` ${cell(label(o, e.a))} | \`${e.b}\` ${cell(label(o, e.b))} | ${e.weight} |`);
  L.push('');

  L.push('## Merge proposals', '');
  const props = mergeProposals(o);
  if (!props.length) L.push('None.', '');
  else {
    L.push(`Pairs at or above ${THRESHOLDS.MERGE}. Accept: \`bun comb/ontology.mjs merge <keep> <drop>\`. Dismiss: \`merge --dismiss <a> <b>\`.`, '', '| A | B | Weight |', '|---|---|---|');
    for (const p of props) L.push(`| \`${p.a}\` ${cell(label(o, p.a))} | \`${p.b}\` ${cell(label(o, p.b))} | ${p.weight} |`);
    L.push('');
  }

  L.push('## Review', '');
  if (!o.review) L.push('No review recorded. The skill runs an independent reviewer after it names new nodes.', '');
  else {
    L.push(`Proposals from the independent reviewer, run ${o.review.run}. Its brief is to prune candidates not worth building. Accept: \`bun comb/review.mjs accept R001\`. Dismiss: \`bun comb/review.mjs dismiss R001\`.`, '');
    if (!o.review.proposals.length) L.push('No open proposals.', '');
    else {
      L.push('| ID | Kind | Node | Detail | Reason |', '|---|---|---|---|---|');
      for (const p of o.review.proposals) {
        const detail = p.kind === 'merge' ? `into \`${p.into}\` ${cell(label(o, p.into))}` : p.kind === 'edit' ? cell(Object.entries(p.fields).map(([k, v]) => `${k}: ${v}`).join('; ')) : 'status → rejected';
        L.push(`| \`${p.id}\` | ${p.kind} | \`${p.node}\` ${cell(label(o, p.node))} | ${detail} | ${cell(p.reason)} |`);
      }
      L.push('');
    }
  }

  L.push('## Since last run', '');
  const { window, signals } = impactSignals(o);
  if (!window) L.push('no window yet', '');
  else {
    L.push(`Window ${window.from} → ${window.to}, ${window.sessions} new sessions.`, '');
    if (!signals.length) L.push('No signals for built or rejected nodes.', '');
    else {
      L.push('| Signal | Node | Detail |', '|---|---|---|');
      for (const s of signals) L.push(`| ${s.kind} | \`${s.node}\` ${cell(label(o, s.node))} | ${s.successor ? `successor \`${s.successor}\` ` : ''}rate change ${fmtPct(s.change)} |`);
      L.push('');
    }
  }
  return L.join('\n');
}

export function renderTo(workspace, o) {
  writeFileSync(join(workspace, 'candidates.md'), `${render(o)}\n`);
}

// ---------------------------------------------------------------------------
// Skill-owned and human-owned mutations
// ---------------------------------------------------------------------------

const requireNode = (o, id) => { if (!o.nodes[id]) throw new Error(`unknown node ${id}`); return o.nodes[id]; };

export const ANNOTATABLE = ['name', 'summary', 'tool', 'type', 'theme'];

export function annotate(o, id, fields) {
  const allowedNode = ANNOTATABLE;
  const node = requireNode(o, id);
  for (const k of Object.keys(fields)) if (!allowedNode.includes(k)) throw new Error(`${k} is not annotatable; use status/merge/move`);
  if (fields.type !== undefined && !TYPES.includes(fields.type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  for (const k of allowedNode) if (fields[k] !== undefined) node[k] = fields[k];
  return o;
}

export function setStatus(o, id, status) {
  const node = requireNode(o, id);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  node.status = status;
  return o;
}

export function mergeNodes(o, keep, drop) {
  const k = requireNode(o, keep); requireNode(o, drop);
  if (keep === drop) throw new Error('keep and drop are the same node');
  for (const [mid, nid] of Object.entries(o.assignments)) if (nid === drop) o.assignments[mid] = keep;
  k.motifs = [...new Set([...k.motifs, ...o.nodes[drop].motifs])].sort();
  k.mergedFrom = [...k.mergedFrom, drop, ...o.nodes[drop].mergedFrom];
  delete o.nodes[drop];
  o.flow = o.flow.filter((e) => e.from !== drop && e.to !== drop);
  o.similarity = o.similarity.filter((e) => e.a !== drop && e.b !== drop);
  if (o.review) o.review.proposals = o.review.proposals.filter((p) => p.node !== drop && p.into !== drop);
  return o;
}

export function dismissMerge(o, a, b) {
  const pair = [a, b].sort();
  if (!o.dismissedMerges.some(([x, y]) => x === pair[0] && y === pair[1])) o.dismissedMerges.push(pair);
  return o;
}

export function moveMotif(o, motifId, nodeId) {
  requireNode(o, nodeId);
  const from = o.assignments[motifId];
  if (from && o.nodes[from]) o.nodes[from].motifs = o.nodes[from].motifs.filter((m) => m !== motifId);
  o.assignments[motifId] = nodeId;
  o.nodes[nodeId].motifs = [...new Set([...o.nodes[nodeId].motifs, motifId])].sort();
  return o;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set(['dismiss']);

function parseFlags(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (BOOL_FLAGS.has(k)) flags[k] = true;
      else flags[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

export function paths(workspace) {
  return {
    ontology: join(workspace, 'comb', 'ontology.json'),
    motifs: join(workspace, 'comb', '.work', 'motifs.json'),
    skeletons: join(workspace, 'comb', '.work', 'skeletons.jsonl'),
  };
}

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const workspace = resolve(flags.workspace ?? process.env.COMB_WORKSPACE ?? process.cwd());
  const P = paths(workspace);
  const o = loadOntology(P.ontology);
  const runDate = flags.run ?? new Date().toISOString().slice(0, 10);

  try {
    switch (cmd) {
      case 'upsert': {
        if (!existsSync(P.motifs)) throw new Error(`no motifs at ${P.motifs}; run motifs.mjs first`);
        const motifs = JSON.parse(readFileSync(P.motifs, 'utf8')).motifs;
        const steps = readJsonl(P.skeletons);
        const { created, proposals } = upsert(o, motifs, steps, runDate);
        console.error(`upsert: ${Object.keys(o.nodes).length} nodes, ${created.length} new, ${proposals.length} merge proposal(s)`);
        break;
      }
      case 'render': break;
      case 'annotate': {
        const [id] = rest; if (!id) throw new Error('usage: annotate <id> [--name S] [--summary S] [--tool S] [--type S] [--theme S]');
        const fields = {}; for (const k of ANNOTATABLE) if (flags[k] !== undefined) fields[k] = flags[k];
        annotate(o, id, fields); break;
      }
      case 'status': { const [id, status] = rest; setStatus(o, id, status); break; }
      case 'merge': {
        if (flags.dismiss) { const [a, b] = rest; dismissMerge(o, a, b); }
        else { const [keep, drop] = rest; mergeNodes(o, keep, drop); }
        break;
      }
      case 'move': { const [m, n] = rest; moveMotif(o, m, n); break; }
      default:
        console.error('usage: ontology.mjs <upsert|render|annotate|status|merge|move> ...'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(1); }

  saveOntology(P.ontology, o);
  renderTo(workspace, o);
  console.error(`ontology -> ${P.ontology}\ncandidates -> ${join(workspace, 'candidates.md')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
