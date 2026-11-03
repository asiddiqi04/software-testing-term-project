# tests-human

Hand-written test suites by Caleb and Benjamin.

## Rules

- **Blind.** Do not look at Codex's tests or any AI-generated suite before
  you finish your own. That includes the original ShadowBoxer repo, other
  branches, and teammates' screens. Only read the code under test in
  `frontend/src/training/` and `frontend/src/lib/`.
- **Time-boxed.** Work within the agreed time limit and record your start and
  end times in your commit messages or in `results/`.
- **No AI help.** Write the tests yourself, without AI assistants or code
  completion that generates tests.
- **Don't edit the code under test.** If you think you have found a bug, write
  a test that shows it and note it. Do not fix it.

## Layout

Put each person's suite in its own subfolder so test files sit one level
deeper. Imports then use `../../frontend/src/...`:

```
tests-human/
  caleb/      *.test.mjs
  benjamin/   *.test.mjs
```

Use Node's built-in runner (`import test from 'node:test'`,
`import assert from 'node:assert/strict'`). `fake-indexeddb` is available
for testing `sessionStorage.js`. Run everything with `npm test` and
coverage with `npm run coverage`.
