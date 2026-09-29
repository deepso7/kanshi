# anti-slop Effect rules (vendored)

The opt-in Effect rule group of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
registered in `oxlint.config.ts` as the `anti-slop-effect` JS plugin.

- Source: https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/effect
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (main, 2026-09-29)
- License: MIT, see `LICENSE` (copied from upstream).

Upstream is meant to be vendored; it has no official npm package. The
generic anti-slop rules come from `ultracite/oxlint/anti-slop` instead, so
only `src/effect/` is copied here: `index.ts`, `rules/*.ts` and
`shared/tagged-values.ts`, unmodified. Upstream's RuleTester suites
(`*.test.ts`) are not copied. The rules import `@oxlint/plugins`, which is a
dev dependency pinned to the installed `oxlint` version.

Rules (all enabled at `error`, as upstream recommends):
`no-manual-effect-error-tag`, `no-manual-tag-comparison`,
`no-manual-tagged-construction`, `no-service-constructor-imports`,
`prefer-effect-match`.

This directory is excluded from oxlint and oxfmt. To update, diff
`src/effect/` of a newer upstream commit against these files and bump the
commit above.
