#!/usr/bin/env bun
/**
 * STAGE 2 — motif detection. Deterministic, no model.
 *
 * Consumes action skeletons (already projected — contains no client data) and
 * emits ranked motifs: recurring action sequences that are candidates for
 * automation.
 *
 * Two signals:
 *   - CYCLE   an (A B)+ run repeating within a single session. Trial-and-error.
 *   - RITUAL  an n-gram recurring across multiple distinct sessions.
 *
 * Usage: bun motifs.mjs [--workspace DIR] [--in FILE] [--out FILE]
 *                       [--min-sessions N] [--min-cycles N] [--max-motifs N]
 *
 * Runs under Bun or Node (>= 20). Paths default to the workspace
 * (--workspace, else $COMB_WORKSPACE, else cwd), like project.mjs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isLowSignal } from './vocabulary.mjs';

const MIN_N = 2;
const MAX_N = 6;
const MAX_CYCLE_LEN = 4;

/** A human turn this soon after a step is a delivery artifact, not a correction. */
export const CORRECTION_FLOOR_MS = 2000;

// Scaffolding and inspection carry no automation signal and would otherwise
// dominate every n-gram (the first run's top motifs were ls / cat / echo).
const DROP = new Set(['Bash(noise)']);
const drop = (token) => DROP.has(token) || isLowSignal(token);

export const motifId = (seq) => `M${createHash('sha256').update(seq.join('>')).digest('hex').slice(0, 5).toUpperCase()}`;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Group skeleton steps into per-session ordered sequences. */
export function buildSequences(steps) {
  const bySession = new Map();
  for (const s of steps) {
    if (drop(s.step)) continue;
    const key = `${s.session}:${s.sidechain ? 'sub' : 'main'}`;
    if (!bySession.has(key)) {
      bySession.set(key, { session: s.session, project: s.project, sidechain: s.sidechain, steps: [] });
    }
    bySession.get(key).steps.push(s);
  }
  // Stable order: timestamp where present, insertion order otherwise.
  for (const seq of bySession.values()) {
    seq.steps.forEach((s, i) => { s._i = i; });
    seq.steps.sort((a, b) => {
      const ta = a.ts ? Date.parse(a.ts) : NaN;
      const tb = b.ts ? Date.parse(b.ts) : NaN;
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a._i - b._i;
    });
  }
  return [...bySession.values()];
}

/** A human turn counts as a correction only when it lands CORRECTION_FLOOR_MS or more after the step. */
const isCorrection = (last, next) => {
  const a = last?.ts ? Date.parse(last.ts) : NaN;
  const b = next?.ts ? Date.parse(next.ts) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b - a >= CORRECTION_FLOOR_MS;
};

const elapsed = (steps, i, len) => {
  const a = steps[i]?.ts ? Date.parse(steps[i].ts) : NaN;
  const b = steps[i + len - 1]?.ts ? Date.parse(steps[i + len - 1].ts) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
};

/** CYCLE: find (block)+ runs repeating >= minRepeats consecutively within a session. */
export function findCycles(sequences, minRepeats) {
  const found = new Map();
  for (const seq of sequences) {
    const toks = seq.steps.map((s) => s.step);
    const claimed = new Array(toks.length).fill(false);

    for (let L = 1; L <= MAX_CYCLE_LEN; L++) {
      for (let i = 0; i + L * minRepeats <= toks.length; i++) {
        if (claimed[i]) continue;
        const block = toks.slice(i, i + L);
        if (L > 1 && block.every((t) => t === block[0])) continue; // covered by L=1
        if (block.every((t) => t === 'User')) continue; // consecutive human turns are not a motif
        let reps = 1;
        while (
          i + (reps + 1) * L <= toks.length &&
          toks.slice(i + reps * L, i + (reps + 1) * L).every((t, k) => t === block[k])
        ) reps++;

        if (reps < minRepeats) continue;
        for (let k = i; k < i + reps * L; k++) claimed[k] = true;

        const id = motifId(block);
        if (!found.has(id)) {
          found.set(id, { id, kind: 'cycle', sequence: block, occurrences: 0, sessions: new Set(), projects: new Set(), sidechain: seq.sidechain, elapsedSamples: [], corrections: 0, maxDepth: 0 });
        }
        const m = found.get(id);
        m.occurrences += reps;
        m.maxDepth = Math.max(m.maxDepth, reps);
        {
          const next = seq.steps[i + reps * L];
          const last = seq.steps[i + reps * L - 1];
          if (next?.step === 'User' && isCorrection(last, next)) m.corrections++;
        }
        m.sessions.add(seq.session);
        m.projects.add(seq.project);
        const e = elapsed(seq.steps, i, reps * L);
        if (e !== null) m.elapsedSamples.push(Math.round(e / reps));
        i += reps * L - 1;
      }
    }
  }
  return found;
}

/** RITUAL: n-grams recurring across >= minSessions distinct sessions. */
export function findRituals(sequences, minSessions) {
  const found = new Map();
  for (const seq of sequences) {
    const toks = seq.steps.map((s) => s.step);
    for (let n = MIN_N; n <= MAX_N; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const gram = toks.slice(i, i + n);
        if (gram.every((t) => t === gram[0])) continue; // pure repetition is a cycle
        const id = motifId(gram);
        if (!found.has(id)) {
          found.set(id, { id, kind: 'ritual', sequence: gram, occurrences: 0, sessions: new Set(), projects: new Set(), sidechain: seq.sidechain, elapsedSamples: [], corrections: 0, maxDepth: 1 });
        }
        const m = found.get(id);
        m.occurrences++;
        {
          const next = seq.steps[i + n];
          const last = seq.steps[i + n - 1];
          if (next?.step === 'User' && isCorrection(last, next)) m.corrections++;
        }
        m.sessions.add(seq.session);
        m.projects.add(seq.project);
        const e = elapsed(seq.steps, i, n);
        if (e !== null) m.elapsedSamples.push(e);
      }
    }
  }
  for (const [id, m] of found) if (m.sessions.size < minSessions) found.delete(id);
  return found;
}

/**
 * Drop a shorter motif when a longer one contains it with equal support — the
 * shorter adds nothing and would flood the table with sub-motifs.
 */
export function collapseSubsumed(motifs) {
  const sorted = [...motifs].sort((a, b) => b.sequence.length - a.sequence.length);
  const kept = [];
  for (const m of sorted) {
    const subsumed = kept.some(
      (k) => k.kind === m.kind &&
        k.occurrences === m.occurrences &&
        k.sequence.length > m.sequence.length &&
        k.sequence.join('>').includes(m.sequence.join('>')),
    );
    if (!subsumed) kept.push(m);
  }
  return kept;
}

export function analyze(steps, { minSessions = 2, minCycles = 3, maxMotifs = 300 } = {}) {
  const sequences = buildSequences(steps);
  const raw = [...findCycles(sequences, minCycles).values(), ...findRituals(sequences, minSessions).values()];

  const finalized = raw.map((m) => ({
    id: m.id,
    kind: m.kind,
    sequence: m.sequence,
    length: m.sequence.length,
    occurrences: m.occurrences,
    distinctSessions: m.sessions.size,
    distinctProjects: m.projects.size,
    sidechain: m.sidechain,
    // Prose tiering: only cross-project motifs may be described in prose.
    crossProject: m.projects.size >= 2,
    medianElapsedMs: median(m.elapsedSamples),
    rank: m.occurrences * m.sequence.length * Math.max(1, m.projects.size),
    correctionRate: m.occurrences ? Number((m.corrections / m.occurrences).toFixed(3)) : 0,
    retryDepth: m.maxDepth,
    sessions: [...m.sessions].sort(),
    projects: [...m.projects].sort(),
  }));

  const ranked = collapseSubsumed(finalized).sort((a, b) => b.rank - a.rank);
  const kept = ranked.slice(0, maxMotifs);

  return {
    generatedFrom: {
      steps: steps.length,
      sessions: new Set(sequences.map((s) => s.session)).size,
      projects: new Set(sequences.map((s) => s.project)).size,
    },
    thresholds: { minSessions, minCycles, maxMotifs, MIN_N, MAX_N, MAX_CYCLE_LEN },
    motifsFound: ranked.length,
    motifsEmitted: kept.length,
    motifs: kept,
  };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') a.in = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--min-sessions') a.minSessions = Number(argv[++i]);
    else if (argv[i] === '--min-cycles') a.minCycles = Number(argv[++i]);
    else if (argv[i] === '--max-motifs') a.maxMotifs = Number(argv[++i]);
    else if (argv[i] === '--workspace') a.workspace = argv[++i];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(args.workspace ?? process.env.COMB_WORKSPACE ?? process.cwd());
  const inPath = args.in ?? join(workspace, 'comb', '.work', 'skeletons.jsonl');
  const outPath = args.out ?? join(workspace, 'comb', '.work', 'motifs.json');

  if (!existsSync(inPath)) {
    console.error(`no skeletons at ${inPath} — run project.mjs first`);
    process.exit(1);
  }

  const steps = readFileSync(inPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const result = analyze(steps, { minSessions: args.minSessions ?? 2, minCycles: args.minCycles ?? 3, maxMotifs: args.maxMotifs ?? 300 });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`${result.motifs.length} motifs from ${steps.length} steps across ${result.generatedFrom.sessions} sessions`);
  console.error(`motifs -> ${outPath}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
