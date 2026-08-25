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
 * Usage:
 *   bun automation-spotter/project.mjs [--out FILE] [--state FILE] [--all] [--projects DIR]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import {
  BASH_VERBS, BASH_NOISE, FILE_EXTS, BARE_TOOLS, FILE_TOOLS,
  GENERIC_SKILLS, GENERIC_AGENTS, GENERIC_MCP,
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
  const head = headToken(payload.split('|')[0]);
  if (head === null) return 'Bash(other)';

  // Path-like invocations (./scripts/acme_sync.sh) deliberately fail closed:
  // the basename could encode a client name, so it is never unwrapped.
  if (head.includes('/')) return 'Bash(other)';

  // Match-and-emit-a-constant. Never emit a slice of the input.
  return BASH_VERBS.has(head) ? `Bash(${head})` : 'Bash(other)';
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

/** Skill names can encode client domain (e.g. `wind-ar-master-refresh`), so allowlist them. */
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
  }
  return a;
}

function loadState(path) {
  if (!existsSync(path)) return { salt: randomBytes(16).toString('hex'), files: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s.salt) s.salt = randomBytes(16).toString('hex');
    if (!s.files) s.files = {};
    return s;
  } catch {
    return { salt: randomBytes(16).toString('hex'), files: {} };
  }
}

const hashId = (salt, value) => createHash('sha256').update(salt).update(value).digest('hex').slice(0, 12);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.projects ?? join(homedir(), '.claude', 'projects');
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');
  const statePath = args.state ?? join(repoRoot, 'state', 'processed.json');
  const outPath = args.out ?? join(repoRoot, 'automation-spotter', '.work', 'skeletons.jsonl');

  const state = loadState(statePath);
  // Self-exclusion: never mine our own project directory.
  const selfDir = repoRoot.replace(/\//g, '-');

  const out = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  const projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of projectDirs) {
    if (dir.name === selfDir || dir.name.endsWith('-dev-RnD')) { filesSkipped++; continue; }
    const dirPath = join(root, dir.name);
    const projectId = hashId(state.salt, dir.name);

    let files;
    try { files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      const full = join(dirPath, file);
      const key = `${dir.name}/${file}`;
      const prior = args.all ? null : state.files[key];
      const size = statSync(full).size;
      if (prior && prior.size === size) { filesSkipped++; continue; }

      let lines;
      try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }

      const startLine = prior?.lines ?? 0;
      const sessionId = hashId(state.salt, file);
      const { steps, lastUuid, linesSeen } = projectLines(lines, { sessionId, projectId, startLine });

      out.push(...steps);
      state.files[key] = { lines: linesSeen, size, lastUuid, project: projectId };
      filesProcessed++;
    }
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

if (import.meta.main) main();
