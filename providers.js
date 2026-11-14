'use strict';
// Провайдеры нейросетей: единый интерфейс chat() со стримингом и вызовом инструментов.
// Внутренний формат сообщений:
//  {role:'user', content}
//  {role:'assistant', text, toolCalls:[{id,name,args}], raw?}
//  {role:'tool', results:[{id,name,content,isError}]}

const META = {
  anthropic: {
    name: 'Anthropic (Claude)', type: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  },
  gemini: {
    name: 'Google Gemini', type: 'gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/',
    models: ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-3.8-flash'],
  },
  openai: {
    name: 'OpenAI', type: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4.1', 'gpt-4o', 'o4-mini'],
  },
  deepseek: {
    name: 'DeepSeek', type: 'openai',
    url: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  openrouter: {
    name: 'OpenRouter (много моделей)', type: 'openai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: ['google/gemini-4-carbon', 'google/gemini-4-hydrogen', 'openai/gpt-4o', 'deepseek/deepseek-chat'],
  },
  custom: {
    name: 'Свой (OpenAI-совместимый)', type: 'openai', url: '', models: [],
  },
};

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

async function* sse(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d && d !== '[DONE]') { try { yield JSON.parse(d); } catch { /* skip */ } }
      }
    }
  }
}

async function errText(resp) {
  let t = '';
  try { t = await resp.text(); } catch { /* ignore */ }
  try { const j = JSON.parse(t); t = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || t; } catch { /* keep raw */ }
  if (Array.isArray(t)) t = JSON.stringify(t);
  let hint = '';
  if (resp.status === 401 || resp.status === 403) hint = ' — проверь API-ключ и доступ к модели.';
  else if (resp.status === 404) hint = ' — проверь название модели.';
  else if (resp.status === 429) hint = ' — лимит запросов или нет денег на балансе.';
  return `Ошибка API ${resp.status}: ${String(t).slice(0, 600)}${hint}`;
}

async function doFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Не удалось связаться с провайдером (' + (e.cause?.code || e.message) + '). Проверь интернет/VPN.');
  }
}

// ---------- OpenAI-совместимые ----------
async function chatOpenAI(o) {
  const msgs = [{ role: 'system', content: o.system }];
  for (const m of o.messages) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const a = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        a.tool_calls = m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
      }
      msgs.push(a);
    } else if (m.role === 'tool') {
      for (const r of m.results) msgs.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  const body = {
    model: o.model, messages: msgs, stream: true,
    tools: o.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
  const r = await doFetch(o.url, {
    method: 'POST', signal: o.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + o.key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  let text = '';
  const calls = [];
  for await (const j of sse(r)) {
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const d = j.choices?.[0]?.delta;
    if (!d) continue;
    if (d.content) { text += d.content; o.onText(d.content); }
    for (const tc of d.tool_calls || []) {
      const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, args: safeParse(c.args) }));
  return { text, toolCalls };
}

// ---------- Anthropic ----------
async function chatAnthropic(o) {
  const msgs = [];
  for (const m of o.messages) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls || []) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args || {} });
      if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      msgs.push({ role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content || '(пусто)', is_error: !!r.isError })) });
    }
  }
  const body = {
    model: o.model, max_tokens: 16000, stream: true, system: o.system, messages: msgs,
    tools: o.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
  const r = await doFetch(o.url, {
    method: 'POST', signal: o.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': o.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  let text = '';
  const blocks = {};
  for await (const j of sse(r)) {
    if (j.type === 'error') throw new Error(j.error?.message || 'Ошибка стрима Anthropic');
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
      blocks[j.index] = { id: j.content_block.id, name: j.content_block.name, json: '' };
    } else if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta' && j.delta.text) { text += j.delta.text; o.onText(j.delta.text); }
      else if (j.delta?.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].json += j.delta.partial_json || '';
    }
  }
  const toolCalls = Object.keys(blocks).sort((a, b) => a - b).map(k => ({ id: blocks[k].id, name: blocks[k].name, args: safeParse(blocks[k].json) }));
  return { text, toolCalls };
}

// ---------- Google Gemini ----------
async function chatGemini(o) {
  const contents = [];
  for (const m of o.messages) {
    if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.content }] });
    else if (m.role === 'assistant') {
      let parts = m.raw;
      if (!parts || !parts.length) {
        parts = [];
        if (m.text) parts.push({ text: m.text });
        for (const t of m.toolCalls || []) parts.push({ functionCall: { name: t.name, args: t.args || {} } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({ role: 'user', parts: m.results.map(r => ({ functionResponse: { name: r.name, response: { result: r.content || '(пусто)' } } })) });
    }
  }
  const body = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents,
    tools: [{ functionDeclarations: o.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
  };
  const url = `${o.url}${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`;
  const r = await doFetch(url, {
    method: 'POST', signal: o.signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  let text = '';
  const toolCalls = [];
  const raw = [];
  let n = 0;
  for await (const j of sse(r)) {
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.promptFeedback?.blockReason) throw new Error('Запрос заблокирован: ' + j.promptFeedback.blockReason);
    for (const part of j.candidates?.[0]?.content?.parts || []) {
      if (part.thought) continue;
      if (part.functionCall) {
        toolCalls.push({ id: part.functionCall.id || `g_${Date.now()}_${n++}`, name: part.functionCall.name, args: part.functionCall.args || {} });
        raw.push(part);
      } else if (typeof part.text === 'string') {
        if (part.text) { text += part.text; o.onText(part.text); }
        raw.push(part);
      }
    }
  }
  return { text, toolCalls, raw };
}

async function chat(o) {
  const meta = META[o.provider];
  if (!meta) throw new Error('Неизвестный провайдер: ' + o.provider);
  if (!o.key) throw new Error('Не задан API-ключ. Открой /settings.');
  if (!o.model) throw new Error('Не выбрана модель. Открой /settings.');
  if (!o.url) throw new Error('Не задан адрес API (Base URL). Открой /settings.');
  if (meta.type === 'anthropic') return chatAnthropic(o);
  if (meta.type === 'gemini') return chatGemini(o);
  return chatOpenAI(o);
}

function resolveUrl(provider, settings) {
  const meta = META[provider];
  const base = ((settings && settings.baseUrl) || '').trim().replace(/\/+$/, '');
  if (!base) return meta ? meta.url : '';
  // BASE_URL позволяет указать прокси/зеркало для любого провайдера
  if (meta && meta.type === 'anthropic') return /\/messages$/.test(base) ? base : base.replace(/\/v1$/, '') + '/v1/messages';
  if (meta && meta.type === 'gemini') return (/\/models$/.test(base) ? base : /\/v1(beta)?$/.test(base) ? base + '/models' : base + '/v1beta/models') + '/';
  return /chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

module.exports = { META, chat, resolveUrl };
