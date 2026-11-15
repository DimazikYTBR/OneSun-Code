#!/usr/bin/env node
// listen.js: mini voice listener for OneSun Code (Windows).
// Enter: start listening. Enter again: stop. The recording goes to Gemini with the key from config.txt,
// and the words appear one by one with the same shimmer that OneSun shows while it thinks.
// Recording uses the built-in Windows audio API (winmm), so no speech settings or extra installs are needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const CONFIG = path.join(__dirname, 'config.txt');
const WAV = path.join(os.tmpdir(), 'onesun-listen.wav');

function readConfig() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) cfg[m[1]] = m[2];
    }
  } catch { /* no config.txt yet */ }
  return cfg;
}

const cfg = readConfig();
const M = cfg.LANG === 'ru' ? {
  listening: 'Слушаю', transcribing: 'Распознаю', empty: 'Ничего не распознано',
  needGemini: 'Нужен ключ Gemini: в config.txt поставь PROVIDER=gemini и API_KEY',
  noMic: 'Звук не записан. Проверь микрофон и «Параметры → Конфиденциальность → Микрофон».',
  err: 'Ошибка: ', again: 'Enter — слушать снова', stop: 'Enter — остановить · Ctrl+C — выход',
  ready: 'Enter — начать слушать · Ctrl+C — выход',
} : {
  listening: 'Listening', transcribing: 'Transcribing', empty: 'Nothing was recognized',
  needGemini: 'A Gemini key is needed: set PROVIDER=gemini and API_KEY in config.txt',
  noMic: 'No audio was recorded. Check the microphone and Settings → Privacy → Microphone.',
  err: 'Error: ', again: 'Enter — listen again', stop: 'Enter — stop · Ctrl+C — quit',
  ready: 'Enter — start listening · Ctrl+C — quit',
};

// ---------- shimmer (same idea as OneSun: white text with a blue wave moving through it) ----------
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
const PALETTE = [231, 195, 153, 117, 75, 33];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const draw = (s) => process.stdout.write('\r\x1b[2K' + s);
const say = (s) => process.stdout.write(s + '\n');

function paint(text, frame) {
  let out = '';
  [...text].forEach((ch, i) => {
    if (ch === ' ') { out += ' '; return; }
    const s = (Math.sin(i * 0.9 - frame * 0.35) + 1) / 2; // 0 = white, 1 = blue
    if (TRUECOLOR) {
      const r = Math.round(255 + (60 - 255) * s);
      const g = Math.round(255 + (130 - 255) * s);
      out += `\x1b[38;2;${r};${g};255m${ch}`;
    } else {
      out += `\x1b[38;5;${PALETTE[Math.round(s * 5)]}m${ch}`;
    }
  });
  return out + '\x1b[0m';
}

// Animated status line; returns a function that stops it and clears the line.
function spin(label) {
  const t0 = Date.now();
  let frame = 0;
  const id = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    draw(`${paint(label + '…', frame++)}  \x1b[90m${sec}s\x1b[0m`);
  }, 70);
  return () => { clearInterval(id); draw(''); };
}

// Words appear one by one: each word shimmers for a moment, then settles to bold white.
async function revealWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  let done = '';
  for (const w of words) {
    for (let f = 0; f < 6; f++) {
      draw(done + paint(w, f));
      await sleep(60);
    }
    done += `\x1b[1;37m${w}\x1b[0m `;
    draw(done);
    await sleep(40);
  }
  process.stdout.write('\n');
}

// ---------- recording (Windows MCI, via PowerShell) ----------
let rec = null;
function startRecording() {
  const file = WAV.replace(/'/g, "''");
  const script = [
    'Add-Type -MemberDefinition \'[DllImport("winmm.dll")] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, IntPtr h);\' -Name M -Namespace W',
    'function Mci($c) { [void][W.M]::mciSendString($c, $null, 0, [IntPtr]::Zero) }',
    `$f='${file}'`,
    'Mci "open new type waveaudio alias r"',
    'Mci "set r time format ms channels 1 samplespersec 16000 bitspersample 16 alignment 2"',
    'Mci "record r"',
    '[void][Console]::In.ReadLine()', // waits until Node writes a newline (= stop)
    'Mci "stop r"',
    'Mci ("save r \\"" + $f + "\\" wait")',
    'Mci "close r"',
  ].join('\n');
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });
  child.on('error', (e) => { err += e.message; });
  rec = { child, err: () => err.trim().split('\n')[0] || '', closed: new Promise((r) => child.on('close', r)) };
}

async function stopRecording() {
  const r = rec;
  rec = null;
  r.child.stdin.end('\n');
  await r.closed;
  return r.err();
}

// ---------- transcription (Gemini, with the key from config.txt) ----------
async function transcribe() {
  const key = cfg.GEMINI_API_KEY || (cfg.PROVIDER === 'gemini' ? cfg.API_KEY : '');
  if (!key) throw new Error(M.needGemini);
  const model = cfg.MODEL && cfg.MODEL.includes('gemini') ? cfg.MODEL : 'gemini-3.6-flash';
  const body = { contents: [{ parts: [
    { text: 'Transcribe this audio exactly as spoken. Reply with the transcript only: no quotes, no comments. If there is no speech, reply with an empty string.' },
    { inlineData: { mimeType: 'audio/wav', data: fs.readFileSync(WAV).toString('base64') } },
  ] }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  return ((json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [])
    .map((p) => p.text || '').join('').trim();
}

// ---------- main loop: Enter starts, Enter stops ----------
let recording = false, busy = false;
say(`\x1b[1m${paint('OneSun Listen', 0)}\x1b[0m`);
say(`\x1b[90m${M.ready}\x1b[0m\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.on('SIGINT', () => { if (rec) try { rec.child.kill(); } catch { /* ignore */ } process.exit(0); });

rl.on('line', async () => {
  if (busy) return;

  if (!recording) {
    recording = true;
    startRecording();
    stopSpin = spin(M.listening);
    return;
  }

  // Enter while recording: stop, transcribe, show.
  recording = false;
  busy = true;
  stopSpin();
  const recErr = await stopRecording();
  const size = fs.existsSync(WAV) ? fs.statSync(WAV).size : 0;
  if (size < 2000) {
    say(`\x1b[31m${M.noMic}${recErr ? ' (' + recErr + ')' : ''}\x1b[0m`);
  } else {
    const stopT = spin(M.transcribing);
    try {
      const text = await transcribe();
      stopT();
      if (!text) say(`\x1b[90m${M.empty}\x1b[0m`);
      else await revealWords(text);
    } catch (e) {
      stopT();
      say(`\x1b[31m${M.err}${e.message}\x1b[0m`);
    }
  }
  try { fs.unlinkSync(WAV); } catch { /* ignore */ }
  say(`\x1b[90m${M.again}\x1b[0m\n`);
  busy = false;
});

let stopSpin = () => {};
