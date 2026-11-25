# tests-ai

One-shot AI-generated test suites go here: 5 runs from one fixed prompt.

- Use the same prompt, unchanged, for every run. Store the exact prompt and
  the model/tool name, version and date alongside the suites.
- Commit each run's output exactly as generated, in its own subfolder
  (`run-1/` … `run-5/`). Don't fix, edit or delete generated tests. A suite
  that doesn't run is itself a result.
- Files in a subfolder import the code under test with `../../frontend/src/...`.
