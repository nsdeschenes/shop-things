# Backend acceptance

Specification: https://github.com/nsdeschenes/shop-things/issues/33

Implementation graph: contract (#34) and database (#35) → startup/session actions
(#36) → protected switching/close (#37) → export/backup/restore (#38) → authorized
IPC and bundled unattached preload (#39) → build orchestration (#40) → Linux
x64 shipped-backend acceptance (#41).

Acceptance requires real temporary database checks, contract conformance under
both consumer compiler configurations, an injected-client connected proof, and
Linux glibc x64 packaged Electron backend execution tied to the commit/artifact.
Required failures or missing evidence block acceptance.

The preload remains unattached. Interface screens/forms/DTOs and renderer-dependent
transition/close hooks stay inactive in the placeholder app. Real renderer IPC,
security/navigation, drafts/save races, subscriptions, watcher behavior, native
GUI dialogs and GUI installation remain deferred. macOS arm64, Windows x64 and
Linux arm64 require separate verification.
