# Nomi API Room mode (Chat Bridge 0.4.0)

This is the **third conversation mode**, alongside Direct Chat and Group Chat. It uses one ChatGPT browser tab and a persistent Nomi **API room containing exactly one selected Nomi**. The Nomi's ordinary private chat is not involved, so you can run a World Engine / daily-life simulation entirely inside a separate room.

## Setup

1. Load the updated **extension/** folder via `edge://extensions` → Load unpacked. If already installed, click Reload. (A new permission for `https://api.nomi.ai/*` must be granted.)
2. Open the bridge dashboard; set Conversation mode to **Nomi API room — one Nomi, every turn**.
3. Paste a Nomi API key in Settings and click **Save key**. The key is saved in **Edge extension local storage**, not in GitHub, ChatGPT prompts, bridge snapshots, or troubleshooting reports. Access to the extension/browser profile can still expose locally stored keys, so use a trusted profile.
4. Click **Refresh Nomis and rooms**. Choose **one Nomi** and an existing room containing her, or create a new dedicated room (e.g. `WORLD::Gwen`).
5. Select your ChatGPT tab, and press Play. ChatGPT is always the initial speaker in this mode; send an opening prompt there if needed.

## Manage API rooms from the bridge

With API Room mode selected and the world-engine bridge **stopped**, choose one Nomi and its API room:

- **Create room:** enter an optional name and description (maximum 1,000 characters), then create the room. Backchanneling remains **enabled**.
- **Save description:** edit the selected room's note and save. Only the `note` property is sent; the selected Nomi and backchanneling setting are not modified. The bridge checks for an edit made elsewhere before writing.
- **Delete room permanently:** press **Delete room permanently…**, type the room's exact name, and approve a separate final confirmation. A room with an unfinished send/reply checkpoint must be recovered or explicitly abandoned before deletion.
- Deletion removes the **API room and its room history**, not the Nomi herself. A timeout during deletion has an uncertain outcome; **refresh the list** before trying again. No automatic retries of DELETE or PUT requests.

## Optional World Engine live-chat monitoring (preview)

Enable **Monitor Nomi live private chat** in API Room settings and optionally select the Nomi private-chat tab. If the tab is not open yet, the bridge will try to auto-bind it when the URL contains the selected Nomi UUID or matches a previously chosen conversation URL.

- **World messages always go to the API room.** The bridge never writes them to the Nomi's private chat.
- **When the private-chat tab is connected and has recent new messages:** the bridge does **not** immediately call `POST /rooms/{id}/chat/request` for the world event. It waits for genuinely **new** Nomi/user observations, then forwards those to ChatGPT. If the live conversation becomes inactive, it requests exactly one reply for that pending room event instead. The user-selectable inactivity fallback defaults to **5 minutes** (2–60 minutes). An idle tab does not suppress room replies indefinitely.
- **When there is no usable live conversation history** (tab closed, not yet connected, no recognized messages): the bridge uses normal API-room reply requests. If the tab closes mid-session, monitoring drops immediately and future world turns get API-room replies.
- **`[say room]`** followed by text delivers that text to the API room with the existing 800-byte chunking and checkpoint rules. Untagged replies are also treated as world-room sends for backward compatibility.
- **`[listening]`** and **`[wait]`** are strictly passive. They never send content to Nomi, invoke `/chat/request`, or send a synthetic status message back to GPT. With live monitoring enabled, they forward only genuinely new private-chat observations; otherwise they remain idle. This works even when the Live Chat Monitor checkbox is OFF. To generate another world event and get a Nomi reply when live chat is absent, GPT must explicitly issue **`[say room]`** followed by world text.
- **`[tail]`** returns the last ten locally observed events, **`[history]`** returns the latest retained history page, and **`[history 2]`**, `[history 3]`, etc. retrieve progressively older pages.
- **`[say chat]` is deliberately disabled** in this preview: private-chat access remains read-only.

The extension keeps the latest **100** events in a separate persistent local journal per API room (source: live chat or room, speaker, observation timestamp and up to 6,000 text characters per event). Reopening Edge does not destroy this journal; ChatGPT can request `[tail]` or `[history]` after restarting. The **Clear local history** button erases the local journal while the bridge is stopped; deleting an API room also clears the journal. Neither action removes Nomi's underlying private chat. Local observation timestamps are when messages were seen by the bridge, not guaranteed original send times.

The bridge activity log now identifies actual `/chat/request` attempts separately from observation deliveries. Each attempt appears as `Nomi API /chat/request attempt N`. This makes unintended reply loops auditable without exporting credentials.

**Browser-selector limitation:** live user/Nomi message reading depends on Nomi's current DOM. If the website changes its message CSS classes, the monitor may report zero observed messages and fall back to room replies. This requires a real Edge/Nomi smoke test before relying on unattended monitoring. While no new private-chat messages arrive, `[listening]` can remain idle; the World Engine does not automatically schedule new time-of-day events merely because monitoring is enabled.

## Control-command and recovery fixes (development build)

**Control tags are never Nomi conversation text.** The World Engine may send `[tail]`, `[history]`, `[history 2]`, `[listening]`, or `[wait]` as its entire response. A single enclosing Markdown code fence is tolerated. A malformed tag, a tag mixed with commentary, or a second tag in a `[say room]` body is **not sent to Nomi**. The bridge logs a protocol error and waits for a corrected GPT response. If the dashboard is accidentally in Direct Chat mode, it blocks World Engine command tags from reaching the Nomi private chat.

**Live monitoring never replays stale observations as new Nomi replies.** After a `[say room]` event, while live monitoring is active, the bridge waits for **new** private-chat activity and keeps that room event checkpointed. If the live conversation becomes inactive or closes, it requests one Nomi API-room reply for the already-sent event, without reposting the event. `[wait]` itself remains completely passive, regardless of inactivity, and can stay idle longer than 15 minutes.

**Resume/reload rules:** Stop/Play after a passive `[wait]` does not create or resend a room checkpoint. A harmless ChatGPT page reload at the same URL outside an active send preserves the room session but deliberately ignores the old GPT response. A reload during a potentially active send remains uncertain. The explicit recovery controls restore live monitoring when selected and, if a confirmed event is still awaiting a Nomi response, continue monitoring fresh private-chat activity rather than automatically forcing a room reply. Uncertain POSTs must still be approved individually to prevent duplicates.

The Activity log includes distinct `Nomi API /chat/request attempt` entries; control commands do not produce these entries. The bridge does not change Nomi's private-chat messages.

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
