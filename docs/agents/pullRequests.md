# Pull request titles and releases

- Use `<type>: <summary>` or `<type>(<scope>): <summary>`, with a lowercase type and an imperative summary describing the resulting behavior.
- Choose the type from the change's release impact, rather than the files modified. For mixed changes, use the highest actual release impact.
- Update the title when the final PR scope changes. Keep the squash commit title consistent with the PR title.

| Change                                                                        | Title type                                                          | Craft version bump              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| New product behavior                                                          | `feat`                                                              | Minor                           |
| Bug fix                                                                       | `fix`                                                               | Patch                           |
| Security fix                                                                  | `security`                                                          | Patch                           |
| Performance, refactoring, build, CI, tests, style, maintenance, documentation | `perf`, `refactor`, `build`, `ci`, `test`, `style`, `chore`, `docs` | Patch                           |
| Incompatible change                                                           | Add `!` before the colon, such as `feat(contract)!:`                | Major, including before `1.0.0` |

- Use a scope such as `electron`, `interface`, `db`, `contract`, `scripts`, `ci`, or `release` when it clarifies the affected area.
- Describe the user-visible outcome where one exists: `fix(electron): Preserve unsaved edits when closing a database` or `feat(interface): Filter customers by outstanding balance`.
- For internal changes, describe the concrete tooling outcome: `ci: Run script tests independently of desktop acceptance`.
- Explain incompatible changes and migration steps in the PR body while retaining the `!` marker in the title.
- To supply more detailed release-note text, add a `### Changelog Entry` section to the PR body; retain the conventional title for version detection.
- Use `#skip-changelog` in the PR body only when deliberately excluding the change from both release notes and automatic version detection.

These rules match the conventional-commit defaults used by [.craft.yml](../../.craft.yml).
See [Craft's changelog and versioning configuration](https://craft.sentry.dev/configuration/#auto-mode) for matching rules and custom release configuration.
