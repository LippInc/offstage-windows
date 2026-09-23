// The self-test's Windows tools: a watcher that records every window shown on the visible desktop, and the window
// probes. Built from the .cs files next to this one with the same compiler offstage uses, into the temp folder.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const here = import.meta.dirname
const folder = join(tmpdir(), 'offstage-selftest-tools')

function compiler() {
  const windows = process.env.SystemRoot || 'C:\\Windows'
  for (const framework of ['Framework64', 'Framework']) {
    const csc = join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
    if (existsSync(csc)) return csc
  }
  throw new Error('csc.exe not found')
}

/** Paths of the built tools: observer, probeWindow (console program), probeGui (windowed program). */
export function tools() {
  mkdirSync(folder, { recursive: true })
  const built = {}
  for (const [name, file, source, target] of [
    ['observer', 'observer.exe', 'observer.cs', 'exe'],
    ['probeWindow', 'probe-window.exe', 'probe-window.cs', 'exe'],
    ['probeGui', 'probe-gui.exe', 'probe-window.cs', 'winexe'],
  ]) {
    const exe = join(folder, file)
    const src = join(here, source)
    if (!existsSync(exe) || statSync(exe).mtimeMs < statSync(src).mtimeMs) {
      const result = spawnSync(compiler(), ['-nologo', `-target:${target}`, '-optimize+', `-out:${exe}`, src], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result.status !== 0) throw new Error(`could not build ${name}: ${result.stdout}${result.stderr}`)
    }
    built[name] = exe
  }
  return built
}

/**
 * Starts recording every top-level window shown on this desktop, which must be the visible one ("Default"). stop()
 * returns what was shown in the meantime: { process, pid, class, title, rect }.
 */
export async function startWatcher() {
  const work = mkdtempSync(join(tmpdir(), 'offstage-watch-'))
  const out = join(work, 'shown.jsonl')
  const stopFile = join(work, 'stop')
  const child = spawn(tools().observer, [out, stopFile], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let ready = null
  for (let i = 0; i < 200 && !ready; i++) {
    await sleep(25)
    if (existsSync(out))
      ready = readFileSync(out, 'utf8')
        .split('\n')
        .find((line) => line.includes('"ready"'))
  }
  if (!ready) throw new Error('the watcher did not start')
  const desktop = JSON.parse(ready).desktop
  if (desktop !== 'Default')
    throw new Error(`the watcher runs on desktop "${desktop}", not the visible one: run this outside offstage`)
  return {
    async stop() {
      await sleep(300)
      writeFileSync(stopFile, '')
      await exited
      const shown = readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => !entry.ready)
      rmSync(work, { recursive: true, force: true })
      return shown
    },
  }
}
