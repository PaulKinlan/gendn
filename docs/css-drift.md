# On-demand computed-style drift check

`css-drift` compares rendered CSS on served reference pages at 1280×800 desktop and
360×740 mobile (DPR 3), using the repo's CDP browser. It is **not** the responsive
or conformance gate and does not replace browser interaction/accessibility review.

1. Before a CSS convergence wave, record a baseline from the unmodified tree:
   `deno task css-drift --record wave-name --routes 'v147/*'`
2. After the edit, with the same worktree and Chrome version:
   `deno task css-drift --compare wave-name --routes 'v147/*'`
3. Inspect `reports/css-drift/wave-name.diff.json` and the first route's
   `wave-name.{record,compare}.{desktop,mobile}.png` screenshots. Zero differences
   exits 0; computed-style differences exit 1; incomplete scans/invalid state exit 2.

`--routes` accepts a comma-separated list of exact routes or `*` globs, including
nested reference routes. For a deliberate full corpus run, substitute `--all` in
**both** commands (about 300 pages × 2 widths; several minutes). Neither mode
runs by default. Snapshots are uncommitted per-wave artifacts ignored under
`reports/css-drift/`; preserve the baseline across the edit, and choose a new
name for a new wave. The tool never overwrites a baseline, never silently compares
against a different route set or Chrome version, and aborts on failed local loads.

The check samples up to three nodes of each designated element/component selector
and selected computed CSS properties. Changes deeper in repeated tables or in
unselected selectors/properties are **not detected**. Animations/transitions are
disabled during collection; web fonts are awaited. Use `deno task responsive` and
visual inspection for broader UI coverage. For longer runs use a bounded
`fleet-gate` job rather than tying up a foreground lane.
