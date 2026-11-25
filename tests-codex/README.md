# tests-codex

Suite 1: the tests OpenAI Codex wrote for ShadowBoxer while building it,
copied unmodified from source commit `c023fef`.

Only the in-scope files are included. `models.test.mjs` is excluded because it
tests the pose-model build script, which is out of scope.

These files must stay byte-identical to the originals and match the checksums
recorded before the study started. Never edit them; the control suite in
`tests-stripped/` is generated from them by a script.
