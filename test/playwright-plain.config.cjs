// The self-test's wrapped Playwright run (test/playwright-plain/plain.spec.cjs).
module.exports = {
  testDir: require('node:path').join(__dirname, 'playwright-plain'),
  testMatch: '*.spec.cjs',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
}
