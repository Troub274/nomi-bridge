# Nomi API Room mode (Chat Bridge 0.4.0)

This is the **third conversation mode**, alongside Direct Chat and Group Chat. It uses one ChatGPT browser tab and a persistent Nomi **API room containing exactly one selected Nomi**. The Nomi's ordinary private chat is not involved, so you can run a World Engine / daily-life simulation entirely inside a separate room.

## Setup

1. Load the updated **extension/** folder via `edge://extensions` → Load unpacked. If already installed, click Reload. (A new permission for `https://api.nomi.ai/*` must be granted.)
2. Open the bridge dashboard; set Conversation mode to **Nomi API room — one Nomi, every turn**.
3. Paste a Nomi API key in Settings and click **Save key**. The key is saved in **Edge extension local storage**, not in GitHub, ChatGPT prompts, bridge snapshots, or troubleshooting reports. Access to the extension/browser profile can still expose locally stored keys, so use a trusted profile.
4. Click **Refresh Nomis and rooms**. Choose **one Nomi** and an existing room containing her, or create a new dedicated room (e.g. `WORLD::Gwen`).
5. Select your ChatGPT tab, and press Play. ChatGPT is always the initial speaker in this mode; send an opening prompt there if needed.

## Every turn

- Wait for a **complete ChatGPT answer**. A large World Engine action is allowed without a total message-length limit in the bridge.
- Split it **losslessly**, preferably at word/paragraph boundaries, into ordered API room messages of **at most 800 UTF-8 bytes each**. For non-ASCII characters such as emoji, this can be fewer than 800 visible characters. No source text is discarded.
- POST **every chunk in order** to `/rooms/{roomUuid}/chat`. Confirm each submission; track the number of confirmed chunks in session state.
- Only after the **entire ChatGPT turn** is sent, request **one** reply from the selected Nomi using `/rooms/{roomUuid}/chat/request` with her UUID. This follows the uploader API pattern but invokes the Nomi every conversation turn.
- Forward that Nomi reply back into ChatGPT; ChatGPT generates the next turn. Repeat until Stop.

## Reliability and limitations

- **Durable checkpoint per room:** the bridge records `attempt` before each POST, `confirmed` after each acknowledged POST, and `reply_attempt`/`reply_committed` for Nomi responses. Checkpoints live in Edge extension local storage, survive an ordinary browser restart, and are separate from Nomi room history.
- **Read-only API GETs** retry at most eight times for transient errors using 1, 2, 4, 8, 16, 30, 30 second exponential backoff. A content POST, room-creation POST, or ambiguous reply POST is **never** automatically repeated.
- **NoReply / not-ready / rate-limit on a reply request:** continue waiting with exponential backoff (up to 30 seconds between attempts), with no fixed retry count, until Nomi answers or you stop the bridge. The original world message is **not** resent.
- **Uncertain content POST:** Stop with its 1-based chunk index and the number of confirmed chunks intact. Review the room/checkpoint, click **Resume or authorize uncertain chunk**, and explicitly accept the risk of duplication. Only the first unconfirmed chunk is retried; earlier confirmed chunks are skipped.
- **Uncertain reply POST:** Review and click **Resume or authorize uncertain reply**. This requests a reply only; it **never** resends the completed world message. A duplicate Nomi reply may result. If a reply was committed before the browser went away, recovery reuses it without requesting another reply.
- **Stop during chunking:** a fully confirmed prefix is retained; use recovery controls rather than starting a new world turn. Abandoning the local checkpoint does not remove content already present in the room.
- **Service-worker restart:** an in-flight POST cannot be inferred to have failed. The checkpoint remains unresolved until recovery is expressly authorized. The bridge requires the original ChatGPT conversation and Nomi room when resuming.
- Only one Nomi may belong to an API room in this mode; rooms containing multiple Nomis are excluded from selection.
- Storage and browser resources remain finite. The bridge imposes no overall length/truncation threshold on World Engine turns, but an exceptionally large output can exceed browser storage limits.
- The older Direct Chat and Group Chat modes retain their existing behavior.
- Existing Direct Chat and browser Group Chat modes are unchanged, including their existing message-size behavior.
- This is an Edge extension mode, not yet wired into the separate portable Windows desktop wrapper.
- Live Nomi account testing is needed. Unit/simulated room tests do not establish real-world API delivery.

## Security

The key is passed only to `https://api.nomi.ai/v1` in an Authorization header, from the extension service worker. It is **not** serialized with the bridge state, shown in the room UI, or copied in troubleshooting data. Use **Clear key** to remove it. Do not commit secrets or exported Chrome/Edge profile data to GitHub.
