// watch: runs a command and lists every window that appeared on the visible desktop while it ran, to find what still
// reaches the screen (a project's e2e suite, say). Windows the person opened meanwhile show up too, so read it as leads.
// Slivers under 4 px (Windows' own screen-edge trigger strips, for one) are counted, not listed.
// Usage (Windows, outside offstage): node <offstage repo>/test/watch.mjs <command line>
// The command line runs through the shell, as an npm script does, in the current folder; the exit code is the command's.
import { spawn } from 'node:child_process'
import { startWatcher } from './tools.mjs'

const commandLine = process.argv.slice(2).join(' ')
if (!commandLine) {
  console.error('usage: node watch.mjs <command line>')
  process.exit(2)
}
const watcher = await startWatcher()
const started = Date.now()
const code = await new Promise((resolve) => {
  const child = spawn(commandLine, { shell: true, stdio: 'inherit' })
  child.on('exit', (exitCode) => resolve(exitCode ?? 1))
})
const shown = await watcher.stop()
const seconds = Math.round((Date.now() - started) / 1000)
const sized = (entry) => entry.rect[2] - entry.rect[0] >= 4 && entry.rect[3] - entry.rect[1] >= 4
const windows = shown.filter(sized)
const slivers = shown.length - windows.length
const note = slivers ? ` (and ${slivers} sliver${slivers === 1 ? '' : 's'} under 4 px)` : ''
if (windows.length === 0) {
  console.error(`\nwatch: no window appeared on the visible desktop in ${seconds} s${note}`)
} else {
  console.error(`\nwatch: ${windows.length} window(s) appeared on the visible desktop in ${seconds} s${note}:`)
  for (const entry of windows) {
    console.error(`  ${entry.process} (pid ${entry.pid}) ${entry.class} "${entry.title}" at [${entry.rect}]`)
  }
}
process.exit(code)
