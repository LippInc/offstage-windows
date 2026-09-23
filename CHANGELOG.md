# Changelog

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
