// What offstage adds to one run: the same short program started directly and through the helper, N times each (medians).
// node test/bench.mjs [runs] [path to offstage.cjs]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const runs = Number(process.argv[2] ?? 20)
const offstage = createRequire(import.meta.url)(
  process.argv[3] ?? fileURLToPath(new URL('../offstage.cjs', import.meta.url)),
)
// A program that runs 200 ms, and one that also leaves a child behind for 30 ms after it exits (Chromium's helpers do that).
const plain = [process.execPath, ['-e', 'setTimeout(() => {}, 200)']]
const leaves = [
  process.execPath,
  [
    '-e',
    "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 230)'], { stdio: 'ignore' }); setTimeout(() => {}, 200)",
  ],
]

const once = (file, args) =>
  new Promise((done) => {
    const started = performance.now()
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
    child.on('exit', () => done(performance.now() - started))
  })

async function measure(label, [file, args], wrap) {
  const [f, a] = wrap ? offstage.spawnArgs(file, args) : [file, args]
  await once(f, a) // warm-up
  const times = []
  for (let i = 0; i < runs; i++) times.push(await once(f, a))
  times.sort((x, y) => x - y)
  const median = times[Math.floor(times.length / 2)]
  console.log(
    `${label.padEnd(34)} median ${median.toFixed(0)} ms  min ${times[0].toFixed(0)}  max ${times.at(-1).toFixed(0)}`,
  )
  return median
}

if (!offstage.enabled()) {
  console.log('offstage is off here (not Windows, or OFFSTAGE=0): nothing to measure')
  process.exit(0)
}
const direct = await measure('direct, 200 ms program', plain, false)
const wrapped = await measure('offstage, 200 ms program', plain, true)
const directLeaves = await measure('direct, leaves a child 30 ms', leaves, false)
const wrappedLeaves = await measure('offstage, leaves a child 30 ms', leaves, true)
console.log(
  `offstage adds ${(wrapped - direct).toFixed(0)} ms per run; ${(wrappedLeaves - directLeaves).toFixed(0)} ms when a child outlives the program by 30 ms`,
)
