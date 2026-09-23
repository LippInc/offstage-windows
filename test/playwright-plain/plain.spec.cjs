// A whole Playwright run wrapped by the CLI (`npx offstage-windows playwright test`): this spec launches Electron the plain
// way, with nothing of offstage in it, and its window must still open offstage. Run by test/selftest.mjs, once wrapped and
// once not (the control, with the probe far off-screen so that run disturbs no one: it must fail at the first check).
const path = require('node:path')
const { test, expect, _electron } = require('@playwright/test')

const probe = path.join(__dirname, '..', 'electron-probe')

test('a plain Electron launch inside a wrapped run opens offstage', async () => {
  const app = await _electron.launch({
    args: [probe, '--hold', ...(process.env.PROBE_OFFSCREEN ? ['--offscreen'] : [])],
  })
  try {
    expect(await app.evaluate(() => process.env.OFFSTAGE_DESKTOP ?? 'not offstage')).toMatch(/^offstage-/)
    const page = await app.firstWindow()
    await expect(page).toHaveTitle('offstage electron probe')
    const field = page.getByLabel('Field')
    await field.click()
    await page.keyboard.type('typed offstage')
    await expect(field).toHaveValue('typed offstage')
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
  } finally {
    await app.close()
  }
})
