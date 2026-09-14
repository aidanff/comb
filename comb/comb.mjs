#!/usr/bin/env bun
/**
 * comb — one command. Runs the projector, the miner, and the ontology upsert in order,
 * then prints the skill's input as JSON on stdout: unnamed nodes, merge proposals, the
 * top of the build order, how many motifs wait below the seed floor, and how many review
 * proposals await a human. Stage logs go to stderr. The review itself (review.mjs) runs
 * from the skill, after naming, because it needs a model.
 *
 * Usage: bun comb/comb.mjs [--all] [--exclude DIR]... [--workspace DIR] [--projects DIR]
 *                          [--team-key HEX] [--min-sessions N] [--min-cycles N]
 *                          [--max-motifs N] [--run YYYY-MM-DD]
 */

import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOntology, paths, buildOrder, mergeProposals } from './ontology.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const a = { exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--all') a.all = true;
    else if (k === '--exclude') a.exclude.push(argv[++i]);
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

function run(script, args) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error(`${script} failed`); process.exit(r.status ?? 1); }
}

export function skillInput(o) {
  return {
    run: o.run,
    unnamedNodes: Object.entries(o.nodes).filter(([, n]) => !n.name)
      .map(([id, n]) => ({ id, seed: n.seed, theme: n.theme, motifs: n.motifs, stats: n.stats, class: n.class })),
    waiting: o.unassigned.length,
    reviewPending: o.review?.proposals.length ?? 0,
    proposals: mergeProposals(o),
    buildOrder: buildOrder(o).slice(0, 5),
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const workspace = resolve(a.workspace ?? process.env.COMB_WORKSPACE ?? process.cwd());
  const ws = ['--workspace', workspace];

  const p1 = [...ws];
  if (a.all) p1.push('--all');
  if (a.projects) p1.push('--projects', a.projects);
  if (a['team-key']) p1.push('--team-key', a['team-key']);
  for (const e of a.exclude) p1.push('--exclude', e);
  run('project.mjs', p1);

  const p2 = [...ws];
  if (a['min-sessions']) p2.push('--min-sessions', a['min-sessions']);
  if (a['min-cycles']) p2.push('--min-cycles', a['min-cycles']);
  if (a['max-motifs']) p2.push('--max-motifs', a['max-motifs']);
  run('motifs.mjs', p2);

  const p3 = ['upsert', ...ws];
  if (a.run) p3.push('--run', a.run);
  run('ontology.mjs', p3);

  const o = loadOntology(paths(workspace).ontology);
  process.stdout.write(`${JSON.stringify(skillInput(o), null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
