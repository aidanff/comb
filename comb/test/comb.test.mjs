import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { skillInput } from '../comb.mjs';
import { emptyOntology } from '../ontology.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const mk = (o) => JSON.stringify(o);
const rec = (sec, content, type = 'assistant') => mk({ type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString(), message: { content } });
const bash = (sec, command) => rec(sec, [{ type: 'tool_use', name: 'Bash', input: { command } }]);

describe('comb.mjs driver', () => {
  test('runs all three stages against a temp workspace and prints the skill input', () => {
    const ws = mkdtempSync(join(tmpdir(), 'comb-ws-'));
    const projects = join(ws, 'projects');
    for (const [p, s] of [['proj-a', 'a'], ['proj-b', 'b'], ['proj-c', 'c']]) {
      mkdirSync(join(projects, p, 'subagents'), { recursive: true });
      const lines = [bash(0, 'grep -rn foo .'), bash(1, 'sed -i "" s/a/b/ x.py'), rec(5, 'no, wrong file', 'user'),
        bash(10, 'grep -rn foo .'), bash(11, 'sed -i "" s/a/b/ x.py')];
      writeFileSync(join(projects, p, `${s}.jsonl`), lines.join('\n'));
      writeFileSync(join(projects, p, 'subagents', 'agent-x.jsonl'), bash(0, 'rm -rf /clients/acme'));
    }
    const r = spawnSync(process.execPath, [join(HERE, '..', 'comb.mjs'), '--workspace', ws, '--projects', projects, '--team-key', 'k', '--run', '2026-09-14'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.unnamedNodes.length >= 1);
    assert.ok(existsSync(join(ws, 'comb', 'ontology.json')));
    assert.ok(readFileSync(join(ws, 'candidates.md'), 'utf8').includes('## Candidates'));
    // The subagent transcript was never read: its token would be Bash(rm), absent from the corpus.
    assert.equal(readFileSync(join(ws, 'comb', '.work', 'skeletons.jsonl'), 'utf8').includes('Bash(rm)'), false);
  });

  test('skillInput lists unnamed nodes and themes only', () => {
    const o = emptyOntology();
    o.nodes.N001 = { name: null, seed: ['A'], stats: { occurrences: 1 }, status: 'new', theme: 'T01', motifs: [] };
    o.nodes.N002 = { name: 'named', seed: ['B'], stats: { occurrences: 1 }, status: 'new', theme: 'T01', motifs: [] };
    o.themes.T01 = { name: null, nodes: ['N001', 'N002'] };
    const s = skillInput(o);
    assert.deepEqual(s.unnamedNodes.map((n) => n.id), ['N001']);
    assert.deepEqual(s.unnamedThemes.map((t) => t.id), ['T01']);
  });
});
