#!/usr/bin/env node
'use strict';
// OneSun Code — терминальный ИИ-агент для программирования (интерфейс в стиле Claude Code).
// Без внешних зависимостей: нужен только Node.js 18+.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { META, resolveUrl } = require('./providers');
const { createAgent } = require('./agent');
const pkg = require('./package.json');

const CONFIG_FILE = process.env.ONESUN_CONFIG || path.join(__dirname, 'config.txt');
const EXAMPLE_FILE = path.join(__dirname, 'config.example.txt');
const MODES = ['ask', 'edits', 'yolo'];
const MODE_LABEL = { ask: 'спрашивать разрешения', edits: 'правки без вопросов', yolo: 'всё без вопросов (!)' };

// ---------- оформление ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (s) => (useColor ? s : '');
const C = {
  reset: ansi('\x1b[0m'), bold: ansi('\x1b[1m'), dim: ansi('\x1b[2m'),
  orange: ansi('\x1b[38;5;214m'), red: ansi('\x1b[38;5;203m'), green: ansi('\x1b[38;5;114m'),
  cyan: ansi('\x1b[38;5;116m'), gray: ansi('\x1b[38;5;245m'),
};
const FANCY = !process.env.ONESUN_ASCII &&
  !(process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM && !process.env.ConEmuANSI);
const S = FANCY
  ? { dot: '●', branch: '⎿', sel: '❯', star: '✻', bullet: '•', h: '─', tl: '╭', tr: '╮', bl: '╰', br: '╯', v: '│', frames: ['·', '✢', '✳', '✶', '✻', '✽'] }
  : { dot: '*', branch: '|_', sel: '>', star: '*', bullet: '-', h: '-', tl: '+', tr: '+', bl: '+', br: '+', v: '|', frames: ['|', '/', '-', '\\'] };

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const out = (s) => process.stdout.write(s);
const cols = () => Math.max(40, Math.min(process.stdout.columns || 80, 140));
const clipTo = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- настройки (config.txt) ----------
function parseConfig(text) {
  const o = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toUpperCase();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    o[k] = v;
  }
  return o;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    try { fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE); }
    catch { fs.writeFileSync(CONFIG_FILE, 'PROVIDER=anthropic\nAPI_KEY=\nMODEL=\nBASE_URL=\nMODE=ask\n', 'utf8'); }
  }
  const raw = parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const provider = (raw.PROVIDER || 'anthropic').toLowerCase();
  const key = raw[provider.toUpperCase() + '_API_KEY'] || raw.API_KEY || '';
  const mode = MODES.includes((raw.MODE || '').toLowerCase()) ? raw.MODE.toLowerCase() : 'ask';
  return { provider, key, model: raw.MODEL || '', baseUrl: raw.BASE_URL || '', mode };
}

function missingFields(cfg) {
  const m = [];
  if (!META[cfg.provider]) m.push(`PROVIDER (одно из: ${Object.keys(META).join(', ')})`);
  if (!cfg.key) m.push('API_KEY');
  if (!cfg.model) m.push('MODEL');
  if (cfg.provider === 'custom' && !cfg.baseUrl) m.push('BASE_URL');
  return m;
}

function setConfigValue(key, value) {
  let text = '';
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { /* новый файл */ }
  const re = new RegExp('^[ \\t]*' + key + '[ \\t]*=.*$', 'im');
  if (re.test(text)) text = text.replace(re, () => `${key}=${value}`);
  else text += (text && !text.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(CONFIG_FILE, text, 'utf8');
}

function openInEditor(file) {
  try {
    let child;
    if (process.platform === 'win32') child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') child = spawn('open', ['-t', file], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* редактор не найден — путь к файлу уже показан */ });
    child.unref();
  } catch { /* ignore */ }
}

function waitEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { rl.close(); process.exit(0); });
    rl.on('close', () => resolve());
    rl.question(msg, () => rl.close());
  });
}

async function ensureConfig() {
  let cfg = loadConfig();
  while (true) {
    const miss = missingFields(cfg);
    if (!miss.length) return cfg;
    out(`\n${C.orange}${S.star} OneSun Code${C.reset} — нужно заполнить настройки.\n`);
    out(`  Не хватает: ${C.bold}${miss.join(', ')}${C.reset}\n`);
    out(`  Открываю файл: ${C.cyan}${CONFIG_FILE}${C.reset}\n`);
    out('  Впиши значения после «=», сохрани файл (Ctrl+S) и вернись в это окно.\n\n');
    openInEditor(CONFIG_FILE);
    await waitEnter(`${C.gray}Нажми Enter, когда сохранишь файл… ${C.reset}`);
    cfg = loadConfig();
  }
}

// ---------- состояние ----------
const state = { cfg: null, mode: 'ask' };
const hist = [];
const modeLabel = () => MODE_LABEL[state.mode];
function cycleMode() { state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]; }

// ---------- рамка ----------
function box(lines) {
  const w = Math.max(...lines.map((l) => strip(l).length)) + 2;
  out(C.orange + S.tl + S.h.repeat(w) + S.tr + C.reset + '\n');
  for (const l of lines) {
    out(C.orange + S.v + C.reset + ' ' + l + ' '.repeat(Math.max(0, w - 1 - strip(l).length)) + C.orange + S.v + C.reset + '\n');
  }
  out(C.orange + S.bl + S.h.repeat(w) + S.br + C.reset + '\n');
}

function banner() {
  const max = cols() - 12;
  box([
    `${C.orange}${S.star}${C.reset} ${C.bold}Добро пожаловать в OneSun Code${C.reset} ${C.gray}v${pkg.version}${C.reset}`,
    '',
    `${C.gray}/help — команды · /config — ключ и модель${C.reset}`,
    `${C.gray}папка:${C.reset}  ${clipTo(process.cwd(), max)}`,
    `${C.gray}модель:${C.reset} ${state.cfg.provider} · ${clipTo(state.cfg.model, max - 10)}`,
  ]);
  out(`${C.gray}  Советы: Esc — прервать · Shift+Tab — режим разрешений · «\\» в конце строки — перенос${C.reset}\n`);
}

function printHelp() {
  const rows = [
    ['/help', 'эта справка'],
    ['/config', 'открыть config.txt (ключ, модель, провайдер)'],
    ['/model [имя]', 'показать или сменить модель'],
    ['/provider [имя]', 'показать или сменить провайдера'],
    ['/mode', 'сменить режим разрешений (или Shift+Tab)'],
    ['/clear', 'очистить диалог и экран'],
    ['/cwd', 'показать рабочую папку'],
    ['/exit', 'выйти (или Ctrl+C дважды)'],
  ];
  out('\n');
  for (const [a, b] of rows) out(`  ${C.orange}${a.padEnd(17)}${C.reset}${b}\n`);
  out(`\n  ${C.gray}Режимы: «спрашивать разрешения» — перед правкой файлов и командами;\n  «правки без вопросов» — файлы правятся сами, команды спрашивают;\n  «всё без вопросов» — агент делает всё сам, будь осторожен.${C.reset}\n`);
  out(`  ${C.gray}Файл ONESUN.md в папке проекта читается как инструкции для агента.${C.reset}\n`);
}

// ---------- спиннер ----------
const spin = { t: null, i: 0, t0: 0, label: '', on: false };
const VERBS = ['Думаю', 'Колдую', 'Соображаю', 'Кодю', 'Грею мозги'];
function spinStart(label) {
  if (spin.on) { if (label) spin.label = label; return; }
  spin.on = true; spin.i = 0; spin.t0 = Date.now();
  spin.label = label || VERBS[Math.floor(Math.random() * VERBS.length)];
  out('\x1b[?25l');
  const draw = () => {
    const f = S.frames[spin.i++ % S.frames.length];
    const s = Math.floor((Date.now() - spin.t0) / 1000);
    out(`\r\x1b[2K${C.orange}${f} ${spin.label}…${C.reset} ${C.gray}(esc — прервать · ${s} с)${C.reset}`);
  };
  draw();
  spin.t = setInterval(draw, 120);
}
function spinStop() {
  if (!spin.on) return;
  clearInterval(spin.t);
  spin.on = false;
  out('\r\x1b[2K\x1b[?25h');
}
process.on('exit', () => { try { if (process.stdout.isTTY) out('\x1b[?25h'); } catch { /* ignore */ } });

// ---------- потоковый markdown ----------
class MdStream {
  constructor(w) { this.w = w; this.reset(); }
  reset() {
    this.mode = null; this.buf = ''; this.first = true; this.inCode = false;
    this.inl = false; this.bold = false; this.pend = false; this.skipLead = false;
  }
  push(s) { for (const ch of s) this.ch(ch); }
  ch(ch) {
    if (ch === '\r') return;
    if (this.mode === null) {
      if (ch === '\n') { if (this.buf) this.decide(); this.endLine(); return; }
      this.buf += ch;
      if (this.buf.length >= 3) this.decide();
      return;
    }
    if (ch === '\n') { this.endLine(); return; }
    this.emit(ch);
  }
  decide() {
    const b = this.buf; this.buf = '';
    if (this.first) this.w('\n');
    const prefix = this.first ? `${C.orange}${S.dot} ${C.reset}` : '  ';
    this.first = false;
    if (b.startsWith('```')) { this.inCode = !this.inCode; this.mode = 'skip'; return; }
    if (this.inCode) { this.mode = 'code'; this.w('    ' + C.cyan); this.w(b); return; }
    if (/^#{1,6}(\s|$)/.test(b)) { this.mode = 'head'; this.skipLead = true; this.w(prefix + C.bold + C.orange); this.emitHead(b); return; }
    const m = b.match(/^(\s*)[-*]\s/);
    if (m) { this.mode = 'text'; this.w(prefix + m[1] + C.orange + S.bullet + C.reset + ' '); this.emitText(b.slice(m[0].length)); return; }
    this.mode = 'text'; this.w(prefix); this.emitText(b);
  }
  emit(ch) {
    if (this.mode === 'text') this.emitText(ch);
    else if (this.mode === 'code') this.w(ch);
    else if (this.mode === 'head') this.emitHead(ch);
  }
  emitHead(s) {
    for (const ch of s) {
      if (this.skipLead && (ch === '#' || ch === ' ')) continue;
      this.skipLead = false; this.w(ch);
    }
  }
  emitText(s) {
    for (const ch of s) {
      if (this.inl) {
        if (ch === '`') { this.inl = false; this.w(C.reset + (this.bold ? C.bold : '')); } else this.w(ch);
        continue;
      }
      if (this.pend) {
        this.pend = false;
        if (ch === '*') { this.bold = !this.bold; this.w(this.bold ? C.bold : ansi('\x1b[22m')); continue; }
        this.w('*');
      }
      if (ch === '`') { this.inl = true; this.w(C.cyan); continue; }
      if (ch === '*') { this.pend = true; continue; }
      this.w(ch);
    }
  }
  endLine() {
    if (this.mode === 'text' && this.pend) this.w('*');
    this.pend = false;
    this.w(this.mode === 'skip' ? C.reset : C.reset + '\n'); // строка с ``` ничего не печатает
    this.mode = null; this.buf = ''; this.inl = false; this.bold = false;
  }
  flush() {
    if (this.mode === null && this.buf) this.decide();
    if (this.mode !== null) this.endLine();
  }
}
const md = new MdStream(out);

// ---------- вывод инструментов ----------
const LABEL = { Edit: 'Update', Write: 'Write', Read: 'Read', Bash: 'Bash', LS: 'List', Glob: 'Search', Grep: 'Search' };
const cur = { diff: null, shownDiff: false };

function printDiff(diff) {
  const MAX = 12, w = cols() - 10;
  const show = (arr, total, sign, color) => {
    arr.slice(0, MAX).forEach((l) => out(`      ${color}${sign} ${clipTo(l, w)}${C.reset}\n`));
    const t = total || arr.length;
    if (t > MAX) out(`      ${C.gray}… ещё ${t - MAX} строк${C.reset}\n`);
  };
  show(diff.removed || [], diff.removedTotal, '-', C.red);
  show(diff.added || [], diff.addedTotal, '+', C.green);
}

function printBranch(preview, color) {
  const lines = String(preview || '').split('\n');
  const w = cols() - 8;
  out(`  ${C.gray}${S.branch}${C.reset}  ${color}${clipTo(lines[0] || '', w)}${C.reset}\n`);
  for (const l of lines.slice(1)) out(`     ${color}${clipTo(l, w)}${C.reset}\n`);
}

// ---------- клавиши во время работы агента ----------
let permHandler = null;
let agent = null;
function runKey(s, key) {
  if (!key) return;
  if (permHandler) { permHandler(s, key); return; }
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) agent.abort();
}
function attachRunKeys() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', runKey);
}
function detachRunKeys() {
  process.stdin.off('keypress', runKey);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

function askPermission(info) {
  return new Promise((resolve) => {
    spinStop();
    out('\n');
    if (info.diff) { printDiff(info.diff); cur.shownDiff = true; }
    else if (info.detail) {
      const lines = info.detail.split('\n');
      lines.slice(0, 12).forEach((l) => out(`      ${C.gray}${clipTo(l, cols() - 10)}${C.reset}\n`));
      if (lines.length > 12) out(`      ${C.gray}… ещё ${lines.length - 12} строк${C.reset}\n`);
    }
    out(`\n  ${C.bold}${info.title}${C.reset}\n`);
    const opts = ['Да', info.alwaysLabel || 'Да, и больше не спрашивать в этой сессии', 'Нет, сделай по-другому (Esc)'];
    let sel = 0;
    const draw = (first) => {
      if (!first) out(`\x1b[${opts.length}A`);
      opts.forEach((o, i) => out(`\r\x1b[2K  ${i === sel ? C.orange + S.sel : ' '} ${i + 1}. ${clipTo(o, cols() - 10)}${C.reset}\n`));
    };
    draw(true);
    const finish = (i) => {
      permHandler = null;
      out(`\x1b[${opts.length + 2}A\x1b[J`);
      resolve(['yes', 'always', 'no'][i]);
    };
    permHandler = (s, key) => {
      if (key.name === 'up') { sel = (sel + opts.length - 1) % opts.length; draw(false); }
      else if (key.name === 'down' || key.name === 'tab') { sel = (sel + 1) % opts.length; draw(false); }
      else if (s === '1' || s === '2' || s === '3') finish(Number(s) - 1);
      else if (key.name === 'return' || key.name === 'enter') finish(sel);
      else if (key.name === 'escape') finish(2);
      else if (key.ctrl && key.name === 'c') { finish(2); agent.abort(); }
    };
  });
}

const ui = {
  status(s) {
    if (s === 'thinking') spinStart();
    else if (s === 'tool') spinStart('Выполняю');
    else spinStop();
  },
  text(t) { spinStop(); md.push(t); },
  textEnd() { md.flush(); md.reset(); },
  toolStart({ name, summary, diff }) {
    spinStop();
    cur.diff = diff || null; cur.shownDiff = false;
    out(`\n${C.green}${S.dot}${C.reset} ${C.bold}${LABEL[name] || name}${C.reset}(${C.cyan}${clipTo(summary || '', cols() - 20)}${C.reset})\n`);
  },
  toolResult({ ok, preview, denied }) {
    spinStop();
    if (ok && cur.diff && !cur.shownDiff) printDiff(cur.diff);
    printBranch(preview, denied ? C.orange : ok ? C.gray : C.red);
  },
  askPermission,
  interrupted() { spinStop(); out(`\n  ${C.gray}${S.branch}${C.reset}  ${C.orange}Прервано${C.reset}\n`); },
  error(msg) { spinStop(); out(`\n${C.red}✗ ${msg}${C.reset}\n`); },
};

// ---------- ввод ----------
const SLASH = ['/help', '/config', '/settings', '/model', '/provider', '/mode', '/clear', '/cwd', '/exit', '/quit'];

function separator() {
  const label = ` ${state.cfg.model} · ${modeLabel()} · /help `;
  const line = S.h.repeat(2) + label + S.h.repeat(Math.max(2, cols() - 2 - label.length));
  out(`\n${C.gray}${line}${C.reset}\n`);
}

let lastSigint = 0;
function readInput() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
      history: hist.slice(), historySize: 200, prompt: `${C.orange}>${C.reset} `,
      completer: (line) => (line.startsWith('/') ? [SLASH.filter((c) => c.startsWith(line)), line] : [[], line]),
    });
    let parts = [], timer = null, done = false;
    const finish = () => {
      done = true;
      process.stdin.off('keypress', onKey);
      rl.close();
      resolve(parts.join('\n'));
    };
    const onKey = (s, key) => {
      if (key && key.name === 'tab' && key.shift) {
        cycleMode();
        out('\r\x1b[2K');
        out(`${C.orange}  ⏵⏵ ${modeLabel()}${C.reset}\n`);
        rl.prompt(true);
      }
    };
    process.stdin.on('keypress', onKey);
    rl.on('line', (l) => {
      if (l.endsWith('\\')) { parts.push(l.slice(0, -1)); rl.setPrompt(`${C.gray}…${C.reset} `); rl.prompt(); return; }
      parts.push(l);
      clearTimeout(timer);
      timer = setTimeout(finish, 35); // склеиваем вставленный многострочный текст
    });
    rl.on('SIGINT', () => {
      if (rl.line && rl.line.length) { rl.write(null, { ctrl: true, name: 'u' }); return; }
      if (Date.now() - lastSigint < 2000) { bye(); return; }
      lastSigint = Date.now();
      out(`\n${C.gray}  Нажми Ctrl+C ещё раз, чтобы выйти${C.reset}\n`);
      rl.prompt(true);
    });
    rl.on('close', () => { if (!done) bye(); });
    separator();
    rl.prompt();
  });
}

function bye() {
  out(`\n${C.orange}${S.star}${C.reset} До встречи!\n`);
  process.exit(0);
}

// ---------- команды ----------
async function editConfig() {
  out(`\n  Открываю ${C.cyan}${CONFIG_FILE}${C.reset}\n`);
  openInEditor(CONFIG_FILE);
  await waitEnter(`${C.gray}  Сохрани файл и нажми Enter, чтобы применить… ${C.reset}`);
  const cfg = loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) { out(`${C.red}  Всё ещё не хватает: ${miss.join(', ')}${C.reset}\n`); return; }
  state.cfg = cfg;
  out(`${C.green}  ✓ Настройки применены:${C.reset} ${cfg.provider} · ${cfg.model}\n`);
}

async function handleSlash(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/help': printHelp(); break;
    case '/config': case '/settings': case '/key': await editConfig(); break;
    case '/model':
      if (arg) {
        state.cfg.model = arg; setConfigValue('MODEL', arg);
        out(`${C.green}  ✓ Модель:${C.reset} ${arg}\n`);
      } else {
        out(`\n  Сейчас: ${C.orange}${state.cfg.provider} · ${state.cfg.model}${C.reset}\n`);
        const list = META[state.cfg.provider]?.models || [];
        if (list.length) out(`  ${C.gray}Для ${state.cfg.provider}: ${list.join(', ')}${C.reset}\n`);
        out(`  ${C.gray}Сменить: /model имя-модели${C.reset}\n`);
      }
      break;
    case '/provider':
      if (arg && META[arg.toLowerCase()]) {
        const p = arg.toLowerCase();
        setConfigValue('PROVIDER', p);
        const cfg = loadConfig();
        state.cfg = cfg;
        out(`${C.green}  ✓ Провайдер:${C.reset} ${p}\n`);
        const miss = missingFields(cfg);
        if (miss.length) out(`${C.orange}  Не хватает: ${miss.join(', ')} — открой /config${C.reset}\n`);
        else if (!META[p].models.includes(cfg.model)) out(`${C.gray}  Модель «${cfg.model}» может не подойти. Доступно: ${META[p].models.join(', ')}. Сменить: /model имя${C.reset}\n`);
      } else {
        out(`\n  Сейчас: ${C.orange}${state.cfg.provider}${C.reset}\n  ${C.gray}Доступно: ${Object.keys(META).join(', ')}\n  Сменить: /provider имя${C.reset}\n`);
      }
      break;
    case '/mode': cycleMode(); out(`${C.orange}  ⏵⏵ ${modeLabel()}${C.reset}\n`); break;
    case '/clear':
      agent.clear(); out('\x1b[2J\x1b[3J\x1b[H'); banner(); break;
    case '/cwd': out(`  ${process.cwd()}\n`); break;
    case '/exit': case '/quit': bye(); break;
    default: out(`${C.red}  Неизвестная команда ${cmd}.${C.reset} ${C.gray}/help — список команд${C.reset}\n`);
  }
}

async function runAgent(text) {
  attachRunKeys();
  try { await agent.run(text); }
  finally { spinStop(); detachRunKeys(); }
}

// ---------- запуск ----------
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`OneSun Code v${pkg.version}\n\nИспользование:\n  onesun            запустить в текущей папке\n  onesun "задача"   запустить и сразу выполнить задачу\n  onesun --config   открыть config.txt\n  onesun --version  версия\n\nНастройки: ${CONFIG_FILE}`);
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') { console.log(pkg.version); return; }
  if (args[0] === '--config') { loadConfig(); openInEditor(CONFIG_FILE); console.log('Открыт файл: ' + CONFIG_FILE); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('OneSun Code нужен интерактивный терминал (PowerShell, Windows Terminal, cmd).');
    process.exit(1);
  }

  state.cfg = await ensureConfig();
  state.mode = state.cfg.mode;
  agent = createAgent({
    getConfig: () => ({
      provider: state.cfg.provider, key: state.cfg.key, model: state.cfg.model,
      url: resolveUrl(state.cfg.provider, { baseUrl: state.cfg.baseUrl }),
    }),
    getMode: () => state.mode,
    ui, cwd: process.cwd(),
  });

  out('\n');
  banner();

  let first = args.join(' ').trim();
  while (true) {
    let text;
    if (first) { text = first; first = ''; out(`\n${C.orange}>${C.reset} ${text}\n`); }
    else text = (await readInput()).trim();
    if (!text) continue;
    if (hist[0] !== text) hist.unshift(text);
    if (text.startsWith('/')) { await handleSlash(text); continue; }
    if (text === 'exit' || text === 'quit') bye();
    await runAgent(text);
  }
}

main().catch((e) => { spinStop(); console.error('\n' + C.red + 'Критическая ошибка: ' + (e && e.stack || e) + C.reset); process.exit(1); });
