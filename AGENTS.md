# Liekan engineering rules

GEOInflow is the product display name of the Liekan MIT derivative of Umami, with a separate GEO statistics UI. Display version v1.2 maps to build version 1.2.0. Joint publishers are 猎看科技 and 北京日报社智源GEO; preserve these names in both locales and retain existing Liekan technical identifiers, data, copyright and deployment resources.

- UI authority: design/reference/geo-stats-v3 and supplemental feature-ui SHA-256 manifests. Preserve original HTML, chart form, table fields, spacing and colors. Approved 0.2.2 navigation/header/copy changes use config/liekan/navigation-ui.json; keep original body/chart checks alongside the incremental navigation gate. No autonomous redesign.
- User approved phase-one implementation, local branches/commits, isolated database and Docker on 127.0.0.1:3002. Do not modify the original Umami checkout or its data volume. Remote publication requires explicit user authorization for the destination and visibility.
- Work on feature/* or upstream-sync/* and freeze a verified candidate on main. Only the root controller commits, stages or changes branches while collaborators work.
- Product pages consume Liekan contracts. Upstream query/auth/permission imports belong only to src/lib/liekan/upstream. Register necessary core changes in config/liekan/core-overrides.json.
- Keep existing tracker API, database schema, SDK names and MIT copyright compatible. Own SQL migrations are incremental and immutable after use. Never reset a joined database.
- The initial Liekan login is admin / liekan. Apply the product default only to the unchanged upstream initial administrator; preserve customized credentials, renamed identities, roles and deleted accounts on upgrades and restarts.
- No fake production analytics. Empty, missing input, estimated and unsupported states are distinct. Demonstration data is explicitly named and isolated.
- Browser traffic quality uses one versioned policy across analytics, cursor reads, referrals and exports. PostgreSQL owns policy and control authority; ClickHouse projections are read at the accepted publication and policy versions. Raw collection-presence metadata stays independent of the eligible population. Historical missing verdicts stay unknown. Preserve cookieless defaults and upstream ClickHouse/link/pixel behavior. See docs/traffic-quality.md.
- Optional website event UUID receipts, events, properties, revenue and quality evidence form one durable, verified event package with atomic business confirmation and publication. A successful collection response requires the complete package and its accepted decision; partial or unaccepted writes stay invisible. Public payload overrides never establish trusted provenance. Only explicitly configured ingress headers or the authorized server collector can supply trusted IP evidence. Quality and receipt tables must not retain raw IP or full UA.
- The default bundled example is “猎看官网（示例数据）” at www.liekan.com. Initialize it with pnpm liekan:seed-demo after migrations. Keep the compressed fixture and its SHA-256 manifest together, preserve existing populated/deleted examples and administrator credentials, and verify import in an isolated database. See docs/default-demo.md.
- Never log/commit credentials or raw visitor IP. Parameterize SQL, validate website permissions and reject partial 2FA and public share identities for new endpoints.
- One-command Docker deployment uses scripts/liekan-deploy.sh and preserves existing configuration and database credentials. Geography defaults to DB-IP City Lite with visible attribution; valid authorized City MMDB files take precedence. Missing geography never prevents event collection. See docs/local-deployment.md.
- Select verification by change scope using the rules below. Full release/upstream verification covers pnpm frozen install, types, meaningful unit/API tests, generator consistency, original visual reference, production build and Docker migration. Upstream release checks also preserve local device/geography fixes.
- No rhetorical contrast templates in authored prose. Do not commit process plans, local review reports, temporary outputs, screenshots or database dumps.

- Navigation lives in src/lib/liekan/contracts/navigation.ts and the shared Navigation component. Global management, website analytics, account, admin, authentication and public share contexts stay distinct; private analytics require an explicit website ID. Resource metadata determines ownership; cross-site navigation clears site-owned conditions and identifiers. See docs/navigation.md.

- Crawler control uses independent Zone credentials, durable preview/confirmation and per-Zone leases. Unknown provider results quarantine the Zone across disconnected/frozen connections. Read-only handoff reconciliation never transfers write authority; adoption requires a separate confirmed preview. See docs/crawler-control.md.
- Crawler risk quality must distinguish missing input, unknown continuity, partial gaps and proved observed-file coverage. Preserve classification versions, epoch fencing, late-data correction and self-check exclusion.

- UI language is zh-CN or en-US. Browser preference and the same-origin locale cookie persist after logout. Translate display text while preserving resource IDs, raw visitor/user content, snapshot identity and Monday-to-Sunday natural weeks. New AI runs and human-readable exports capture locale at submission. See docs/i18n.md.

- Historical upgrade repair preserves raw collection verdicts and GEO proof, publishes only explicitly confirmed generations, and rechecks website authority at each batch. Keep repair metadata, source boundaries, analytics revisions and rollback generations consistent; see docs/history-repair.md.

## Verification scope and stop conditions

- Before testing, identify the changed behavior and its direct dependencies. Choose the smallest set of checks that proves the requested behavior and covers the affected risks.
- Ordinary features, bug fixes and local development merges use targeted regression checks, plus types, API checks or builds where the change requires them. Do not make the full release acceptance pipeline a routine merge prerequisite.
- For shared UI changes, check representative affected pages, locales and desktop/mobile layouts. Expand coverage when a page has distinct behavior or a concrete coverage gap appears.
- Reuse passing evidence while the relevant code, dependencies and runtime inputs remain unchanged. A new commit hash, documentation edit or test-script-only change does not require rerunning unrelated product checks. Retain the actual tested revision and state the scope of reused evidence.
- After a fix, rerun the failed check and checks affected by that fix. Broaden testing only for a new failure, a specific unresolved risk or demonstrated wider impact. Stop when the necessary checks pass.
- Reserve full release acceptance for an explicitly requested release/upstream synchronization or a demonstrated risk spanning multiple subsystems. State the trigger before starting it. Keep required release gates when a release is in scope.
- Diagnose stale fixtures, expected asynchronous retries and test-infrastructure failures within the failing scenario. Keep unrelated test-infrastructure repairs separate from the feature. Preserve production safeguards, report real product failures and never manufacture passing evidence.
- Documentation/instruction-only edits require a scoped diff and formatting review. Do not run application suites, rebuild containers or restart services for these edits.
- Briefly report checks run or reused, checks intentionally omitted and any remaining material gaps. Claim a full release pass only after the required release checks complete.
