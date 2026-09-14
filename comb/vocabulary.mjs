/**
 * The projection vocabulary — the single source of truth for every token the
 * projector is allowed to emit.
 *
 * INVARIANT: the projector never copies bytes from a transcript into a token.
 * Input is used ONLY to *select* a constant from the tables below. The record
 * timestamp is the one field carried through, for elapsed-time measurement. Anything
 * unrecognized selects a fallback constant. This makes the set of possible
 * outputs finite and enumerable, which `test/projection.test.mjs` asserts
 * mechanically against the real corpus.
 */

// Bash verbs we recognize. Anything else collapses to Bash(other), so
// client-specific scripts (./scripts/acme_sync.sh) can never surface.
export const BASH_VERBS = new Set([
  // vcs / forge
  'git', 'gh', 'glab', 'jj',
  // js
  'node', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'deno', 'tsc', 'vite', 'eslint', 'prettier',
  // python
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'pytest', 'ruff', 'black', 'mypy', 'poetry', 'tox',
  // other langs
  'cargo', 'rustc', 'go', 'java', 'mvn', 'gradle', 'dotnet', 'ruby', 'bundle', 'rails', 'php', 'composer',
  // infra
  'terraform', 'tofu', 'pulumi', 'ansible', 'kubectl', 'helm', 'docker', 'docker-compose', 'podman',
  'aws', 'az', 'gcloud', 'flyctl', 'vercel', 'wrangler', 'serverless',
  // data
  'psql', 'mysql', 'sqlite3', 'mongo', 'mongosh', 'redis-cli', 'duckdb', 'alembic', 'prisma', 'dbt',
  // build / task
  'make', 'just', 'task', 'bazel', 'cmake', 'ninja',
  // shell utilities
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'fd', 'sed', 'awk', 'jq', 'yq', 'wc', 'sort', 'uniq',
  'diff', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'ln', 'tar', 'zip', 'unzip', 'curl', 'wget',
  'echo', 'printf', 'which', 'env', 'ps', 'kill', 'open', 'pbcopy', 'pbpaste', 'date', 'sleep',
  'ssh', 'scp', 'rsync', 'brew', 'code', 'defaults', 'launchctl', 'osascript',
]);

// Commands that are scaffolding rather than the payload of a step.
export const BASH_NOISE = new Set(['cd', 'export', 'source', '.', 'set', 'unset', 'pushd', 'popd', 'eval', 'exec']);

// Our own repo scripts, matched by basename and emitted as a constant. A client script
// that shares a name is mis-attributed to us; that is an analysis error, not a leak.
export const INTERNAL_SCRIPTS = new Set([
  'validate-all.sh', 'run_checks.sh', 'guard-tests.sh', 'agent-checks.sh',
  'connector-checks.sh', 'skill-budget-checks.sh', 'delivery.sh',
]);

// Runner verbs whose second token names the work: `uv run`, `npm test`.
export const RUNNER_VERBS = new Set([
  'uv', 'uvx', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'make', 'just',
  'task', 'poetry', 'docker',
]);
export const SECOND_TOKENS = new Set(['run', 'test', 'check', 'lint', 'build', 'install']);

// Inline-Python shapes. The shape is selected, never sliced from the command.
export const PYTHON_VERBS = new Set(['python', 'python3']);
export const PYTHON_SHAPES = ['-c', '-m', 'stdin', 'file'];

// File extensions we recognize. Unknown extensions collapse to `.other`,
// so a client-specific format (.acmeconf) cannot surface.
export const FILE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.py', '.pyi', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.html', '.css', '.scss', '.less', '.vue', '.svelte', '.md', '.mdx', '.txt', '.rst',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.csv', '.tsv', '.parquet',
  '.tf', '.tfvars', '.hcl', '.dockerfile', '.lock', '.ipynb', '.pdf', '.png', '.jpg', '.svg',
]);

// Tools emitted bare — they carry no argument worth projecting.
export const BARE_TOOLS = new Set([
  'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode',
  'ListAgents', 'ToolSearch', 'KillShell', 'BashOutput', 'Artifact', 'AskUserQuestion',
]);

// Tools whose input names a file.
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Skill names known to be generic (public marketplaces / superpowers / official).
// Client marketplace skills (e.g. an `acme-marketplace` skill named `acme-ledger-refresh`)
// encode client business domain in the NAME, so they collapse to a constant.
export const GENERIC_SKILLS = new Set([
  'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'systematic-debugging', 'using-superpowers', 'requesting-code-review', 'receiving-code-review',
  'verification-before-completion', 'using-git-worktrees', 'writing-skills',
  'subagent-driven-development', 'dispatching-parallel-agents', 'finishing-a-development-branch',
  'code-review', 'simplify', 'init', 'security-review', 'run', 'loop', 'schedule',
  'artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'dataviz', 'design',
  'update-config', 'keybindings-help', 'claude-api', 'claude-in-chrome', 'fewer-permission-prompts',
  'docs-generator', 'update-documentation', 'fix-documentation-links', 'skill-creator',
  'diagnosing-bugs', 'tdd', 'prototype', 'research', 'domain-modeling', 'codebase-design',
  'resolving-merge-conflicts', 'wizard', 'grilling', 'writing-for-agents',
  'new-plugin', 'new-agent', 'new-connector', 'repo-init', 'validate', 'add-skill',
  'reflect', 'eow', 'eow-email-creator',
]);

// Subagent types that ship with the harness / public marketplaces.
export const GENERIC_AGENTS = new Set([
  'general-purpose', 'Explore', 'Plan', 'claude', 'claude-code-guide', 'statusline-setup',
  'code-reviewer', 'fork',
]);

// MCP servers that are third-party vendors rather than client-named integrations.
export const GENERIC_MCP = new Set([
  'harvest', 'linear', 'slack', 'github', 'notion', 'gmail', 'figma', 'sentry', 'stripe',
  'playwright', 'context7', 'exa', 'fireflies', 'granola', 'pylon', 'vercel', 'zapier',
  'asana', 'calendly', 'canva', 'gamma', 'postman', 'sanity', 'typeform', 'box',
]);

export const STRUCTURAL = ['User'];

export const FALLBACKS = [
  'Bash(other)', 'Bash(noise)', 'Tool(other)', 'Skill(other)', 'Task(other)', 'Mcp(other)',
];

/** Every token the projector may ever emit. The audit test asserts closure over this. */
export function buildVocabulary() {
  const v = new Set(STRUCTURAL);
  for (const f of FALLBACKS) v.add(f);
  for (const b of BASH_VERBS) v.add(`Bash(${b})`);
  for (const t of BARE_TOOLS) v.add(t);
  for (const t of FILE_TOOLS) for (const e of FILE_EXTS) v.add(`${t}(${e})`);
  for (const t of FILE_TOOLS) v.add(`${t}(.other)`);
  for (const t of FILE_TOOLS) v.add(`${t}(.none)`);
  for (const s of GENERIC_SKILLS) v.add(`Skill(${s})`);
  for (const a of GENERIC_AGENTS) v.add(`Task(${a})`);
  for (const m of GENERIC_MCP) v.add(`Mcp(${m})`);
  v.add('Bash(script)');
  for (const s of INTERNAL_SCRIPTS) v.add(`Bash(script:${s})`);
  for (const r of RUNNER_VERBS) for (const t of SECOND_TOKENS) v.add(`Bash(${r}:${t})`);
  for (const p of PYTHON_VERBS) for (const s of PYTHON_SHAPES) v.add(`Bash(${p}:${s})`);
  return v;
}

export const VOCABULARY = buildVocabulary();

/**
 * Signal tiering (used by stage 2, not stage 1).
 *
 * These verbs are how an agent *looks around* — inspection, navigation, trivial
 * file shuffling. They are legitimate steps and stay in the skeleton, but they
 * swamp motif detection and are not themselves automatable work. Stage 2 filters
 * them out of motif sequences.
 *
 * Kept deliberately OUT of this list because repetition of them is real signal:
 * grep/rg/find/fd (search flailing), git, and every build/test/infra verb.
 */
export const LOW_SIGNAL_VERBS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'echo', 'printf', 'which',
  'date', 'sleep', 'open', 'pbcopy', 'pbpaste', 'ps', 'env', 'diff',
  'mkdir', 'touch', 'chmod', 'ln', 'cp', 'mv', 'defaults', 'launchctl', 'osascript',
]);

export const isLowSignal = (token) => {
  const m = /^Bash\(([^)]+)\)$/.exec(token);
  return m ? LOW_SIGNAL_VERBS.has(m[1]) : false;
};
