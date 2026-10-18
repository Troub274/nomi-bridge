# Chat Bridge

An unpacked Microsoft Edge extension for ChatGPT and Nomi. **Current release: 0.4.3.**

Choose a mode, select the required tabs, and press Play. Stop prevents further sends; a message already submitted can still receive a reply.

| Mode | Connects | Behavior |
| --- | --- | --- |
| Direct Chat | Two ChatGPT or Nomi chat tabs | Alternates completed replies. Messages sent to Nomi are limited to 750 characters. |
| [Group room](GROUP-MODE.md) | ChatGPT and a Nomi browser group room | GPT can speak, listen, choose a Nomi, or control Auto Chat. Long messages are split without truncation. |
| [Nomi API room](API-ROOM-MODE.md) | ChatGPT and a persistent API room with one Nomi | Sends room messages through the API; optionally observes the Nomi's private chat without writing to it. |
| [Heartbeat](HEARTBEAT.md) | One ChatGPT tab | Repeats your phrase after completed responses, with a configurable 10-second default delay and GPT sleep commands. |

**One session runs at a time per browser profile.** Multiple dashboard windows control the same session. Heartbeat cannot run alongside another bridge mode. No separate server, Python installation, or WSL is needed to run the extension. Only API Room mode requires a Nomi API key.

## Install or update

1. Download **ChatBridge-Edge-0.4.3.zip** from the [GitHub release](https://github.com/Troub274/nomi-bridge/releases/tag/v0.4.3), or use this repository's `extension/` folder.
2. Extract the download to a permanent folder. In Edge, open `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**, then select the **extension** folder containing `manifest.json`. Keep that folder in place.
4. Open the chats you want to use and sign in normally. Open Chat Bridge from Edge's Extensions menu, then **Open Play / Stop controls**.
5. Select the mode and tabs. Tabs in the same Edge profile appear automatically; Play activates the selected tabs and tries to connect them.

To update, stop the bridge, replace the files in the folder shown under the extension's **Loaded from** location, click **Reload** at `edge://extensions`, and reopen the controls. Confirm **v0.4.3** appears. If you use a Git checkout, pull updates into that checkout first. Reloading does not download new code. The old ZIPs and backup directories in this repository are historical; use the versioned release asset above.

## Run and stop

- Direct Chat needs an existing reply from the selected first speaker. API Room starts with an existing GPT reply. Group mode supplies startup instructions automatically. Heartbeat sends your phrase when GPT is ready, with controls explained in its first prompt.
- Keep Edge running and the computer awake. Timers may run late in background tabs or after computer sleep; the extension cannot send while the computer is asleep.
- Leave the selected editors empty. A draft blocks automated delivery. Avoid navigating or manually editing the selected conversation while a send is in progress.
- **Play** resumes the pending position. **Stop** prevents new sends. **Reset** discards the bridge position and can repeat previously seen content. For an unresolved API checkpoint, use the recovery controls described in the [API guide](API-ROOM-MODE.md) before resetting.
- Completion detection requires the site's generation/completion indicators and a quiet-time check. The quiet-time setting also applies before Heartbeat's repeat delay.

Direct mode supports ChatGPT ↔ Nomi, ChatGPT ↔ ChatGPT, and Nomi ↔ Nomi. Messages to Nomi are shortened to 750 characters; after confirmed truncation, a later Nomi-to-GPT delivery includes a length reminder. Group mode uses chunks of up to 800 UTF-16 units; API mode uses chunks of up to 800 UTF-8 bytes. These are distinct limits. Text is supported; audio, images, and attachments are not relayed.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Old version after Reload | Verify the **Loaded from** folder. Reload only reads files in that folder; it does not fetch GitHub changes. Reopen the dashboard. |
| Missing tab | Confirm it belongs to this Edge profile, open it, finish sign-in/loading, and try Play again. |
| Extension not answering | Reload it at `edge://extensions`, reopen controls, and inspect its service-worker errors if the problem persists. |
| Waiting for a reply | Check the selected tab, completion controls, generation status, and editor drafts. Website layout changes may require selector updates in the extension's setup preview. |
| Uncertain delivery | Inspect the destination before retrying. Use API checkpoint recovery for API mode; do not blindly Reset and replay. |
| Need a diagnostic report | Use **Activity → Copy troubleshooting status**. It omits message bodies and the API key, but can include conversation URLs and identifiers. |

## Data and persistence

The extension has no relay server. Browser chat modes operate signed-in pages; API mode calls Nomi directly. Tabs in one profile share website logins.

Running sessions and recent snapshots use Edge session storage: service-worker suspension retains them; browser shutdown, extension reload, or disabling the extension clears them. Heartbeat's phrase and delay are remembered separately by the dashboard. Selectors, the API key, room checkpoints, and optional observation journals use persistent local storage. The journal retains the latest 500 events per room, up to 6,000 characters per event. See the [API guide](API-ROOM-MODE.md) for clearing history and recovering interrupted requests.

## Development and release notes

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture and checks, and [CHANGELOG.md](CHANGELOG.md) for this release. The automated suite has **151 passing tests** at 0.4.3. Tests use mocks and fixtures, not live account messages; website/API changes still require live verification.

The separate [Windows desktop wrapper](desktop/README.md) is a legacy two-chat tool. This release updates the Edge extension; it does not add API Room, Group, or Heartbeat support to that wrapper.
