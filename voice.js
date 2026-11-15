// Voice input. Windows: built-in speech recognition (System.Speech), works until you stop it.
// Termux: termux-speech-to-text (needs the Termux:API app), listens once and returns the text.
// Returns null where voice input is not available.
const { spawn } = require('child_process');

function startVoice(lang) {
  if (process.platform === 'win32') {
    const culture = lang === 'ru' ? 'ru-RU' : 'en-US';
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Speech',
      `$r=New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Globalization.CultureInfo]'${culture}')`,
      '$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      '$r.SetInputToDefaultAudioDevice()',
      'Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -Action { [Console]::WriteLine($Event.SourceEventArgs.Result.Text); [Console]::Out.Flush() } | Out-Null',
      '$r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
      'while ($true) { Start-Sleep -Milliseconds 200 }',
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', enc],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const s = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (s) lines.push(s);
      }
    });
    child.on('error', () => { /* no PowerShell: stop() returns nothing */ });
    return {
      oneShot: false,
      stop() {
        try { child.kill(); } catch { /* already gone */ }
        const rest = buf.trim();
        return [...lines, rest].filter(Boolean).join(' ');
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
    return { oneShot: true, done, stop() { try { child.kill(); } catch { /* ignore */ } return ''; } };
  }

  return null;
}

module.exports = { startVoice };
