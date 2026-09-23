// offstage self-test (Windows): `node test/selftest.mjs` from the repo, outside offstage, after `pnpm install`.
// Every window it opens is either offstage or far off-screen with no taskbar button, so it disturbs no one.
// Each check prints PASS or FAIL; the exit code is the number of failures. Controls come first: the watcher must see a
// window shown on the visible desktop, and a naive command line must mangle the tricky arguments, before a clean result
// from either instrument counts.
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { startWatcher, tools } from './tools.mjs'

const require = createRequire(import.meta.url)
const root = join(import.meta.dirname, '..')
const offstageModule = join(root, 'offstage.cjs')
const offstage = require(offstageModule)
const node = process.execPath
const comspec = process.env.ComSpec || 'cmd.exe'
const probeApp = join(import.meta.dirname, 'electron-probe')
const SWITCHES = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
]

if (process.platform !== 'win32') {
  console.log('offstage self-test: Windows only')
  process.exit(0)
}
if (!offstage.enabled()) {
  console.log('offstage self-test: OFFSTAGE turns offstage off here; unset it first')
  process.exit(1)
}

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}
async function check(name, body) {
  try {
    const { ok, detail } = await body()
    record(name, ok, detail)
  } catch (error) {
    record(name, false, error.stack ?? String(error))
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const lastJson = (text) =>
  JSON.parse(
    text
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{'))
      .at(-1),
  )
const near = (a, b, tolerance) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance)
// This process's environment with some variables replaced. Windows reads names without regard to case, so a copy that
// kept COMSPEC beside a new ComSpec would carry both, and the child might see the old one.
const envWith = (overrides) => {
  const replaced = new Set(Object.keys(overrides).map((name) => name.toUpperCase()))
  const kept = Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase()))
  return { ...Object.fromEntries(kept), ...overrides }
}
const helper = offstage.helper()
const { probeWindow } = tools()

await check('control: the watcher sees a window shown on the visible desktop', async () => {
  const watcher = await startWatcher()
  const run = spawnSync(probeWindow, ['800'], { encoding: 'utf8' })
  const shown = await watcher.stop()
  const probe = lastJson(run.stdout)
  const seen = shown.filter((entry) => entry.process === 'probe-window.exe')
  return {
    ok: probe.desktop === 'Default' && seen.length > 0,
    detail: `probe on ${probe.desktop}; watcher saw ${seen.length}`,
  }
})

await check('a window opened offstage stays offstage (and offstage counted it)', async () => {
  const reports = mkdtempSync(join(tmpdir(), 'offstage-reports-'))
  const watcher = await startWatcher()
  const run = spawnSync(helper, ['--', probeWindow, '800'], {
    encoding: 'utf8',
    env: { ...process.env, OFFSTAGE_REPORT_DIR: reports },
  })
  const shown = await watcher.stop()
  const probe = lastJson(run.stdout)
  const report = JSON.parse(readFileSync(join(reports, readdirSync(reports)[0]), 'utf8'))
  rmSync(reports, { recursive: true, force: true })
  const leaked = shown.filter((entry) => entry.process === 'probe-window.exe')
  const counted = report.windows.filter((window) => window.process === 'probe-window.exe')
  return {
    ok:
      run.status === 0 &&
      probe.desktop.startsWith('offstage-') &&
      probe.visible &&
      leaked.length === 0 &&
      counted.length === 1,
    detail: `probe on ${probe.desktop} (visible there: ${probe.visible}); on screen ${leaked.length}; offstage counted ${counted.length}`,
  }
})

await check(
  'exit codes pass through; 127 for a missing program (helper and wrapper), 124 after --timeout, and not before it',
  async () => {
    const seven = spawnSync(helper, ['--', comspec, '/d', '/c', 'exit 7']).status
    const zero = spawnSync(helper, ['--', comspec, '/d', '/c', 'exit 0']).status
    const missing = spawnSync(helper, ['--', 'no-such-program-offstage.exe'], { encoding: 'utf8' }).status
    const wrapperMissing = spawnSync(node, [offstageModule, 'no-such-command-offstage', 'x'], {
      encoding: 'utf8',
    }).status
    // Both bounds: a timeout that fires early (a unit slip) is as wrong as one that fires late.
    const started = Date.now()
    const timedOut = spawnSync(helper, ['--timeout', '2', '--', node, '-e', 'setTimeout(() => {}, 30000)'], {
      encoding: 'utf8',
    })
    const elapsed = Date.now() - started
    const tooLong = spawnSync(helper, ['--timeout', '3000000', '--', comspec, '/d', '/c', 'exit 0']).status
    return {
      ok:
        seven === 7 &&
        zero === 0 &&
        missing === 127 &&
        wrapperMissing === 127 &&
        timedOut.status === 124 &&
        elapsed >= 1900 &&
        elapsed < 6000 &&
        tooLong === 125,
      detail: `exit 7 -> ${seven}, exit 0 -> ${zero}, missing -> ${missing}, wrapper missing -> ${wrapperMissing}, --timeout 2 -> ${timedOut.status} after ${elapsed} ms, --timeout 3000000 -> ${tooLong}`,
    }
  },
)

await check('stdin reaches the command; stdout and stderr stay separate', async () => {
  const run = spawnSync(
    helper,
    ['--', node, '-e', 'process.stdin.pipe(process.stdout); process.stderr.write("to stderr")'],
    {
      encoding: 'utf8',
      input: 'piped in',
    },
  )
  return {
    ok: run.status === 0 && run.stdout === 'piped in' && run.stderr === 'to stderr',
    detail: `stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)}`,
  }
})

await check('the command sees OFFSTAGE_DESKTOP, and offstage inside offstage keeps that desktop', async () => {
  const inner = `const { spawnSync } = require('node:child_process');
    const inner = spawnSync(${JSON.stringify(helper)}, ['--', process.execPath, '-e', 'console.log(process.env.OFFSTAGE_DESKTOP)'], { encoding: 'utf8' });
    console.log(process.env.OFFSTAGE_DESKTOP + ' ' + inner.stdout.trim())`
  const run = spawnSync(helper, ['--', node, '-e', inner], { encoding: 'utf8' })
  const [outer, nested] = run.stdout.trim().split(' ')
  return {
    ok: run.status === 0 && outer.startsWith('offstage-') && outer === nested,
    detail: `outer ${outer}, nested ${nested}`,
  }
})

await check(
  'inside a run, an app launch (spawnArgs, OFFSTAGE_OWN_DESKTOP) gets a desktop of its own, and an explicit --desktop wins',
  async () => {
    const script = `const o = require(${JSON.stringify(offstageModule)}); const { spawnSync } = require('node:child_process');
    const show = 'console.log(process.env.OFFSTAGE_DESKTOP)';
    const run = (file, args, env) => spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
    const plain = run(${JSON.stringify(helper)}, ['--', process.execPath, '-e', show]);
    const own = run(...o.spawnArgs(process.execPath, ['-e', show]));
    const standIn = run(${JSON.stringify(helper)}, ['-e', show], { OFFSTAGE_EXEC: process.execPath, OFFSTAGE_OWN_DESKTOP: '1' });
    const named = run(${JSON.stringify(helper)}, ['--desktop', 'Default', '--', process.execPath, '-e', show]);
    console.log(JSON.stringify({ outer: process.env.OFFSTAGE_DESKTOP, plain, own, standIn, named }))`
    const got = lastJson(spawnSync(helper, ['--', node, '-e', script], { encoding: 'utf8' }).stdout)
    const fresh = (name) => name.startsWith('offstage-') && name !== got.outer
    return {
      ok:
        got.outer.startsWith('offstage-') &&
        got.plain === got.outer &&
        fresh(got.own) &&
        fresh(got.standIn) &&
        got.named === 'Default',
      detail: `run on ${got.outer}: a plain nested helper ran on ${got.plain}, spawnArgs on ${got.own}, a stand-in with OFFSTAGE_OWN_DESKTOP on ${got.standIn}, --desktop Default on ${got.named}`,
    }
  },
)

const LEAVE_ONE_RUNNING = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' });
  child.unref(); console.log(child.pid)`

await check(
  'what the command leaves running is stopped (within the 2 s grace); --keep-orphans leaves it running, and its own code runs',
  async () => {
    const stoppedFrom = Date.now()
    const stopped = spawnSync(helper, ['--', node, '-e', LEAVE_ONE_RUNNING], { encoding: 'utf8' })
    const stoppedMs = Date.now() - stoppedFrom
    const stoppedPid = Number(stopped.stdout.trim())
    // The kept process writes a marker from its own code half a second in. One that died while still starting up (its
    // desktop gone before it attached: 4 of 5 kept processes before the helper handed them the desktop, 2026-09-23) never
    // writes it, and alive() read the moment the helper exits could not tell.
    const marker = join(mkdtempSync(join(tmpdir(), 'offstage-kept-')), 'ran')
    const body = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 500); setTimeout(() => {}, 120000)`
    const keep = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(body)}], { detached: true, stdio: 'ignore' });
  child.unref(); console.log(child.pid)`
    const kept = spawnSync(helper, ['--keep-orphans', '--', node, '-e', keep], { encoding: 'utf8' })
    const keptPid = Number(kept.stdout.trim())
    await sleep(2000)
    const keptAlive = alive(keptPid)
    const keptRan = existsSync(marker)
    if (keptAlive) process.kill(keptPid)
    return {
      ok:
        stopped.status === 0 &&
        !alive(stoppedPid) &&
        /stopped 1 process/.test(stopped.stderr) &&
        stoppedMs >= 1500 &&
        stoppedMs < 8000 &&
        keptAlive &&
        keptRan,
      detail: `stopped: pid ${stoppedPid} alive ${alive(stoppedPid)} after a ${stoppedMs} ms run, said ${JSON.stringify(stopped.stderr.trim())}; kept: pid ${keptPid} alive ${keptAlive} 2 s later, its own code ran ${keptRan}`,
    }
  },
)

await check('killing offstage takes the whole tree with it, with --keep-orphans too', async () => {
  const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    console.log(process.pid + ' ' + child.pid); setTimeout(() => {}, 120000)`
  const details = []
  let ok = true
  for (const flags of [[], ['--keep-orphans']]) {
    const run = spawn(helper, [...flags, '--', node, '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const line = await new Promise((resolve) => run.stdout.once('data', (data) => resolve(String(data))))
    const [command, grandchild] = line.trim().split(' ').map(Number)
    const before = alive(command) && alive(grandchild)
    run.kill()
    await sleep(1500)
    ok &&= before && !alive(command) && !alive(grandchild)
    details.push(
      `${flags.join(' ') || 'default'}: before the kill both alive ${before}; after: command ${alive(command)}, its child ${alive(grandchild)}`,
    )
  }
  return { ok, detail: details.join('; ') }
})

await check(
  'OFFSTAGE_VERBOSE=1 reports what a run opened and left running, whichever way offstage was started',
  async () => {
    const env = { ...process.env, OFFSTAGE_VERBOSE: '1' }
    const direct = spawnSync(helper, ['--', comspec, '/d', '/c', 'exit 0'], { encoding: 'utf8', env })
    const standIn = spawnSync(helper, ['/d', '/c', 'exit 0'], {
      encoding: 'utf8',
      env: { ...env, OFFSTAGE_EXEC: comspec },
    })
    const withWindow = spawnSync(helper, ['--', probeWindow, '800'], { encoding: 'utf8', env })
    const kept = spawnSync(helper, ['--keep-orphans', '--', node, '-e', LEAVE_ONE_RUNNING], { encoding: 'utf8', env })
    const keptPid = Number(kept.stdout.trim())
    if (alive(keptPid)) process.kill(keptPid)
    const said = (run) => /offstage: desktop offstage-\S+; 0 windows opened there/.test(run.stderr)
    const sawWindow = /1 window opened there: probe-window\.exe "offstage probe \d+"/.test(withWindow.stderr)
    const sawKept = /left running as asked: node\.exe/.test(kept.stderr)
    return {
      ok: said(direct) && said(standIn) && sawWindow && sawKept,
      detail: `with --: ${JSON.stringify(direct.stderr.trim())}; stand-in: ${JSON.stringify(standIn.stderr.trim())}; a window: ${JSON.stringify(withWindow.stderr.trim())}; kept: ${JSON.stringify(kept.stderr.trim())}`,
    }
  },
)

await check('ten runs at once each get a desktop of their own', async () => {
  const reports = mkdtempSync(join(tmpdir(), 'offstage-reports-'))
  const runs = await Promise.all(
    Array.from(
      { length: 10 },
      () =>
        new Promise((resolve) => {
          const run = spawn(helper, ['--', probeWindow, '1500'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, OFFSTAGE_REPORT_DIR: reports },
          })
          let out = ''
          run.stdout.on('data', (data) => (out += data))
          run.on('close', (code) => {
            let desktop = ''
            try {
              desktop = out ? lastJson(out).desktop : ''
            } catch {
              desktop = `unreadable output: ${out.slice(0, 80)}`
            }
            resolve({ code, desktop })
          })
        }),
    ),
  )
  const desktops = new Set(runs.map((run) => run.desktop))
  // One report per run: runs at the same moment must not overwrite each other's.
  const reported = new Set(
    readdirSync(reports).map((file) => JSON.parse(readFileSync(join(reports, file), 'utf8')).desktop),
  )
  rmSync(reports, { recursive: true, force: true })
  return {
    ok:
      runs.every((run) => run.code === 0 && run.desktop.startsWith('offstage-')) &&
      desktops.size === 10 &&
      reported.size === 10,
    detail: `exit codes ${[...new Set(runs.map((run) => run.code))]}, ${desktops.size} distinct desktops, ${reported.size} distinct reports`,
  }
})

await check('a helper that is built but cannot run falls back to visible windows, saying why', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'offstage-cache-'))
  // The trial run starts ComSpec; pointing it nowhere makes the new helper fail the way a blocked one would.
  // The second spawnArgs call asks for a timeout, which a fallback cannot apply: that must be said too, even though the
  // same failure was already reported once.
  const script = `const o = require(${JSON.stringify(offstageModule)});
    console.log(JSON.stringify([o.spawnArgs('x.exe', ['a']), o.electronLaunchOptions({ args: ['.'] }), o.spawnArgs('y.exe', [], { timeout: 5 })]))`
  const run = spawnSync(node, ['-e', script], {
    encoding: 'utf8',
    env: envWith({ OFFSTAGE_CACHE: cache, ComSpec: join(cache, 'missing', 'cmd.exe') }),
  })
  const left = readdirSync(cache)
  rmSync(cache, { recursive: true, force: true })
  return {
    ok:
      // The last line: a first use of Electron can print a download message first (seen on a fresh node_modules).
      isDeepStrictEqual(JSON.parse(run.stdout.trim().split(/\r?\n/).pop()), [
        ['x.exe', ['a']],
        { args: ['.'] },
        ['y.exe', []],
      ]) &&
      /the helper was built but does not run \(exit 127\); windows will show/.test(run.stderr) &&
      /windows will show on screen, and timeout is not applied/.test(run.stderr) &&
      !left.some((name) => /^offstage-[0-9a-f]{12}\.exe$/.test(name)),
    detail: `returned ${run.stdout.trim()}; said ${JSON.stringify(run.stderr.trim())}; cached ${JSON.stringify(left)}`,
  }
})

await check(
  '--wait-all waits for a program that hands over to another process, and killing it still stops that',
  async () => {
    const handOver = (ms) =>
      `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${ms})'], { detached: true, stdio: 'ignore' });
    child.unref(); console.log(child.pid)`
    let started = Date.now()
    const waited = spawnSync(helper, ['--wait-all', '--', node, '-e', handOver(2500)], { encoding: 'utf8' })
    const waitedMs = Date.now() - started
    started = Date.now()
    const run = spawn(helper, ['--wait-all', '--', node, '-e', handOver(120_000)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const successor = Number(await new Promise((resolve) => run.stdout.once('data', (data) => resolve(String(data)))))
    await sleep(1500)
    const stillWaiting = run.exitCode === null && alive(successor)
    run.kill()
    await sleep(1500)
    return {
      ok:
        waited.status === 0 && waitedMs >= 2400 && !/stopped/.test(waited.stderr) && stillWaiting && !alive(successor),
      detail: `waited ${waitedMs} ms for a 2.5 s successor (exit ${waited.status}); with a long one: still waiting ${stillWaiting}, after the kill it is alive ${alive(successor)}`,
    }
  },
)

// Asks a window for its title's length with a window message and prints "<handle> <reply>": the probe window found on this
// desktop by its title (handle 0), or a handle given (as a helper that got it from the app would).
const ASK_WINDOW = (handle) => `$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Ask {
  public delegate bool Proc(IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(IntPtr w, StringBuilder t, int m);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr w, uint m, IntPtr wp, IntPtr lp, uint f, uint t, out IntPtr r);
  public static string Run(long handle) {
    IntPtr window = new IntPtr(handle);
    if (handle == 0) EnumWindows((w, l) => { var t = new StringBuilder(256); InternalGetWindowText(w, t, 256); if (t.ToString().StartsWith("offstage probe")) window = w; return true; }, IntPtr.Zero);
    IntPtr reply = IntPtr.Zero;
    if (window != IntPtr.Zero) SendMessageTimeoutW(window, 0x000E, IntPtr.Zero, IntPtr.Zero, 2, 3000, out reply);
    return window.ToInt64() + " " + reply;
  }
}
"@
[Ask]::Run(${handle})`

await check(
  "--desktop runs a helper beside an app offstage, where the app's window handle works (from here it reaches nothing)",
  async () => {
    const script = `const { spawnSync } = require('node:child_process'); console.log(process.env.OFFSTAGE_DESKTOP);
    spawnSync(${JSON.stringify(probeWindow)}, ['60000'])`
    const app = spawn(helper, ['--', node, '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const desktop = String(await new Promise((resolve) => app.stdout.once('data', resolve))).trim()
    await sleep(1500)
    const encoded = (text) => [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(text, 'utf16le').toString('base64'),
    ]
    const ask = ([file, args]) =>
      spawnSync(file, args, { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).at(-1).split(' ')
    const [handle, besideReply] = ask(offstage.spawnArgs('powershell.exe', encoded(ASK_WINDOW(0)), { desktop }))
    const [, hereReply] = ask(['powershell.exe', encoded(ASK_WINDOW(handle))])
    // Beside the app once more: the window is still there, so the visible desktop's 0 was the handle not reaching it.
    const [, againReply] = ask(offstage.spawnArgs('powershell.exe', encoded(ASK_WINDOW(handle)), { desktop }))
    app.kill()
    return {
      ok: Number(handle) !== 0 && Number(besideReply) > 0 && Number(hereReply) === 0 && Number(againReply) > 0,
      detail: `beside the app on ${desktop}: window ${handle} replied ${besideReply}; the same handle from the visible desktop: ${hereReply}; beside the app again: ${againReply}`,
    }
  },
)

await check(
  'the wrapper hands tricky arguments to a node_modules/.bin shim unchanged (a naive line does not)',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'offstage-args-'))
    mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      join(work, 'echo-args.cjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 3',
    )
    writeFileSync(
      join(work, 'node_modules', '.bin', 'echo-args.cmd'),
      '@ECHO off\r\nnode "%~dp0\\..\\..\\echo-args.cjs" %*\r\n',
    )
    // npm also writes an extensionless sh shim beside each .cmd; the wrapper must still pick the .cmd.
    writeFileSync(
      join(work, 'node_modules', '.bin', 'echo-args'),
      '#!/bin/sh\nexec node "$basedir/../../echo-args.cjs" "$@"\n',
    )
    const env = { ...process.env, PATH: `${join(work, 'node_modules', '.bin')};${process.env.PATH}` }
    const tricky = [
      'plain',
      'with space',
      'quote"inside',
      'amp&er',
      'pct%PATH%x',
      'caret^x',
      'paren(x)',
      'bang!x',
      'trailing\\',
      'two trailing\\\\',
      'two\\\\"before a quote',
      'lt<gt>',
      'pipe|x',
      '',
    ]
    const wrapped = spawnSync(node, [offstageModule, 'echo-args', ...tricky], { cwd: work, env, encoding: 'utf8' })
    const naive = spawnSync(comspec, ['/d', '/s', '/c', `"echo-args ${tricky.join(' ')}"`], {
      cwd: work,
      env,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    })
    const direct = spawnSync(node, [offstageModule, node, join(work, 'echo-args.cjs'), ...tricky], {
      cwd: work,
      encoding: 'utf8',
    })
    rmSync(work, { recursive: true, force: true })
    let got = null
    let gotDirect = null
    try {
      got = JSON.parse(wrapped.stdout)
      gotDirect = JSON.parse(direct.stdout)
    } catch {
      // Left null: the comparison fails and the detail shows what came out.
    }
    const naiveSame = naive.stdout.trim().startsWith('[') && isDeepStrictEqual(JSON.parse(naive.stdout), tricky)
    return {
      ok:
        wrapped.status === 3 &&
        isDeepStrictEqual(got, tricky) &&
        direct.status === 3 &&
        isDeepStrictEqual(gotDirect, tricky) &&
        !naiveSame,
      detail: `shim: exit ${wrapped.status}, ${got ? (isDeepStrictEqual(got, tricky) ? 'exact' : wrapped.stdout) : wrapped.stdout + wrapped.stderr}; .exe: exit ${direct.status}, ${gotDirect && isDeepStrictEqual(gotDirect, tricky) ? 'exact' : direct.stdout + direct.stderr}; naive line exact: ${naiveSame}`,
    }
  },
)

await check('Electron through spawnArgs renders offstage at full speed, and shows nothing on screen', async () => {
  const watcher = await startWatcher()
  const [file, args] = offstage.spawnArgs(require('electron'), [probeApp, ...SWITCHES])
  const run = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000 })
  const shown = await watcher.stop()
  const report = lastJson(run.stdout)
  const leaked = shown.filter((entry) => entry.process.toLowerCase() === 'electron.exe')
  const ok =
    run.status === 0 &&
    !report.error &&
    report.desktop?.startsWith('offstage-') &&
    report.renderer.visibility === 'visible' &&
    report.renderer.frames >= 30 &&
    report.renderer.transitionEnded &&
    near(report.capturePage.rgb, report.expectedCentre, 16) &&
    near(report.cdpScreenshot.rgb, report.expectedCentre, 16) &&
    leaked.length === 0
  return {
    ok,
    detail: `desktop ${report.desktop}; ${report.renderer.frames} frames/s, ${report.renderer.ticks} timer ticks/s; screenshots ${report.capturePage.ms} ms and ${report.cdpScreenshot.ms} ms, centre ${report.cdpScreenshot.rgb} (page ${report.expectedCentre}); GPU compositing ${report.gpu.gpu_compositing}; on screen ${leaked.length}`,
  }
})

await check(
  "Playwright's Electron launch through electronLaunchOptions runs offstage, and shows nothing on screen",
  async () => {
    const watcher = await startWatcher()
    const run = spawnSync(
      node,
      [require.resolve('@playwright/test/cli'), 'test', '-c', join(import.meta.dirname, 'playwright.config.cjs')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
      },
    )
    const shown = await watcher.stop()
    const leaked = shown.filter((entry) => entry.process.toLowerCase() === 'electron.exe')
    const passed = /(\d+) passed/.exec(run.stdout)?.[1]
    return {
      ok: run.status === 0 && passed === '2' && leaked.length === 0,
      detail: `playwright exit ${run.status}, ${passed ?? 0} passed; on screen ${leaked.length}${run.status === 0 ? '' : `\n${run.stdout}${run.stderr}`}`,
    }
  },
)

await check(
  'A whole Playwright run wrapped by the CLI puts a plain Electron launch offstage (the same run unwrapped does not)',
  async () => {
    const cli = [
      require.resolve('@playwright/test/cli'),
      'test',
      '-c',
      join(import.meta.dirname, 'playwright-plain.config.cjs'),
    ]
    // The control runs unwrapped, with the probe far off-screen and never focused: it must fail at its first check.
    const control = spawnSync(node, cli, {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, PROBE_OFFSCREEN: '1' },
    })
    const controlFailed = control.status !== 0 && /not offstage/.test(control.stdout + control.stderr)
    const watcher = await startWatcher()
    const run = spawnSync(node, [offstageModule, node, ...cli], { cwd: root, encoding: 'utf8', timeout: 300_000 })
    const shown = await watcher.stop()
    const leaked = shown.filter((entry) => entry.process.toLowerCase() === 'electron.exe')
    const passed = /(\d+) passed/.exec(run.stdout)?.[1]
    return {
      ok: controlFailed && run.status === 0 && passed === '1' && leaked.length === 0,
      detail: `control unwrapped exit ${control.status} (${controlFailed ? 'failed at the offstage check, as it must' : 'DID NOT FAIL as expected'}); wrapped exit ${run.status}, ${passed ?? 0} passed; on screen ${leaked.length}${run.status === 0 ? '' : `\n${run.stdout}${run.stderr}`}`,
    }
  },
)

await check(
  "the CLI passes its options through a .cmd (timeout, verbose), keeps Playwright's report closed, and runs the command visibly (saying what it drops) when the helper cannot run",
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'offstage wrap '))
    const sleeper = join(work, 'sleep-30.cmd')
    writeFileSync(sleeper, `@"${node}" -e "setTimeout(() => {}, 30000)"\r\n`)
    const quick = join(work, 'exit-0.cmd')
    writeFileSync(quick, '@exit /b 0\r\n')
    const started = Date.now()
    const timed = spawnSync(node, [offstageModule, '--timeout', '1', sleeper], { encoding: 'utf8', timeout: 60_000 })
    const seconds = (Date.now() - started) / 1000
    const verbose = spawnSync(node, [offstageModule, '--verbose', quick], { encoding: 'utf8', timeout: 60_000 })
    const cache = mkdtempSync(join(tmpdir(), 'offstage-cache-'))
    const blocked = spawnSync(node, [offstageModule, '--timeout', '30', node, '-e', 'process.exit(3)'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: envWith({ OFFSTAGE_CACHE: cache, ComSpec: join(cache, 'missing', 'cmd.exe') }),
    })
    // A wrapped run keeps Playwright's HTML report from opening a browser offstage, unless the caller chose otherwise.
    const reportOpen = (value) => {
      const env = envWith({})
      for (const name of Object.keys(env))
        if (/^(PLAYWRIGHT_HTML_OPEN|PW_TEST_HTML_REPORT_OPEN)$/i.test(name)) delete env[name]
      if (value) env.PLAYWRIGHT_HTML_OPEN = value
      const show = 'console.log(`${process.env.PLAYWRIGHT_HTML_OPEN} ${process.env.PW_TEST_HTML_REPORT_OPEN}`)'
      return spawnSync(node, [offstageModule, node, '-e', show], { encoding: 'utf8', env }).stdout.trim()
    }
    const openDefault = reportOpen('')
    const openChosen = reportOpen('always')
    rmSync(work, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
    return {
      ok:
        timed.status === 124 &&
        seconds < 20 &&
        /offstage: desktop offstage-\S+; 0 windows opened there/.test(verbose.stderr) &&
        verbose.status === 0 &&
        blocked.status === 3 &&
        /the helper was built but does not run .*--timeout is not applied/.test(blocked.stderr) &&
        openDefault === 'never never' &&
        openChosen === 'always undefined',
      detail: `--timeout 1 on a .cmd: exit ${timed.status} after ${seconds.toFixed(1)} s; --verbose on a .cmd: exit ${verbose.status}, ${JSON.stringify(verbose.stderr.trim())}; helper blocked: exit ${blocked.status}, said ${JSON.stringify(blocked.stderr.trim())}; PLAYWRIGHT_HTML_OPEN in a wrapped run: ${openDefault} (unset), ${openChosen} (set to always)`,
    }
  },
)

await check(
  'the CLI finds a program through a quoted PATH entry and an App Execution Alias; spawnArgs throws for a bad desktop name; --check names a helper that cannot run',
  async () => {
    // A copy of whoami.exe in a folder with a space, reached only through a quoted PATH entry.
    const folder = join(mkdtempSync(join(tmpdir(), 'offstage path ')), 'bin')
    mkdirSync(folder)
    writeFileSync(
      join(folder, 'whoami-offstage.exe'),
      readFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe')),
    )
    const quoted = spawnSync(node, [offstageModule, 'whoami-offstage'], {
      encoding: 'utf8',
      env: envWith({ PATH: `"${folder}";${process.env.PATH}` }),
    })
    // An App Execution Alias cannot be stat'ed, only lstat'ed (so existsSync says it is not there: this check's first
    // version skipped itself on a machine that has one). winget's is on most Windows 11 machines; without it this part
    // is skipped and says so.
    const alias = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'winget.exe')
    let hasAlias = false
    try {
      hasAlias = lstatSync(alias).isFile() || lstatSync(alias).isSymbolicLink()
    } catch {
      // No alias here.
    }
    const aliased = hasAlias
      ? spawnSync(node, [offstageModule, 'winget', '--version'], { encoding: 'utf8', timeout: 60_000 })
      : null
    let threw = ''
    try {
      offstage.spawnArgs('x.exe', [], { desktop: 'a b' })
    } catch (error) {
      threw = `${error.constructor.name}: ${error.message}`
    }
    const cache = mkdtempSync(join(tmpdir(), 'offstage-cache-'))
    const broken = spawnSync(node, [offstageModule, '--check'], {
      encoding: 'utf8',
      env: envWith({ OFFSTAGE_CACHE: cache, ComSpec: join(cache, 'missing', 'cmd.exe') }),
    })
    rmSync(cache, { recursive: true, force: true })
    return {
      ok:
        quoted.status === 0 &&
        quoted.stdout.trim().length > 0 &&
        (!hasAlias || aliased.status !== 127) &&
        threw.startsWith('TypeError') &&
        broken.status === 1 &&
        /offstage is broken: the helper was built but does not run/.test(broken.stdout) &&
        !/\n\s+at /.test(broken.stderr),
      detail: `quoted PATH entry: exit ${quoted.status}; alias: ${hasAlias ? `exit ${aliased.status}` : 'no winget alias here, skipped'}; bad desktop name: ${threw || 'no throw'}; --check with a blocked helper: exit ${broken.status}, ${JSON.stringify(broken.stdout.trim())}`,
    }
  },
)

await check('OFFSTAGE=0 turns it off: every function passes its input through', async () => {
  const script = `const o = require(${JSON.stringify(offstageModule)});
    console.log(JSON.stringify([o.enabled(), o.spawnArgs('x.exe', ['a']), o.electronLaunchOptions({ args: ['.'] })]))`
  const run = spawnSync(node, ['-e', script], { encoding: 'utf8', env: { ...process.env, OFFSTAGE: '0' } })
  const got = JSON.parse(run.stdout)
  return { ok: isDeepStrictEqual(got, [false, ['x.exe', ['a']], { args: ['.'] }]), detail: run.stdout.trim() }
})

await check(
  'spawnArgs refuses a .cmd (cmd.exe would read its arguments unescaped) and a bad timeout, saying so',
  async () => {
    const ask = (call) =>
      spawnSync(
        node,
        ['-e', `const o = require(${JSON.stringify(offstageModule)}); console.log(JSON.stringify(${call}))`],
        {
          encoding: 'utf8',
        },
      )
    const batch = ask(`o.spawnArgs('C:/tools/run.cmd', ['a&b'])`)
    const timeout = ask(`o.spawnArgs('x.exe', [], { timeout: 1.5 })`)
    return {
      ok:
        isDeepStrictEqual(JSON.parse(batch.stdout), ['C:/tools/run.cmd', ['a&b']]) &&
        /spawnArgs runs programs, not run\.cmd/.test(batch.stderr) &&
        isDeepStrictEqual(JSON.parse(timeout.stdout), ['x.exe', []]) &&
        /timeout takes a whole number of seconds, not 1\.5/.test(timeout.stderr),
      detail: `.cmd: ${batch.stdout.trim()} ${JSON.stringify(batch.stderr.trim())}; timeout 1.5: ${timeout.stdout.trim()} ${JSON.stringify(timeout.stderr.trim())}`,
    }
  },
)

await check("without Playwright's loader, electronLaunchOptions says so and leaves the launch as it was", async () => {
  const empty = mkdtempSync(join(tmpdir(), 'offstage-noplaywright-'))
  const script = `const o = require(${JSON.stringify(offstageModule)});
    console.log(JSON.stringify(o.electronLaunchOptions({ args: ['.'] })))`
  const run = spawnSync(node, ['-e', script], { cwd: empty, encoding: 'utf8' })
  rmSync(empty, { recursive: true, force: true })
  return {
    ok:
      isDeepStrictEqual(JSON.parse(run.stdout), { args: ['.'] }) &&
      /loader .* was not found; windows will show/.test(run.stderr),
    detail: `returned ${run.stdout.trim()}, said ${JSON.stringify(run.stderr.trim())}`,
  }
})

await check(
  'spawnArgs and electronLaunchOptions pass their options on: the flags, a desktop of its own, the stand-in variables',
  async () => {
    const app = 'C:\\app folder\\app.exe'
    const [file, args] = offstage.spawnArgs(app, ['a'], { timeout: 5, waitForAll: true, keepOrphans: true })
    const [, named] = offstage.spawnArgs(app, [], { desktop: 'Default' })
    const launch = offstage.electronLaunchOptions({ executablePath: app, args: ['.'] })
    const ok =
      file === helper &&
      isDeepStrictEqual(args, ['--timeout', '5', '--wait-all', '--keep-orphans', '--own-desktop', '--', app, 'a']) &&
      isDeepStrictEqual(named, ['--desktop', 'Default', '--', app]) &&
      launch.executablePath === helper &&
      isDeepStrictEqual(launch.args, ['.']) &&
      launch.env.OFFSTAGE_EXEC === app &&
      launch.env.OFFSTAGE_EXEC_PREPEND === '' &&
      launch.env.OFFSTAGE_OWN_DESKTOP === '1' &&
      Object.keys(launch.env).length === Object.keys(process.env).length + 3 &&
      !offstage.enabled({ OFFSTAGE: 'no' }) &&
      !offstage.enabled({ OFFSTAGE: ' Off ' }) &&
      offstage.enabled({})
    return {
      ok,
      detail: `spawnArgs -> ${JSON.stringify(args)}; with a desktop -> ${JSON.stringify(named)}; electronLaunchOptions -> OFFSTAGE_EXEC ${launch.env.OFFSTAGE_EXEC}, OFFSTAGE_OWN_DESKTOP ${launch.env.OFFSTAGE_OWN_DESKTOP}, ${Object.keys(launch.env).length} variables for ${Object.keys(process.env).length} here`,
    }
  },
)

await check(
  'the CLI passes --wait-all, --keep-orphans and --verbose on, for a program and for a .cmd; cmd.exe builtins run',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'offstage cli '))
    // A program that hands over to a successor living 5 s, and one that leaves a child running for good.
    const handOver = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: 'ignore' }).unref()`
    const keepOne = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)`
    const handOverCmd = join(work, 'hand-over.cmd')
    writeFileSync(handOverCmd, `@"${node}" -e "${handOver}"\r\n`)
    const keepOneCmd = join(work, 'keep-one.cmd')
    writeFileSync(keepOneCmd, `@"${node}" -e "${keepOne}"\r\n`)
    const timed = (args) => {
      const started = Date.now()
      const run = spawnSync(node, [offstageModule, ...args], { encoding: 'utf8', timeout: 30_000 })
      return { ...run, ms: Date.now() - started }
    }
    const waitedExe = timed(['--wait-all', '--verbose', node, '-e', handOver])
    const waitedCmd = timed(['--wait-all', handOverCmd])
    const keptExe = timed(['--keep-orphans', node, '-e', keepOne])
    const keptCmd = timed(['--keep-orphans', keepOneCmd])
    const builtin = spawnSync(node, [offstageModule, 'echo', 'from cmd'], { encoding: 'utf8' })
    await sleep(500)
    const keptPids = [keptExe, keptCmd].map((run) => Number(String(run.stdout).trim()))
    const keptAlive = keptPids.map((pid) => pid > 0 && alive(pid))
    for (const pid of keptPids) if (pid > 0 && alive(pid)) process.kill(pid)
    rmSync(work, { recursive: true, force: true })
    return {
      ok:
        waitedExe.status === 0 &&
        waitedExe.ms >= 4500 &&
        /offstage: desktop offstage-\S+/.test(waitedExe.stderr) &&
        waitedCmd.status === 0 &&
        waitedCmd.ms >= 4500 &&
        keptExe.status === 0 &&
        keptCmd.status === 0 &&
        keptAlive.every(Boolean) &&
        builtin.status === 0 &&
        // cmd.exe's echo prints its arguments as it gets them, quotes included.
        builtin.stdout.includes('from cmd'),
      detail: `--wait-all: program ${waitedExe.ms} ms (exit ${waitedExe.status}, verbose ${/offstage: desktop/.test(waitedExe.stderr)}), .cmd ${waitedCmd.ms} ms (exit ${waitedCmd.status}); --keep-orphans kept alive: program ${keptAlive[0]}, .cmd ${keptAlive[1]} (exits ${keptExe.status}, ${keptCmd.status}); echo -> ${JSON.stringify(builtin.stdout.trim())}`,
    }
  },
)

await check(
  'the helper runs from a folder whose path has spaces, and stands in for a program whose path has spaces',
  async () => {
    const top = mkdtempSync(join(tmpdir(), 'offstage spaced '))
    const folder = join(top, 'helper copy')
    mkdirSync(folder)
    const copied = join(folder, 'offstage helper.exe')
    writeFileSync(copied, readFileSync(helper))
    const target = join(folder, 'who am i.exe')
    writeFileSync(target, readFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe')))
    // libuv quotes a program path that has a space, so the helper reads a quoted program name from its command line here.
    const direct = spawnSync(copied, ['--', comspec, '/d', '/c', 'echo %OFFSTAGE_DESKTOP%'], { encoding: 'utf8' })
    const standIn = spawnSync(copied, [], { encoding: 'utf8', env: { ...process.env, OFFSTAGE_EXEC: target } })
    rmSync(top, { recursive: true, force: true, maxRetries: 5 })
    return {
      ok:
        direct.status === 0 &&
        direct.stdout.trim().startsWith('offstage-') &&
        standIn.status === 0 &&
        standIn.stdout.trim().length > 0,
      detail: `run from a spaced path: exit ${direct.status}, ${JSON.stringify(direct.stdout.trim())}; standing in for a spaced path: exit ${standIn.status}, ${JSON.stringify(standIn.stdout.trim())}${direct.stderr || standIn.stderr ? `; said ${JSON.stringify(`${direct.stderr}${standIn.stderr}`.trim())}` : ''}`,
    }
  },
)

await check(
  'a stand-in stops its app when the process that started it through cmd.exe is killed (as Playwright starts it)',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'offstage-launcher-'))
    const pidFile = join(work, 'app.pid')
    const appFile = join(work, 'app.cjs')
    writeFileSync(
      appFile,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`,
    )
    // Playwright 1.45 and later start Electron with shell: true on Windows, so the helper is cmd.exe's child, outside the
    // kill-on-close job Node keeps for its own children.
    const launcher = `require('node:child_process').spawn(${JSON.stringify(`"${helper}" "${appFile}"`)}, {
        shell: true, stdio: 'ignore', env: { ...process.env, OFFSTAGE_EXEC: process.execPath } });
      setTimeout(() => {}, 120000)`
    const run = spawn(node, ['-e', launcher], { stdio: 'ignore' })
    let appPid = 0
    for (let i = 0; i < 150 && !appPid; i++) {
      await sleep(100)
      if (existsSync(pidFile)) appPid = Number(readFileSync(pidFile, 'utf8'))
    }
    const before = appPid > 0 && alive(appPid)
    run.kill()
    await sleep(2000)
    const after = appPid > 0 && alive(appPid)
    if (after) process.kill(appPid)
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
    return {
      ok: before && !after,
      detail: `app pid ${appPid}: alive while its launcher ran ${before}; 2 s after the launcher was killed ${after}`,
    }
  },
)

await check(
  'the helper is cached in %LOCALAPPDATA%\\offstage and reused by the next process, not rebuilt',
  async () => {
    const local = mkdtempSync(join(tmpdir(), 'offstage-localappdata-'))
    const env = envWith({ LOCALAPPDATA: local })
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'OFFSTAGE_CACHE') delete env[name]
    const ask = `const o = require(${JSON.stringify(offstageModule)}); const p = o.helper();
    console.log(JSON.stringify({ p, mtime: require('node:fs').statSync(p).mtimeMs }))`
    const first = spawnSync(node, ['-e', ask], { encoding: 'utf8', env })
    const second = spawnSync(node, ['-e', ask], { encoding: 'utf8', env })
    rmSync(local, { recursive: true, force: true, maxRetries: 5 })
    let a = null
    let b = null
    try {
      a = JSON.parse(first.stdout)
      b = JSON.parse(second.stdout)
    } catch {
      // Left null: the check fails and the detail shows the output.
    }
    const expected = join(local, 'offstage', basename(helper))
    return {
      ok: a?.p === expected && b?.p === expected && b.mtime === a.mtime,
      detail: `first ${a?.p ?? first.stdout + first.stderr}, second ${b?.p ?? second.stdout + second.stderr} (expected ${expected}); rebuilt: ${a && b ? b.mtime !== a.mtime : 'unknown'}`,
    }
  },
)

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed`)
process.exit(failed)
