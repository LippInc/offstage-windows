# offstage-windows

[![ci](https://github.com/LippInc/offstage-windows/actions/workflows/ci.yml/badge.svg)](https://github.com/LippInc/offstage-windows/actions/workflows/ci.yml)

**Run your Electron and Playwright GUI tests on Windows without them ever touching your screen.**

Automated runs of a desktop app open real windows: end-to-end tests, screenshot scripts, smoke tests of the packaged app. On Windows those windows pop up on your screen and take your keyboard focus while you work. When a coding agent runs your tests, that happens all day. On Linux you would reach for `xvfb-run`. Windows has had the pieces for decades: a program can create a hidden desktop (`CreateDesktop`) and start processes on it, and small launchers such as [RunHidden](https://github.com/meshko/RunHidden) (2013) do that for one program.

offstage-windows builds a test tool from those pieces. It runs the whole session on a hidden Windows desktop: the test runner and everything it starts, with their output and exit code kept, and what they leave running cleaned up. The app renders as it does on screen (GPU, animations, focus, screenshots; timers too, with Chromium's anti-throttling switches below); you just never see it. Because each app launch can get a desktop and a focus of its own, GUI test runs can also go side by side on one machine without fighting over the keyboard.

- No changes to your app, and no VM, container or second login.
- One file with no dependencies: it builds its small helper with the C# compiler that ships with Windows.
- On macOS and Linux it passes every command through unchanged, so the same scripts run everywhere.

## Quick start

Wrap the command that runs your tests:

```sh
npx offstage-windows npx playwright test
```

or install it (`npm i -D offstage-windows`) and put it in `package.json`:

```json
"scripts": {
  "test:e2e": "offstage-windows playwright test"
}
```

Everything the command starts (the test runner, Electron, its helper processes) opens its windows on one hidden desktop. The run's output and exit code are the command's own. Ctrl+C reaches the command as before, and whatever is still running 10 s later is stopped. When the command exits, anything it left running is stopped.

Playwright's HTML report does not open by itself in a wrapped run (offstage-windows sets `PLAYWRIGHT_HTML_OPEN=never` unless you set it): a browser started from the hidden desktop would open where you cannot see it. Open the report afterwards with `npx playwright show-report`.

One desktop for the whole run is fine with one worker. For Playwright workers side by side, wire the launch (below), which gives each app its own desktop, wrapped or not.

Don't wrap interactive runs (`--ui`, `--debug`, `page.pause()`, codegen): their windows would open where you cannot see them. Run those unwrapped, or with `OFFSTAGE=0`.

To watch a run on screen again, set `OFFSTAGE=0` (PowerShell: `$env:OFFSTAGE = '0'`; cmd: `set OFFSTAGE=0`).

## Wire it into your launch code

Wrapping a command is the quickest way to start. Wiring the places that launch your app covers every way of running the tests: an IDE's test button, a single spec, a script. It also gives each app its own desktop, which is what lets Playwright workers run side by side.

```sh
npm i -D offstage-windows
```

**Playwright's Electron launch:**

```js
const { test, _electron: electron } = require('@playwright/test')
const { electronLaunchOptions } = require('offstage-windows')

test('the app starts', async () => {
  const app = await electron.launch(electronLaunchOptions({ args: ['.'] }))
  const page = await app.firstWindow()
  // ... your test ...
  await app.close()
})
```

The helper stands in as the executable and starts Electron with Playwright's own loader in front, exactly as Playwright does when it resolves Electron itself. Each launch gets a desktop of its own, also inside a wrapped run. This relies on where Playwright keeps that loader (`playwright-core/lib/server/electron/loader.js`, the same from 1.30 to 1.63); if a release moves it, offstage-windows says so and the app launches visibly.

**Scripts that spawn Electron or a packaged app** (CDP screenshot scripts, smoke tests):

```js
const { spawn } = require('node:child_process')
const { spawnArgs } = require('offstage-windows')

const app = spawn(...spawnArgs(electronPath, ['.', '--remote-debugging-port=9222']), {
  stdio: 'inherit',
  windowsHide: true, // the helper is a console program: no console window when the caller has none (a GUI tool)
})
```

The spawned process stands for the app: the same exit code, and `kill()` stops the whole tree. The app gets a desktop of its own. The options:

- `{ waitForAll: true }`: for an app that restarts itself (`app.relaunch()`) or hands over to another process. Otherwise the successor is stopped 2 s after the first process exits.
- `{ keepOrphans: true }`: leaves what it started running (a timeout still stops everything).
- `{ timeout: <seconds> }`: stops the run after that long.

These options only apply offstage: with `OFFSTAGE=0`, off Windows, or when the helper cannot run, the app starts as is.

Only stdin, stdout and stderr reach the app: no Node IPC channel, no `--remote-debugging-pipe`. `spawnArgs` takes programs, not `.cmd` or `.bat` files; use the CLI for those.

**Helpers that touch the app's windows by handle** (a `WM_NCHITTEST` hit test, UI Automation, window rectangles) must run on the app's desktop. From any other desktop a handle reads as an empty, hidden window. Ask the app where it runs, then start the helper there:

```js
const { execFileSync } = require('node:child_process')
const { spawnArgs } = require('offstage-windows')

// inside an async test, with `app` from electron.launch():
const desktop = await app.evaluate(() => process.env.OFFSTAGE_DESKTOP ?? '')
const psArgs = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript] // your helper
const [file, args] = desktop ? spawnArgs('powershell.exe', psArgs, { desktop }) : ['powershell.exe', psArgs]
const answer = execFileSync(file, args, { encoding: 'utf8' })
```

**No dependency at all:** `offstage.cjs` (with `offstage.d.cts` for TypeScript) is the whole package, and a copy works the same in your repo: `node scripts/offstage.cjs <command>`.

Keep Chromium's anti-throttling switches in automated launches. Otherwise a window Chromium thinks is covered pauses its animations and timers:

```
--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding
--disable-backgrounding-occluded-windows --disable-background-timer-throttling
```

## Run tests side by side

Test runs no longer fight over the screen or the keyboard, so work that had to run one at a time can run together. Measured on two real Electron apps, A and B (Electron 44, Playwright 1.63, a 16-core laptop). The e2e rows ran in alternating pairs so that both variants saw the same load; the last two compare with timings of the old one-at-a-time way:

| What                                                                             | One at a time | Side by side                |
| -------------------------------------------------------------------------------- | ------------- | --------------------------- |
| App A: e2e suite, 6 spec files                                                   | 62 s          | 26 s (3 Playwright workers) |
| App B: e2e suite, 2 spec files                                                   | 99-132 s      | 50-79 s (2 workers)         |
| App B: build once, then e2e + screenshot check + packaged smoke at the same time | ~6 min        | 2.8 min                     |
| App B: 383 mutation tests, in 3 git worktrees                                    | ~73 min       | 26.6 min                    |

What makes it safe:

- **Playwright workers:** wire `electronLaunchOptions`, so each app gets its own desktop and focus. Give each spec file its own profile (`mkdtemp`), its own fake servers (port 0 or random pipe names), and a single-instance lock that follows the profile (Electron's does, when `userData` is set before `requestSingleInstanceLock`). No two files should use the real clipboard. Then raise `workers`.
- **Scripts side by side:** give each one its own CDP port.
- **Several copies of a repo** (mutation testing and similar): one git worktree per copy. A mutation counts as caught when a test fails for any reason, so a busy machine can fake a catch. Mix no-op mutations into the queue and require every one of them to pass.

The runs still share the processor and graphics card with whatever else the machine is doing. The numbers above come from two private apps, so this repo cannot reproduce them; `pnpm bench` measures what the helper itself adds to a launch.

## How it works

Windows lets a program create extra desktops in the same session (`CreateDesktop`). Only one is ever shown. A process started on another desktop opens all its windows there, and so do the processes it starts. Chromium renders there normally, GPU included.

`offstage.cjs` carries a small helper's C# source. On first use it compiles it with the .NET Framework 4 compiler that comes with Windows (`csc.exe`) into `%LOCALAPPDATA%\offstage\`, cached by the source's hash. It then runs the new helper once before trusting it (about 0.6 s the first time). The helper:

- starts the command on a new hidden desktop, with the caller's standard handles, environment and working directory;
- puts everything the command starts in a job object, so nothing outlives the run: what is left running when it exits is stopped (after up to 2 s, and named on stderr), and killing the helper kills the whole tree;
- exits with the command's exit code.

It adds about 50-60 ms to each launch.

If the helper cannot be built, or its first test run fails (no compiler, an application-control policy, a security product), offstage says so once and runs everything with visible windows, as before, and without `--timeout` or `--wait-all`, which need the helper (it says that too). If a security product starts blocking a helper that already ran, launches fail instead: `OFFSTAGE=0` runs them visibly until it is allowed again.

## Options and environment

```
offstage-windows [--timeout <seconds>] [--wait-all] [--keep-orphans] [--verbose] [--] <command> [args...]
offstage-windows --check
```

- `--check` compiles the helper and runs a test command offstage.
- The command is found the way cmd.exe finds it: the current folder, then PATH (inside an npm script or `npx`, PATH includes `node_modules/.bin`). `.cmd` and `.bat` files, npm's shims included, run through cmd.exe with their arguments escaped as it needs.
- A command found neither in the current folder, on PATH, nor among cmd.exe's own commands exits 127.
- The options only apply offstage: with `OFFSTAGE=0` or off Windows the command runs as is.

| Variable                               | Effect                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OFFSTAGE=0` (or `false`, `off`, `no`) | Turns it off: windows show, every function passes its input through                                                                                                                                     |
| `OFFSTAGE_VERBOSE=1`                   | Prints what each run opened offstage and what it left running                                                                                                                                           |
| `OFFSTAGE_REPORT_DIR=<dir>`            | Writes one JSON report per run: desktop, exit code, windows opened, leftovers                                                                                                                           |
| `OFFSTAGE_CACHE=<dir>`                 | Where the compiled helper is kept (default `%LOCALAPPDATA%\offstage`; a folder only you can write to)                                                                                                   |
| `OFFSTAGE_DESKTOP`                     | Set for the program: the name of its desktop. A command started from inside a run with the CLI stays on that desktop; `spawnArgs` and `electronLaunchOptions` make a new one unless `desktop` names one |
| `PLAYWRIGHT_HTML_OPEN`                 | Set to `never` for a wrapped command unless you set it (or `PW_TEST_HTML_REPORT_OPEN`): a report opened from the hidden desktop could not be seen                                                       |

Exit codes of its own: 124 timed out (it then lists the windows open on its desktop, which is how a hidden native dialog shows up; an app launched with a desktop of its own is listed by its own run, for example in its `OFFSTAGE_REPORT_DIR` report), 125 offstage failed, 126 could not start, 127 not found.

## What it cannot hide

- **Windows other processes open for your app:** Windows Terminal taking over a new console (start console programs with `windowsHide`), Explorer (`shell.openPath`, `showItemInFolder`), the default browser (`shell.openExternal`), toast notifications, UAC prompts. Stub these in tests.
- **The clipboard** is shared with your desktop: a test that copies overwrites what you copied.
- **A native dialog** (message box, file picker) waits unseen until the test times out. `OFFSTAGE=0` shows it.
- **Real OS input** (`SendInput`, robotjs) and the mouse cursor belong to your desktop, so they do not reach the app. Playwright's and CDP's input do.
- **Maximized frameless windows are 1 CSS px taller** when your taskbar auto-hides: Chromium keeps a strip for a taskbar it cannot find from a hidden desktop. Screenshots at a fixed window size were pixel-identical to on-screen runs.
- **Interactive Playwright modes** (UI mode, `--debug`, the Inspector, codegen) open offstage too when the command is wrapped. Run them unwrapped, or with `OFFSTAGE=0`.
- **The window keeps its focus** (`isFocused()`, `document.hasFocus()`) even while you work in another app, because it is the active window of its own desktop. Focus-dependent tests get steadier, not flakier.

## Security software

Hidden desktops are also a malware technique: remote-access trojans use them for hidden VNC sessions (MITRE ATT&CK [T1564.003](https://attack.mitre.org/techniques/T1564/003/)), and compiling code on the machine with `csc.exe` is another technique defenders watch for ([T1027.004](https://attack.mitre.org/techniques/T1027/004/)). offstage-windows does both, in the open, to keep test windows off your screen. Expect some endpoint-protection products to flag or block it. On a managed machine your security team can see it too: Microsoft Defender for Endpoint records the desktop each process runs on.

The helper is compiled on your machine, on first use, from the C# source inside `offstage.cjs`, which you can read. It makes no network connections, needs no administrator rights, and stays running only while its command runs. If Windows or a security product blocks it when it is built, offstage-windows prints why and your command runs with visible windows.

The compiled helper is found again by its file name, so keep its folder one that only you can write to. The default, `%LOCALAPPDATA%\offstage`, is, also for services running as SYSTEM, which a shared temp folder is not. Set `OFFSTAGE_CACHE` only to such a folder.

## Measured

Tested on Windows 11 (build 26200), Node 24, Electron 44.3 and Playwright 1.63. The self-test also passes on every push on GitHub's `windows-latest` runner (Windows Server 2025), where the helper adds about 40 ms per launch. Windows 10 uses the same APIs but is untested.

- **Two Electron apps in daily development**, each with 31 e2e tests and 38 app launches per run: all passed offstage, and a watcher on the visible desktop saw none of their windows. Screenshot checks of 887 and 155 steps also passed, as did packaged-app smoke tests.
- **A probe app offstage:** GPU compositing on, animations at full frame rate, timers unthrottled, `capturePage` and CDP screenshots with the page's real pixels, `document.hasFocus()` true.
- **A 60-second stress probe**, run offstage and on screen at the same time under load: the same number of animation frames (5,444 each), no gap over 250 ms in either, and 150 ms animations finishing alike.

## Why not...

- **`show: false` in test mode:** it changes your app, a hidden window does not take focus the way a real one does, and some things break or throttle. offstage-windows needs no change to the app.
- **Moving windows off-screen:** they still take focus and flash in the taskbar.
- **Windows virtual desktops (Win+Tab):** new windows open on the desktop you are looking at.
- **Sysinternals Desktops:** real separate desktops, but you switch between them by hand; it does not start a command on one.
- **A VM, Windows Sandbox or a second login:** heavy to set up. Sandbox needs Windows Pro or higher and currently runs one instance at a time.
- **Windows 11's agent workspace:** an experimental, off-by-default session for AI agents such as Copilot Actions, not a way to run your own test command.
- **On Linux:** `xvfb-run` (or `xvfb-maybe`) already does this, and offstage-windows passes commands through there.
- **On macOS:** see [viraatdas/offstage](https://github.com/viraatdas/offstage), which runs an agent's GUI work in a second macOS account, and [thesepehrm/offstage](https://github.com/thesepehrm/offstage), which runs background QA of macOS apps. They are independent projects with the same idea on Mac. This one is unrelated to the npm package `offstage` (an HTTP mocking library).

## Development

```sh
pnpm install
pnpm check      # compile the helper and run a command offstage
pnpm selftest   # 27 checks
pnpm bench      # what the helper adds to one launch
```

The instruments the checks rely on each show first that they can fail:

- A watcher on the visible desktop must see an off-screen probe window before its "nothing appeared" counts.
- A naive command line must mangle tricky arguments before "passed unchanged" counts.
- The same window handle must answer beside the app and fail from the visible desktop.
- A helper that cannot run must fall back to visible windows.
- A plain Playwright run must not land offstage unless it is wrapped.

Every window the self-test opens is offstage, or far off-screen with no taskbar button.

`node test/watch.mjs "<command>"` runs any command and lists every window that appeared on the visible desktop meanwhile.

## License

MIT
