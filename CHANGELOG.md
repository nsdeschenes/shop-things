# Changelog
## 1.0.0

### Breaking Changes 🛠

- (customers) Require a number for every saved customer by @nsdeschenes in [#153](https://github.com/nsdeschenes/shop-things/pull/153)
- (electron) Name the Debian package shop-things by @nsdeschenes in [#162](https://github.com/nsdeschenes/shop-things/pull/162)

### New Features ✨

- (interface) Open customers by number from the header by @nsdeschenes in [#189](https://github.com/nsdeschenes/shop-things/pull/189)

### Internal Changes 🔧

#### Interface

- Type-check the generated route tree by @nsdeschenes in [#172](https://github.com/nsdeschenes/shop-things/pull/172)
- Derive draft protection registration readiness by @nsdeschenes in [#164](https://github.com/nsdeschenes/shop-things/pull/164)
- Remove query dependency suppressions by @nsdeschenes in [#161](https://github.com/nsdeschenes/shop-things/pull/161)

#### Lint

- Remove component export enforcement by @nsdeschenes in [#170](https://github.com/nsdeschenes/shop-things/pull/170)
- Remove default export enforcement by @nsdeschenes in [#169](https://github.com/nsdeschenes/shop-things/pull/169)
- Remove obsolete node test exception by @nsdeschenes in [#166](https://github.com/nsdeschenes/shop-things/pull/166)
- Enable no-misused-spread enforcement by @nsdeschenes in [#163](https://github.com/nsdeschenes/shop-things/pull/163)
- Remove redundant restricted-imports override by @nsdeschenes in [#160](https://github.com/nsdeschenes/shop-things/pull/160)

#### Scripts

- Isolate real builds in current-source fixtures by @nsdeschenes in [#188](https://github.com/nsdeschenes/shop-things/pull/188)
- Select the locked development runtime by @nsdeschenes in [#187](https://github.com/nsdeschenes/shop-things/pull/187)
- Split acceptance assertions into scenario tests by @nsdeschenes in [#167](https://github.com/nsdeschenes/shop-things/pull/167)

#### Other

- (acceptance) Remove unbound startup method suppression by @nsdeschenes in [#165](https://github.com/nsdeschenes/shop-things/pull/165)
- (contract) Remove unnecessary negative-test suppression by @nsdeschenes in [#173](https://github.com/nsdeschenes/shop-things/pull/173)
- (types) Narrow declaration checking exceptions by @nsdeschenes in [#171](https://github.com/nsdeschenes/shop-things/pull/171)

## 0.3.1

### New Features ✨

- (interface) Add a database settings overview by @nsdeschenes in [#128](https://github.com/nsdeschenes/shop-things/pull/128)

### Bug Fixes 🐛

- (customers) Sort customers by customer number by @nsdeschenes in [#126](https://github.com/nsdeschenes/shop-things/pull/126)
- (electron) Include the GPL license in packaged applications by @nsdeschenes in [#146](https://github.com/nsdeschenes/shop-things/pull/146)
- (interface) Place customer back navigation above the heading by @nsdeschenes in [#127](https://github.com/nsdeschenes/shop-things/pull/127)

### Internal Changes 🔧

- Run desktop checks in parallel after dependency caching by @nsdeschenes in [#147](https://github.com/nsdeschenes/shop-things/pull/147)

### Other

- Add GNU GPL v3 License by @nsdeschenes in [#144](https://github.com/nsdeschenes/shop-things/pull/144)

## 0.3.0

### Bug Fixes 🐛

- (interface) Adjust customer balance order and email label by @nsdeschenes in [#122](https://github.com/nsdeschenes/shop-things/pull/122)

## 0.2.0

### New Features ✨

- Use timestamped database backup names and align balance fields by @nsdeschenes in [#120](https://github.com/nsdeschenes/shop-things/pull/120)

### Internal Changes 🔧

- (release) Build and publish the Linux ARM64 installer by @nsdeschenes in [#119](https://github.com/nsdeschenes/shop-things/pull/119)

## 0.1.1

### New Features ✨

#### Customers

- Apply the customer book experience by @nsdeschenes in [#111](https://github.com/nsdeschenes/shop-things/pull/111)
- Add header refresh for customer data by @nsdeschenes in [#100](https://github.com/nsdeschenes/shop-things/pull/100)
- Import CSV customers with review and atomic saving by @nsdeschenes in [#109](https://github.com/nsdeschenes/shop-things/pull/109)
- Improve number fields and delete confirmation by @nsdeschenes in [#90](https://github.com/nsdeschenes/shop-things/pull/90)
- Edit records directly and improve save feedback by @nsdeschenes in [#89](https://github.com/nsdeschenes/shop-things/pull/89)
- Disable editing during Save by @nsdeschenes in [#84](https://github.com/nsdeschenes/shop-things/pull/84)

#### Db

- Add customers schema and initial migration by @nsdeschenes in [#18](https://github.com/nsdeschenes/shop-things/pull/18)
- Add typed local database and migration foundation by @nsdeschenes in [#17](https://github.com/nsdeschenes/shop-things/pull/17)

#### Interface

- Improve database actions and app-wide feedback by @nsdeschenes in [#88](https://github.com/nsdeschenes/shop-things/pull/88)
- Coordinate customer loading with TanStack Router by @nsdeschenes in [#87](https://github.com/nsdeschenes/shop-things/pull/87)
- Connect protected Electron workflows by @nsdeschenes in [#68](https://github.com/nsdeschenes/shop-things/pull/68)
- Validate customer forms and add province selection by @nsdeschenes in [#44](https://github.com/nsdeschenes/shop-things/pull/44)
- Build customer list and form previews by @nsdeschenes in [#43](https://github.com/nsdeschenes/shop-things/pull/43)
- Scaffold initial customer routes by @nsdeschenes in [#25](https://github.com/nsdeschenes/shop-things/pull/25)
- Add StyleX styling and build integration by @nsdeschenes in [#23](https://github.com/nsdeschenes/shop-things/pull/23)
- Add TanStack Query client by @nsdeschenes in [#21](https://github.com/nsdeschenes/shop-things/pull/21)
- Add TanStack Router navigation by @nsdeschenes in [#20](https://github.com/nsdeschenes/shop-things/pull/20)

#### Other

- (backend) Add customer lifecycle and workspace contract by @nsdeschenes in [#42](https://github.com/nsdeschenes/shop-things/pull/42)
- (electron) Integrate Vite renderer with desktop builds by @nsdeschenes in [#2](https://github.com/nsdeschenes/shop-things/pull/2)

### Bug Fixes 🐛

#### Release

- Accept Craft-generated changelog formatting by @nsdeschenes in [#116](https://github.com/nsdeschenes/shop-things/pull/116)
- Avoid Craft changelog output path collision by @nsdeschenes in [#114](https://github.com/nsdeschenes/shop-things/pull/114)
- Fix first-release versioning and preview changelogs by @nsdeschenes in [#113](https://github.com/nsdeschenes/shop-things/pull/113)

#### Other

- (ci) Stabilize acceptance artifact and readiness checks by @nsdeschenes in [#117](https://github.com/nsdeschenes/shop-things/pull/117)
- (customers) Restore form validation and province selection by @nsdeschenes in [#99](https://github.com/nsdeschenes/shop-things/pull/99)
- (dev) Enable TypeScript loading in child tools by @nsdeschenes in [#45](https://github.com/nsdeschenes/shop-things/pull/45)

### Internal Changes 🔧

#### Release

- 0.1.0 by @github-actions in [#115](https://github.com/nsdeschenes/shop-things/pull/115)
- Add Craft desktop releases by @nsdeschenes in [#112](https://github.com/nsdeschenes/shop-things/pull/112)

#### Other

- (acceptance) Report current automated results by @nsdeschenes in [#82](https://github.com/nsdeschenes/shop-things/pull/82)
- (customers) Rename home phone throughout the stack by @nsdeschenes in [#91](https://github.com/nsdeschenes/shop-things/pull/91)
- (interface) Extract shared application shell by @nsdeschenes in [#86](https://github.com/nsdeschenes/shop-things/pull/86)
- (preview) Limit browser preview to temporary customers by @nsdeschenes in [#81](https://github.com/nsdeschenes/shop-things/pull/81)
- Gate acceptance on source checks and enable Electron sandbox by @nsdeschenes in [#102](https://github.com/nsdeschenes/shop-things/pull/102)
- Add TypeScript Vitest suites across packages by @nsdeschenes in [#24](https://github.com/nsdeschenes/shop-things/pull/24)
- Setup skills by @nsdeschenes in [#4](https://github.com/nsdeschenes/shop-things/pull/4)
- Add formatter and linter by @nsdeschenes in [#3](https://github.com/nsdeschenes/shop-things/pull/3)
- Setup initial application by @nsdeschenes in [#1](https://github.com/nsdeschenes/shop-things/pull/1)

### Other

- init nub app by @nsdeschenes in [217d0604](https://github.com/nsdeschenes/shop-things/commit/217d0604dc7f51a7a09feb1b2b52a724a3224487)
