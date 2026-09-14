#!/usr/bin/env bun
/**
 * STAGE 1 — the trust boundary.
 *
 * Reads Claude Code transcripts and emits an action skeleton. This is the ONLY
 * stage that touches raw transcript data, and it contains no model.
 *
 * Redaction is achieved by PROJECTION, not scrubbing: transcript bytes are used
 * only to *select* a constant from `vocabulary.mjs`. No byte from a transcript
 * is ever copied into the output. Unrecognized input selects a fallback
 * constant, so the projector fails closed on anything it has not seen before.
 *
 * One field is carried through verbatim: the record timestamp, which stage 2 needs
 * to measure elapsed time. It is the only transcript value that reaches the output.
 *
 * Usage:
 *   bun project.mjs [--workspace DIR] [--out FILE] [--state FILE] [--team-key HEX] [--all] [--projects DIR]
 *                   [--exclude DIRNAME]...
 *
 * Only top-level session transcripts are read. Nested subagent and workflow transcripts
 * are skipped on purpose: comb measures the operator's main chain. --exclude names a
 * project directory to skip; names persist in the state file under excludeDirs.
 *
 * Runs under Bun or Node (>= 20). Paths default to the WORKSPACE, which is
 * --workspace, else $COMB_WORKSPACE, else the current directory. The
 * workspace is the checkout that holds candidates.md and the committed corpus.
 * Session and project IDs are hashes of transcript directory names mixed with a
 * secret TEAM KEY. The key keeps the IDs unguessable and, when every teammate uses
 * the same key, identical across machines so skeletons can be pooled. It comes from
 * $COMB_TEAM_KEY (or --team-key); otherwise a per-machine key is generated.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import {
  BASH_VERBS, BASH_NOISE, FILE_EXTS, BARE_TOOLS, FILE_TOOLS,
  GENERIC_SKILLS, GENERIC_AGENTS, GENERIC_MCP,
  INTERNAL_SCRIPTS, RUNNER_VERBS, SECOND_TOKENS, PYTHON_VERBS,
} from './vocabulary.mjs';

// ---------------------------------------------------------------------------
// Projection functions. Each returns a CONSTANT selected by the input.
// ---------------------------------------------------------------------------

/**
 * Reduce an arbitrary shell command to one allowlisted verb constant.
 * Handles env prefixes, sudo, `cd x && real-command`, and `payload | pager`.
 */
export function projectBash(command) {
  if (typeof command !== 'string' || !command.trim()) return 'Bash(other)';
  let s = command.trim();

  // Strip leading environment assignments: FOO=bar BAZ=qux cmd
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  // Strip privilege / wrapper prefixes.
  s = s.replace(/^(?:sudo|command|nohup|time|xargs)\s+/, '');

  // Split into sequenced commands; keep the first that is not scaffolding.
  const segments = s.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  let payload = null;
  for (const seg of segments) {
    const head = headToken(seg);
    if (head === null) continue;
    // Only a bare, recognized scaffolding verb counts as noise. A path-like or
    // unknown head is a real payload we simply cannot name.
    if (!head.includes('/') && BASH_NOISE.has(head)) continue;
    payload = seg;
    break;
  }
  if (payload === null) return 'Bash(noise)';

  // Within a pipeline the payload is the FIRST stage; the rest are pagers.
  const stage = payload.split('|')[0];
  const words = stage.trim().split(/\s+/);
  const head = headToken(stage);
  if (head === null) return 'Bash(other)';

  // Path-like invocations: emit the script constant. If the basename is one of our own
  // scripts, emit its constant. Never emit the basename itself.
  if (head.includes('/')) {
    const base = head.split('/').pop();
    return INTERNAL_SCRIPTS.has(base) ? `Bash(script:${base})` : 'Bash(script)';
  }

  if (!BASH_VERBS.has(head)) return 'Bash(other)';

  const second = (words[1] ?? '').toLowerCase();
  if (PYTHON_VERBS.has(head)) {
    if (second === '-c') return `Bash(${head}:-c)`;
    if (second === '-m') return `Bash(${head}:-m)`;
    if (second === '-' || command.includes('<<')) return `Bash(${head}:stdin)`;
    if (second) return `Bash(${head}:file)`;
    return `Bash(${head})`;
  }
  if (RUNNER_VERBS.has(head) && SECOND_TOKENS.has(second)) return `Bash(${head}:${second})`;

  // Match-and-emit-a-constant. Never emit a slice of the input.
  return `Bash(${head})`;
}

function headToken(segment) {
  const raw = segment.trim().split(/\s+/)[0];
  if (!raw) return null;
  return raw.replace(/^\\/, '').toLowerCase();
}

/** Reduce a file path to an allowlisted extension constant. Path and basename are discarded. */
export function projectFile(toolName, input) {
  const path = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (typeof path !== 'string' || !path) return `${toolName}(.none)`;
  const ext = extname(basename(path)).toLowerCase();
  if (!ext) {
    // Extensionless files: recognize Dockerfile/Makefile shapes without copying the name.
    return `${toolName}(.none)`;
  }
  return FILE_EXTS.has(ext) ? `${toolName}(${ext})` : `${toolName}(.other)`;
}

/** Skill names can encode client domain (e.g. `acme-ledger-refresh`), so allowlist them. */
export function projectSkill(input) {
  const raw = input?.skill;
  if (typeof raw !== 'string') return 'Skill(other)';
  const name = raw.includes(':') ? raw.split(':').pop() : raw;
  return GENERIC_SKILLS.has(name) ? `Skill(${name})` : 'Skill(other)';
}

export function projectTask(input) {
  const t = input?.subagent_type;
  if (typeof t !== 'string') return 'Task(other)';
  return GENERIC_AGENTS.has(t) ? `Task(${t})` : 'Task(other)';
}

/** mcp__<server>__<tool> — match the server against known vendors, else collapse. */
export function projectMcp(toolName) {
  const lower = toolName.toLowerCase();
  for (const vendor of GENERIC_MCP) {
    if (lower.includes(vendor)) return `Mcp(${vendor})`;
  }
  return 'Mcp(other)';
}

/** Dispatch: one tool_use block -> exactly one vocabulary constant. */
export function projectToolUse(name, input) {
  if (typeof name !== 'string') return 'Tool(other)';
  if (name.startsWith('mcp__')) return projectMcp(name);
  if (name === 'Bash') return projectBash(input?.command);
  if (FILE_TOOLS.has(name)) return projectFile(name, input);
  if (BARE_TOOLS.has(name)) return name;
  if (name === 'Skill') return projectSkill(input);
  if (name === 'Task' || name === 'Agent') return projectTask(input);
  return 'Tool(other)';
}

// ---------------------------------------------------------------------------
// Transcript walking
// ---------------------------------------------------------------------------

/**
 * Project one transcript's lines into skeleton steps.
 * Only `assistant` and `user` records are inspected; every other record type is
 * dropped without being read, so unknown future record types fail closed.
 */
export function projectLines(lines, { sessionId, projectId, startLine = 0 }) {
  const steps = [];
  let lastUuid = null;
  let seen = startLine;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    seen = i + 1;
    if (!line || !line.trim()) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Torn trailing line from a live session, or corruption. Skip it; the
      // watermark means it is picked up cleanly on a later run.
      continue;
    }

    if (rec?.type !== 'assistant' && rec?.type !== 'user') continue;
    if (rec.uuid) lastUuid = rec.uuid;

    const common = {
      session: sessionId,
      project: projectId,
      sidechain: Boolean(rec.isSidechain),
      ts: typeof rec.timestamp === 'string' ? rec.timestamp : null,
    };

    if (rec.type === 'user') {
      // A genuine human turn. Tool results are delivered as `user` records too,
      // so only count records that are not purely tool_result payloads.
      if (!isToolResultOnly(rec)) steps.push({ step: 'User', ...common });
      continue;
    }

    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      // `thinking` and `text` blocks are dropped without inspection.
      if (block?.type !== 'tool_use') continue;
      steps.push({ step: projectToolUse(block.name, block.input), ...common });
    }
  }

  return { steps, lastUuid, linesSeen: seen };
}

function isToolResultOnly(rec) {
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return false;
  return c.length > 0 && c.every((b) => b?.type === 'tool_result');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') a.all = true;
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--state') a.state = argv[++i];
    else if (argv[i] === '--projects') a.projects = argv[++i];
    else if (argv[i] === '--workspace') a.workspace = argv[++i];
    else if (argv[i] === '--team-key') a.teamKey = argv[++i];
    else if (argv[i] === '--exclude') (a.exclude ??= []).push(argv[++i]);
  }
  return a;
}

/** Resolve the workspace: --workspace, else $COMB_WORKSPACE, else cwd. */
export function resolveWorkspace(args, env = process.env) {
  return resolve(args.workspace ?? env.COMB_WORKSPACE ?? process.cwd());
}

/**
 * Load run state. A team key supplied via --team-key / $COMB_TEAM_KEY wins over
 * the stored one, but switching keys silently would fragment session and project
 * IDs, so a mismatch is refused unless --all rebuilds the corpus from scratch.
 * State files written before the rename stored the key under `salt`; that field is
 * still read and migrated.
 */
export function loadState(path, { teamKey, all = false, exclude = [] } = {}) {
  let s = { teamKey: null, files: {} };
  if (existsSync(path)) {
    try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { s = { teamKey: null, files: {} }; }
    if (!s.files) s.files = {};
    if (!s.teamKey && s.salt) { s.teamKey = s.salt; delete s.salt; }
  }
  if (teamKey) {
    if (s.teamKey && s.teamKey !== teamKey) {
      if (!all) throw new Error(`team key differs from the one in ${path}; re-run with --all to rebuild under the new key`);
      s.files = {};
    }
    s.teamKey = teamKey;
  }
  if (!s.teamKey) s.teamKey = randomBytes(16).toString('hex');
  if (all) s.files = {};
  s.excludeDirs = [...new Set([...(s.excludeDirs ?? []), ...exclude])];
  return s;
}

const hashId = (teamKey, value) => createHash('sha256').update(teamKey).update(value).digest('hex').slice(0, 12);

/**
 * Top-level session transcripts only. Claude Code stores subagent and workflow
 * transcripts in nested directories (`<session>/subagents/`, `wf_*`); comb measures the
 * operator's main chain, so those are not descended into. See the spec, "Corpus scope".
 */
export function listTranscripts(root, { skip }) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const dir of dirs) {
    if (skip(dir.name)) continue;
    let files;
    try { files = readdirSync(join(root, dir.name), { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      out.push({ dir: dir.name, file: f.name, full: join(root, dir.name, f.name) });
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.projects ?? join(homedir(), '.claude', 'projects');
  const workspace = resolveWorkspace(args);
  const statePath = args.state ?? join(workspace, 'state', 'processed.json');
  const outPath = args.out ?? join(workspace, 'comb', '.work', 'skeletons.jsonl');

  let state;
  try {
    state = loadState(statePath, { teamKey: args.teamKey ?? process.env.COMB_TEAM_KEY, all: args.all, exclude: args.exclude ?? [] });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  // Self-exclusion: never mine sessions run inside the workspace or any of its
  // subdirectories (they discuss this tool). Claude Code names a project dir by
  // replacing '/' with '-' in the cwd, so a subdirectory shares the prefix.
  const selfDir = workspace.replace(/\//g, '-');
  const isSelf = (name) => name === selfDir || name.startsWith(`${selfDir}-`);

  // The state file holds the team key and keys watermarks by raw transcript path,
  // which encodes client directory names. It must stay out of git; warn if the
  // workspace does not ignore it.
  const gi = join(workspace, '.gitignore');
  const ignoresState = existsSync(gi) && /^state\/?\s*$/m.test(readFileSync(gi, 'utf8'));
  if (existsSync(join(workspace, '.git')) && !ignoresState) {
    console.error(`warning: ${gi} does not ignore state/ ; state/processed.json contains the team key and transcript paths and must not be committed`);
  }

  const out = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  const excluded = new Set(state.excludeDirs);
  const skip = (name) => isSelf(name) || excluded.has(name);
  for (const { dir, file, full } of listTranscripts(root, { skip })) {
    const projectId = hashId(state.teamKey, dir);
    const key = `${dir}/${file}`;
    const prior = args.all ? null : state.files[key];
    const size = statSync(full).size;
    if (prior && prior.size === size) { filesSkipped++; continue; }

    let lines;
    try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }

    // A file shorter than its watermark was pruned or rewritten; re-project it
    // from the top rather than silently emitting nothing.
    const startLine = prior && prior.lines <= lines.length ? prior.lines : 0;
    const sessionId = hashId(state.teamKey, file);
    const { steps, lastUuid, linesSeen } = projectLines(lines, { sessionId, projectId, startLine });

    out.push(...steps);
    state.files[key] = { lines: linesSeen, size, lastUuid, project: projectId };
    filesProcessed++;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(statePath), { recursive: true });

  // Append: skeletons accumulate across runs; the watermark prevents duplicates.
  const existing = existsSync(outPath) && !args.all ? readFileSync(outPath, 'utf8') : '';
  const body = out.map((s) => JSON.stringify(s)).join('\n');
  writeFileSync(outPath, existing ? `${existing.replace(/\n$/, '')}\n${body}\n` : `${body}\n`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  console.error(`projected ${out.length} steps from ${filesProcessed} transcript(s), skipped ${filesSkipped}`);
  console.error(`skeletons -> ${outPath}`);
}

// Bun and Node >= 20: run main() only when invoked directly, not when imported by tests.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
