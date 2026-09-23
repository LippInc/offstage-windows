// Playwright's Electron launch through electronLaunchOptions: run by test/selftest.mjs (with a watcher on the visible
// desktop), or alone with `pnpm exec playwright test -c test/playwright.config.cjs`.
const path = require('node:path')
const { test, expect, _electron } = require('@playwright/test')
const { electronLaunchOptions } = require('../../offstage.cjs')

const probe = path.join(__dirname, '..', 'electron-probe')

test('electronLaunchOptions starts Electron offstage, with Playwright loader in front as Playwright adds it', async () => {
  const app = await _electron.launch(electronLaunchOptions({ args: [probe, '--hold'] }))
  try {
    const page = await app.firstWindow()
    await expect(page).toHaveTitle('offstage electron probe')
    expect(await app.evaluate(() => process.env.OFFSTAGE_DESKTOP ?? '')).toMatch(/^offstage-/)
    // The loader defines this in the main process; without it Playwright would take the packaged-app path.
    expect(await app.evaluate(() => typeof globalThis.__playwright_run)).toBe('function')
    // The helper's own variables never reach the app.
    expect(
      await app.evaluate(() => Object.keys(process.env).filter((key) => /^OFFSTAGE_(EXEC|EXEC_PREPEND)$/i.test(key))),
    ).toEqual([])
    const field = page.getByLabel('Field')
    await field.click()
    await page.keyboard.type('typed offstage')
    await expect(field).toHaveValue('typed offstage')
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
    const shot = await page.screenshot()
    expect(shot.length).toBeGreaterThan(1000)
  } finally {
    await app.close()
  }
})

test('control: with an executablePath of its own, no loader goes in front (as Playwright does)', async () => {
  const app = await _electron.launch(
    electronLaunchOptions({ executablePath: require('electron'), args: [probe, '--hold'] }),
  )
  try {
    await app.firstWindow()
    expect(await app.evaluate(() => process.env.OFFSTAGE_DESKTOP ?? '')).toMatch(/^offstage-/)
    expect(await app.evaluate(() => typeof globalThis.__playwright_run)).toBe('undefined')
  } finally {
    await app.close()
  }
})
