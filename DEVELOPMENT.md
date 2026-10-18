# Development

The production branch is `main`. The Edge extension is plain JavaScript with no compilation or npm dependencies. The manifest is the version source of truth.

## Architecture

One service worker manages one session per Edge profile. Content scripts run in connected tabs; dashboard windows share the same worker state. Multiple dashboards do not create independent sessions.

| File | Responsibility |
| --- | --- |
| `extension/engine.js` | Direct-chat state machine, completion checks, send claiming, and acknowledgments. |
| `extension/group.js` | Group commands, ordered batches, room context, and Auto Chat. |
| `extension/heartbeat.js` | Single-tab prompts, completed-response delay, and sleep deadlines. |
| `extension/background.js` | Tab discovery/wake-up, messaging, worker transactions, and session persistence. |
| `extension/content.js` | Page snapshots, selectors, reply extraction, editor insertion, and final send checks. |
| `extension/api-room.js`, `api-driver.js`, `api-checkpoint.js` | Nomi API access, command routing, retries, durable checkpoints, and recovery. |
| `extension/world-observer.js` | Bounded persistent observation journal and listening cursor support. |
| `extension/dashboard.*`, `popup.*`, `style.css` | Controls, diagnostics, and selector setup. |

Delivery commands are claimed once and revalidated before submission. Preserve draft checks, completion checks, exact destination validation, Stop cancellation, and uncertain-send handling. Worker suspension must not turn an uncertain POST into a blind retry.

## Checks

Use Node.js 22, matching GitHub Actions, from the repository root:

```sh
node --test tests/*.test.cjs
```

There are 151 automated tests in release 0.4.3. They use fixtures/mocks and do not send live messages. Syntax check in PowerShell:

```powershell
Get-ChildItem extension -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Check Git whitespace with `git diff --check`. The full test checkout includes `desktop/adapter.js`, used by a legacy adapter regression test. Website selectors still require live verification after relevant DOM changes.

## Release

Update the manifest, README, mode guides, and changelog together. Run tests and review the production PR. Merge only after CI succeeds. Create a version tag and a GitHub release with a versioned ZIP containing `extension/` and the user guides. Verify the archive's manifest version and files against the released source. Never include local profiles, credentials, observation exports, or backup directories in a release archive.

Historical root ZIPs, `backup-before-*` folders, and one-off migration scripts are retained for provenance, not installation or build inputs. The separate desktop wrapper is not part of the 0.4.3 extension release. Legacy `edge-source-docs/` pages point to these maintained guides.
