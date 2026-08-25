import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectBash, projectFile, projectSkill, projectTask, projectMcp, projectToolUse, projectLines } from '../project.mjs';
import { VOCABULARY } from '../vocabulary.mjs';

describe('projectBash — match-and-emit-a-constant', () => {
  test('recognizes a plain verb', () => {
    expect(projectBash('pytest -k foo')).toBe('Bash(pytest)');
  });
  test('strips env assignments', () => {
    expect(projectBash('AWS_PROFILE=acme-prod aws s3 sync x y')).toBe('Bash(aws)');
  });
  test('strips sudo', () => {
    expect(projectBash('sudo docker ps')).toBe('Bash(docker)');
  });
  test('skips cd scaffolding and takes the payload', () => {
    expect(projectBash('cd infra && terraform apply -var-file=acme-prod.tfvars')).toBe('Bash(terraform)');
  });
  test('takes the first pipeline stage, not the pager', () => {
    expect(projectBash('pytest tests/ | head -50')).toBe('Bash(pytest)');
  });
  test('path-like commands fail closed', () => {
    expect(projectBash('./scripts/acme_ledger_sync.sh --client acme')).toBe('Bash(other)');
    expect(projectBash('/usr/local/bin/acmectl deploy')).toBe('Bash(other)');
  });
  test('unknown verbs fail closed', () => {
    expect(projectBash('acmectl reconcile --tenant northwind')).toBe('Bash(other)');
  });
  test('pure scaffolding is marked as noise', () => {
    expect(projectBash('cd /Users/aidan/clients/Acme')).toBe('Bash(noise)');
  });
  test('empty / non-string input is safe', () => {
    expect(projectBash('')).toBe('Bash(other)');
    expect(projectBash(undefined)).toBe('Bash(other)');
    expect(projectBash(null)).toBe('Bash(other)');
  });
});

describe('projectFile — extension only', () => {
  test('known extension survives, path does not', () => {
    expect(projectFile('Edit', { file_path: '/Users/aidan/clients/Acme/src/acme_recon.py' })).toBe('Edit(.py)');
  });
  test('unknown extension fails closed', () => {
    expect(projectFile('Read', { file_path: '/x/y/tenant.acmeconf' })).toBe('Read(.other)');
  });
  test('missing path is safe', () => {
    expect(projectFile('Write', {})).toBe('Write(.none)');
    expect(projectFile('Write', undefined)).toBe('Write(.none)');
  });
});

describe('projectSkill — client marketplace names collapse', () => {
  test('generic skills survive', () => {
    expect(projectSkill({ skill: 'superpowers:brainstorming' })).toBe('Skill(brainstorming)');
  });
  test('client-domain skill names never surface', () => {
    // ies-marketplace ships these; the NAME encodes the client business line.
    expect(projectSkill({ skill: 'wind-ar-master-refresh' })).toBe('Skill(other)');
    expect(projectSkill({ skill: 'ies:payroll-to-billing' })).toBe('Skill(other)');
  });
});

describe('projectTask / projectMcp', () => {
  test('known agent types survive', () => {
    expect(projectTask({ subagent_type: 'Explore' })).toBe('Task(Explore)');
  });
  test('unknown agent types collapse', () => {
    expect(projectTask({ subagent_type: 'acme-ledger-auditor' })).toBe('Task(other)');
  });
  test('vendor mcp servers are recognized', () => {
    expect(projectMcp('mcp__harvest__log_time')).toBe('Mcp(harvest)');
  });
  test('unknown mcp servers collapse', () => {
    expect(projectMcp('mcp__acme_internal__fetch_ledger')).toBe('Mcp(other)');
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
    expect(steps).toEqual([]);
  });

  test('tolerates a torn trailing line', () => {
    const lines = [
      mk({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }),
      '{"type":"assistant","message":{"content":[{"type":"tool_u',
    ];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    expect(steps.map((s) => s.step)).toEqual(['Bash(git)']);
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
    expect(steps.map((s) => s.step)).toEqual(['Edit(.py)']);
  });

  test('counts human turns but not tool_result deliveries', () => {
    const lines = [
      mk({ type: 'user', message: { content: 'no, the cutoff date is wrong' } }),
      mk({ type: 'user', message: { content: [{ type: 'tool_result', content: 'acme rows: 1423' }] } }),
    ];
    const { steps } = projectLines(lines, { sessionId: 's', projectId: 'p' });
    expect(steps.map((s) => s.step)).toEqual(['User']);
  });
});

describe('NO-BYTE-FLOW: adversarial inputs never surface', () => {
  const SECRETS = ['Acme', 'acme', 'northwind', 'wind-ar', 'cutoff', 'invoice', 'ledger', 'prod'];
  const hostile = [
    { name: 'Bash', input: { command: 'acmectl sync --tenant northwind --ledger prod' } },
    { name: 'Bash', input: { command: './scripts/acme_invoice_cutoff.sh' } },
    { name: 'Edit', input: { file_path: '/Users/aidan/clients/Acme/acme_ledger.acmeconf' } },
    { name: 'Skill', input: { skill: 'wind-ar-master-refresh' } },
    { name: 'Task', input: { subagent_type: 'acme-ledger-auditor' } },
    { name: 'mcp__acme_prod__ledger', input: { q: 'invoice' } },
    { name: 'AcmeCustomTool', input: { anything: 'northwind' } },
  ];

  test('no projected token contains any secret substring', () => {
    for (const h of hostile) {
      const token = projectToolUse(h.name, h.input);
      for (const secret of SECRETS) {
        expect(token.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    }
  });

  test('every projected token is a member of the closed vocabulary', () => {
    for (const h of hostile) {
      expect(VOCABULARY.has(projectToolUse(h.name, h.input))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// THE AUDIT: the actual security control. Run the projector over the entire
// real transcript corpus and assert closure over the finite vocabulary.
// ---------------------------------------------------------------------------
describe('AUDIT — vocabulary closure over the real corpus', () => {
  test('every token emitted from every real transcript is in VOCABULARY', () => {
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
    expect([...violations]).toEqual([]);
    expect(tokens).toBeGreaterThan(0);
  }, 120000);
});
