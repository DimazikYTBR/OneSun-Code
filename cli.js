#!/usr/bin/env node
'use strict';
// OneSun Code — a terminal AI coding agent (Claude Code-style interface).
// No external dependencies: only Node.js 18+ is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { META, resolveUrl } = require('./providers');
const { undoLast, IMPL } = require('./tools');
const { startVoice } = require('./voice');
const { createAgent } = require('./agent');
const { LANGS, setLang, getLang, t } = require('./i18n');
const pkg = require('./package.json');

const CONFIG_FILE = process.env.ONESUN_CONFIG || path.join(__dirname, 'config.txt');
const MODES = ['ask', 'edits', 'yolo'];
const DEFAULT_CONFIG = 'LANG=en\nPROVIDER=anthropic\nAPI_KEY=\nMODEL=\nBASE_URL=\nMODE=ask\nHEADER=on\n';

// ---------- styling ----------
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

// ---------- settings (config.txt) ----------
// The config file is NEVER overwritten: it is created only if it does not exist (COPYFILE_EXCL),
// and later changes only replace or append single "KEY=value" lines.
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

const normLang = (v) => { const l = String(v || '').trim().toLowerCase(); return LANGS.includes(l) ? l : ''; };

function setConfigValue(key, value) {
  let text = '';
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { /* new file */ }
  const re = new RegExp('^[ \\t]*' + key + '[ \\t]*=.*$', 'im');
  if (re.test(text)) text = text.replace(re, () => `${key}=${value}`);
  else text += (text && !text.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(CONFIG_FILE, text, 'utf8');
}

function createConfig(lang) {
  const tpl = path.join(__dirname, lang === 'ru' ? 'config.example.ru.txt' : 'config.example.txt');
  try {
    fs.copyFileSync(tpl, CONFIG_FILE, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === 'EEXIST') return; // already there: leave it alone
    try { fs.writeFileSync(CONFIG_FILE, DEFAULT_CONFIG, { flag: 'wx' }); } catch { /* exists or read-only */ }
  }
  setConfigValue('LANG', lang);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) createConfig(getLang());
  const raw = parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const provider = (raw.PROVIDER || 'anthropic').toLowerCase();
  const key = raw[provider.toUpperCase() + '_API_KEY'] || raw.API_KEY || '';
  const mode = MODES.includes((raw.MODE || '').toLowerCase()) ? raw.MODE.toLowerCase() : 'ask';
  return {
    provider, key, model: raw.MODEL || '', baseUrl: raw.BASE_URL || '', mode,
    header: (raw.HEADER || 'on').toLowerCase() !== 'off', lang: normLang(raw.LANG),
  };
}

function missingFields(cfg) {
  const m = [];
  if (!META[cfg.provider]) m.push(t('prov.oneof', Object.keys(META).join(', ')));
  if (!cfg.key) m.push('API_KEY');
  if (!cfg.model) m.push('MODEL');
  if (cfg.provider === 'custom' && !cfg.baseUrl) m.push('BASE_URL');
  return m;
}

function openInEditor(file) {
  try {
    let child;
    if (process.platform === 'win32') child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') child = spawn('open', ['-t', file], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no editor found — the file path is already printed */ });
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

// ---------- arrow-key menu ----------
function selectMenu(title, hint, options, def = 0) {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let sel = def;
    out(`${C.bold}${title}${C.reset}\n${C.gray}${hint}${C.reset}\n`);
    const draw = (first) => {
      if (!first) out(`\x1b[${options.length}A`);
      options.forEach((o, i) => out(`\r\x1b[2K  ${i === sel ? C.orange + S.sel + C.reset : ' '} ${i + 1}. ${o}\n`));
    };
    draw(true);
    const done = (i) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out(`\x1b[${options.length + 2}A\x1b[J`);
      resolve(i);
    };
    const onKey = (s, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { out('\n'); process.exit(0); }
      if (key.name === 'up') { sel = (sel + options.length - 1) % options.length; draw(false); }
      else if (key.name === 'down' || key.name === 'tab') { sel = (sel + 1) % options.length; draw(false); }
      else if (/^[1-9]$/.test(s || '') && Number(s) <= options.length) done(Number(s) - 1);
      else if (key.name === 'return' || key.name === 'enter') done(sel);
    };
    process.stdin.on('keypress', onKey);
  });
}

async function chooseLanguage(def) {
  const names = t('lang.names');
  const idx = await selectMenu(t('lang.title'), t('lang.hint'), LANGS.map((l) => names[l]), Math.max(0, LANGS.indexOf(def)));
  return LANGS[idx];
}

// Language is asked once. If the config already exists, it is kept as is: only the LANG line is appended.
async function ensureLanguage() {
  const exists = fs.existsSync(CONFIG_FILE);
  const raw = exists ? parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  let lang = normLang(raw.LANG);
  if (!lang) {
    setLang('en');
    lang = await chooseLanguage('en');
    if (exists) setConfigValue('LANG', lang); else createConfig(lang);
  }
  setLang(lang);
}

async function ensureConfig() {
  let cfg = loadConfig();
  while (true) {
    const miss = missingFields(cfg);
    if (!miss.length) return cfg;
    out(`\n${C.orange}${S.star} OneSun Code${C.reset} — ${t('cfg.title')}\n`);
    out(`  ${t('cfg.missing')} ${C.bold}${miss.join(', ')}${C.reset}\n`);
    out(`  ${t('cfg.opening')} ${C.cyan}${CONFIG_FILE}${C.reset}\n`);
    out(`  ${t('cfg.instr')}\n\n`);
    openInEditor(CONFIG_FILE);
    await waitEnter(`${C.gray}${t('cfg.press')}${C.reset}`);
    cfg = loadConfig();
  }
}

// ---------- state ----------
const state = { cfg: null, mode: 'ask' };
// Input history is kept between launches in the home folder (not in the project, not in config.txt).
const HIST_FILE = path.join(os.homedir(), '.onesun_history');
const hist = (() => {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')).filter((x) => typeof x === 'string').slice(0, 200); }
  catch { return []; }
})();
function saveHist() { try { fs.writeFileSync(HIST_FILE, JSON.stringify(hist.slice(0, 200)), 'utf8'); } catch { /* read-only home: skip */ } }

// Projects folder inside OneSun Code: each user project lives here, and the agent works in it without asking.
const PROJECTS_DIR = path.join(__dirname, 'projects');
try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch { /* read-only install: skip */ }
function isInProjects(dir) {
  const r = path.relative(PROJECTS_DIR, dir);
  return !r.startsWith('..') && !path.isAbsolute(r);
}
const modeLabel = () => t('mode.' + state.mode);
function cycleMode() { state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]; }

// ---------- box ----------
function box(lines) {
  const w = Math.max(...lines.map((l) => strip(l).length)) + 2;
  out(C.orange + S.tl + S.h.repeat(w) + S.tr + C.reset + '\n');
  for (const l of lines) {
    out(C.orange + S.v + C.reset + ' ' + l + ' '.repeat(Math.max(0, w - 1 - strip(l).length)) + C.orange + S.v + C.reset + '\n');
  }
  out(C.orange + S.bl + S.h.repeat(w) + S.br + C.reset + '\n');
}

// ---------- pinned header (logo and name) ----------
// OneSun logo: a ring with a diagonal cut, drawn with block characters (one character = 2 pixels vertically).
const LOGO = [
  '   ▄████▄▄  ',
  ' ██▄    ▀██ ',
  '██        ██',
  '██        ██',
  ' ██▄    ▄▀█ ',
  '  ▀▀████▀▀  ',
];
const LOGO_ASCII = LOGO.map((l) => l.replace(/█/g, '#').replace(/▀/g, '"').replace(/▄/g, ','));
const HDR_LINES = LOGO.length + 1; // logo + divider
const HDR_MIN_ROWS = 18;
let headerOn = false;

function headerLines() {
  const w = cols();
  const white = ansi('\x1b[1;97m');
  const art = FANCY ? LOGO : LOGO_ASCII;
  const max = Math.max(10, w - LOGO[0].length - 6);
  const info = [];
  info[1] = `${white}OneSun Code${C.reset} ${C.gray}v${pkg.version}${C.reset}`;
  info[2] = `${C.gray}${clipTo(state.cfg.provider + ' · ' + state.cfg.model, max)}${C.reset}`;
  info[3] = `${C.gray}${clipTo(process.cwd(), max)}${C.reset}`;
  const lines = art.map((l, i) => white + l + C.reset + '  ' + (info[i] || ''));
  lines.push(`${C.gray}${S.h.repeat(w - 1)}${C.reset}`);
  return lines;
}

function drawHeader() {
  if (!headerOn) return;
  out('\x1b7');
  headerLines().forEach((l, i) => out(`\x1b[${i + 1};1H\x1b[2K${l}`));
  out('\x1b8');
}

function enableHeader() {
  const rows = process.stdout.rows || 0;
  if (state.cfg.header === false || rows < HDR_MIN_ROWS || cols() < 50) return;
  headerOn = true;
  out('\x1b[2J');
  out(`\x1b[${HDR_LINES + 1};${rows}r`); // only the area below the header scrolls
  out(`\x1b[${HDR_LINES + 1};1H`);
  drawHeader();
}

function disableHeader() {
  if (!headerOn) return;
  headerOn = false;
  out('\x1b7\x1b[r\x1b8');
}

process.stdout.on('resize', () => {
  if (!headerOn) return;
  const rows = process.stdout.rows || 0;
  if (rows < HDR_MIN_ROWS) { disableHeader(); return; }
  out('\x1b7');
  out(`\x1b[${HDR_LINES + 1};${rows}r`);
  out('\x1b8');
  drawHeader();
});

function banner() {
  if (headerOn) {
    out(`${C.orange}${S.star}${C.reset} ${C.bold}${t('welcome')}${C.reset}\n`);
    out(`${C.gray}  ${t('welcome.hint')}${C.reset}\n`);
    return;
  }
  const max = cols() - 12;
  box([
    `${C.orange}${S.star}${C.reset} ${C.bold}${t('welcome')}${C.reset} ${C.gray}v${pkg.version}${C.reset}`,
    '',
    `${C.gray}${t('box.hint')}${C.reset}`,
    `${C.gray}${t('box.folder')}${C.reset}  ${clipTo(process.cwd(), max)}`,
    `${C.gray}${t('box.model')}${C.reset} ${state.cfg.provider} · ${clipTo(state.cfg.model, max - 10)}`,
  ]);
  out(`${C.gray}  ${t('box.tips')}${C.reset}\n`);
}

function printHelp() {
  out('\n');
  for (const [a, b] of t('help.rows')) out(`  ${C.orange}${a.padEnd(17)}${C.reset}${b}\n`);
  out(`\n  ${C.gray}${t('help.modes')}${C.reset}\n`);
  out(`  ${C.gray}${t('help.md')}${C.reset}\n`);
}

// ---------- "thinking" indicator: shimmering text + rotating phrases ----------
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
const WAVE256 = [231, 195, 153, 117, 75, 33]; // white -> blue for 256-color terminals

function waveColor(k) { // k: 0 = white, 1 = blue
  if (!useColor) return '';
  if (TRUECOLOR) {
    const r = Math.round(255 + (60 - 255) * k);
    const g = Math.round(255 + (130 - 255) * k);
    return `\x1b[1;38;2;${r};${g};255m`;
  }
  return `\x1b[1;38;5;${WAVE256[Math.round(k * (WAVE256.length - 1))]}m`;
}

// White text with a blue wave running through it (like the shimmer in Claude Code).
function shimmer(text, ms) {
  if (!useColor) return text;
  const chars = [...text];
  const width = 5;
  const pos = (ms / 65) % (chars.length + width * 2) - width;
  let s = '';
  chars.forEach((ch, i) => {
    const d = Math.abs(i - pos);
    s += waveColor(d >= width ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d / width)) + ch;
  });
  return s + C.reset;
}

const spin = { timer: null, t0: 0, label: '', on: false, rotate: false, nextAt: 0 };
function pickPhrase() {
  const list = t('spin.phrases');
  let p;
  do { p = list[Math.floor(Math.random() * list.length)]; } while (p === spin.label && list.length > 1);
  return p;
}
const nextSwitch = () => Date.now() + 2500 + Math.random() * 1500;

function spinStart(label) {
  if (spin.on) { if (label) { spin.label = label; spin.rotate = false; } return; }
  spin.on = true; spin.t0 = Date.now();
  spin.rotate = !label;
  spin.label = label || pickPhrase();
  spin.nextAt = nextSwitch();
  out('\x1b[?25l');
  const draw = () => {
    const now = Date.now();
    const el = now - spin.t0;
    if (spin.rotate && now >= spin.nextAt) { spin.label = pickPhrase(); spin.nextAt = nextSwitch(); }
    const frame = S.frames[Math.floor(el / 120) % S.frames.length];
    const hint = t('spin.hint', Math.floor(el / 1000));
    let lab = spin.label + '…';
    const room = cols() - hint.length - 8;
    if (lab.length > room) lab = lab.slice(0, Math.max(5, room - 1)) + '…';
    out(`\r\x1b[2K${C.orange}${frame}${C.reset} ${shimmer(lab, el)} ${C.gray}(${hint})${C.reset}`);
  };
  draw();
  spin.timer = setInterval(draw, 70);
}
function spinStop() {
  if (!spin.on) return;
  clearInterval(spin.timer);
  spin.on = false;
  out('\r\x1b[2K\x1b[?25h');
}
process.on('exit', () => { try { if (process.stdout.isTTY) { out('\x1b[?25h'); disableHeader(); } } catch { /* ignore */ } });

// ---------- streaming markdown ----------
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
    this.w(this.mode === 'skip' ? C.reset : C.reset + '\n'); // a ``` line prints nothing
    this.mode = null; this.buf = ''; this.inl = false; this.bold = false;
  }
  flush() {
    if (this.mode === null && this.buf) this.decide();
    if (this.mode !== null) this.endLine();
  }
}
const md = new MdStream(out);

// ---------- tool output ----------
const LABEL = { Edit: 'Update', Write: 'Write', Read: 'Read', Bash: 'Bash', LS: 'List', Glob: 'Search', Grep: 'Search' };
const cur = { diff: null, shownDiff: false };

function printDiff(diff) {
  const MAX = 12, w = cols() - 10;
  const show = (arr, total, sign, color) => {
    arr.slice(0, MAX).forEach((l) => out(`      ${color}${sign} ${clipTo(l, w)}${C.reset}\n`));
    const n = total || arr.length;
    if (n > MAX) out(`      ${C.gray}${t('more.lines', n - MAX)}${C.reset}\n`);
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

// ---------- keys while the agent is working ----------
let permHandler = null;
let agent = null;
function makeAgent() {
  return createAgent({
    getConfig: () => ({
      provider: state.cfg.provider, key: state.cfg.key, model: state.cfg.model,
      url: resolveUrl(state.cfg.provider, { baseUrl: state.cfg.baseUrl }),
    }),
    getMode: () => state.mode,
    ui, cwd: process.cwd(), free: isInProjects(process.cwd()),
  });
}
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
      if (lines.length > 12) out(`      ${C.gray}${t('more.lines', lines.length - 12)}${C.reset}\n`);
    }
    out(`\n  ${C.bold}${info.title}${C.reset}\n`);
    const opts = [t('perm.yes'), info.alwaysLabel || t('perm.always.default'), t('perm.no')];
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
    else if (s === 'tool') spinStart(t('spin.running'));
    else spinStop();
  },
  text(chunk) { spinStop(); md.push(chunk); },
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
  interrupted() { spinStop(); out(`\n  ${C.gray}${S.branch}${C.reset}  ${C.orange}${t('interrupted')}${C.reset}\n`); },
  error(msg) { spinStop(); out(`\n${C.red}✗ ${msg}${C.reset}\n`); },
};

// ---------- input ----------
const SLASH = ['/help', '/config', '/settings', '/model', '/provider', '/lang', '/mode', '/clear', '/cwd',
  '/init', '/commit', '/test', '/desktop', '/open', '/undo', '/copy', '/new', '/projects', '/exit', '/quit'];

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
    const parts = [];
    let timer = null, done = false;
    let voice = null; // active voice recording (Ctrl+G)
    const finish = () => {
      done = true;
      if (voice && !voice.oneShot) voice.stop();
      process.stdin.off('keypress', onKey);
      rl.close();
      resolve(parts.join('\n'));
    };
    const voiceStart = () => {
      if (voice) return;
      const v = startVoice(state.cfg && state.cfg.lang);
      if (!v) { out(`${C.gray}  ${t('voice.none')}${C.reset}\n`); return; }
      // Windows: voice typing is started with Win+H; the text lands in the line and Enter sends it as usual.
      if (v.hotkey) { out(`${C.cyan}  ● ${t('voice.hotkey')}${C.reset}\n`); return; }
      voice = v;
      if (v.oneShot) {
        out(`${C.cyan}  ● ${t('voice.listening')}${C.reset}\n`);
        v.done.then((txt) => {
          if (done) return;
          voice = null;
          if (txt) rl.write(txt); else out(`${C.gray}  ${t('voice.empty')}${C.reset}\n`);
          rl.prompt(true);
        });
      } else out(`${C.cyan}  ● ${t('voice.on')}${C.reset}\n`);
    };
    // Ctrl+G while recording: stop and put the recognized text into the line (Enter then sends it).
    const voiceStopToLine = () => {
      const v = voice;
      const txt = v.stop();
      voice = null;
      if (txt) rl.write(txt + ' ');
      else out(`${C.red}  ${t('voice.fail', v.error() || t('voice.empty'))}${C.reset}\n`);
      rl.prompt(true);
    };
    const onKey = (s, key) => {
      if (key && key.ctrl && key.name === 'g') {
        if (voice && !voice.oneShot) voiceStopToLine();
        else voiceStart();
        return;
      }
      if (key && key.name === 'tab' && key.shift) {
        cycleMode();
        out('\r\x1b[2K');
        out(`${C.orange}  ⏵⏵ ${modeLabel()}${C.reset}\n`);
        rl.prompt(true);
      }
    };
    process.stdin.on('keypress', onKey);
    rl.on('line', (l) => {
      // Enter while recording: take the speech and send it right away.
      if (voice && !voice.oneShot) {
        const v = voice;
        const txt = v.stop();
        voice = null;
        if (!txt && !l.trim()) { out(`${C.red}  ${t('voice.fail', v.error() || t('voice.empty'))}${C.reset}\n`); rl.prompt(true); return; }
        parts.push([txt, l].filter(Boolean).join(' '));
        finish();
        return;
      }
      if (l.endsWith('\\')) { parts.push(l.slice(0, -1)); rl.setPrompt(`${C.gray}…${C.reset} `); rl.prompt(); return; }
      parts.push(l);
      clearTimeout(timer);
      timer = setTimeout(finish, 35); // glue together pasted multi-line text
    });
    rl.on('SIGINT', () => {
      if (rl.line && rl.line.length) { rl.write(null, { ctrl: true, name: 'u' }); return; }
      if (Date.now() - lastSigint < 2000) { bye(); return; }
      lastSigint = Date.now();
      out(`\n${C.gray}  ${t('ctrlc')}${C.reset}\n`);
      rl.prompt(true);
    });
    rl.on('close', () => { if (!done) bye(); });
    separator();
    rl.prompt();
  });
}

function bye() {
  out(`\n${C.orange}${S.star}${C.reset} ${t('bye')}\n`);
  process.exit(0);
}

// ---------- commands ----------
async function editConfig() {
  out(`\n  ${t('cfg.open')} ${C.cyan}${CONFIG_FILE}${C.reset}\n`);
  openInEditor(CONFIG_FILE);
  await waitEnter(`${C.gray}  ${t('cfg.apply')}${C.reset}`);
  const cfg = loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) { out(`${C.red}  ${t('cfg.still')} ${miss.join(', ')}${C.reset}\n`); return; }
  state.cfg = cfg;
  if (cfg.lang) setLang(cfg.lang);
  out(`${C.green}  ${t('cfg.applied')}${C.reset} ${cfg.provider} · ${cfg.model}\n`); drawHeader();
}

// Copies text to the system clipboard using the tool that exists on this system.
function copyToClipboard(text) {
  return new Promise((resolve) => {
    let child;
    try {
      if (process.platform === 'win32') {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; $input | Set-Clipboard'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      } else if (process.platform === 'darwin') child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      else if (process.env.TERMUX_VERSION) child = spawn('termux-clipboard-set', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      else child = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => { /* tool exited early */ });
    child.stdin.end(text, 'utf8');
  });
}

// Adds the content of files mentioned as @path (e.g. "fix @src/app.js"). Only real text files under 200 KB.
function expandMentions(text) {
  const cwd = process.cwd();
  const added = [];
  let extra = '';
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const rel = m[1];
    if (added.includes(rel)) continue;
    try {
      const p = path.resolve(cwd, rel);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 200 * 1024) continue;
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue;
      added.push(rel);
      extra += `\n\n[File: ${rel}]\n\`\`\`\n${buf.toString('utf8')}\n\`\`\``;
    } catch { /* not a file: keep it as plain text */ }
  }
  added.forEach((f) => out(`${C.gray}  + ${f}${C.reset}\n`));
  return text + extra;
}

const CMD_PROMPTS = {
  init: 'Explore this project: read the main files, the folder structure and the package/config files. Then create ONESUN.md in the project root with: a short description of the stack, how to install, run and test the project, and the main conventions. Keep it under 60 lines.',
  commit: 'Check the state with git (git status and git diff). Write a short, clear commit message that describes the changes, then stage and commit them (git add -A, then git commit). Do not push. If there is nothing to commit, say so.',
  test: 'Find out how this project runs its tests (package.json scripts, pytest, go test, etc.), run them and report the results. If something fails, explain why and propose a fix. Do not change code without asking unless the fix is obvious.',
};

async function handleSlash(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/': case '/help': printHelp(); break;
    case '/open': {
      if (!arg) { out(`${C.gray}  ${t('open.usage')}${C.reset}\n`); break; }
      // Opened directly by you, so no model call and no permission question.
      const r = await IMPL.Desktop({ action: 'open', target: arg }, { cwd: process.cwd() });
      out(r.isError ? `${C.red}  ${r.preview}${C.reset}\n` : `${C.green}  ${r.preview}${C.reset}\n`);
      break;
    }
    case '/init': case '/commit': case '/test':
      await runAgent(CMD_PROMPTS[cmd.slice(1)]); break;
    case '/desktop':
      if (!arg) { out(`${C.gray}  ${t('desk.usage')}${C.reset}\n`); break; }
      await runAgent(`Use the Desktop tool to do this on the user's computer: ${arg}. Take one step at a time and check the result of each step before the next.`);
      break;
    case '/undo': {
      const p = undoLast();
      out(p ? `${C.green}  ${t('undo.done', path.relative(process.cwd(), p) || p)}${C.reset}\n` : `${C.gray}  ${t('undo.none')}${C.reset}\n`);
      break;
    }
    case '/copy': {
      const last = agent.lastText();
      if (!last) { out(`${C.gray}  ${t('copy.none')}${C.reset}\n`); break; }
      out(`${(await copyToClipboard(last)) ? C.green + '  ' + t('copy.done') : C.red + '  ' + t('copy.fail')}${C.reset}\n`);
      break;
    }
    case '/config': case '/settings': case '/key': await editConfig(); break;
    case '/model':
      if (arg) {
        state.cfg.model = arg; setConfigValue('MODEL', arg);
        out(`${C.green}  ${t('model.set')}${C.reset} ${arg}\n`); drawHeader();
      } else {
        out(`\n  ${t('now')} ${C.orange}${state.cfg.provider} · ${state.cfg.model}${C.reset}\n`);
        const list = META[state.cfg.provider]?.models || [];
        if (list.length) out(`  ${C.gray}${t('model.for', state.cfg.provider, list.join(', '))}${C.reset}\n`);
        out(`  ${C.gray}${t('model.change')}${C.reset}\n`);
      }
      break;
    case '/provider':
      if (arg && META[arg.toLowerCase()]) {
        const p = arg.toLowerCase();
        setConfigValue('PROVIDER', p);
        const cfg = loadConfig();
        state.cfg = cfg;
        out(`${C.green}  ${t('prov.set')}${C.reset} ${p}\n`); drawHeader();
        const miss = missingFields(cfg);
        if (miss.length) out(`${C.orange}  ${t('prov.missing', miss.join(', '))}${C.reset}\n`);
        else if (!META[p].models.includes(cfg.model)) out(`${C.gray}  ${t('prov.mismatch', cfg.model, META[p].models.join(', '))}${C.reset}\n`);
      } else {
        out(`\n  ${t('now')} ${C.orange}${state.cfg.provider}${C.reset}\n  ${C.gray}${t('prov.avail', Object.keys(META).join(', '))}\n  ${t('prov.change')}${C.reset}\n`);
      }
      break;
    case '/lang': {
      const lang = await chooseLanguage(getLang());
      setLang(lang); state.cfg.lang = lang; setConfigValue('LANG', lang);
      out(`${C.green}  ${t('lang.set', t('lang.short')[lang])}${C.reset}\n`);
      break;
    }
    case '/mode': cycleMode(); out(`${C.orange}  ⏵⏵ ${modeLabel()}${C.reset}\n`); break;
    case '/clear':
      agent.clear();
      if (headerOn) { out(`\x1b[${HDR_LINES + 1};1H\x1b[J`); drawHeader(); } else out('\x1b[2J\x1b[3J\x1b[H');
      banner(); break;
    case '/cwd': out(`  ${process.cwd()}\n`); break;
    case '/new': {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,59}$/u.test(arg)) { out(`${C.gray}  ${t('new.usage')}${C.reset}\n`); break; }
      const dir = path.join(PROJECTS_DIR, arg);
      fs.mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      agent = makeAgent();
      out(`${C.green}  ${t('new.done', arg)}${C.reset}\n${C.gray}  ${t('free.note')}${C.reset}\n`);
      break;
    }
    case '/projects': {
      let names = [];
      try { names = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
      out(names.length ? names.map((n) => `  ${n}`).join('\n') + '\n' : `${C.gray}  ${t('projects.none')}${C.reset}\n`);
      break;
    }
    case '/exit': case '/quit': bye(); break;
    default: out(`${C.red}  ${t('cmd.unknown', cmd)}${C.reset} ${C.gray}${t('cmd.unknownHint')}${C.reset}\n`);
  }
}

async function runAgent(text) {
  attachRunKeys();
  try { await agent.run(text); }
  finally { spinStop(); detachRunKeys(); }
}

// ---------- start ----------
async function main() {
  const args = process.argv.slice(2);
  // language for --help / errors before the interactive start (the config is only read, never changed)
  try { setLang(normLang(parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8')).LANG) || 'en'); } catch { setLang('en'); }

  if (args[0] === '--help' || args[0] === '-h') { console.log(t('cli.help', pkg.version, CONFIG_FILE)); return; }
  if (args[0] === '--version' || args[0] === '-v') { console.log(pkg.version); return; }
  if (args[0] === '--config') {
    if (!fs.existsSync(CONFIG_FILE)) createConfig('en');
    openInEditor(CONFIG_FILE);
    console.log(t('cli.opened', CONFIG_FILE));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(t('cli.notty'));
    process.exit(1);
  }

  await ensureLanguage();
  state.cfg = await ensureConfig();
  state.mode = state.cfg.mode;
  agent = makeAgent();

  enableHeader();
  if (!headerOn) out('\n');
  banner();
  if (isInProjects(process.cwd())) out(`${C.gray}  ${t('free.note')}${C.reset}\n`);

  let first = args.join(' ').trim();
  while (true) {
    let text;
    if (first) { text = first; first = ''; out(`\n${C.orange}>${C.reset} ${text}\n`); }
    else text = (await readInput()).trim();
    if (!text) continue;
    if (hist[0] !== text) hist.unshift(text);
    saveHist();
    if (text.startsWith('/')) { await handleSlash(text); continue; }
    if (text === 'exit' || text === 'quit') bye();
    await runAgent(expandMentions(text));
  }
}

main().catch((e) => { spinStop(); console.error('\n' + C.red + t('cli.fatal') + (e && e.stack || e) + C.reset); process.exit(1); });
