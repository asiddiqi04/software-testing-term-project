// StrykerJS config shared by every suite. Pick the suite with SUITE:
//   SUITE=codex npx stryker run      (default)
//   SUITE=stripped npx stryker run
// or use npm run mutation:codex / npm run mutation:stripped.
// The suite runs with a one-line-per-failure reporter so reports stay small.
const suite = process.env.SUITE ?? 'codex'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    command: `node --test --test-reporter=./scripts/brief-reporter.mjs "tests-${suite}/**/*.test.{js,mjs}"`,
  },
  coverageAnalysis: 'off',
  mutate: ['frontend/src/training/**/*.js', 'frontend/src/lib/**/*.js'],
  ignorePatterns: ['results', 'paper', 'coverage', 'reports'],
  reporters: ['clear-text', 'html', 'json', 'progress'],
  htmlReporter: { fileName: `results/mutation-${suite}.html` },
  jsonReporter: { fileName: `results/mutation-${suite}.json` },
  clearTextReporter: { allowColor: false, logTests: false },
  tempDirName: '.stryker-tmp',
  incremental: false,
}
