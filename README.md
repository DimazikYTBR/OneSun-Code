# ☀ OneSun Code

**English** · [Русская версия](README.ru.md)

An AI coding agent right in your terminal, with an interface in the style of Claude Code.
You paste your own API key, pick a model, and the agent reads your project, edits files and runs commands (with your permission).

Supported: **Claude, Google Gemini (including Gemini 4), OpenAI, DeepSeek, OpenRouter** and any OpenAI-compatible API.

## Install (Windows)

You need two free tools:

1. **Node.js 18 or newer** — https://nodejs.org (the LTS button)
2. **Git** — https://git-scm.com

Then open PowerShell, cmd or Windows Terminal and run:

```
git clone https://github.com/DimazikYTBR/OneSun-Code.git
cd OneSun-Code
npm link
```

(Instead of `npm link` you can double-click `install.bat`.)

## Run

Go to your project folder and run the command:

```
cd C:\Projects\my-game
onesun
```

### First run

1. **Language.** The first time, you are asked to pick a language (English is the default; arrows + Enter, or press `1` / `2`). Change it any time with `/lang`.
2. **Settings.** If the API key or model is missing, the program **opens `config.txt` in Notepad by itself**.
   Type the values after the `=` sign, save the file (Ctrl+S), come back to the terminal and press Enter.

```
PROVIDER=gemini
API_KEY=your-key-here
MODEL=gemini-4-argon
```

`config.txt` lives in the OneSun-Code folder. The program creates it from `config.example.txt` and it is not uploaded to GitHub, so your key stays private.
Change settings later with `/config` inside the program or `onesun --config`.

### Your settings are never reset

- `config.txt` is created **only if it does not exist**. An existing file is never overwritten, not by the program and not by updates (`git pull`).
- If your config is from an older version and has no language yet, you are asked once and only the line `LANG=...` is **appended** to the end of the file. Everything else stays byte for byte.
- `/model`, `/provider` and `/lang` change only their own line.
- Do not upload `config.txt` to GitHub by hand (for example with “Upload files”): it contains your key.

## Using it

Write the task in plain language:

```
> find out why login doesn't work and fix it
> add a /stats command to the bot
> create index.html with a Snake game
```

While the agent is thinking, a shimmering status line is shown (white text with a blue wave running through it) and the phrase changes every few seconds (“Thinking”, “Catching rays”, “Brewing”…).

| Command | What it does |
|---|---|
| `/help` | list of commands |
| `/config` | open config.txt |
| `/model name` | change the model |
| `/provider name` | change the provider |
| `/lang` | change the language (English / Русский) |
| `/mode` or **Shift+Tab** | permission mode |
| `/clear` | clear the conversation |
| `/exit` or Ctrl+C twice | quit |
| **Esc** | interrupt the agent |

You can give a task right away: `onesun "add a README"`.
Line break: `\` at the end of a line. Pasting multi-line text works as is.

### Permission modes

- **ask permissions** (default) — before editing a file or running a command it shows exactly what it is about to do and asks: Yes / Yes, don't ask again / No;
- **edits without asking** — files are edited automatically, commands still ask;
- **everything without asking** — the agent does everything itself. Use with care.

Reading files inside the project folder needs no permission. Reading outside the folder asks.

### Pinned header

The OneSun logo and name (plus provider, model and project folder) are pinned to the top of the screen and do not scroll away. The header updates when you change the model.
If the terminal window is too small (under 18 rows), the header is skipped automatically.
Downside: the mouse wheel cannot bring back old messages that scrolled past the top of the conversation area. If that bothers you, put `HEADER=off` in `config.txt`.

### Project instructions

Create a file named `ONESUN.md` in your project folder — the agent reads it on every start (code style, how to run tests, etc.).

## If the API is blocked

In some countries Claude, OpenAI or Google are not reachable directly. Options:

- get an **OpenRouter** key (`PROVIDER=openrouter`) or a **DeepSeek** key (`PROVIDER=deepseek`);
- put the address of a proxy/mirror into `BASE_URL=` — it works for any provider.

## Update

```
cd OneSun-Code
git pull
```

If `git pull` complains about “local changes” in a file, run `git restore <file>` and pull again. Your `config.txt` is not part of the repository and stays untouched.

## If the symbols look broken

**Windows Terminal** works best (it is the default in Windows 11). In the old console the program switches to plain symbols by itself; to force it: `set ONESUN_ASCII=1`.
