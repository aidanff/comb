import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectBash, projectFile, projectSkill, projectTask, projectMcp, projectToolUse, projectLines } from '../project.mjs';
import { VOCABULARY } from '../vocabulary.mjs';

describe('projectBash — match-and-emit-a-constant', () => {
  test('recognizes a plain verb', () => {
    assert.equal(projectBash('pytest -k foo'), 'Bash(pytest)');
  });
  test('strips env assignments', () => {
    assert.equal(projectBash('AWS_PROFILE=acme-prod aws s3 sync x y'), 'Bash(aws)');
  });
  test('strips sudo', () => {
    assert.equal(projectBash('sudo docker ps'), 'Bash(docker)');
  });
  test('skips cd scaffolding and takes the payload', () => {
    assert.equal(projectBash('cd infra && terraform apply -var-file=acme-prod.tfvars'), 'Bash(terraform)');
  });
  test('takes the first pipeline stage, not the pager', () => {
    assert.equal(projectBash('pytest tests/ | head -50'), 'Bash(pytest)');
  });
  test('path-like commands emit Bash(script), never the path', () => {
    assert.equal(projectBash('./scripts/acme_ledger_sync.sh --client acme'), 'Bash(script)');
    assert.equal(projectBash('/usr/local/bin/acmectl deploy'), 'Bash(script)');
  });
  test('internal script basenames emit their own constant', () => {
    assert.equal(projectBash('scripts/validate-all.sh --all'), 'Bash(script:validate-all.sh)');
    assert.equal(projectBash('./plugins/x/evals/run_checks.sh'), 'Bash(script:run_checks.sh)');
  });
  test('a client script that shares an internal basename is attributed to us, not leaked', () => {
    assert.equal(projectBash('/clients/acme/tools/delivery.sh acme'), 'Bash(script:delivery.sh)');
  });
  test('runner second tokens are named', () => {
    assert.equal(projectBash('uv run pytest -x'), 'Bash(uv:run)');
    assert.equal(projectBash('npm test'), 'Bash(npm:test)');
    assert.equal(projectBash('make build'), 'Bash(make:build)');
    assert.equal(projectBash('uv sync'), 'Bash(uv)');
  });
  test('python shapes are named', () => {
    assert.equal(projectBash('python3 -c "import json; print(1)"'), 'Bash(python3:-c)');
    assert.equal(projectBash('python3 -m pytest'), 'Bash(python3:-m)');
    assert.equal(projectBash('python3 - <<EOF\nprint(1)\nEOF'), 'Bash(python3:stdin)');
    assert.equal(projectBash('python3 evals/check_palette.py'), 'Bash(python3:file)');
    assert.equal(projectBash('python3'), 'Bash(python3)');
    assert.equal(projectBash('python -c "1"'), 'Bash(python:-c)');
  });
  test('unknown verbs fail closed', () => {
    assert.equal(projectBash('acmectl reconcile --tenant northwind'), 'Bash(other)');
  });
  test('pure scaffolding is marked as noise', () => {
    assert.equal(projectBash('cd /Users/<name>/clients/Acme'), 'Bash(noise)');
  });
  test('empty / non-string input is safe', () => {
    assert.equal(projectBash(''), 'Bash(other)');
    assert.equal(projectBash(undefined), 'Bash(other)');
    assert.equal(projectBash(null), 'Bash(other)');
  });
});

describe('projectFile — extension only', () => {
  test('known extension survives, path does not', () => {
    assert.equal(projectFile('Edit', { file_path: '/Users/<name>/clients/Acme/src/acme_recon.py' }), 'Edit(.py)');
  });
  test('unknown extension fails closed', () => {
    assert.equal(projectFile('Read', { file_path: '/x/y/tenant.acmeconf' }), 'Read(.other)');
  });
  test('missing path is safe', () => {
    assert.equal(projectFile('Write', {}), 'Write(.none)');
    assert.equal(projectFile('Write', undefined), 'Write(.none)');
  });
});

describe('projectSkill — client marketplace names collapse', () => {
  test('generic skills survive', () => {
    assert.equal(projectSkill({ skill: 'superpowers:brainstorming' }), 'Skill(brainstorming)');
  });
  test('client-domain skill names never surface', () => {
    // A client marketplace ships these; the NAME encodes the client business line.
    assert.equal(projectSkill({ skill: 'acme-ledger-refresh' }), 'Skill(other)');
    assert.equal(projectSkill({ skill: 'acme:payroll-to-billing' }), 'Skill(other)');
  });
});

describe('projectTask / projectMcp', () => {
  test('known agent types survive', () => {
    assert.equal(projectTask({ subagent_type: 'Explore' }), 'Task(Explore)');
  });
  test('unknown agent types collapse', () => {
    assert.equal(projectTask({ subagent_type: 'acme-ledger-auditor' }), 'Task(other)');
  });
  test('vendor mcp servers are recognized', () => {
    assert.equal(projectMcp('mcp__harvest__log_time'), 'Mcp(harvest)');
  });
  test('unknown mcp servers collapse', () => {
    assert.equal(projectMcp('mcp__acme_internal__fetch_ledger'), 'Mcp(other)');
  });
});

describe('projectLines — record triage and robustness', () => {
  const mk = (o) => JSON.stringify(o);

  test('drops non-message record types without reading them', () => {
    const lines = [
      mk({ type: 'ai-title', title: 'Acme invoice reconciliation for Q3' }),
      mk({ type: 'last-prompt', prompt: 'fix the acme cutoff date' }),
      mk({ type: 'file-history-snapshot', snapshot: { '/clients/Acme/x.py': 'secret' } }),
    ];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    assert.deepEqual(steps, []);
  });

  test('tolerates a torn trailing line', () => {
    const lines = [
      mk({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }),
      '{"type":"assistant","message":{"content":[{"type":"tool_u',
    ];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    assert.deepEqual(steps.map((s) => s.step), ['Bash(git)']);
  });

  test('drops thinking and text blocks', () => {
    const lines = [mk({
      type: 'assistant',
      message: { content: [
        { type: 'thinking', thinking: 'The Acme invoice cutoff is wrong because...' },
        { type: 'text', text: 'I will fix the Acme reconciliation.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/clients/Acme/recon.py' } },
      ] },
    })];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    assert.deepEqual(steps.map((s) => s.step), ['Edit(.py)']);
  });

  test('counts human turns but not tool_result deliveries', () => {
    const lines = [
      mk({ type: 'user', message: { content: 'no, the cutoff date is wrong' } }),
      mk({ type: 'user', message: { content: [{ type: 'tool_result', content: 'acme rows: 1423' }] } }),
    ];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    assert.deepEqual(steps.map((s) => s.step), ['User']);
  });
});

describe('NO-BYTE-FLOW: adversarial inputs never surface', () => {
  const SECRETS = ['Acme', 'acme', 'northwind', 'acme-ledger', 'cutoff', 'invoice', 'ledger', 'prod'];
  const hostile = [
    { name: 'Bash', input: { command: 'acmectl sync --tenant northwind --ledger prod' } },
    { name: 'Bash', input: { command: './scripts/acme_invoice_cutoff.sh' } },
    { name: 'Bash', input: { command: '/clients/acme/tools/delivery.sh northwind' } },
    { name: 'Edit', input: { file_path: '/Users/<name>/clients/Acme/acme_ledger.acmeconf' } },
    { name: 'Skill', input: { skill: 'acme-ledger-refresh' } },
    { name: 'Task', input: { subagent_type: 'acme-ledger-auditor' } },
    { name: 'mcp__acme_prod__ledger', input: { q: 'invoice' } },
    { name: 'AcmeCustomTool', input: { anything: 'northwind' } },
  ];

  test('no projected token contains any secret substring', () => {
    for (const h of hostile) {
      const token = projectToolUse(h.name, h.input);
      for (const secret of SECRETS) {
        assert.ok(!(token.toLowerCase()).includes(secret.toLowerCase()));
      }
    }
  });

  test('every projected token is a member of the closed vocabulary', () => {
    for (const h of hostile) {
      assert.equal(VOCABULARY.has(projectToolUse(h.name, h.input)), true);
    }
  });
});

// ---------------------------------------------------------------------------
// THE AUDIT: the actual security control. Run the projector over the entire
// real transcript corpus and assert closure over the finite vocabulary.
// ---------------------------------------------------------------------------
describe('AUDIT — vocabulary closure over the real corpus', () => {
  test('every token emitted from every real transcript is in VOCABULARY', { timeout: 120000 }, () => {
    const root = join(homedir(), '.claude', 'projects');
    let dirs = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }

    const violations = new Set();
    let tokens = 0;

    for (const dir of dirs) {
      let files = [];
      try { files = readdirSync(join(root, dir.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const file of files) {
        let lines;
        try { lines = readFileSync(join(root, dir.name, file), 'utf8').split('\n'); } catch { continue; }
        const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
        for (const s of steps) {
          tokens++;
          if (!VOCABULARY.has(s.step)) violations.add(s.step);
        }
      }
    }

    console.log(`  audited ${tokens} tokens across ${dirs.length} project dirs`);
    assert.deepEqual([...violations], []);
    assert.ok((tokens) > 0);
  });
});

// ---------------------------------------------------------------------------
// Run state: team-key handling and watermark reset.
// ---------------------------------------------------------------------------
import { loadState } from '../project.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('loadState — team key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comb-state-'));
  const path = join(dir, 'processed.json');

  test('generates a team key when none is stored or supplied', () => {
    const s = loadState(join(dir, 'missing.json'));
    assert.equal(typeof s.teamKey, 'string');
    assert.equal(s.teamKey.length, 32);
  });
  test('adopts a supplied team key on a fresh state', () => {
    const s = loadState(join(dir, 'missing2.json'), { teamKey: 'abc123' });
    assert.equal(s.teamKey, 'abc123');
  });
  test('refuses a differing team key without --all, so IDs never fragment silently', () => {
    writeFileSync(path, JSON.stringify({ teamKey: 'old', files: { 'a/b.jsonl': { lines: 3, size: 9 } } }));
    assert.throws(() => loadState(path, { teamKey: 'new' }), /--all/);
  });
  test('accepts a differing team key with --all and drops stale watermarks', () => {
    const s = loadState(path, { teamKey: 'new', all: true });
    assert.equal(s.teamKey, 'new');
    assert.deepEqual(s.files, {});
  });
  test('keeps the stored team key when the supplied one matches', () => {
    const s = loadState(path, { teamKey: 'old' });
    assert.equal(s.teamKey, 'old');
    assert.equal(s.files['a/b.jsonl'].lines, 3);
  });
  test('migrates a pre-rename state file that stored the key as salt', () => {
    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ salt: 'oldkey', files: { 'a/b.jsonl': { lines: 1, size: 2 } } }));
    const s = loadState(legacy);
    assert.equal(s.teamKey, 'oldkey');
    assert.equal(s.salt, undefined);
    assert.equal(s.files['a/b.jsonl'].lines, 1);
  });
});

import { listTranscripts } from '../project.mjs';
import { mkdirSync } from 'node:fs';

describe('listTranscripts — main chain only', () => {
  const root = mkdtempSync(join(tmpdir(), 'comb-projects-'));
  mkdirSync(join(root, 'proj-a', 'subagents'), { recursive: true });
  mkdirSync(join(root, 'proj-a', 'wf_abc'), { recursive: true });
  mkdirSync(join(root, 'proj-b'), { recursive: true });
  writeFileSync(join(root, 'proj-a', 'sess1.jsonl'), '');
  writeFileSync(join(root, 'proj-a', 'subagents', 'agent-1.jsonl'), '');
  writeFileSync(join(root, 'proj-a', 'wf_abc', 'x.jsonl'), '');
  writeFileSync(join(root, 'proj-b', 'sess2.jsonl'), '');

  test('returns top-level session files only', () => {
    const files = listTranscripts(root, { skip: () => false }).map((f) => `${f.dir}/${f.file}`).sort();
    assert.deepEqual(files, ['proj-a/sess1.jsonl', 'proj-b/sess2.jsonl']);
  });
  test('applies the skip predicate to project dirs', () => {
    const files = listTranscripts(root, { skip: (d) => d === 'proj-a' }).map((f) => f.dir);
    assert.deepEqual(files, ['proj-b']);
  });
});

describe('loadState — excludeDirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comb-exclude-'));
  const path = join(dir, 'processed.json');
  test('stores excludes and unions them on later calls', () => {
    let s = loadState(path, { exclude: ['-Users-x-dev-RnD'] });
    assert.deepEqual(s.excludeDirs, ['-Users-x-dev-RnD']);
    writeFileSync(path, JSON.stringify(s));
    s = loadState(path, { exclude: ['-Users-x-other'] });
    assert.deepEqual(s.excludeDirs, ['-Users-x-dev-RnD', '-Users-x-other']);
  });
  test('defaults to an empty list', () => {
    assert.deepEqual(loadState(join(dir, 'none.json')).excludeDirs, []);
  });
});
