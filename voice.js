// Voice input.
// Windows: presses Win+H, which starts the system's own voice typing. It works on Windows 10/11 with any
// microphone and the built-in speech languages. The recognized text is typed into the focused line,
// so the user presses Enter to send it. Nothing is installed and no API key is needed.
// Termux: termux-speech-to-text (needs the Termux:API app), listens once and returns the text.
// Returns null where voice input is not available.
const { spawn } = require('child_process');

function startVoice() {
  if (process.platform === 'win32') {
    // keybd_event: 0x5B = Left Windows key, 0x48 = H, flag 2 = key up.
    const script = [
      'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);\' -Name K -Namespace W',
      '[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)',
      '[W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero)',
      '[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero)',
      '[W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)',
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { windowsHide: true, stdio: 'ignore', detached: true });
    child.on('error', () => { /* no PowerShell: nothing to press */ });
    child.unref();
    return { hotkey: true };
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
