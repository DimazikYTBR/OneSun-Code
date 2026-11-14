'use strict';
// Agent tools: Read, Write, Edit, LS, Glob, Grep, Bash.
// Each returns a string or {content, preview, isError}.
// content goes to the model (always English); preview is shown to the user (in their language).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { t, tEn, tErr } = require('./i18n');

const IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.idea', '.vscode']);
const MAX_OUT = 30000;

function resolveP(ctx, p) {
  if (!p || typeof p !== 'string') throw tErr('err.nopath');
  return path.resolve(ctx.cwd, p);
}
function relP(ctx, p) {
  const r = path.relative(ctx.cwd, p);
  return (!r || r.startsWith('..') || path.isAbsolute(r)) ? p : r;
}
function clip(s, n = MAX_OUT) {
  if (s.length <= n) return s;
  const h = Math.floor(n / 2);
  return s.slice(0, h) + `\n${tEn('clip', s.length - n)}\n` + s.slice(-h);
}
function firstLines(s, n = 8) {
  const l = String(s).split('\n');
  return l.length > n ? l.slice(0, n).join('\n') + `\n${t('more.lines', l.length - n)}` : String(s);
}
function isBinary(buf) { return buf.subarray(0, 8000).includes(0); }

function* walk(root, maxFiles = 30000) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!IGNORE.has(e.name)) stack.push(path.join(d, e.name)); }
      else if (e.isFile()) { if (++n > maxFiles) return; yield path.join(d, e.name); }
    }
  }
}

function globToRegex(g) {
  if (!g.includes('/')) g = '**/' + g;
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth++; re += '(?:'; }
    else if (c === '}' && depth > 0) { depth--; re += ')'; }
    else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// ---------- Read ----------
function readTool(a, ctx) {
  const p = resolveP(ctx, a.path);
  if (!fs.existsSync(p)) throw tErr('err.notfound', a.path);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw tErr('err.isdir');
  if (st.size > 2 * 1024 * 1024) throw tErr('err.toobig');
  const buf = fs.readFileSync(p);
  if (isBinary(buf)) throw tErr('err.binary');
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const off = Math.max(1, a.offset || 1);
  const lim = Math.max(1, a.limit || 2000);
  const slice = lines.slice(off - 1, off - 1 + lim);
  const body = slice.map((l, i) => `${String(off + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
  const more = off - 1 + lim < lines.length ? '\n' + tEn('read.more', lines.length, off, off - 1 + slice.length) : '';
  return { content: (body || tEn('read.empty')) + more, preview: t('read.preview', slice.length) };
}

// ---------- Write ----------
function writeTool(a, ctx) {
  const p = resolveP(ctx, a.path);
  if (typeof a.content !== 'string') throw tErr('err.needcontent');
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, a.content, 'utf8');
  const n = a.content.split('\n').length;
  const k = existed ? 'write.updated' : 'write.created';
  return { content: tEn(k, a.path, n), preview: t(k, relP(ctx, p), n) };
}

// ---------- Edit ----------
function editTool(a, ctx) {
  const p = resolveP(ctx, a.path);
  if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string') throw tErr('err.needstrings');
  if (a.old_string === a.new_string) throw tErr('err.same');
  if (!fs.existsSync(p)) throw tErr('err.notfound', a.path);
  let text = fs.readFileSync(p, 'utf8');
  const bom = text.charCodeAt(0) === 0xFEFF;
  if (bom) text = text.slice(1);
  let oldS = a.old_string, newS = a.new_string;
  const count = (h, n) => (n ? h.split(n).length - 1 : 0);
  let n = count(text, oldS);
  if (n === 0 && text.includes('\r\n')) { // файлы Windows с CRLF
    const o2 = oldS.replace(/\r?\n/g, '\r\n');
    if (count(text, o2) > 0) { oldS = o2; newS = newS.replace(/\r?\n/g, '\r\n'); n = count(text, oldS); }
  }
  if (n === 0) throw tErr('err.nomatch');
  if (n > 1 && !a.replace_all) throw tErr('err.multi', n);
  const res = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  fs.writeFileSync(p, (bom ? '﻿' : '') + res, 'utf8');
  return { content: tEn('edit.done', a.path, a.replace_all ? n : 1), preview: t('edit.preview', relP(ctx, p)) };
}

// ---------- LS ----------
function lsTool(a, ctx) {
  const p = resolveP(ctx, a.path || '.');
  if (!fs.existsSync(p)) throw tErr('err.dirnotfound', a.path || '.');
  if (!fs.statSync(p).isDirectory()) throw tErr('err.isfile');
  const ents = fs.readdirSync(p, { withFileTypes: true })
    .sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
  const lines = ents.slice(0, 300).map(e => e.name + (e.isDirectory() ? '/' : ''));
  if (ents.length > 300) lines.push(tEn('more.n', ents.length - 300));
  return { content: lines.join('\n') || tEn('ls.empty'), preview: t('ls.preview', ents.length) };
}

// ---------- Glob ----------
function globTool(a, ctx) {
  if (!a.pattern) throw tErr('err.needpattern');
  const base = resolveP(ctx, a.path || '.');
  const re = globToRegex(a.pattern);
  const res = [];
  for (const f of walk(base)) {
    const r = path.relative(base, f).split(path.sep).join('/');
    if (re.test(r)) res.push(r);
  }
  res.sort();
  const shown = res.slice(0, 200);
  if (res.length > 200) shown.push(tEn('more.n', res.length - 200));
  return { content: shown.join('\n') || tEn('glob.none'), preview: t('glob.preview', res.length) };
}

// ---------- Grep ----------
function grepTool(a, ctx) {
  if (!a.pattern) throw tErr('err.needpattern');
  let re;
  try { re = new RegExp(a.pattern, a.ignore_case ? 'i' : ''); } catch (e) { throw tErr('err.badregex', e.message); }
  const base = resolveP(ctx, a.path || '.');
  const gre = a.glob ? globToRegex(a.glob) : null;
  const single = fs.existsSync(base) && fs.statSync(base).isFile();
  const files = single ? [base] : walk(base);
  const out = [];
  let total = 0;
  outer:
  for (const f of files) {
    const rel = path.relative(single ? path.dirname(base) : base, f).split(path.sep).join('/');
    if (gre && !gre.test(rel)) continue;
    let buf;
    try { if (fs.statSync(f).size > 1024 * 1024) continue; buf = fs.readFileSync(f); } catch { continue; }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        total++;
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (total >= 200) break outer;
      }
    }
  }
  return { content: out.join('\n') || tEn('grep.none'), preview: t('grep.preview', total, total >= 200) };
}

// ---------- Bash ----------
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

function bashTool(a, ctx) {
  return new Promise((resolve) => {
    const cmd = String(a.command || '').trim();
    if (!cmd) return resolve({ content: tEn('err.emptycmd'), isError: true, preview: t('err.emptycmd') });
    const timeoutMs = Math.min(Math.max(Number(a.timeout) || 120, 1), 600) * 1000;
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ' + cmd],
      { cwd: ctx.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', ['-lc', cmd], { cwd: ctx.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false, aborted = false;
    const add = d => { out += d.toString('utf8'); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    ctx.signal?.addEventListener('abort', onAbort);
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ content: tEn('err.spawn', e.message), isError: true, preview: t('err.spawn', e.message) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      const base = out.replace(/\r\n/g, '\n').trimEnd();
      const build = (tf, clipFn) => {
        let text = clipFn(base);
        if (timedOut) text += '\n' + tf('bash.timeout', timeoutMs / 1000);
        if (aborted) text += '\n' + tf('bash.aborted');
        if (code !== 0 && code !== null) text += '\n' + tf('bash.exit', code);
        return text;
      };
      const content = build(tEn, clip) || tEn('bash.noout');
      const shown = build(t, (x) => x);
      resolve({ content, preview: shown ? firstLines(shown, 10) : t('bash.noout'), isError: (code !== 0) || timedOut || aborted });
    });
  });
}

const IMPL = { Read: readTool, Write: writeTool, Edit: editTool, LS: lsTool, Glob: globTool, Grep: grepTool, Bash: bashTool };

const TOOL_DEFS = [
  {
    name: 'Read', description: 'Reads a text file and returns its lines with line numbers. For large files use offset and limit.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Path to the file (absolute or relative to the working folder)' },
      offset: { type: 'integer', description: 'Line to start from (1-based)' },
      limit: { type: 'integer', description: 'How many lines to read (default 2000)' } }, required: ['path'] },
  },
  {
    name: 'Write', description: 'Creates a file or completely overwrites an existing one. For small changes use Edit.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'Full contents of the file' } }, required: ['path', 'content'] },
  },
  {
    name: 'Edit', description: 'Replaces an exact fragment old_string with new_string in a file. The fragment must be unique (or set replace_all). Read the file before editing it.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Path to the file' },
      old_string: { type: 'string', description: 'What to replace (exactly, including indentation)' },
      new_string: { type: 'string', description: 'What to replace it with' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences' } }, required: ['path', 'old_string', 'new_string'] },
  },
  {
    name: 'LS', description: 'Lists the contents of a folder.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the folder (default: the working folder)' } } },
  },
  {
    name: 'Glob', description: 'Finds files by a glob pattern, e.g. **/*.js or src/**/*.{ts,tsx}.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'File pattern' },
      path: { type: 'string', description: 'Where to search (default: the working folder)' } }, required: ['pattern'] },
  },
  {
    name: 'Grep', description: 'Searches file contents with a regular expression. Returns file:line: text.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or folder (default: the working folder)' },
      glob: { type: 'string', description: 'File filter, e.g. *.py' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search' } }, required: ['pattern'] },
  },
  {
    name: 'Bash', description: 'Runs a command in the terminal (PowerShell on Windows, bash on Linux/macOS) in the working folder. Use it for tests, git, package managers, etc. Do not run interactive or never-ending commands.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'The command' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 120, max 600)' } }, required: ['command'] },
  },
];

module.exports = { IMPL, TOOL_DEFS, relP, firstLines };
