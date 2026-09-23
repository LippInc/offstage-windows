// The self-test's Playwright run (test/playwright/electron.spec.cjs).
module.exports = {
  testDir: require('node:path').join(__dirname, 'playwright'),
  testMatch: '*.spec.cjs',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
}
