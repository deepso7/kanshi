# AGENTS.md

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect/LLMS.md` first and inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy/` for examples of idiomatic usage, tests, module structure, and API design.
- When using tinybird sdk, refer to `.repos/tinybird-sdk-typescript/` for examples of idiomatic usage, tests and SDK for analytics database.
