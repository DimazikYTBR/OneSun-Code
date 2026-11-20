'use strict';
// Agent loop: model -> tools -> model ... until the answer is ready.
// All output goes through the ui object (implemented in cli.js), so the agent can be tested on its own.

const fs = require('fs');
const path = require('path');
const providers = require('./providers');
const { t, tEn, getLang } = require('./i18n');
const { IMPL, TOOL_DEFS, relP } = require('./tools');

const MAX_TURNS = 40;

function oneLine(s, n = 90) {
  const lines = String(s || '').split('\n');
  let t = lines[0];
  if (lines.length > 1) t += ' …';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function describe(name, a, ctx) {
  a = a || {};
  const rel = () => relP(ctx, path.resolve(ctx.cwd, a.path || '.'));
  switch (name) {
    case 'Read': return { summary: rel(), title: t('perm.read') };
    case 'LS': return { summary: rel(), title: t('perm.ls') };
    case 'Glob': return { summary: `${a.pattern || ''}${a.path ? t('perm.in') + rel() : ''}`, title: t('perm.glob') };
    case 'Grep': return { summary: `${a.pattern || ''}${a.path ? t('perm.in') + rel() : ''}`, title: t('perm.grep') };
    case 'Write': {
      const lines = String(a.content || '').split('\n');
      return {
        summary: rel(), title: t('perm.write'),
        alwaysLabel: t('perm.always.edit'),
        diff: { removed: [], added: lines.slice(0, 200), addedTotal: lines.length },
      };
    }
    case 'Edit': {
      const o = String(a.old_string || '').split('\n');
      const n = String(a.new_string || '').split('\n');
      return {
        summary: rel(), title: t('perm.edit'),
        alwaysLabel: t('perm.always.edit'),
        diff: { removed: o.slice(0, 200), added: n.slice(0, 200), addedTotal: n.length, removedTotal: o.length },
      };
    }
    case 'Bash': {
      const first = String(a.command || '').trim().split(/\s+/)[0] || t('perm.cmd');
      return {
        summary: oneLine(a.command), title: t('perm.bash'), detail: String(a.command || ''),
        alwaysLabel: t('perm.always', first),
      };
    }
    case 'Desktop': {
      const what = a.target != null ? String(a.target) : (a.x != null ? `${a.x},${a.y}` : '');
      return { summary: oneLine(`${a.action || ''} ${what}`), title: t('perm.desktop'), detail: what, alwaysLabel: t('perm.always', 'Desktop ' + (a.action || '')) };
    }
    default: return { summary: oneLine(JSON.stringify(a)), title: t('perm.other') };
  }
}

function allowKey(name, a) {
  if (name === 'Desktop') return 'Desktop:' + ((a && a.action) || '');
  if (name === 'Write' || name === 'Edit') return 'edit';
  if (name === 'Bash') return 'Bash:' + (String((a && a.command) || '').trim().split(/\s+/)[0] || '');
  return name + ':' + ((a && a.path) || '');
}

// free = the project is inside the projects folder: edits and commands run without questions there.
function createAgent({ getConfig, getMode, ui, cwd, free = false }) {
  const history = [];
  const allow = new Set();
  let abortCtl = null;
  let running = false;

  function systemPrompt() {
    const isWin = process.platform === 'win32';
    let extra = '';
    for (const f of ['ONESUN.md']) {
      try {
        const txt = fs.readFileSync(path.join(cwd, f), 'utf8');
        if (txt.trim()) extra += `\n\nProject instructions (${f}):\n${txt.slice(0, 8000)}`;
      } catch { /* no such file */ }
    }
    return [
      'You are OneSun Code, an interactive coding agent that runs in the user\'s terminal (similar to Claude Code).',
      'You help with software engineering tasks: exploring a project, writing and editing code, running commands and tests.',
      '',
      'Rules:',
      '- Reply in the same language as the user (usually Russian). Be concise: this is a terminal, so no long preambles.',
      '- Inspect the project with tools before changing it. Read a file before editing it.',
      '- Prefer Edit for small changes and Write for new files. Make minimal, focused changes.',
      `- Bash runs ${isWin ? 'PowerShell on Windows' : 'bash'} in the working directory. Do not start interactive or never-ending commands (dev servers, watchers) unless asked.`,
      '- When the task is done, say briefly what you did. Do not paste whole files back into the chat.',
      '- If the user denies an action, do not retry it; ask what to do instead.',
      '- The Desktop tool acts on the user\'s own computer (open apps, type, click). Use it only when the user asks for that; use Bash for project work.',
      '- Use plain markdown: ``` fences for code, `inline code`, **bold**, "-" for lists. No tables.',
      '',
      `Environment: working directory = ${cwd}; platform = ${process.platform}; date = ${new Date().toISOString().slice(0, 10)}.`,
      `The user chose the interface language "${getLang()}"; reply in it unless the user writes in another language.`,
    ].join('\n') + extra;
  }

  function needsPermission(name, a) {
    const mode = getMode();
    // The computer itself is never free: Desktop always asks unless in yolo mode.
    if (name === 'Desktop' || name.startsWith('mcp__')) return mode !== 'yolo'; // external tools always ask
    if (mode === 'yolo') return false;
    if (free) return false;
    if (name === 'Bash') return true;
    if (name === 'Write' || name === 'Edit') return mode === 'ask';
    if (!a || !a.path) return false;
    const r = path.relative(cwd, path.resolve(cwd, a.path));
    return r.startsWith('..') || path.isAbsolute(r);
  }

  async function execTool(tc, signal) {
    const ctx = { cwd, signal };
    const a = tc.args || {};
    const impl = IMPL[tc.name];
    if (!impl) {
      ui.toolStart({ name: tc.name, summary: '?' });
      ui.toolResult({ ok: false, preview: t('agent.unknownTool', tc.name) });
      return { id: tc.id, name: tc.name, content: tEn('agent.unknownTool', tc.name), isError: true };
    }
    const d = describe(tc.name, a, ctx);
    ui.toolStart({ name: tc.name, summary: d.summary, diff: d.diff });
    if (needsPermission(tc.name, a)) {
      const key = allowKey(tc.name, a);
      if (!allow.has(key)) {
        const dec = await ui.askPermission({ name: tc.name, title: d.title, summary: d.summary, diff: d.diff, detail: d.detail, alwaysLabel: d.alwaysLabel });
        if (dec === 'no') {
          ui.toolResult({ ok: false, denied: true, preview: t('agent.denied') });
          return { id: tc.id, name: tc.name, content: 'The user denied this action. Do not repeat it; ask what to do instead.', isError: true };
        }
        if (dec === 'always') allow.add(key);
      }
    }
    ui.status('tool');
    try {
      const r = await impl(a, ctx);
      const o = typeof r === 'string' ? { content: r } : r;
      ui.toolResult({ ok: !o.isError, preview: o.preview || String(o.content).split('\n').slice(0, 8).join('\n') });
      return { id: tc.id, name: tc.name, content: o.content, isError: !!o.isError };
    } catch (e) {
      ui.toolResult({ ok: false, preview: e.message });
      return { id: tc.id, name: tc.name, content: 'Error: ' + (e.en || e.message), isError: true };
    }
  }

  async function run(userText) {
    running = true;
    abortCtl = new AbortController();
    const signal = abortCtl.signal;
    const last = history[history.length - 1];
    if (last && last.role === 'user') last.content += '\n\n' + userText;
    else history.push({ role: 'user', content: userText });
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        ui.status('thinking');
        const cfg = getConfig();
        let res;
        try {
          res = await providers.chat({
            ...cfg, system: systemPrompt(), messages: history, tools: TOOL_DEFS, signal,
            onText: t => ui.text(t),
          });
        } catch (e) {
          ui.textEnd();
          if (signal.aborted || e.name === 'AbortError') { ui.interrupted(); return; }
          ui.error(e.message);
          return;
        }
        ui.textEnd();
        if (!res.text && !res.toolCalls.length) { ui.error(t('agent.empty')); return; }
        history.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
        if (!res.toolCalls.length) return;
        const results = [];
        for (const tc of res.toolCalls) {
          if (signal.aborted) { results.push({ id: tc.id, name: tc.name, content: 'Interrupted by the user', isError: true }); continue; }
          results.push(await execTool(tc, signal));
        }
        history.push({ role: 'tool', results });
        if (signal.aborted) { ui.interrupted(); return; }
      }
      ui.error(t('agent.limit', MAX_TURNS));
    } finally {
      running = false;
      abortCtl = null;
      ui.status('idle');
    }
  }

  return {
    run,
    abort() { if (abortCtl) abortCtl.abort(); },
    clear() { history.length = 0; allow.clear(); },
    lastText() {
      for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'assistant' && history[i].text) return history[i].text;
      return '';
    },
    get running() { return running; },
    getHistory() { return history; },
    setHistory(h) { history.length = 0; if (Array.isArray(h)) history.push(...h); },
    get historyLength() { return history.length; },
  };
}

module.exports = { createAgent, describe };
