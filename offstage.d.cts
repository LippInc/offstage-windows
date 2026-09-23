// Types for offstage.cjs (offstage-windows; when copying the file into a TypeScript project, copy this one beside it).

/** True where offstage hides windows: on Windows, unless OFFSTAGE is 0, false, off or no. */
export declare function enabled(env?: Record<string, string | undefined>): boolean

/**
 * The helper's path, compiled on first use and cached. Windows only. Throws when it cannot be compiled or its first run
 * fails, and again on every later call in the same process.
 */
export declare function helper(): string

/**
 * Options for Playwright's `_electron.launch()` that start the app offstage (the helper stands in as the executable,
 * so the result also carries `executablePath` and `env`). Returns the options unchanged when offstage is off or cannot
 * run.
 */
export declare function electronLaunchOptions<T extends object = {}>(
  options?: T & { executablePath?: string; cwd?: string; env?: { [key: string]: string | undefined } },
): T & { executablePath?: string; env?: { [key: string]: string } }

/**
 * `[command, args]` for child_process.spawn or execFile that run `file args` offstage; unchanged when offstage is off.
 * What the program leaves running when it exits is stopped after a moment, unless `waitForAll` (wait for the whole tree:
 * an app that restarts itself or hands over) or `keepOrphans` (leave it). `timeout` is in whole seconds. `desktop` runs
 * it on an app's desktop (the app's OFFSTAGE_DESKTOP) instead of a new one, for a helper that works with the app's
 * windows by handle: from any other desktop the handle reads as an empty, hidden window.
 * Throws a TypeError when `desktop` is not a desktop's name (letters, digits, `_`, `.`, `-`). A `.cmd` or `.bat` is
 * returned unchanged, with a warning (run those through the CLI). When the helper cannot run, the program starts as is,
 * without `timeout` or `waitForAll`, and a warning says so.
 */
export declare function spawnArgs(
  file: string,
  args?: readonly string[],
  options?: { waitForAll?: boolean; keepOrphans?: boolean; timeout?: number; desktop?: string },
): [string, string[]]
