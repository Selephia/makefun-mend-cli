# makefun-mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Selephia/makefun-mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Selephia/makefun-mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls to a tree of text files, finds the lines each edit names at three matching tiers, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or absent) to read it from standard input. `--format=unified|search-replace|v4a|json|auto` selects the format (auto-detected by default), `--check` reports what would change without writing, and `--strict` matches lines exactly. See `SPEC.md` for the full contract.

## Check it

```sh
node check.ts ../program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rhrzs01t&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
