'use strict';
// Тексты интерфейса на двух языках. Английский — по умолчанию и запасной вариант.
// t()   — текст на выбранном пользователем языке (для экрана);
// tEn() — всегда по-английски (для сообщений, которые уходят модели);
// tErr() — ошибка: message на языке пользователя, .en — для модели.

const LANGS = ['en', 'ru'];

const EN = {
  // --- приветствие ---
  'welcome': 'Welcome to OneSun Code!',
  'welcome.hint': '/help — commands · /config — key & model · Esc — interrupt · Shift+Tab — mode',
  'box.hint': '/help — commands · /config — key & model',
  'box.folder': 'folder:',
  'box.model': 'model:',
  'box.tips': 'Tips: Esc — interrupt · Shift+Tab — permission mode · “\\” at the end of a line — line break',

  // --- режимы ---
  'mode.ask': 'ask permissions',
  'mode.edits': 'edits without asking',
  'mode.yolo': 'everything without asking (!)',

  // --- справка ---
  'help.rows': [
    ['/help', 'this help'],
    ['/config', 'open config.txt (key, model, provider)'],
    ['/model [name]', 'show or change the model'],
    ['/provider [name]', 'show or change the provider'],
    ['/lang', 'change the language'],
    ['/mode', 'change the permission mode (or Shift+Tab)'],
    ['/clear', 'clear the conversation and the screen'],
    ['/cwd', 'show the working folder'],
    ['/init', 'the agent creates ONESUN.md for this project'],
    ['/commit', 'the agent writes a commit message and commits the changes'],
    ['/test', 'the agent finds and runs the project tests'],
    ['/desktop <task>', 'the agent works on your computer (open apps, type, click)'],
    ['/undo', 'undo the last file change made by the agent'],
    ['/copy', 'copy the last answer to the clipboard'],
    ['/open <app>', 'open a program right away, e.g. /open calc (Windows)'],
    ['Ctrl+G', 'voice: press, speak, press Enter to send (Windows; Termux with Termux:API)'],
    ['/new <name>', 'create a project in the projects folder and work in it'],
    ['/projects', 'list the projects in the projects folder'],
    ['/exit', 'quit (or Ctrl+C twice)'],
  ],
  'perm.desktop': 'Control your computer (open / type / click)?',
  'desk.preview': (a, x) => `Desktop ${a}: ${x}`,
  'desk.fail': (m) => `Desktop: ${m}`,
  'desk.unsupported': (a) => `“${a}” works only on Windows here`,
  'undo.none': 'Nothing to undo',
  'undo.done': (p) => `✓ Undone: ${p}`,
  'copy.none': 'No answer to copy yet',
  'copy.done': '✓ Copied to the clipboard',
  'copy.fail': 'Could not copy: no clipboard tool found',
  'desk.usage': 'Usage: /desktop what to do, e.g. /desktop open Notepad and write hello',
  'open.usage': 'Usage: /open program, e.g. /open calc or /open notepad',
  'voice.on': 'Listening… Enter sends, Ctrl+G stops and puts the text in the line',
  'voice.listening': 'Listening… speak now',
  'voice.empty': 'Nothing was recognized',
  'voice.none': 'Voice input works on Windows and in Termux (with Termux:API)',
  'free.note': 'Project folder: the agent edits files and runs commands here without asking.',
  'new.usage': 'Usage: /new project-name (letters, digits, spaces, - and _)',
  'new.done': (n) => `✓ Project created: projects/${n}`,
  'projects.none': 'No projects yet. Create one with /new name',
  'help.modes': 'Modes: “ask permissions” — before file edits and commands;\n  “edits without asking” — files are edited automatically, commands ask;\n  “everything without asking” — the agent does everything itself, be careful.',
  'help.md': 'A file named ONESUN.md in the project folder is read as instructions for the agent.',

  // --- «думаю» ---
  'spin.hint': (s) => `esc to interrupt · ${s}s`,
  'spin.running': 'Running',
  'spin.phrases': [
    'Thinking', 'Pondering', 'Cooking', 'Brewing', 'Conjuring', 'Crunching', 'Noodling',
    'Hatching a plan', 'Basking in the sun', 'Catching rays', 'Warming up', 'Shining',
    'Tinkering', 'Percolating', 'Connecting the dots', 'Writing code in my head',
  ],

  // --- запросы разрешений ---
  'perm.yes': 'Yes',
  'perm.always': (first) => `Yes, and don't ask again about “${first}” in this session`,
  'perm.always.edit': "Yes, and don't ask again about file edits in this session",
  'perm.always.default': "Yes, and don't ask again in this session",
  'perm.no': 'No, do something else (Esc)',
  'perm.read': 'Read a file outside the working folder?',
  'perm.ls': 'List a folder outside the working folder?',
  'perm.glob': 'Search for files outside the working folder?',
  'perm.grep': 'Search in files outside the working folder?',
  'perm.write': 'Create or overwrite the file?',
  'perm.edit': 'Edit the file?',
  'perm.bash': 'Run the command?',
  'perm.other': 'Run the action?',
  'perm.in': ' in ',
  'perm.cmd': 'commands',
  'more.lines': (n) => `… ${n} more lines`,
  'more.n': (n) => `… ${n} more`,

  // --- агент ---
  'interrupted': 'Interrupted',
  'agent.unknownTool': (n) => `Unknown tool: ${n}`,
  'agent.denied': 'Denied',
  'agent.empty': 'The model returned an empty response. Try again or use another model.',
  'agent.limit': (n) => `Step limit reached (${n}). Type “continue” to keep going.`,

  // --- результаты инструментов ---
  'read.preview': (n) => `Read ${n} lines`,
  'read.empty': '(file is empty)',
  'read.more': (tot, a, b) => `… [file has ${tot} lines in total, showing ${a}–${b}]`,
  'write.created': (p, n) => `Created ${p} (${n} lines)`,
  'write.updated': (p, n) => `Updated ${p} (${n} lines)`,
  'edit.done': (p, n) => `File updated: ${p} (replacements: ${n})`,
  'edit.preview': (p) => `Edited: ${p}`,
  'ls.preview': (n) => `Entries: ${n}`,
  'ls.empty': '(folder is empty)',
  'glob.preview': (n) => `Files found: ${n}`,
  'glob.none': 'No files found',
  'grep.preview': (n, more) => `Matches: ${n}${more ? '+' : ''}`,
  'grep.none': 'No matches',
  'bash.noout': '(no output)',
  'bash.timeout': (s) => `[command stopped after the ${s} s timeout]`,
  'bash.aborted': '[interrupted by the user]',
  'bash.exit': (c) => `[exit code ${c}]`,
  'clip': (n) => `… [truncated ${n} characters] …`,
  'empty': '(empty)',

  // --- ошибки инструментов ---
  'err.nopath': 'No path given',
  'err.notfound': (p) => `File not found: ${p}`,
  'err.isdir': 'This is a folder, not a file. Use LS.',
  'err.toobig': 'The file is larger than 2 MB. Use Grep or Bash to find the part you need.',
  'err.binary': 'Binary file, it cannot be read as text.',
  'err.needcontent': 'The field "content" is required',
  'err.needstrings': 'The fields old_string and new_string are required',
  'err.same': 'old_string and new_string are identical',
  'err.nomatch': 'old_string was not found in the file. Re-read the file (Read) and copy the fragment exactly, including indentation.',
  'err.multi': (n) => `old_string occurs ${n} times. Add more context to make it unique, or set replace_all=true.`,
  'err.dirnotfound': (p) => `Folder not found: ${p}`,
  'err.isfile': 'This is a file, not a folder.',
  'err.needpattern': 'The field "pattern" is required',
  'err.badregex': (m) => `Invalid regular expression: ${m}`,
  'err.emptycmd': 'Empty command',
  'err.spawn': (m) => `Could not start the command: ${m}`,

  // --- API ---
  'api.err': (status, text, hint) => `API error ${status}: ${text}${hint}`,
  'api.hint.auth': ' — check the API key and your access to the model.',
  'api.hint.404': ' — check the model name.',
  'api.hint.429': ' — rate limit reached, or no funds on the balance.',
  'net.err': (c) => `Could not reach the provider (${c}). Check your internet connection / VPN.`,
  'anthropic.stream': 'Anthropic stream error',
  'gemini.blocked': (r) => `Request blocked: ${r}`,
  'prov.unknown': (p) => `Unknown provider: ${p}`,
  'prov.nokey': 'No API key set. Open /config.',
  'prov.nomodel': 'No model selected. Open /config.',
  'prov.nourl': 'No API address (BASE_URL) set. Open /config.',

  // --- настройки ---
  'cfg.title': 'you need to fill in the settings.',
  'cfg.missing': 'Missing:',
  'cfg.opening': 'Opening the file:',
  'cfg.instr': 'Enter the values after “=”, save the file (Ctrl+S) and return to this window.',
  'cfg.press': 'Press Enter when you have saved the file… ',
  'cfg.open': 'Opening',
  'cfg.apply': 'Save the file and press Enter to apply… ',
  'cfg.still': 'Still missing:',
  'cfg.applied': '✓ Settings applied:',
  'prov.oneof': (l) => `PROVIDER (one of: ${l})`,

  // --- команды ---
  'model.set': '✓ Model:',
  'now': 'Now:',
  'model.for': (p, l) => `For ${p}: ${l}`,
  'model.change': 'Change: /model model-name',
  'prov.set': '✓ Provider:',
  'prov.missing': (m) => `Missing: ${m} — open /config`,
  'prov.mismatch': (m, l) => `The model “${m}” may not fit. Available: ${l}. Change: /model name`,
  'prov.avail': (l) => `Available: ${l}`,
  'prov.change': 'Change: /provider name',
  'cmd.unknown': (c) => `Unknown command ${c}.`,
  'cmd.unknownHint': '/help — list of commands',
  'ctrlc': 'Press Ctrl+C again to exit',
  'bye': 'See you!',

  // --- язык ---
  'lang.title': 'Select language / Выберите язык:',
  'lang.hint': '↑/↓ + Enter, or press 1 / 2',
  'lang.names': { en: 'English (default)', ru: 'Русский' },
  'lang.short': { en: 'English', ru: 'Русский' },
  'lang.set': (n) => `✓ Language: ${n}`,

  // --- запуск ---
  'cli.help': (v, f) => `OneSun Code v${v}\n\nUsage:\n  onesun            start in the current folder\n  onesun "task"     start and run the task right away\n  onesun --config   open config.txt\n  onesun --version  show the version\n\nSettings: ${f}`,
  'cli.opened': (f) => `Opened file: ${f}`,
  'cli.notty': 'OneSun Code needs an interactive terminal (PowerShell, Windows Terminal, cmd).',
  'cli.fatal': 'Fatal error: ',
};

const RU = {
  'welcome': 'Добро пожаловать в OneSun Code!',
  'welcome.hint': '/help — команды · /config — ключ и модель · Esc — прервать · Shift+Tab — режим',
  'box.hint': '/help — команды · /config — ключ и модель',
  'box.folder': 'папка:',
  'box.model': 'модель:',
  'box.tips': 'Советы: Esc — прервать · Shift+Tab — режим разрешений · «\\» в конце строки — перенос',

  'mode.ask': 'спрашивать разрешения',
  'mode.edits': 'правки без вопросов',
  'mode.yolo': 'всё без вопросов (!)',

  'help.rows': [
    ['/help', 'эта справка'],
    ['/config', 'открыть config.txt (ключ, модель, провайдер)'],
    ['/model [имя]', 'показать или сменить модель'],
    ['/provider [имя]', 'показать или сменить провайдера'],
    ['/lang', 'сменить язык'],
    ['/mode', 'сменить режим разрешений (или Shift+Tab)'],
    ['/clear', 'очистить диалог и экран'],
    ['/cwd', 'показать рабочую папку'],
    ['/init', 'агент создаст ONESUN.md для этого проекта'],
    ['/commit', 'агент напишет сообщение коммита и закоммитит изменения'],
    ['/test', 'агент найдёт и запустит тесты проекта'],
    ['/desktop <задача>', 'агент работает на компьютере (открыть программу, ввести текст, нажать)'],
    ['/undo', 'отменить последнее изменение файла, сделанное агентом'],
    ['/copy', 'скопировать последний ответ в буфер обмена'],
    ['/open <программа>', 'сразу открыть программу, например /open калькулятор (Windows)'],
    ['Ctrl+G', 'голос: нажми, скажи, нажми Enter — отправится (Windows; Termux с Termux:API)'],
    ['/new <имя>', 'создать проект в папке projects и работать в нём'],
    ['/projects', 'показать проекты в папке projects'],
    ['/exit', 'выйти (или Ctrl+C дважды)'],
  ],
  'perm.desktop': 'Управлять компьютером (открыть / ввести / нажать)?',
  'desk.preview': (a, x) => `Компьютер, ${a}: ${x}`,
  'desk.fail': (m) => `Компьютер: ${m}`,
  'desk.unsupported': (a) => `«${a}» здесь работает только на Windows`,
  'undo.none': 'Нечего отменять',
  'undo.done': (p) => `✓ Отменено: ${p}`,
  'copy.none': 'Пока нет ответа для копирования',
  'copy.done': '✓ Скопировано в буфер обмена',
  'copy.fail': 'Не удалось скопировать: не найдена программа для буфера обмена',
  'desk.usage': 'Пример: /desktop открой Блокнот и напиши привет',
  'open.usage': 'Пример: /open калькулятор или /open блокнот',
  'voice.on': 'Слушаю… Enter — отправить, Ctrl+G — остановить и вставить текст в строку',
  'voice.listening': 'Слушаю… говори',
  'voice.empty': 'Ничего не распознано',
  'voice.none': 'Голосовой ввод работает на Windows и в Termux (с Termux:API)',
  'free.note': 'Папка проекта: агент здесь правит файлы и запускает команды без вопросов.',
  'new.usage': 'Пример: /new мой-проект (буквы, цифры, пробелы, - и _)',
  'new.done': (n) => `✓ Проект создан: projects/${n}`,
  'projects.none': 'Проектов пока нет. Создай: /new имя',
  'help.modes': 'Режимы: «спрашивать разрешения» — перед правкой файлов и командами;\n  «правки без вопросов» — файлы правятся сами, команды спрашивают;\n  «всё без вопросов» — агент делает всё сам, будь осторожен.',
  'help.md': 'Файл ONESUN.md в папке проекта читается как инструкции для агента.',

  'spin.hint': (s) => `esc — прервать · ${s} с`,
  'spin.running': 'Выполняю',
  'spin.phrases': [
    'Думаю', 'Колдую', 'Соображаю', 'Кодю', 'Грею мозги', 'Ловлю лучи', 'Мозгую', 'Прикидываю',
    'Подбираю слова', 'Колдую над кодом', 'Солнечничаю', 'Складываю пазл', 'Варю идею', 'Грею процессор',
  ],

  'perm.yes': 'Да',
  'perm.always': (first) => `Да, и больше не спрашивать про «${first}» в этой сессии`,
  'perm.always.edit': 'Да, и больше не спрашивать про правки файлов в этой сессии',
  'perm.always.default': 'Да, и больше не спрашивать в этой сессии',
  'perm.no': 'Нет, сделай по-другому (Esc)',
  'perm.read': 'Прочитать файл вне рабочей папки?',
  'perm.ls': 'Посмотреть папку вне рабочей папки?',
  'perm.glob': 'Искать файлы вне рабочей папки?',
  'perm.grep': 'Искать в файлах вне рабочей папки?',
  'perm.write': 'Создать или перезаписать файл?',
  'perm.edit': 'Внести изменения в файл?',
  'perm.bash': 'Выполнить команду?',
  'perm.other': 'Выполнить действие?',
  'perm.in': ' в ',
  'perm.cmd': 'команды',
  'more.lines': (n) => `… ещё ${n} строк`,
  'more.n': (n) => `… ещё ${n}`,

  'interrupted': 'Прервано',
  'agent.unknownTool': (n) => `Неизвестный инструмент: ${n}`,
  'agent.denied': 'Отклонено',
  'agent.empty': 'Модель вернула пустой ответ. Попробуй ещё раз или другую модель.',
  'agent.limit': (n) => `Достигнут лимит шагов (${n}). Напиши «продолжай», чтобы идти дальше.`,

  'read.preview': (n) => `Прочитано строк: ${n}`,
  'write.created': (p, n) => `Создан ${p} (${n} строк)`,
  'write.updated': (p, n) => `Обновлён ${p} (${n} строк)`,
  'edit.preview': (p) => `Изменено: ${p}`,
  'ls.preview': (n) => `Элементов: ${n}`,
  'glob.preview': (n) => `Найдено файлов: ${n}`,
  'grep.preview': (n, more) => `Совпадений: ${n}${more ? '+' : ''}`,
  'bash.noout': '(нет вывода)',
  'bash.timeout': (s) => `[команда остановлена по таймауту ${s} с]`,
  'bash.aborted': '[прервано пользователем]',
  'bash.exit': (c) => `[код выхода ${c}]`,

  'err.nopath': 'Не указан путь',
  'err.notfound': (p) => `Файл не найден: ${p}`,
  'err.isdir': 'Это папка, а не файл. Используй LS.',
  'err.toobig': 'Файл больше 2 МБ. Используй Grep или Bash, чтобы найти нужное место.',
  'err.binary': 'Бинарный файл, прочитать как текст нельзя.',
  'err.needcontent': 'Нужно поле content',
  'err.needstrings': 'Нужны поля old_string и new_string',
  'err.same': 'old_string и new_string одинаковы',
  'err.nomatch': 'old_string не найден в файле. Перечитай файл (Read) и скопируй фрагмент точно, с отступами.',
  'err.multi': (n) => `old_string встречается ${n} раз. Добавь контекста, чтобы фрагмент был уникальным, или укажи replace_all=true.`,
  'err.dirnotfound': (p) => `Папка не найдена: ${p}`,
  'err.isfile': 'Это файл, а не папка.',
  'err.needpattern': 'Нужен pattern',
  'err.badregex': (m) => `Неверное регулярное выражение: ${m}`,
  'err.emptycmd': 'Пустая команда',
  'err.spawn': (m) => `Не удалось запустить команду: ${m}`,

  'api.err': (status, text, hint) => `Ошибка API ${status}: ${text}${hint}`,
  'api.hint.auth': ' — проверь API-ключ и доступ к модели.',
  'api.hint.404': ' — проверь название модели.',
  'api.hint.429': ' — лимит запросов или нет денег на балансе.',
  'net.err': (c) => `Не удалось связаться с провайдером (${c}). Проверь интернет/VPN.`,
  'anthropic.stream': 'Ошибка потока Anthropic',
  'gemini.blocked': (r) => `Запрос заблокирован: ${r}`,
  'prov.unknown': (p) => `Неизвестный провайдер: ${p}`,
  'prov.nokey': 'Не задан API-ключ. Открой /config.',
  'prov.nomodel': 'Не выбрана модель. Открой /config.',
  'prov.nourl': 'Не задан адрес API (BASE_URL). Открой /config.',

  'cfg.title': 'нужно заполнить настройки.',
  'cfg.missing': 'Не хватает:',
  'cfg.opening': 'Открываю файл:',
  'cfg.instr': 'Впиши значения после «=», сохрани файл (Ctrl+S) и вернись в это окно.',
  'cfg.press': 'Нажми Enter, когда сохранишь файл… ',
  'cfg.open': 'Открываю',
  'cfg.apply': 'Сохрани файл и нажми Enter, чтобы применить… ',
  'cfg.still': 'Всё ещё не хватает:',
  'cfg.applied': '✓ Настройки применены:',
  'prov.oneof': (l) => `PROVIDER (одно из: ${l})`,

  'model.set': '✓ Модель:',
  'now': 'Сейчас:',
  'model.for': (p, l) => `Для ${p}: ${l}`,
  'model.change': 'Сменить: /model имя-модели',
  'prov.set': '✓ Провайдер:',
  'prov.missing': (m) => `Не хватает: ${m} — открой /config`,
  'prov.mismatch': (m, l) => `Модель «${m}» может не подойти. Доступно: ${l}. Сменить: /model имя`,
  'prov.avail': (l) => `Доступно: ${l}`,
  'prov.change': 'Сменить: /provider имя',
  'cmd.unknown': (c) => `Неизвестная команда ${c}.`,
  'cmd.unknownHint': '/help — список команд',
  'ctrlc': 'Нажми Ctrl+C ещё раз, чтобы выйти',
  'bye': 'До встречи!',

  'lang.set': (n) => `✓ Язык: ${n}`,

  'cli.help': (v, f) => `OneSun Code v${v}\n\nИспользование:\n  onesun            запустить в текущей папке\n  onesun "задача"   запустить и сразу выполнить задачу\n  onesun --config   открыть config.txt\n  onesun --version  версия\n\nНастройки: ${f}`,
  'cli.opened': (f) => `Открыт файл: ${f}`,
  'cli.notty': 'OneSun Code нужен интерактивный терминал (PowerShell, Windows Terminal, cmd).',
  'cli.fatal': 'Критическая ошибка: ',
};

const DICT = { en: EN, ru: RU };
let lang = 'en';

function setLang(l) { lang = DICT[l] ? l : 'en'; }
function getLang() { return lang; }
function pick(l, key) {
  const d = DICT[l];
  return d && key in d ? d[key] : EN[key];
}
function render(v, key, args) {
  if (v === undefined) return key;
  return typeof v === 'function' ? v(...args) : v;
}
function t(key, ...args) { return render(pick(lang, key), key, args); }
function tEn(key, ...args) { return render(EN[key], key, args); }
function tErr(key, ...args) {
  const e = new Error(t(key, ...args));
  e.en = tEn(key, ...args);
  return e;
}

module.exports = { LANGS, setLang, getLang, t, tEn, tErr };
