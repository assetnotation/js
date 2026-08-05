# AGENTS.md

Rules for any agent or contributor working in this repo. They are not tied to a
particular tool. This file is tracked by git, so a fresh clone has it: it must
stand on its own. `README.md` covers what the package does and how to run it.

This is the reference implementation of the Asset Notation format: it validates a
document and converts to and from the spreadsheets people already keep. The
format itself is specified in `assetnotation/spec`, which is authoritative. When
the two disagree, the spec wins and this repo has a bug.

## The rule that is easiest to break here

**This repo never names another product.** Not fidalo, not selfstore, not
quitalo, not lacantabilite - in code, docs, examples, tests, commit messages or
PR bodies. The whole `assetnotation` organisation is under this rule, strictly
and without exception.

The reason is not modesty: an open notation that mentions one vendor's app in its
reference implementation stops looking like a standard. Examples use invented,
neutral data. If you need a realistic sample, invent one.

## The gate

```sh
npm run gate
```

= `format:check` + `lint` + `typecheck` + `test` + `build`. Green before every
push, no exception. When it is red, fix the cause: never weaken a rule or disable
a test to get through.

Behaviour changes ship with a test. A conversion is exactly the kind of code
where a silent regression is invisible until someone's data is wrong.

## Git

- `main` is the only long branch. Work goes through a branch and a pull request,
  never a direct push to `main`.
- Branch and PR names follow open-source convention: English, kebab-case, and
  **no tool prefix** - not `claude/`, not `agent/`, not `codex/`. A merge commit
  carries the branch name into the history for good.
- Commits: conventional, English, pure ASCII. Author is always
  Florian Mousseau <florian.mousseau@gmail.com>. **No AI mention anywhere** - no
  co-author line, no trailer, no branding. `gh pr create` sometimes adds a
  generated-by trailer: re-read the body and remove it.
- This repo is **public**. An agent prepares the pull request; the merge is
  Florian's call, and publishing to npm is his alone.

## Versions

Patch by default. The second digit moves for a real change of shape in the
implementation, not for one more exported helper. A breaking change follows the
spec's own major, never leads it.
