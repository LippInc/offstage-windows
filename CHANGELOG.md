# Changelog

## 0.1.1 (unreleased)

Fixes from a pre-launch review.

- `electronLaunchOptions`: the app no longer outlives a Playwright worker or runner that is killed outright. Playwright starts the stand-in through cmd.exe on Windows, which puts it outside the job Node uses to end its children, so such an app kept running on a desktop no one could see. In stand-in mode the helper now ends the run when the process that started it ends.
- The CLI's escaping for cmd.exe no longer mangles an argument with two or more backslashes before a quote or at its end. Before, the escaping taken from cross-spawn shifted every later argument when it ran through an npm `.bin` shim.
- When the helper cannot run, offstage now says that `--timeout` and `--wait-all` (`timeout` and `waitForAll` in `spawnArgs`) are not applied, instead of dropping them silently.
- A wrapped run sets `PLAYWRIGHT_HTML_OPEN=never` (and the older `PW_TEST_HTML_REPORT_OPEN`) unless you set either, so Playwright does not open its HTML report in a browser on the hidden desktop.
- The helper always says when it cannot put the command in a job object. Before, it said so only with `--verbose`.
- A first build whose rename is held up for a moment, for example by an antivirus scan, is retried before offstage gives up on the helper.
- `spawnArgs` refuses a `.cmd` or `.bat` with a message that says it returns the file unchanged.
- Types: the README's own `electron.launch(electronLaunchOptions({ args: ['.'] }))` now compiles in TypeScript. 0.1.0's types rejected `args` and clashed with Playwright's `env` type. The result is typed with `executablePath` and `env`.
- README:
  - it no longer says nothing like this existed on Windows (hidden-desktop launchers such as RunHidden did), and says what offstage-windows adds;
  - the security section names the techniques (hidden desktops, compiling on the machine) and says a security team can see the runs;
  - the Quick start shows the install step for the `package.json` form, with PowerShell and cmd syntax for `OFFSTAGE=0`;
  - "Why not" adds Sysinternals Desktops and Windows 11's agent workspace;
  - the side-by-side table says which app each row is from.
- Self-test: 27 checks. New ones cover timeouts from both sides, the CLI's flags through an `.exe` and a `.cmd`, spaces in paths, the cache folder and its reuse, one report per parallel run, and a killed launcher. CI also runs the pass-through check on macOS.

## 0.1.0 (2026-09-23)

First public release.

- Runs a command, a Playwright Electron launch (`electronLaunchOptions`) or a spawned app (`spawnArgs`) on a hidden Windows desktop; passes everything through unchanged elsewhere or with `OFFSTAGE=0`.
- A job object ends the whole process tree with the run; `--wait-all` for apps that restart or hand over, `--keep-orphans` to leave what the command started.
- The helper compiles itself with Windows' own C# compiler on first use, is test-run before it is trusted, and falls back to visible windows if it cannot run.
- Each app launch (`electronLaunchOptions`, `spawnArgs`) gets a desktop of its own, also inside a run wrapped by the CLI; a plain nested run keeps its parent's desktop, and an explicit `--desktop` always wins.
- A process left running with `--keep-orphans` keeps the hidden desktop alive for itself (before, one still starting up when the run ended could die before its first line).
- The helper is cached in `%LOCALAPPDATA%\offstage` (a folder only the user can write to, also for services), not in a shared temp folder.
- A report that cannot be written no longer changes the run's exit code; the CLI finds App Execution Aliases and quoted PATH entries, and forwards SIGTERM and SIGHUP on macOS and Linux.
- Self-test: 22 checks; the instruments they rely on each show first that they can fail.
