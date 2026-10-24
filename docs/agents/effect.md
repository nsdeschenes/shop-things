# Effect and reference repositories

Application code uses the installed `effect` package. The `repos/` trees are read-only source references, excluded from workspace builds, lint, and formatting.

## Source references

- `repos/effect/` is the Effect repository at `effect@4.0.6`, commit `3b28bf686bf26e9700edd39c025aff2744dc5303`.
- `repos/effect/packages/effect/src/` and its neighboring `test/` directory define the pinned runtime APIs and examples.

Use the installed Shop Things version and `repos/effect/` to confirm API availability.

## Update a reference

Start with a clean working tree. Run `scripts/update-subtrees.sh effect effect@<version>`. The script uses squashed git subtrees, matching the convention in flightsim-things.

Update this document with the selected revision. When the runtime dependency changes, update its exact package versions and lockfile, then run the application checks.
