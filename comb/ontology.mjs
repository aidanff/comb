#!/usr/bin/env bun
/**
 * STAGE 3 — the ontology. Deterministic, no model.
 *
 * Groups motifs into candidate nodes, connects nodes with similarity and flow edges,
 * groups nodes into themes, ranks nodes by friction and centrality, keeps per-run
 * history, and renders candidates.md. comb/ontology.json is the source of truth.
 *
 * Ownership: `upsert` writes machine fields only. The skill writes name, summary, tool,
 * type, and theme names through `annotate`. A human writes status, merges, moves, and
 * dismissals. `upsert` never touches those fields.
 *
 * Usage:
 *   bun ontology.mjs upsert  [--workspace DIR] [--run YYYY-MM-DD]
 *   bun ontology.mjs render  [--workspace DIR]
 *   bun ontology.mjs annotate <N001|T01> [--name S] [--summary S] [--tool S] [--type S]
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
  JOIN: 0.7, THEME: 0.3, MERGE: 0.7, RENDER_SIM: 0.3, RENDER_FLOW_COUNT: 3, RENDER_FLOW_SESSIONS: 2,
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
    version: 1, run: null, nextNode: 1, nextTheme: 1,
    corpus: { steps: 0, sessions: 0, projects: 0 }, runs: [],
    nodes: {}, themes: {}, assignments: {}, motifIndex: {},
    similarity: [], flow: [], dismissedMerges: [],
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
const themeId = (n) => `T${String(n).padStart(2, '0')}`;

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
 * node at or above JOIN; the rest form connected components at JOIN and become new nodes.
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

  // Connected components among the pending motifs at JOIN.
  const seen = new Set();
  for (const m of pending) {
    if (seen.has(m.id)) continue;
    const comp = [m]; seen.add(m.id);
    for (let i = 0; i < comp.length; i++) {
      for (const other of pending) {
        if (seen.has(other.id)) continue;
        if (similarity(new Set(comp[i].sequence), new Set(other.sequence)) >= THRESHOLDS.JOIN) { comp.push(other); seen.add(other.id); }
      }
    }
    const id = newNode(o, m.id, runDate);   // m is the highest-ranked in its component
    for (const c of comp) { o.assignments[c.id] = id; o.nodes[id].motifs.push(c.id); }
    created.push(id);
  }
  for (const n of Object.values(o.nodes)) n.motifs.sort();
  return { created };
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

function components(ids, connected) {
  const seen = new Set(); const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp = [id]; seen.add(id);
    for (let i = 0; i < comp.length; i++) for (const other of ids) {
      if (!seen.has(other) && connected(comp[i], other)) { comp.push(other); seen.add(other); }
    }
    out.push(comp.sort());
  }
  return out;
}

/** Node-level components at THEME. Names persist by largest member overlap. */
export function computeThemes(o) {
  const ids = Object.keys(o.nodes).sort();
  const toks = new Map(ids.map((id) => [id, nodeTokens(o, id)]));
  const comps = components(ids, (a, b) => similarity(toks.get(a), toks.get(b)) >= THRESHOLDS.THEME);

  const old = o.themes; const next = {}; const used = new Set();
  for (const comp of comps) {
    let bestId = null; let bestOverlap = 0;
    for (const [tid, t] of Object.entries(old)) {
      if (used.has(tid)) continue;
      const overlap = t.nodes.filter((n) => comp.includes(n)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; bestId = tid; }
    }
    const tid = bestId ?? themeId(o.nextTheme++);
    used.add(tid);
    next[tid] = { name: old[tid]?.name ?? null, nodes: comp };
    for (const n of comp) o.nodes[n].theme = tid;
  }
  o.themes = next;
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
