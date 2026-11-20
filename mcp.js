
'use strict';

// OneSun Code MCP support: Streamable HTTP + stdio.
// Node.js 18+, no external dependencies.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { addTool } = require('./tools');

const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT = 30000;

// ---------- Config ----------

function configPath(directory) {
  return path.join(directory, 'mcp.json');
}

function readConfig(directory) {
  const file = configPath(directory);

  if (!fs.existsSync(file)) {
    return { mcpServers: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mcp.json must contain a JSON object');
  }

  if (!parsed.mcpServers ||
      typeof parsed.mcpServers !== 'object' ||
      Array.isArray(parsed.mcpServers)) {
    parsed.mcpServers = {};
  }

  return parsed;
}

function writeConfig(directory, config) {
  fs.mkdirSync(directory, { recursive: true });

  const file = configPath(directory);
  const temp = file + '.' + process.pid + '.tmp';

  fs.writeFileSync(
    temp,
    JSON.stringify(config, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 }
  );

  try {
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }

  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function validateName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name || '')) {
    throw new Error(
      'Server name must be 1–64 chars: letters, numbers, _, . or -'
    );
  }
}

function normalizeHeaders(headers) {
  const out = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (!key || /[\r\n:]/.test(key) || /[\r\n]/.test(String(value))) {
      throw new Error('Invalid HTTP header');
    }

    out[key] = String(value);
  }

  return out;
}

function safeToolName(server, tool) {
  const base = `mcp_${server}_${tool}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 56);

  const suffix = crypto
    .createHash('sha1')
    .update(`${server}\0${tool}`)
    .digest('hex')
    .slice(0, 7);

  return `${base}_${suffix}`;
}

// ---------- STDIO transport ----------

class StdioClient {
  constructor(name, cfg, directory) {
    this.name = name;
    this.cfg = cfg;
    this.directory = directory;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
    this.buffer = '';
  }

  async start() {
    if (typeof this.cfg.command !== 'string' ||
        !this.cfg.command.trim()) {
      throw new Error('stdio server requires "command"');
    }

    const cwd = this.cfg.cwd
      ? path.resolve(this.directory, this.cfg.cwd)
      : this.directory;

    const env = {
      ...process.env,
      ...(this.cfg.env || {})
    };

    this.child = spawn(
      this.cfg.command,
      Array.isArray(this.cfg.args)
        ? this.cfg.args.map(String)
        : [],
      {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-5000);
    });

    this.child.on('error', e => {
      this.failAll(
        new Error(`Could not start ${this.name}: ${e.message}`)
      );
    });

    this.child.on('close', code => {
      this.failAll(
        new Error(
          `${this.name} exited (${code})` +
          (this.stderr ? ': ' + this.stderr.trim() : '')
        )
      );
    });

    await this.waitForSpawn();

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'onesun-code',
        version: '0.5.0'
      }
    });

    if (!init || !init.protocolVersion) {
      throw new Error('MCP initialize returned an invalid response');
    }

    this.notify('notifications/initialized');

    return this;
  }

  waitForSpawn() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out starting ${this.name}`));
      }, 10000);

      this.child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });

      this.child.once('error', e => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  onData(chunk) {
    this.buffer += chunk;

    if (this.buffer.length > 2 * 1024 * 1024) {
      this.failAll(new Error('MCP stdout buffer exceeded 2 MB'));
      this.close();
      return;
    }

    let i;

    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);

      if (!line) continue;

      let msg;

      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.id == null) continue;

      const pending = this.pending.get(msg.id);

      if (!pending) continue;

      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(
          new Error(msg.error.message || JSON.stringify(msg.error))
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  request(method, params = {}) {
    if (!this.child || this.closed || this.child.killed) {
      return Promise.reject(
        new Error(`${this.name} is not running`)
      );
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params
        }) + '\n',
        error => {
          if (error && this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        }
      );
    });
  }

  notify(method, params = {}) {
    if (!this.closed &&
        this.child &&
        this.child.stdin.writable) {
      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method,
          params
        }) + '\n'
      );
    }
  }

  async listTools() {
    const all = [];
    let cursor;

    do {
      const result = await this.request(
        'tools/list',
        cursor ? { cursor } : {}
      );

      if (Array.isArray(result.tools)) {
        all.push(...result.tools);
      }

      cursor = result.nextCursor;
    } while (cursor);

    return all;
  }

  callTool(name, args) {
    return this.request('tools/call', {
      name,
      arguments: args || {}
    });
  }

  close() {
    if (this.closed) return;

    this.closed = true;
    this.failAll(new Error(`${this.name} closed`));

    try {
      this.child?.stdin.end();
    } catch {}

    const timer = setTimeout(() => {
      try {
        this.child?.kill();
      } catch {}
    }, 500);

    timer.unref?.();
  }
}

// ---------- HTTP transport ----------

class HttpClient {
  constructor(name, cfg) {
    this.name = name;
    this.url = new URL(cfg.url);
    this.headers = normalizeHeaders(cfg.headers);

    this.sessionId = null;
    this.nextId = 1;
    this.protocolVersion = PROTOCOL_VERSION;
    this.closed = false;
  }

  async post(message, expectResponse = true) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
    );

    const headers = {
      ...this.headers,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': this.protocolVersion
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });

      const sid = response.headers.get('mcp-session-id');

      if (sid) {
        this.sessionId = sid;
      }

      if (response.status === 202 && !expectResponse) {
        return null;
      }

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ` +
          (await response.text()).slice(0, 500)
        );
      }

      if (!expectResponse ||
          response.status === 202 ||
          response.status === 204) {
        return null;
      }

      const type = (
        response.headers.get('content-type') || ''
      ).toLowerCase();

      if (type.includes('application/json')) {
        return await response.json();
      }

      if (type.includes('text/event-stream')) {
        return await this.readSse(response);
      }

      throw new Error(
        `Unexpected MCP content type: ${type || '(missing)'}`
      );
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`${this.name} request timed out`);
      }

      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async readSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let latest = null;

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true
        });

        buffer = buffer.replace(/\r\n/g, '\n');

        let idx;

        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const data = block
            .split(/\r?\n/)
            .filter(x => x.startsWith('data:'))
            .map(x => x.slice(5).trim())
            .join('\n');

          if (data) {
            try {
              const parsed = JSON.parse(data);

              if (
                parsed &&
                parsed.jsonrpc === '2.0' &&
                parsed.id != null
              ) {
                latest = parsed;
              }
            } catch {}
          }

          if (latest) return latest;
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        const data = buffer
          .split(/\r?\n/)
          .filter(x => x.startsWith('data:'))
          .map(x => x.slice(5).trim())
          .join('\n');

        if (data) {
          try {
            const parsed = JSON.parse(data);

            if (parsed && parsed.id != null) {
              latest = parsed;
            }
          } catch {}
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    if (!latest) {
      throw new Error(
        'MCP server closed its event stream without a JSON-RPC response'
      );
    }

    return latest;
  }

  async request(method, params = {}) {
    const id = this.nextId++;

    const msg = await this.post({
      jsonrpc: '2.0',
      id,
      method,
      params
    }, true);

    if (!msg || msg.id !== id) {
      throw new Error(
        `Invalid JSON-RPC response to ${method}`
      );
    }

    if (msg.error) {
      throw new Error(
        msg.error.message || JSON.stringify(msg.error)
      );
    }

    return msg.result;
  }

  async notify(method, params = {}) {
    await this.post({
      jsonrpc: '2.0',
      method,
      params
    }, false);
  }

  async start() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'onesun-code',
        version: '0.5.0'
      }
    });

    if (!init || !init.protocolVersion) {
      throw new Error('MCP initialize returned an invalid response');
    }

    this.protocolVersion = init.protocolVersion;

    await this.notify('notifications/initialized');

    return this;
  }

  async listTools() {
    const all = [];
    let cursor;

    do {
      const result = await this.request(
        'tools/list',
        cursor ? { cursor } : {}
      );

      if (Array.isArray(result.tools)) {
        all.push(...result.tools);
      }

      cursor = result.nextCursor;
    } while (cursor);

    return all;
  }

  callTool(name, args) {
    return this.request('tools/call', {
      name,
      arguments: args || {}
    });
  }

  async close() {
    if (this.closed) return;

    this.closed = true;

    if (this.sessionId) {
      try {
        const controller = new AbortController();

        const timer = setTimeout(
          () => controller.abort(),
          2000
        );

        await fetch(this.url, {
          method: 'DELETE',
          headers: {
            ...this.headers,
            'Mcp-Session-Id': this.sessionId,
            'MCP-Protocol-Version': this.protocolVersion
          },
          signal: controller.signal
        });

        clearTimeout(timer);
      } catch {}
    }
  }
}

// ---------- Connection ----------

async function connect(name, cfg, directory) {
  if (cfg.transport === 'http' || cfg.url) {
    if (typeof cfg.url !== 'string') {
      throw new Error('HTTP server requires "url"');
    }

    const url = new URL(cfg.url);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('MCP URL must use http:// or https://');
    }

    const client = new HttpClient(name, cfg);

    await client.start();

    return client;
  }

  if (cfg.transport === 'stdio' || cfg.command) {
    const client = new StdioClient(name, cfg, directory);

    await client.start();

    return client;
  }

  throw new Error('transport must be "http" or "stdio"');
}

// ---------- Load tools into OneSun ----------

async function loadMcpTools(directory) {
  let config;

  try {
    config = readConfig(directory);
  } catch (e) {
    return [{
      name: 'config',
      ok: false,
      error: e.message
    }];
  }

  const reports = [];
  const clients = [];

  for (const [serverName, cfg] of Object.entries(config.mcpServers)) {
    let client;

    try {
      client = await connect(serverName, cfg, directory);
      clients.push(client);

      const tools = await client.listTools();

      for (const tool of tools) {
        if (
          !tool ||
          typeof tool.name !== 'string' ||
          !tool.name
        ) {
          continue;
        }

        const name = safeToolName(serverName, tool.name);

        addTool(name, {
          description:
            `[MCP ${serverName}] ${tool.description || tool.name}`,

          parameters:
            tool.inputSchema || {
              type: 'object',
              properties: {}
            }
        }, async args => {
          try {
            const result = await client.callTool(
              tool.name,
              args
            );

            const content = Array.isArray(result?.content)
              ? result.content
                  .map(c =>
                    c.text ||
                    (c.type === 'image'
                      ? '[image result omitted]'
                      : '')
                  )
                  .filter(Boolean)
                  .join('\n')
              : JSON.stringify(result);

            return {
              content: content || JSON.stringify(result),
              isError: !!result?.isError
            };
          } catch (e) {
            return {
              content:
                `MCP ${serverName}/${tool.name}: ${e.message}`,
              isError: true
            };
          }
        });
      }

      reports.push({
        name: serverName,
        ok: true,
        count: tools.length
      });
    } catch (e) {
      try {
        await client?.close();
      } catch {}

      reports.push({
        name: serverName,
        ok: false,
        error: e.message
      });
    }
  }

  const closeAll = () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {}
    }
  };

  process.once('exit', closeAll);

  process.once('SIGINT', () => {
    closeAll();
    process.exit(130);
  });

  process.once('SIGTERM', () => {
    closeAll();
    process.exit(143);
  });

  return reports;
}

// ---------- CLI argument parser ----------

function parseAddArgs(args) {
  let transport = 'stdio';

  const headers = {};
  const env = {};
  let cwd;

  const positional = [];
  const commandArgs = [];

  let afterDash = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (afterDash) {
      commandArgs.push(a);
      continue;
    }

    if (a === '--') {
      afterDash = true;
      continue;
    }

    if (a === '--transport') {
      transport = args[++i];

      if (!transport) {
        throw new Error('--transport requires http or stdio');
      }

      continue;
    }

    if (a === '--header') {
      const h = args[++i];

      if (!h) {
        throw new Error('--header requires "Name: value"');
      }

      const n = h.indexOf(':');

      if (n < 1) {
        throw new Error('--header format: "Name: value"');
      }

      headers[h.slice(0, n).trim()] =
        h.slice(n + 1).trim();

      continue;
    }

    if (a === '--env') {
      const e = args[++i];
      const n = e ? e.indexOf('=') : -1;

      if (n < 1) {
        throw new Error('--env format: KEY=value');
      }

      env[e.slice(0, n)] = e.slice(n + 1);

      continue;
    }

    if (a === '--cwd') {
      cwd = args[++i];

      if (!cwd) {
        throw new Error('--cwd requires a path');
      }

      continue;
    }

    if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    }

    positional.push(a);
  }

  if (!['http', 'stdio'].includes(transport)) {
    throw new Error('--transport must be "http" or "stdio"');
  }

  const name = positional.shift();

  validateName(name);

  if (transport === 'http') {
    const url = positional.shift();

    if (!url) {
      throw new Error(
        'Usage: sun mcp add --transport http <name> <url>'
      );
    }

    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('URL must use http:// or https://');
    }

    if (positional.length || afterDash) {
      throw new Error('Unexpected arguments after HTTP URL');
    }

    return {
      name,
      cfg: {
        transport,
        url: parsed.toString(),
        headers: normalizeHeaders(headers)
      }
    };
  }

  if (Object.keys(headers).length) {
    throw new Error(
      '--header is only valid with --transport http'
    );
  }

  if (positional.length) {
    throw new Error(
      'For stdio, put the command after --'
    );
  }

  if (!commandArgs.length) {
    throw new Error(
      'Usage: sun mcp add --transport stdio <name> -- <command> [args...]'
    );
  }

  return {
    name,
    cfg: {
      transport,
      command: commandArgs[0],
      args: commandArgs.slice(1),
      ...(Object.keys(env).length ? { env } : {}),
      ...(cwd ? { cwd } : {})
    }
  };
}

// ---------- CLI help ----------

function help() {
  console.log(`
OneSun Code — MCP commands

  sun mcp add --transport http <name> <url> [--header "Name: value"]
  sun mcp add --transport stdio <name> -- <command> [args...]

  sun mcp list
  sun mcp get <name>
  sun mcp test <name>
  sun mcp remove <name>

Options:

  --header "Name: value"   HTTP header
  --env KEY=value          stdio environment variable
  --cwd <path>             stdio working directory
`);
}

// ---------- MCP CLI commands ----------

async function runMcpCommand(args, directory) {
  const [sub, ...rest] = args;

  if (
    !sub ||
    sub === '--help' ||
    sub === '-h' ||
    sub === 'help'
  ) {
    help();
    return true;
  }

  try {
    const config = readConfig(directory);

    if (sub === 'add') {
      const { name, cfg } = parseAddArgs(rest);

      if (config.mcpServers[name]) {
        throw new Error(
          `MCP server "${name}" already exists. Remove it first.`
        );
      }

      config.mcpServers[name] = cfg;

      writeConfig(directory, config);

      console.log(
        `✓ Added MCP server "${name}" (${cfg.transport}).`
      );

      if (
        cfg.transport === 'http' &&
        Object.keys(cfg.headers || {}).length
      ) {
        console.log(
          'Authentication headers saved locally in mcp.json. Keep this file private.'
        );
      }

      return true;
    }

    if (sub === 'list') {
      const entries = Object.entries(config.mcpServers);

      if (!entries.length) {
        console.log('No MCP servers configured.');
      } else {
        for (const [name, cfg] of entries) {
          console.log(
            `  ${name.padEnd(18)} ` +
            `${cfg.transport || (cfg.url ? 'http' : 'stdio')}  ` +
            `${cfg.url || cfg.command || ''}`
          );
        }
      }

      return true;
    }

    if (sub === 'get') {
      const name = rest[0];

      if (!name || !config.mcpServers[name]) {
        throw new Error(`MCP server not found: ${name || '(missing name)'}`);
      }

      const cfg = JSON.parse(
        JSON.stringify(config.mcpServers[name])
      );

      if (cfg.headers) {
        for (const key of Object.keys(cfg.headers)) {
          if (/authorization|token|api[-_]?key/i.test(key)) {
            cfg.headers[key] = '[REDACTED]';
          }
        }
      }

      console.log(
        JSON.stringify({ name, ...cfg }, null, 2)
      );

      return true;
    }

    if (sub === 'remove' || sub === 'rm') {
      const name = rest[0];

      if (!name || !config.mcpServers[name]) {
        throw new Error(`MCP server not found: ${name || '(missing name)'}`);
      }

      delete config.mcpServers[name];

      writeConfig(directory, config);

      console.log(`✓ Removed MCP server "${name}".`);

      return true;
    }

    if (sub === 'test') {
      const name = rest[0];

      if (!name || !config.mcpServers[name]) {
        throw new Error(`MCP server not found: ${name || '(missing name)'}`);
      }

      let client;

      try {
        client = await connect(
          name,
          config.mcpServers[name],
          directory
        );

        const tools = await client.listTools();

        console.log(
          `✓ ${name}: connected; ${tools.length} tool(s) available.`
        );

        for (const tool of tools) {
          console.log(
            `  • ${tool.name}` +
            (tool.description
              ? ' — ' + tool.description.split('\n')[0]
              : '')
          );
        }
      } finally {
        try {
          await client?.close();
        } catch {}
      }

      return true;
    }

    throw new Error(
      `Unknown MCP command: ${sub}. Run "sun mcp --help".`
    );
  } catch (e) {
    console.error(`MCP: ${e.message}`);
    process.exitCode = 1;
    return true;
  }
}

module.exports = {
  loadMcpTools,
  runMcpCommand
};
