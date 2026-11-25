# CIS*4150 AI-test study: code under test and test suites

This repository holds the code under test and the test suites for a
CIS*4150 Software Reliability and Testing study on whether AI-generated tests
protect software reliability. The code under test is the plain-JavaScript logic
of ShadowBoxer (a browser-based boxing trainer), taken from ShadowBoxer commit
`c023fef`: `frontend/src/training/` and `frontend/src/lib/`. The React UI, pose
detection, build tooling and deployment are not included.

## Test suites

- `tests-codex/`: Suite 1. The tests OpenAI Codex wrote for ShadowBoxer while
  building it, copied unmodified from commit `c023fef` (in-scope files only).
- `tests-stripped/`: Suite 2. An assertion-stripped control generated from
  Suite 1. Each file matches its original except that `node:assert/strict`
  points at a stub where every assertion is a no-op.
- `tests-ai/`: Suite 3. One-shot AI-generated suites, one subfolder per run,
  committed exactly as generated.

## Running the tests

Requires Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm test
```

## Mutation testing

Mutation testing uses StrykerJS (`stryker.config.mjs`). Pick the suite with
`SUITE`:

```sh
SUITE=codex npx stryker run       # Codex's original tests
SUITE=stripped npx stryker run    # assertion-stripped copy
```

It mutates only `frontend/src/training/` and `frontend/src/lib/`, and writes
its HTML and JSON reports to `results/`.
