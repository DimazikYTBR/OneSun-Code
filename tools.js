'use strict';
// Инструменты агента: Read, Write, Edit, LS, Glob, Grep, Bash.
// Каждый возвращает строку или {content, preview, isError}.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.idea', '.vscode']);
const MAX_OUT = 30000;

function resolveP(ctx, p) {
  if (!p || typeof p !== 'string') throw new Error('Не указан путь');
  return path.resolve(ctx.cwd, p);
}
function relP(ctx, p) {
  const r = path.relative(ctx.cwd, p);
  return (!r || r.startsWith('..') || path.isAbsolute(r)) ? p : r;
}
function clip(s, n = MAX_OUT) {
  if (s.length <= n) return s;
  const h = Math.floor(n / 2);
  return s.slice(0, h) + `\n… [обрезано ${s.length - n} символов] …\n` + s.slice(-h);
}
function firstLines(s, n = 8) {
  const l = String(s).split('\n');
  return l.length > n ? l.slice(0, n).join('\n') + `\n… ещё ${l.length - n} строк` : String(s);
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
  if (!fs.existsSync(p)) throw new Error('Файл не найден: ' + a.path);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('Это папка, а не файл. Используй LS.');
  if (st.size > 2 * 1024 * 1024) throw new Error('Файл больше 2 МБ. Используй Grep или Bash, чтобы найти нужное место.');
  const buf = fs.readFileSync(p);
  if (isBinary(buf)) throw new Error('Бинарный файл, прочитать как текст нельзя.');
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const off = Math.max(1, a.offset || 1);
  const lim = Math.max(1, a.limit || 2000);
  const slice = lines.slice(off - 1, off - 1 + lim);
  const body = slice.map((l, i) => `${String(off + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
  const more = off - 1 + lim < lines.length ? `\n… [в файле всего ${lines.length} строк, прочитаны ${off}–${off - 1 + slice.length}]` : '';
  return { content: (body || '(файл пуст)') + more, preview: `Прочитано строк: ${slice.length}` };
}

// ---------- Write ----------
function writeTool(a, ctx) {
  const p = resolveP(ctx, a.path);
  if (typeof a.content !== 'string') throw new Error('Нужно поле content');
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, a.content, 'utf8');
  const n = a.content.split('\n').length;
  return { content: `Файл ${existed ? 'перезаписан' : 'создан'}: ${a.path} (${n} строк)`, preview: `${existed ? 'Обновлён' : 'Создан'} ${relP(ctx, p)} (${n} строк)` };
}

// ---------- Edit ----------
function editTool(a, ctx) {
  const p = resolveP(ctx, a.path);
  if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string') throw new Error('Нужны поля old_string и new_string');
  if (a.old_string === a.new_string) throw new Error('old_string и new_string одинаковы');
  if (!fs.existsSync(p)) throw new Error('Файл не найден: ' + a.path);
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
  if (n === 0) throw new Error('old_string не найден в файле. Перечитай файл (Read) и скопируй фрагмент точно, с отступами.');
  if (n > 1 && !a.replace_all) throw new Error(`old_string встречается ${n} раз. Добавь контекста, чтобы фрагмент был уникальным, или укажи replace_all=true.`);
  const res = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  fs.writeFileSync(p, (bom ? '﻿' : '') + res, 'utf8');
  return { content: `Файл обновлён: ${a.path} (замен: ${a.replace_all ? n : 1})`, preview: `Изменено: ${relP(ctx, p)}` };
}

// ---------- LS ----------
function lsTool(a, ctx) {
  const p = resolveP(ctx, a.path || '.');
  if (!fs.existsSync(p)) throw new Error('Папка не найдена: ' + (a.path || '.'));
  if (!fs.statSync(p).isDirectory()) throw new Error('Это файл, а не папка.');
  const ents = fs.readdirSync(p, { withFileTypes: true })
    .sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
  const lines = ents.slice(0, 300).map(e => e.name + (e.isDirectory() ? '/' : ''));
  if (ents.length > 300) lines.push(`… ещё ${ents.length - 300}`);
  return { content: lines.join('\n') || '(папка пуста)', preview: `Элементов: ${ents.length}` };
}

// ---------- Glob ----------
function globTool(a, ctx) {
  if (!a.pattern) throw new Error('Нужен pattern');
  const base = resolveP(ctx, a.path || '.');
  const re = globToRegex(a.pattern);
  const res = [];
  for (const f of walk(base)) {
    const r = path.relative(base, f).split(path.sep).join('/');
    if (re.test(r)) res.push(r);
  }
  res.sort();
  const shown = res.slice(0, 200);
  if (res.length > 200) shown.push(`… ещё ${res.length - 200}`);
  return { content: shown.join('\n') || 'Ничего не найдено', preview: `Найдено файлов: ${res.length}` };
}

// ---------- Grep ----------
function grepTool(a, ctx) {
  if (!a.pattern) throw new Error('Нужен pattern');
  let re;
  try { re = new RegExp(a.pattern, a.ignore_case ? 'i' : ''); } catch (e) { throw new Error('Неверное регулярное выражение: ' + e.message); }
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
  return { content: out.join('\n') || 'Совпадений нет', preview: `Совпадений: ${total}${total >= 200 ? '+' : ''}` };
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
    if (!cmd) return resolve({ content: 'Пустая команда', isError: true, preview: 'Пустая команда' });
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
      resolve({ content: 'Не удалось запустить команду: ' + e.message, isError: true, preview: e.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      let text = clip(out.replace(/\r\n/g, '\n').trimEnd());
      if (timedOut) text += `\n[команда остановлена по таймауту ${timeoutMs / 1000} с]`;
      if (aborted) text += '\n[прервано пользователем]';
      if (code !== 0 && code !== null) text += `\n[код выхода ${code}]`;
      resolve({ content: text || '(нет вывода)', preview: text ? firstLines(text, 10) : '(нет вывода)', isError: (code !== 0) || timedOut || aborted });
    });
  });
}

const IMPL = { Read: readTool, Write: writeTool, Edit: editTool, LS: lsTool, Glob: globTool, Grep: grepTool, Bash: bashTool };

const TOOL_DEFS = [
  {
    name: 'Read', description: 'Читает текстовый файл и возвращает строки с номерами. Для больших файлов используй offset и limit.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Путь к файлу (абсолютный или относительно рабочей папки)' },
      offset: { type: 'integer', description: 'С какой строки начать (нумерация с 1)' },
      limit: { type: 'integer', description: 'Сколько строк прочитать (по умолчанию 2000)' } }, required: ['path'] },
  },
  {
    name: 'Write', description: 'Создаёт файл или полностью перезаписывает существующий. Для небольших правок используй Edit.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      content: { type: 'string', description: 'Полное содержимое файла' } }, required: ['path', 'content'] },
  },
  {
    name: 'Edit', description: 'Заменяет точный фрагмент old_string на new_string в файле. Фрагмент должен быть уникальным (или укажи replace_all). Перед правкой файл нужно прочитать.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      old_string: { type: 'string', description: 'Что заменить (точно, с отступами)' },
      new_string: { type: 'string', description: 'На что заменить' },
      replace_all: { type: 'boolean', description: 'Заменить все вхождения' } }, required: ['path', 'old_string', 'new_string'] },
  },
  {
    name: 'LS', description: 'Показывает содержимое папки.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Путь к папке (по умолчанию рабочая папка)' } } },
  },
  {
    name: 'Glob', description: 'Ищет файлы по маске, например **/*.js или src/**/*.{ts,tsx}.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Маска файлов' },
      path: { type: 'string', description: 'Где искать (по умолчанию рабочая папка)' } }, required: ['pattern'] },
  },
  {
    name: 'Grep', description: 'Ищет текст по регулярному выражению в файлах. Возвращает файл:строка: текст.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Регулярное выражение' },
      path: { type: 'string', description: 'Файл или папка (по умолчанию рабочая папка)' },
      glob: { type: 'string', description: 'Фильтр файлов, например *.py' },
      ignore_case: { type: 'boolean', description: 'Не учитывать регистр' } }, required: ['pattern'] },
  },
  {
    name: 'Bash', description: 'Выполняет команду в терминале (PowerShell на Windows, bash на Linux/macOS) в рабочей папке. Для тестов, git, менеджеров пакетов и т.п. Не запускай интерактивные и бесконечные команды.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'Команда' },
      timeout: { type: 'integer', description: 'Таймаут в секундах (по умолчанию 120, максимум 600)' } }, required: ['command'] },
  },
];

module.exports = { IMPL, TOOL_DEFS, relP, firstLines };
