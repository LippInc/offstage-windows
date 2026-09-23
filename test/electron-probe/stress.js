// stress: does rendering keep going on the desktop the app runs on? For the self-test and for chasing a test that looks
// like a close animation never finished.
// Usage: electron <electron-probe folder>/stress.js [seconds] [--offscreen] [chromium switches...]
// For the given time (default 60 s) it counts animation frames and the longest gap between two, and every 300 ms runs a
// 150 ms Web Animation (what Base UI waits on before it removes a closing menu) and a 150 ms CSS transition, recording
// how long each took to finish. Prints one JSON line, then quits.
const { app, BrowserWindow } = require('electron')

const seconds = Number(process.argv.find((argument) => /^\d+$/.test(argument)) ?? 60)
const offscreen = process.argv.includes('--offscreen')
const page = `<!doctype html><title>offstage stress probe</title>
<body style="margin:0;background:#123"><div id="a" style="width:80px;height:80px;background:#fa0"></div>
<div id="t" style="width:80px;height:80px;background:#0af;transition:opacity 150ms linear"></div></body>`

const measure = `(async (seconds) => {
  const a = document.getElementById('a'), t = document.getElementById('t')
  let frames = 0, last = performance.now(), maxGap = 0, stalls = 0
  const end = performance.now() + seconds * 1000
  await new Promise((done) => {
    const onFrame = (now) => {
      frames++; const gap = now - last; last = now
      if (gap > maxGap) maxGap = gap
      if (gap > 250) stalls++
      if (now < end) requestAnimationFrame(onFrame); else done()
    }
    requestAnimationFrame(onFrame)
  })
  return { frames, maxGap: Math.round(maxGap), stalls }
})`

const cycles = `(async (seconds) => {
  const a = document.getElementById('a'), t = document.getElementById('t')
  const animation = [], transition = []
  let animationMissed = 0, transitionMissed = 0
  const end = performance.now() + seconds * 1000
  let on = false
  while (performance.now() < end) {
    const started = performance.now()
    const finished = a.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: 150 }).finished
    const took = await Promise.race([finished.then(() => performance.now() - started), new Promise((r) => setTimeout(() => r(null), 2000))])
    if (took === null) animationMissed++; else animation.push(took)
    on = !on
    const tStarted = performance.now()
    const ended = new Promise((r) => t.addEventListener('transitionend', () => r(performance.now() - tStarted), { once: true }))
    t.style.opacity = on ? '0.2' : '1'
    const tTook = await Promise.race([ended, new Promise((r) => setTimeout(() => r(null), 2000))])
    if (tTook === null) transitionMissed++; else transition.push(tTook)
    await new Promise((r) => setTimeout(r, 300 - Math.min(300, performance.now() - started)))
  }
  const stats = (list) => { const s = [...list].sort((x, y) => x - y); const at = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? -1); return { n: s.length, p50: at(0.5), p99: at(0.99), max: Math.round(s[s.length - 1] ?? -1) } }
  return { animation: stats(animation), animationMissed, transition: stats(transition), transitionMissed }
})`

app.whenReady().then(async () => {
  const report = { desktop: process.env.OFFSTAGE_DESKTOP ?? null, offscreen, seconds }
  try {
    const win = new BrowserWindow({
      width: 700,
      height: 500,
      show: false,
      ...(offscreen ? { x: -5000, y: -5000, skipTaskbar: true, focusable: false } : {}),
    })
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
    if (offscreen) win.showInactive()
    else win.show()
    const [frames, runs] = await Promise.all([
      win.webContents.executeJavaScript(`${measure}(${seconds})`),
      win.webContents.executeJavaScript(`${cycles}(${seconds})`),
    ])
    Object.assign(report, frames, runs)
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
  }
  process.stdout.write(JSON.stringify(report) + '\n')
  app.quit()
})
