# Development notes

## Files

- `extension/manifest.json`: Manifest V3 registration, supported site URLs, permissions, and version.
- `extension/engine.js`: pure turn engine, reply stability, routing, length limit, send claiming, acknowledgements, and uncertain-send handling.
- `extension/background.js`: service worker, session state persistence, tab messaging, source revalidation, and periodic wake-ups.
- `extension/content.js`: page selectors, AI reply extraction, completion checks, editor insertion, last-moment authorization, and Send confirmation.
- `extension/dashboard.html`, `dashboard.js`, `style.css`: chat selection, Play/Stop/Reset, status, and activity.
- `extension/popup.html`, `popup.js`: setup controls, selector picking, and reply preview.
- `tests/`: extension-focused tests using Node's built-in test runner and local fixtures.

The shared page adapter has an optional desktop transport hook, but this package uses the browser extension API and needs no desktop application or desktop adapter.

## Run tests

Install Node.js, then open a terminal in the extracted package root and run:

```
node --test tests/*.test.cjs
```

No npm packages or package installation are needed. The extension-focused suite contains 41 checks. Tests cover sustained alternation, both same-site pairings, controls, generation/completion detection, Stop/Resume, uncertain sends, navigation, drafts, session restoration, wrong-tab delivery, length limiting, and send verification. They use synthetic page fixtures and do not send real account messages.

To check JavaScript syntax in PowerShell:

```powershell
Get-ChildItem extension -Filter *.js | ForEach-Object { node --check $_.FullName }
```

## Design and maintenance

The engine accepts two distinct connected tab IDs. It waits for an AI reply to finish and remain stable, checks the destination for an existing draft, creates one command, validates the current source again, and allows that command to be claimed once. The page code verifies inserted text, rechecks permission just before clicking Send, and waits for the editor to clear before acknowledging delivery. Changed or uncertain delivery is never blindly replayed.

Keep these safeguards when changing selectors or adding sites. Website layout changes can invalidate reply extraction or completion detection even when the fixture tests pass. Verify on real chats before distributing an update. Avoid starting Play in chats with valuable drafts or manually changing the selected chats during a relay.

Custom selectors are stored per site, not per tab, so a selector change applies to other tabs from that site. The default quiet-time delay adds a check after completion detection; elapsed quiet time alone is not proof that generation is finished.

To share a changed extension, update its manifest version, rerun the tests, and ZIP the extension source or this source-package layout. Keep `extension` and `tests` as sibling folders if including tests. Exclude extension storage exports, browser profile folders, and personal chat data.

`SOURCE_MANIFEST.sha256` records the original handoff file hashes. It is an integrity inventory, not a signing certificate or authenticity guarantee.
