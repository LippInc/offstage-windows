// electron-probe: reports how an Electron window behaves where it runs (offstage or not), for the self-test.
// Usage: electron <this folder> [--offscreen] [--hold] [chromium switches...]
// Prints one JSON line: the desktop, GPU state, display and work area, focus, the page's visibility, how many animation
// frames and timer ticks it got, and the colour at the centre of two screenshots (capturePage and CDP), then quits.
// --offscreen puts the window far off-screen with no taskbar button and never focuses it, so a run on the visible desktop
// disturbs no one. --hold only opens the page (with a text field) and waits, for Playwright to drive.
const { app, BrowserWindow, screen } = require('electron')

const offscreen = process.argv.includes('--offscreen')
const hold = process.argv.includes('--hold')
const PAGE_COLOUR = [12, 200, 90]
const page = `<!doctype html><title>offstage electron probe</title>
<body style="margin:0;background:rgb(${PAGE_COLOUR.join(',')})"><div id="box" style="width:100px;height:100px;background:#000;transition:transform 300ms linear"></div>
<input id="field" aria-label="Field"></body>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function centre(image) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap() // BGRA
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return { width, height, rgb: [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]] }
}

if (hold) {
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      show: false,
      ...(offscreen ? { x: -5000, y: -5000, skipTaskbar: true, focusable: false } : {}),
    })
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
    if (offscreen) win.showInactive()
    else win.show()
  })
} else
  app.whenReady().then(async () => {
    const report = { desktop: process.env.OFFSTAGE_DESKTOP ?? null, argv: process.argv.slice(2) }
    try {
      const win = new BrowserWindow({
        width: 900,
        height: 600,
        show: false,
        ...(offscreen ? { x: -5000, y: -5000, skipTaskbar: true, focusable: false } : {}),
      })
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      if (offscreen) win.showInactive()
      else win.show()
      await sleep(300)
      const display = screen.getPrimaryDisplay()
      report.display = {
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        count: screen.getAllDisplays().length,
      }
      report.window = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() }
      report.renderer = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const box = document.getElementById('box')
      let frames = 0, ticks = 0
      const start = performance.now()
      const onFrame = () => { frames++; if (performance.now() - start < 1000) requestAnimationFrame(onFrame) }
      requestAnimationFrame(onFrame)
      const onTick = () => { ticks++; if (performance.now() - start < 1000) setTimeout(onTick, 0) }
      setTimeout(onTick, 0)
      box.getBoundingClientRect()
      box.style.transform = 'translateX(200px)'
      let transitionEnded = false
      box.addEventListener('transitionend', () => { transitionEnded = true })
      setTimeout(() => resolve({ visibility: document.visibilityState, hasFocus: document.hasFocus(), frames, ticks, transitionEnded }), 1100)
    })`)
      let started = Date.now()
      const captured = await Promise.race([win.webContents.capturePage(), sleep(20000).then(() => null)])
      report.capturePage = captured
        ? { ms: Date.now() - started, ...centre(captured) }
        : { ms: Date.now() - started, timedOut: true }
      win.webContents.debugger.attach('1.3')
      started = Date.now()
      const shot = await Promise.race([
        win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
        sleep(20000).then(() => null),
      ])
      report.cdpScreenshot = shot
        ? {
            ms: Date.now() - started,
            ...centre(require('electron').nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))),
          }
        : { ms: Date.now() - started, timedOut: true }
      win.maximize()
      await sleep(500)
      report.maximized = {
        isMaximized: win.isMaximized(),
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
      }
      report.gpu = app.getGPUFeatureStatus()
      const info = await app.getGPUInfo('basic')
      report.gpuDevice = (info.gpuDevice ?? [])
        .filter((d) => d.active)
        .map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId }))
      report.expectedCentre = PAGE_COLOUR
    } catch (error) {
      report.error = String(error && error.stack ? error.stack : error)
    }
    process.stdout.write(JSON.stringify(report) + '\n')
    app.quit()
  })
