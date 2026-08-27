# Changelog

All notable changes to the Agentic Browser project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.0.50] - 2026-08-27

### Fixed

- **Native copy for selected text** — selecting text in the app could only be quoted, never copied. Two independent paths were broken at once: renderer keydown listeners bound `Ctrl+C` to pause/cancel and swallowed the event whenever focus sat outside an input, and Electron ships no default context menu, so right-click offered nothing either. A shared guard now yields to the browser whenever a real selection is being copied, and app UI windows gained a standard edit context menu. Automation-driven browser views are deliberately excluded so agent page interaction is never blocked by a native popup.

### Verification

- TypeScript typecheck passed and ESLint reported no errors on the changed files.
- Window creation suites (`logsPill`, `pillWindow`) pass; the remaining unit failures are pre-existing POSIX path assumptions that fail on Windows and are unrelated to this change.

**Package delta:** Desktop `0.0.49..0.0.50`; renderer shortcut handling and main-process context menus only, no session or schema changes.

## [0.0.49] - 2026-08-27

### Fixed

- **Complete CDP readiness enforcement** — the ownership gate introduced in `0.0.48` now covers new tasks, follow-ups/resumes, and reruns. No engine entry point can receive an unreachable or foreign CDP endpoint.

### Verification

- TypeScript typecheck passed and the final Windows installer was rebuilt after auditing every `runEngine` call site.

**Package delta:** Desktop `0.0.48..0.0.49`; this is the final replacement build for the CDP-collision repair.

## [0.0.48] - 2026-08-27

### Fixed

- **Occupied CDP override recovery** — `AGB_CDP_PORT` and explicit debugging-port requests are now treated as preferences. If Windows already owns or excludes the requested port, Desktop selects a free high port before Chromium starts instead of advertising a dead endpoint to Claude Code, Codex, Pi, or BrowserCode.
- **CDP ownership startup gate** — Desktop now waits for `/json/version` to prove that the debugging endpoint belongs to this exact Electron instance. Browser tasks and the integrated extension sync receiver cannot start against an unreachable endpoint or another Chromium profile.
- **Per-run Harness cleanup** — the conversation-scoped Browser Harness REPL is stopped when its owning engine run ends. Reruns retain one persistent REPL while active without accumulating detached Bun processes on obsolete resource ports.
- **Actionable diagnostics** — startup logs retain both the requested and effective CDP port, and a rare post-bind race fails the task preflight explicitly instead of producing repeated, misleading “Chromium debugging port not connected” loops.

### Verification

- Startup port parser and collision regression suite: 29/29 passed.
- Focused Browser Harness target-isolation, timeout, runner, and cleanup-adjacent suite: 15 passed, 1 platform-specific test skipped.
- TypeScript typecheck passed before packaging.

**Package delta:** Desktop `0.0.47..0.0.48`; companion authentication extension remains `0.4.3` and continues to connect directly to Desktop's integrated loopback receiver.

## [0.0.47] - 2026-08-27

### Fixed

- **Single-source authentication ownership** — every extension write now carries a persistent Chrome Profile source ID, a fresh worker epoch, and one global monotonic revision shared by Cookie snapshots, Cookie changes, and Web Storage. Desktop binds the first active source to a renewable 120-second lease and rejects competing Profiles, retired workers, stale revisions, and unidentified legacy writers before they can mutate destination state.
- **Latest-state delivery** — the extension sends all authentication mutations through one ordered outbound pipeline. A newer full snapshot can no longer be swallowed by an older in-flight request, and retried work cannot overtake later Cookie or Storage state.
- **Complete Cookie discovery** — full snapshots merge Chrome's ordinary and partition-aware Cookie views and deduplicate by the complete Cookie identity. Browser-version differences in `chrome.cookies.getAll` no longer turn a valid ordinary Cookie into a false deletion.
- **Exact Cookie readback** — each Space verifies the complete non-expired Cookie set through its attached target session, including value and partition identity. A CDP command that succeeds while retaining an old value is now reported as degraded instead of a false success; host-only and domain Cookies with the same name remain distinct.
- **Stable multi-tab reconciliation** — all pages in Chromium's default browser context are treated as one Cookie jar, so opening another tab does not trigger a second clear-and-seed cycle for the same Space.
- **Independent health accounting** — Cookie and Web Storage generations retain separate success and failure state. A successful Storage write can no longer hide a Cookie failure, and the extension popup only reports success after the aggregate receiver state is verified.
- **Deterministic live acceptance** — the release verifier waits for Cookie, localStorage, and sessionStorage convergence instead of treating page load completion as authentication completion. Diagnostics use the same target-session Cookie boundary as production and avoid Electron's invalid browser-context identifier path.

### Verification

- Companion extension syntax checks and complete unit suite: 19/19 passed with source/epoch/global-revision, trailing latest snapshot, dual Cookie view, retry, and invalidated-context coverage.
- Focused Desktop auth-sync, provider, Browser Harness, multi-page Space, screencast, renderer, and Windows-path suite: 189 passed, 1 platform-specific test skipped.
- Full Desktop unit suite under Node 22: 736 passed, 5 skipped. The same 8 pre-existing Windows/POSIX portability or timing failures recorded for `0.0.43..0.0.46` remain outside this release path.
- Live acceptance creates a new Pi Space and requires a random sentinel to match in request Cookies, `document.cookie`, localStorage, and sessionStorage before packaging is accepted.

**Package delta:** Desktop `0.0.46..0.0.47`; companion authentication extension `0.4.2..0.4.3`. The extension still connects directly to Desktop's integrated loopback receiver; no standalone synchronization service or startup task is restored.

## [0.0.46] - 2026-08-27

### Fixed

- **Fresh Pi reruns** — a new run now receives a fresh provider-side conversation UUID instead of reusing the durable Desktop session ID. Rerunning a task can no longer reopen an old Pi transcript and act on stale browser targets; explicit resume still uses the provider conversation captured from the paused run.
- **Bounded Browser Harness execution** — CDP calls, target discovery, the local evaluation endpoint, and its shell client now have explicit time limits and cleanup paths. A stalled page script or nested shell no longer leaves the task spinning forever, and timed-out per-session REPL workers are discarded before the next command.
- **Async target discovery misuse** — `listPageTargets()` remains awaitable but now fails immediately with an actionable error when code tries to spread, search, enumerate, or serialize the unresolved Promise. Agent guidance and interaction docs consistently require `await listPageTargets()`.
- **Duplicate OA workflow windows** — repeated `window.open()` calls from the same opener reuse the recently created managed page when the business URL is equivalent. Volatile `_rdm` and `_key` parameters no longer turn one workflow into many tabs, while different business parameters, different openers, and intentional later opens remain independent.
- **Transactional form handling** — every provider receives the same rules for one-field-at-a-time mutation, real input/change events, exact field readback, failure inspection before retry, no business-value guessing, confirmation before irreversible actions, and post-save verification.
- **Reliable authentication mirroring** — extension snapshots, Cookie changes, Storage updates, target events, and periodic reconciliation now pass through one ordered CDP writer. Target events are coalesced, target attachment is single-flight, stale sessions get one bounded retry, and timeout/disconnect failures recycle the poisoned CDP connection instead of exploding a failed batch into thousands of per-Cookie commands.
- **Exact new-Space state** — a new or unverified Space clears its previous Cookie jar before receiving the full Chrome snapshot, then reads Cookies back through its own target session. Verified Spaces receive only snapshot diffs; Cookie deletions remain as tombstones until every Space confirms removal, including same-name partitioned Cookies.
- **Exact Web Storage state** — localStorage and sessionStorage are treated as complete per-origin snapshots: obsolete destination keys are cleared, current keys are written, and the entire expected key set is read back before a Space can become healthy.
- **Truthful sync status** — the integrated receiver reports waiting, degraded, and running separately with per-Space applied/verified/failed/skipped counts, backlog, last successful apply time, and the current error. The companion extension only displays “已同步” when Desktop and source are connected and every discovered Space has passed readback verification.
- **Bounded extension delivery** — the companion extension `0.4.2` shares concurrent full snapshots, gives them a dedicated 60-second deadline, merges Cookie bursts by key, serializes mutation delivery, and falls back to a complete snapshot after a failed tail. Extension reloads, invalidated contexts, and failed fetches are caught at every asynchronous entry point instead of surfacing as unhandled errors.
- **Auth-sync startup resilience** — a loopback port conflict is contained to the integrated extension receiver and no longer aborts Desktop startup; a partially created sync engine is closed before the app continues with a clear diagnostic.
- **Release portability** — the Windows Explorer path regression fixture no longer embeds a developer-specific user profile path.

### Verification

- Focused provider, rerun, BrowserPool, Browser Harness, auth-sync, multi-page UI, and Windows-path regression suite: 180 passed, 1 platform-specific test skipped.
- Companion extension: 14/14 tests passed; all three shipped JavaScript entry points passed syntax validation.
- Full Desktop unit suite under the repository-required Node 22 runtime: 731 passed, 5 skipped. The same 8 pre-existing Windows/POSIX portability or timing failures recorded for `0.0.43` remain outside this release path.
- Live release acceptance uses a random Cookie/localStorage/sessionStorage sentinel and requires target-session Cookie plus in-page Storage readback in a newly created Space; receiver health alone is not accepted as proof.

**Package delta:** Desktop `0.0.45..0.0.46`; companion authentication extension `0.4.1..0.4.2`. The former standalone synchronization service remains removed; the extension connects directly to Desktop's integrated loopback receiver.

## [0.0.45] - 2026-08-27

### Fixed

- **Visible browser viewport** — the multi-page tab strip's browser viewport now grows into the remaining pane height instead of measuring as a zero-height native-view slot. Electron receives the real viewport bounds, so the live browser is visible when a conversation is opened while the independent thumbnail preview remains aligned.
- **Viewport resize tracking** — the renderer now observes the browser viewport itself in addition to the outer pane, so tab-strip and in-pane layout changes trigger a native `WebContentsView` resize even when the outer window size does not change.

### Verification

- Renderer typecheck passed; changed-file ESLint reported 0 errors; the focused tab-strip, BrowserPool, and screencast suite passed 70/70.
- A live `0.0.44..0.0.45` upgrade measured the selected conversation viewport at `1226 × 629` below a `1226 × 38` tab strip, and a native window capture confirmed the OA page was visibly composited instead of showing a black pane.
- The installed runtime selected a non-reserved CDP port, kept both extension and Desktop destinations connected, and accepted 2,936 Cookies across 12 origins plus 689 localStorage and 20 sessionStorage items with zero Cookie failures in the recorded full sync.

**Package delta:** Desktop `0.0.44..0.0.45`; includes the Windows reserved-port repair and every multi-page Space change documented in `0.0.43..0.0.44`.

## [0.0.44] - 2026-08-27

### Fixed

- **Windows reserved CDP ports** — Desktop now reads Windows' excluded TCP ranges before choosing Chromium's remote-debugging port. A port that is absent from `netstat` but reserved by the OS is rejected, preventing the browser surface and integrated authentication receiver from starting in a disconnected `waiting` state.

### Verification

- Startup parser, Space lifecycle, Harness isolation, screencast, schema, and tab-strip suite: 132 passed.
- TypeScript typecheck and changed-file ESLint pass with no errors.
- A fresh installer is rebuilt as `0.0.44` so Squirrel performs a real upgrade from the already-installed `0.0.43` package.

**Package delta:** Desktop `0.0.43..0.0.44`; companion authentication extension remains `0.4.1` and connects directly to Desktop's integrated receiver.

## [0.0.43] - 2026-08-27

### Added

- **Visible multi-page Space tabs** — every conversation now renders a horizontally scrollable page strip above its browser viewport. The strip follows the live Space state and supports page activation, favicon/loading/title updates, pinning, closing, keyboard navigation, narrow layouts, and accessible status announcements.
- **Bounded page lifecycle** — each Space keeps at most eight managed pages. When capacity is exceeded, Browser Use closes the least-recently-used inactive page while always preserving the root page, current page, pinned pages, audible pages, and pages that reject `beforeunload` because they contain unsaved work.
- **Completed-task retention** — inactive unpinned child pages remain available for follow-up work for ten minutes after a task completes, then close automatically. Resuming or following up cancels the cleanup timer; deleting the conversation still tears down the entire Space immediately.

### Changed

- **Compact manual takeover** — replaced the full-browser transparent Electron overlay with a small `Agent 正在操作 / 接管` control in the renderer tab bar. Taking over now reuses the normal pause path, and the native browser view is bounded strictly below the tab bar.
- **Per-page resource policy** — foreground pages keep interactive frame rates while background and idle pages are throttled independently; detached idle pages freeze and resume page-by-page instead of treating only the last active page as the whole Space.

### Fixed

- **Agent/renderer target alignment** — `session.use(targetId)` activates the selected CDP target before attaching, keeping the agent's active target, visible native page, tab highlight, and input focus synchronized.
- **Root-page ownership** — Browser Harness rejects attempts to close the assigned root target while continuing to allow owned child targets, and an unexpected root process exit now tears down every child page instead of leaving orphaned browser processes.
- **Multi-page preview accuracy** — screencasts rebind safely when the active page changes, discard stale in-flight frames, preserve debugger ownership, and keep the previous binding intact if the new page cannot attach.
- **Windows black browser pane** — removed the obsolete full-size takeover WebContentsView and its IPC/preload surface, eliminating the transparent sibling-view layering path that could paint an empty black pane over the live browser.

### Verification

- Focused Space, lifecycle, Harness-isolation, screencast, schema, and tab-strip suite: 105 passed.
- Full unit suite: 716 passed, 5 skipped; 8 pre-existing Windows/POSIX portability or timing failures remain outside this release path.
- TypeScript typecheck and changed-file ESLint pass with no errors.

**Package delta:** Desktop `0.0.42..0.0.43`; companion authentication extension remains `0.4.1` and is rebuilt unchanged for the paired installer handoff.

## [0.0.42] - 2026-08-27

### Fixed

- **Detached Space popup startup** — when a task is submitted before its chat view is visible, rescue only an untouched popup whose initial Electron navigation has not started. This prevents an `about:blank` target from remaining uninitialized and blocking `session.use(targetId)`.
- **Visible Space behavior preserved** — ordinary attached conversations still use Electron's native popup navigation; the fallback runs only when the target has no URL and is not loading.

### Verification

- A live Pi task created an isolated Space and exposed three same-context page targets while other conversations remained hidden.
- Focused Space lifecycle, Browser Harness isolation, and authentication synchronization tests pass after the detached-popup correction.

**Package delta:** Desktop `0.0.41..0.0.42`; includes every change documented in `0.0.37..0.0.41` and companion extension `0.4.1`.

## [0.0.41] - 2026-08-27

### Fixed

- **Electron Space Cookie delivery** — seed each isolated Space through an attached page Target with session-scoped `Network.setCookies`. Electron exposes partition identifiers in `TargetInfo` but rejects those identifiers in browser-level `Storage.setCookies`; the new route follows the actual Target/session boundary.
- **Destination filtering** — authentication synchronization ignores Hub, extension, worker, and other non-browser surfaces and applies Cookie/Web Storage state only to managed `about:blank` and HTTP(S) Space pages.

### Verification

- Runtime logs from the first `0.0.40` package reproduced Electron's `Failed to find browser context` response and were used as the regression boundary.
- Focused Space, Target-isolation, auth-sync, and Windows-path suites pass after the Target-scoped correction.

**Package delta:** Desktop `0.0.40..0.0.41`; includes the full Space implementation and all fixes documented in `0.0.37..0.0.40`.

## [0.0.40] - 2026-08-27

### Fixed

- **Conversation browser Spaces** — each conversation now owns an isolated persistent Chromium Profile and may keep multiple managed page targets. Direct links and `window.open('about:blank')` script flows preserve both the opener and destination page instead of overwriting the current page or creating an unmanaged Electron `BrowserWindow`.
- **Agent multi-page control** — Browser Harness exposes every target opened by the assigned Space, supports `listPageTargets()`, `session.use(targetId)`, activation, inspection, and closing inside that Space, and continues to hide and reject targets from other conversations.
- **Visible page activation** — a newly opened or CDP-activated managed page becomes the conversation's visible `WebContentsView`; background pages remain alive and share the Space's Cookie and Web Storage profile.
- **Per-Space authentication seeding** — integrated extension synchronization now applies Cookies to every isolated browser context and continues injecting localStorage/sessionStorage into newly created Space pages.

### Verification

- Added regression coverage for managed direct and delayed blank popups, nested Space target discovery, in-Space target switching, cross-conversation rejection, and per-context authentication synchronization.
- Live `0.0.39` logs confirmed the reported Feishu new-window request reached its final Bitable table/view URL; `0.0.40` replaces that single-page compatibility route with the full multi-page Space lifecycle.

**Package delta:** Desktop `0.0.39..0.0.40`; includes all path-opening and extension-sync fixes from `0.0.38` and `0.0.39`.

## [0.0.39] - 2026-08-27

### Fixed

- **Windows Skill and output-folder opening** — launch Explorer with the already verified directory as one normal argv entry. This removes both Explorer's `/select` parsing bug and Electron `shell.openPath` false-success dialogs on `Browser Use` paths containing spaces.
- **Conversation browser popups** — safe `window.open()` destinations now stay inside the owning conversation's single browser view; blank/script popups are suppressed. Electron no longer creates unmanaged browser windows that cover the Hub or bypass the session preview lifecycle.

### Verification

- Added regressions for file and Skill paths containing spaces, in-session popup routing, and blank-popup suppression.
- The exact Skill directory from the reported failure is validated against Windows Explorer before packaging.

**Package delta:** Desktop `0.0.38..0.0.39`; includes the companion extension `0.4.1` fixes documented in `0.0.38`.

## [0.0.38] - 2026-08-27

### Fixed

- **Windows output-file opening** — open the verified output directory through Electron's awaited shell API instead of Explorer's unreliable `/select` parser, preventing “Location is unavailable” for paths such as `AppData\\Roaming\\Browser Use\\harness\\outputs`.
- **Extension reload recovery** — the companion Browser Use Auth Sync `0.4.1` collector now replaces stale content-script instances after an extension reload, eliminating `Extension context invalidated` loops and restoring Cookie, localStorage, and sessionStorage delivery.
- **Extension identity assets** — the companion extension now declares packaged 16/32/48/128 px Browser Use icons so Chrome consistently shows the product logo.

### Verification

- Added a Windows path-with-spaces regression test and an extension reload lifecycle regression test.
- Packaged Desktop `0.0.38` and extension `0.4.1` are validated together against the integrated loopback synchronization service.

**Package delta:** Desktop `0.0.37..0.0.38`; companion extension `0.4.0..0.4.1`.

## [0.0.37] - 2026-08-27

### Added

- **Desktop-integrated Chrome authentication sync** — Browser Use Desktop now owns the loopback receiver on `127.0.0.1:17331` and accepts Cookie, localStorage, and sessionStorage snapshots directly from the Browser Use data-sync extension.
- **Partitioned Cookie support** — extension Cookie snapshots are written through Desktop's own browser-level CDP connection, preserving HttpOnly and partitioned Cookie data.
- **Storage propagation to conversation browsers** — localStorage and sessionStorage snapshots are applied to matching open pages and registered for new document loads.

### Changed

- **Dynamic Desktop targeting** — the integrated receiver uses the exact CDP port selected by the running Desktop process instead of relying on a fixed external port.
- **Single-process lifecycle** — authentication synchronization now starts and stops with Browser Use Desktop; the standalone Node service, local control token, and Windows startup task are no longer required.

### Security

- Sync writes are bound to loopback and require a Chrome extension origin plus the Browser Use sync protocol header. Health responses never expose Cookie or Storage contents.

### Verification

- Added receiver tests for Cookie/Storage delivery, origin rejection, and connection health reporting.
- TypeScript typecheck, focused unit tests, packaged Desktop build, and live extension-to-Desktop synchronization are required release gates.

**Full source range:** `v0.0.36..v0.0.37`

## [0.0.36] - 2026-08-27

This release contains every change since `v0.0.33`. The intermediate `v0.0.34`
and `v0.0.35` source tags were not published: package validation first exposed
a missing-manifest build failure, then a concurrent Windows reveal fix entered
the release range. `0.0.36` supersedes both source-only tags.

### Added

- **Durable per-task model selection** (`12e725a`) — added an in-composer model picker and persisted the selected provider-qualified model across task execution and Pi transcript updates.
- **Browser conversation isolation regression coverage** — added tests for inherited REPL environment contamination, per-conversation target visibility, cross-target rejection, and assigned-session CDP routing.

### Changed

- **More durable desktop task runtime** (`12e725a`) — made harness materialization recover around locked Windows launchers, improved task-process cleanup, refined file and tool event rendering, and kept model state synchronized through the task lifecycle.
- **Resumable chat behavior** (`854a18b`) — restored continuation of completed conversations and repaired transcript hydration when reopening an existing task.
- **Browser Harness guidance is conversation-scoped** — updated the bundled skill and interaction references so agents operate only on their assigned browser view instead of enumerating or switching to other task targets.

### Fixed

- **Cross-conversation browser control** — always derive `CDP_REPL_PORT` and the REPL log from the current task and target, preventing a desktop process launched from an old agent shell from reusing another conversation's persistent REPL.
- **REPL ownership enforcement** — expose the owning task and target in health responses, and reject start, status, stop, or restart operations when a live port belongs to another conversation.
- **Browser target access control** — force Browser Harness connections through the assigned local CDP endpoint, hide unrelated targets, reject cross-target attachment/switching, and block target-creation and browser-global mutations from a conversation-scoped session.
- **Windows file reveal and task resume** (`854a18b`, `8a3c71a`) — prevent a completed-state check from disabling valid follow-up messages, and route output-file reveals through a dedicated, awaited Windows implementation with explicit fallback and error reporting.
- **Packaged application manifest** — retain the root `package.json` while filtering source files for the Vite package, allowing Electron Packager and the production-dependency hook to complete reliably.

### Verification

- Browser isolation and harness regression suite: 19 passed, 1 skipped.
- TypeScript typecheck passed.
- Shell launcher syntax validation and live two-owner REPL rejection passed.
- Full unit suite: 695 passed, 5 skipped; 7 pre-existing Windows portability failures remain in four unrelated test files.

**Full source range:** `v0.0.33..v0.0.36`

## [0.0.33] - 2026-08-27

This release contains every change since the `0.0.32` version baseline (`43a2d99`).

### Added

- **Pi agent runtime and per-agent model preferences** (`ec2d87d`) — added the Pi engine adapter, installer integration, persisted model configuration, settings UI, and model routing for Pi, Claude Code, Codex, and Browser Code.
- **Per-task model selection and stronger skill discovery** (`d218eb0`) — added a task-level model picker, carried the selected model through execution, and improved the bundled `agent-skill` search/create behavior and related tests.
- **Simplified Chinese desktop localization** (`e22c3d6`) — localized the hub, settings, connections, commands, task controls, status text, tray behavior, and supporting interaction prompts.

### Changed

- **Faster packaged startup** (`18dedb7`) — cache packaged dependencies in Electron Forge so repeated launches do not rebuild or reinstall unchanged runtime dependencies.
- **Agent settings integration** (`9af1248`) — unified model preferences with the existing connections/settings surface and refined the agent preference layout and IPC contracts.
- **Safer Windows browser sessions** (`e22c3d6`, `efbf674`) — stabilized browser identity/profile selection, restored persisted session metadata, improved browser-pool recovery, and hardened session-to-renderer synchronization.
- **Release notes are sourced from this changelog** — stable releases now publish the matching version section from `CHANGELOG.md`; automatic commit notes remain the fallback when no matching section exists.

### Fixed

- **Windows Skill paths and missing Skill files** — recognize drive-letter, UNC, and POSIX absolute Markdown paths; canonicalize bare user Skill IDs to `user/general/<skill>` so cards resolve the same `SKILL.md` path created by the CLI.
- **Opening generated files on Windows** — verify the target first, then open its parent directory through an awaited API with real error reporting, avoiding Electron's false-success `showItemInFolder` behavior and native “Location is unavailable” dialogs.
- **Pi media and chat rendering** (`9af1248`, `efbf674`) — repaired media-path handling, stream conversion, output cards, tool/error rendering, and transcript state for resumed or partially populated sessions.
- **Empty browser preview** (`df6660d`) — do not render a browser preview until a real page is available.
- **Browser session resilience** (`e22c3d6`, `efbf674`) — improved cleanup, identity recovery, persisted session fields, sidebar refreshes, and renderer updates when sessions change outside the current task.

### Verification

- Added regression coverage for Windows absolute Skill paths and canonical `user/general` Skill events; the Windows output-folder handler is covered by the production typecheck and package build.
- Targeted regression suite: 12 passed, 1 skipped.
- TypeScript typecheck passed.

**Full source range:** `43a2d99..v0.0.33`

## [Unreleased]

### Track 1 — Agent wiring

- **Agent daemon** — Unix socket server with async event protocol
  - Agent loop (plan → code → execute → eval)
  - LLM client with streaming + prompt caching (Anthropic SDK)
  - Code sandbox (JS/Python execution with security restrictions)
  - Budget enforcement (step + token limits)
  - Event emitter + telemetry
- **Electron IPC wiring** — Main ↔ Renderer message protocol
  - `ipc-shell:navigate` — URL bar input
  - `ipc-pill:submit-task` — agent task submission
  - `ipc-pill:*` — streaming events (step/progress/result/error)
  - Settings persistence (Keychain backend)
- **Hotkey binding** — Cmd+K (globalShortcut) + Cmd+T/W/N (Menu accelerators)
- **Daemon lifecycle** — spawn on app ready, graceful shutdown
- **MockDaemonClient** — mocked agent for tests (no Python subprocess)
- **Test IPC harness** — mock server injection for integration tests

### Track 2 — Design polish

- **Component library refresh** — 5 family implementations
  - Shell (Linear + neon aesthetic)
  - Pill (streaming progress UI)
  - Onboarding (warm, character-forward flow)
  - Settings (preferences + factory reset)
  - Shared (Button, Input, Modal, Skeleton, Empty, Error)
- **Theme system** — dual themes via `data-theme` attribute
  - Shell theme (dark + neon accent)
  - Onboarding theme (warm dark + mascot colors)
- **Typography finalization** — Geist (UI) + Berkeley Mono (code)
- **Spacing & sizing** — 8px grid system
- **Empty + error states** — dedicated components for all surfaces
- **Skeleton loaders** — placeholder UI during data fetch
- **Visual polish** — borders, shadows, transitions across all windows

### Track 3 — QA harness

- **Vitest integration** — 117 unit + integration tests
  - Budget enforcement (step/token limits)
  - Sandbox security (blocked imports, safe builtins)
  - IPC protocol (message serialization, ordering)
  - Settings persistence (Keychain round-trip)
  - Agent loop happy path + failure modes
- **Playwright e2e framework** — test infrastructure
  - Electron-specific test utils (window creation, DevTools protocol)
  - Visual snapshot testing (PNG baseline + diff)
  - Test config for main + settings renderers
- **Visual QA pipeline** — screenshot baselines + HTML review
  - 15 visual specs (onboarding, shell, pill, settings)
  - 10 baseline PNG captures
  - Visual regression detection (`pixelmatch`)
  - HTML gallery for human review
- **Test scripts** — CI-friendly one-shot commands
  - `npm run qa` — lint + typecheck + test
  - `npm run visual:qa` — capture + diff
  - `npm run qa:review` — open HTML gallery
- **Hotkey regression fix** — ensure Cmd+K opens pill reliably in tests

### Track 5 — Settings UI

- **Settings window** — Electron renderer (separate from shell)
  - `npm run dev:settings` — opens shell + Settings side-by-side
  - Fixed size 720×560 (per design spec)
- **Settings form** — preferences panel
  - API key input (masked display: first 7 + last 4 chars)
  - Agent name text input
  - Theme toggle (shell ↔ onboarding)
  - Factory reset button (with confirmation modal)
- **Settings persistence** — Keychain backend
  - Read on app startup
  - Write on form submit
  - Validation (empty key rejected)
- **IPC contract** — renderer ↔ main communication
  - `ipc-settings:get-state` → current settings
  - `ipc-settings:set-key` → update value
- **Keychain integration** — real key storage (no mocks)
  - `setKey(service, account, password)`
  - `getKey(service, account)`
  - Test mode detection (skips `app.relaunch()`)

### Track 6 — Brand assets

- **Mascot design** — character-forward identity
  - SVG + CSS animations (idle, thinking, celebrating, error)
  - Color palette (blue-grey body, shadow, highlight)
  - Animation timings (3s idle float, 0.8s thinking bounce, spring pop, sharp error shake)
- **Wordmark** — Agentic Browser logotype
  - Asset files in `/app/assets/brand/`
  - BRAND.md documentation (palette, brand essence, asset registry)
- **App icon** — macOS icon set (icon.icns)
- **Color system** — brand accent colors
  - Neon yellow-green (`#c8f135`) — primary
  - Warm dark (`#1a1a1f`) — onboarding base
  - Deep dark (`#0a0a0d`) — shell base
  - Blue-grey (`#7fb3d0`) — mascot body
  - Coral (`#ff6b4a`) — error/celebrating

### Accessibility (a11y)

- **WCAG AA compliance** — color contrast minimum 4.5:1 for text
  - fgTertiary adjusted in both themes
  - All interactive elements contrast-compliant
- **Focus rings** — visible on all interactive elements
  - Tab navigation fully keyboard accessible
  - Focus ring color: accent (neon in shell, pastel in onboarding)
- **Reduced motion** — respects `prefers-reduced-motion` media query
  - Global catch-all rule in theme.global.css (after specifics)
  - Animations removed when user has reduced motion enabled
- **Semantic HTML** — proper element usage
  - `<button>` for all clickable actions (not divs)
  - `<input>` with `<label>` for form fields
  - `<nav>` for navigation areas

### Dev tooling

- **CI workflow** — GitHub Actions (macOS + signing)
  - Build matrix (Node 20.x)
  - Signing configuration (Developer ID)
  - Artifacts upload (DMG, ZIP)
- **Dev server improvements**
  - `npm run dev:settings` — isolated Settings window testing
  - Faster hot reload via Vite
  - Cleaner error messages
- **Logging enhancements** — JSON-line format
  - Structured logging (timestamp, level, component, context)
  - Secret scrubbing (API key, token, password redaction)
  - Dev mode toggle (`NODE_ENV`, `AGENTIC_DEV`)
- **Crash telemetry** — error tracking + reporting
  - Unhandled rejection catcher
  - Daemon crash detection
  - Optional remote reporting
- **Design system documentation** — DESIGN_SYSTEM.md
  - Themes, typography, color palette
  - Component library reference
  - Usage examples
- **Microcopy audit** — consistent, clear messaging
  - Button labels (imperative: "Sign in", "Reset", "Copy")
  - Error messages (specific: "API key invalid" not "Error")
  - Placeholder text (hint: "Your agent's name")

### Testing

- **Unit tests** — vitest (9 test files, 117 pass)
  - Budget enforcement, sandbox security, event protocol
  - Settings persistence, IPC messaging, agent loop
- **Integration tests** — real Keychain + mocked daemon
  - End-to-end IPC flows
  - Settings read/write
  - Agent task submission
- **E2E tests** — Playwright + Electron
  - Preload bridge isolation
  - (Pill flow pending: `tests/e2e/pill-flow.spec.ts`)
  - (Golden path pending: `tests/e2e/golden-path.spec.ts`)
- **Visual tests** — screenshot-based regression detection
  - 15 visual specs, 10 baseline PNGs captured
  - Diff gallery (HTML review)
  - `npm run visual:qa` workflow
- **Python tests** — pytest (253 total, 252 pass, 1 skip)
  - Sandbox security (18 import tests, 8 builtin tests, 17 attribute tests)
  - Budget logic (13 tests)
  - Agent loop (17 tests)
  - Event protocol (12 tests)
  - Logger (23 tests)
  - Frame walking/path traversal/memory caps (10 tests)

### Documentation

- **README.md** (app root) — fresh quickstart + architecture
  - One-line description + feature overview
  - Prerequisites + quick start (3 commands)
  - Dev shortcuts table (npm scripts)
  - Architecture overview (directory structure, key files, IPC)
  - Testing guide (unit, e2e, visual, Python)
  - Troubleshooting (blank window, hotkeys, daemon, timeout)
- **CONTRIBUTING.md** (repo root) — setup, workflow, testing rules
  - Dev environment setup (Node + Python)
  - Git workflow (branch naming, Conventional Commits)
  - Testing rules (no mocks for Keychain/filesystem)
  - Design rules (no Inter, no !important, no sparkles)
  - Adding a new window (6-step checklist)
  - Debugging guide
- **CHANGELOG.md** (repo root) — this file
  - Organized by track (agent, design, QA, settings, branding)
  - Accessibility + dev tooling sections
  - Testing + documentation subsections
- **DESIGN_SYSTEM.md** — color tokens, typography, component library
- **BRAND.md** — brand essence, palette, mascot specs

### Fixed

- **Websockets dependency** — relaxed version constraint (15.0+ instead of 16.0+)
- **Python requirements** — removed unavailable cdp-use package

### Commits

Iteration 1 (Settings UI, 10 commits): 200cd15, 9c7a9dd, 95405dd, c2e41b6, 2b052ca, f26f0f6, 64601a9, 916bf77, 3334773, a348f8f

Iteration 2 (QA harness, 5 commits): 8c7956f, 5eead90, d4ea076, e1791a9, 2ce6881

Iteration 3 (Design polish, 6 commits + 3 brand): 2e4cb5e, 3b995a2, 2b98948, 0e6bd14, 0dbfa5f, c5845fa, 6552165, 0f506fd, 4aba6cb

Iteration 4 (CI + tooling, 8 commits): 1a46bf2, 2261dc6, 4866fca, 19c5bfb, c92711a, c3b417b, fbc933e, 700ad2e

Iteration 5 (a11y + e2e, 3 commits): 0634f30, 4c2b7ee, 0258e59

Final (pytest + docs, 2 commits): 2647fbf, [readme], [contributing], [changelog]

---

## [1.0.0-alpha] — 2026-04-16

### Added

- Initial Electron app scaffold (Electron Forge + Vite)
- Main process entry with window management
- React renderer with shell, pill, onboarding, settings windows
- Preload bridge for context isolation
- Python agent daemon (basic loop structure)
- Keychain integration for API key storage
- Vitest unit test setup

### Notes

- Tracks 1–6 completed during overnight autonomous loop
- All test suites passing (vitest 117/117, pytest 252/253)
- Visual baselines captured (10 PNGs)
- Documentation complete (README, CONTRIBUTING, CHANGELOG)

---

## Older versions

(Not yet released to production)
