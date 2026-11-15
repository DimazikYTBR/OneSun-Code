// Voice input for OneSun Code.
// Windows: records the microphone through the built-in Windows audio API (winmm, called from PowerShell)
// and sends the recording to Gemini with the key from config.txt. Nothing extra to install.
// Termux: termux-speech-to-text (needs the Termux:API app); listens once and returns the text.
// startVoice() returns null where voice input is not available.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WAV = path.join(os.tmpdir(), 'onesun-voice.wav');
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MSG = {
  en: {
    noMic: 'nothing was recorded: check the microphone and Settings → Privacy → Microphone',
    needGemini: 'voice needs a Gemini key (PROVIDER=gemini in config.txt)',
  },
  ru: {
    noMic: 'звук не записан: проверь микрофон и «Параметры → Конфиденциальность → Микрофон»',
    needGemini: 'для голоса нужен ключ Gemini (PROVIDER=gemini в config.txt)',
  },
};

// Starts recording with winmm (MCI). Every MCI error is printed as "MCI: ..." so it reaches the terminal.
function startWindowsRecording() {
  const file = WAV.replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    'Add-Type -MemberDefinition \'[DllImport("winmm.dll", CharSet=CharSet.Auto)] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, IntPtr h); [DllImport("winmm.dll", CharSet=CharSet.Auto)] public static extern bool mciGetErrorString(int e, System.Text.StringBuilder s, int l);\' -Name M -Namespace W',
    'function Mci($c) { $rc = [W.M]::mciSendString($c, $null, 0, [IntPtr]::Zero); if ($rc -ne 0) { $sb = New-Object System.Text.StringBuilder 256; [void][W.M]::mciGetErrorString($rc, $sb, 256); [Console]::WriteLine("MCI: " + $c + " -> " + $sb.ToString()); [Console]::Out.Flush() } }',
    `$f='${file}'`,
    'Mci "open new type waveaudio alias r"',
    'Mci "set r time format ms channels 1 samplespersec 16000 bitspersample 16 alignment 2"',
    'Mci "record r"',
    '[void][Console]::In.ReadLine()', // waits for a newline from Node = stop
    'Mci "stop r"',
    'Mci (\'save r "\' + $f + \'" wait\')',
    'Mci "close r"',
    '} catch { [Console]::WriteLine("ERR: " + $_.Exception.Message); [Console]::Out.Flush() }',
  ].join('\n');
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* process already exited */ });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });
  child.on('error', (e) => { out += `\nERR: ${e.message}`; });
  const closed = new Promise((r) => child.on('close', r));
  const explain = () => {
    const ours = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(MCI|ERR):/.test(l));
    if (ours) return ours;
    const plain = err.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes('CLIXML') && !l.startsWith('#<'));
    return plain || 'Windows gave no details';
  };
  return { child, closed, explain };
}

// Sends the WAV bytes to Gemini and returns the transcript.
async function transcribe(cfg, wav) {
  const lang = cfg.lang === 'ru' ? 'ru' : 'en';
  if (cfg.provider !== 'gemini' || !cfg.key) throw new Error(MSG[lang].needGemini);
  const model = cfg.model && cfg.model.includes('gemini') ? cfg.model : DEFAULT_GEMINI_MODEL;
  const body = { contents: [{ parts: [
    { text: 'Transcribe this audio exactly as spoken. Reply with the transcript only: no quotes, no comments. If there is no speech, reply with an empty string.' },
    { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
  ] }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// cfg: { provider, key, model, lang } from OneSun's config.
// Windows returns { oneShot: false, stop(), cancel() }: stop() resolves to { text, error }.
// Termux returns { oneShot: true, done }: done resolves to the recognized text.
function startVoice(cfg) {
  cfg = cfg || {};
  const lang = cfg.lang === 'ru' ? 'ru' : 'en';

  if (process.platform === 'win32') {
    const rec = startWindowsRecording();
    return {
      oneShot: false,
      async stop() {
        try { rec.child.stdin.end('\n'); } catch { /* already closed */ }
        await rec.closed;
        const size = fs.existsSync(WAV) ? fs.statSync(WAV).size : 0;
        if (size < 2000) return { text: '', error: `${MSG[lang].noMic} (${rec.explain()})` };
        try {
          const text = await transcribe(cfg, fs.readFileSync(WAV));
          return { text, error: '' };
        } catch (e) {
          return { text: '', error: e.message };
        } finally {
          try { fs.unlinkSync(WAV); } catch { /* ignore */ }
        }
      },
      cancel() {
        try { rec.child.kill(); } catch { /* ignore */ }
        try { fs.unlinkSync(WAV); } catch { /* ignore */ }
      },
    };
  }

  if (process.env.TERMUX_VERSION) {
    let out = '';
    const child = spawn('termux-speech-to-text', [], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    const done = new Promise((resolve) => {
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out.trim()));
    });
    return { oneShot: true, done, cancel() { try { child.kill(); } catch { /* ignore */ } } };
  }

  return null;
}

module.exports = { startVoice };
