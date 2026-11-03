# Contributing

The commit history is evidence of each member's contribution, so:

- **Commit under your own name.** Set `git config user.name` and
  `git config user.email` to your own details before your first commit.
  Don't commit someone else's work, and don't squash other people's commits.
- **Blind rule (Caleb and Benjamin).** Don't look at Codex's tests or any
  AI-generated suite until your own suite in `tests-human/` is committed. That
  includes the original ShadowBoxer repo. Rules in `tests-human/README.md`.
- **Never edit anything in `frontend/src/`.** It is the code under test and
  must stay byte-identical to the source commit. Planted bugs and mutants go
  in separate working copies, never on `main`.
- Keep raw results in `results/` and the paper source in `paper/`.
- `npm test` must pass on `main`. CI runs it on every push and pull request.
