# Do AI-Generated Tests Protect Software Reliability? A Case Study on ShadowBoxer

Term project for **CIS\*4150 Software Reliability and Testing**, University of Guelph (Fall 2026).

**Group members:** Adil Siddiqi, Caleb, Benjamin <!-- TODO: full names -->

## Research question

As AI is increasingly used to write tests, are those tests effective enough to
protect software reliability?

Sub-question: does higher code coverage mean more faults found?

## Subject program

ShadowBoxer is a browser-based boxing trainer. It uses webcam pose detection
(TensorFlow.js) to recognise jabs, crosses, hooks and uppercuts in real time,
guides the user through timed rounds and combos, and saves workout history
locally. It is a React/Vite web app, built almost entirely with an AI coding
agent.

## Scope

**In scope:** the plain-JavaScript logic modules, which run in Node without a browser.

- `frontend/src/training/`: `punchClassifier`, `comboService`, `trainingService`, `speedProfiles`, `validators`
- `frontend/src/lib/`: `sessionStorage`, `completionQueue`, `poseRecording`, `poseModelConfig`

**Out of scope:** the React UI, webcam capture and pose detection, build
tooling (including pose-model preparation), and deployment. These were removed
from this repo.

## Study design

Three sets of tests are run against the same code under test:

1. **Codex:** the tests Codex wrote while developing ShadowBoxer (`tests-codex/`)
2. **AI one-shot:** fresh AI-generated suites from one fixed prompt, 5 runs (`tests-ai/`)
3. **Human:** suites written by hand, time-boxed and blind (`tests-human/`)

Measures: whether the tests run; tests that pass while checking nothing
useful; line and branch coverage; mutation score (StrykerJS); and detection
of hand-planted faults.

## Layout

```
frontend/src/training/   code under test (byte-identical to source commit; do not edit)
frontend/src/lib/        code under test (byte-identical to source commit; do not edit)
tests-codex/             Codex's original tests (added after the human tests are written)
tests-human/             hand-written suites (blind, time-boxed)
tests-ai/                one-shot AI-generated suites
results/                 raw results and analysis output
paper/                   LaTeX source of the paper
```

The test folders sit one level below the root, so Codex's tests import the
code under test with `../frontend/src/...`, exactly as they did in the
original repository.

## Running

### With Docker (recommended)

Needs only [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(or Docker Engine with the Compose plugin). It runs everything in a pinned
Node 22.18.0 container, so everyone tests with the same Node version.

```sh
git clone <repo-url>
cd cis4150-ai-test-study
docker compose run --rm test        # install dependencies, then npm test
docker compose run --rm coverage    # install dependencies, then npm run coverage
```

The repo is mounted into the container, so new or edited test files are
picked up on the next run without rebuilding anything. Dependencies are
kept in a Docker volume. Remove it with `docker compose down -v` to start
fresh.

### With Node installed locally

Requires Node.js 22 (see `.nvmrc`).

```sh
nvm use
npm ci
npm test            # runs every *.test.mjs / *.test.js under tests-codex, tests-human and tests-ai
npm run coverage    # same, with Node's built-in line/branch/function coverage
                    # limited to frontend/src/training and frontend/src/lib
```

Note: Node's coverage only reports files that a test actually loads. A module
no test imports does not appear in the report as 0%.

## Provenance

- **Source:** ShadowBoxer commit `c023fef1a412dde39f8bc5b250fd0b0b081a77e6`
  (Oct 19, 2026). The files in `frontend/src/training/` and `frontend/src/lib/`
  are byte-identical to that commit. This repository starts a fresh history;
  no ShadowBoxer history was carried over.
- **Authorship:** ShadowBoxer was built with OpenAI Codex. Codex also wrote
  all of the original tests. They were never edited or reviewed by a human
  before this study.
- TODO(Adil): Codex model/version and dates
