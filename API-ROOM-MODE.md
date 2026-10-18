# Nomi API Room mode

Use one ChatGPT tab and a persistent Nomi API room containing **exactly one selected Nomi**. World messages go to that room, never to the Nomi's private chat. Optional live monitoring reads the private chat and reports observations to GPT.

## Setup

1. Install/update the extension following the [main guide](README.md). Select **Nomi API room** in the dashboard.
2. Save your Nomi API key locally, then refresh the Nomis and rooms list.
3. Choose one Nomi and a matching existing API room, or create a dedicated room. Multi-Nomi rooms are excluded.
4. Select the ChatGPT tab with an existing completed opening reply and press Play.

The key is stored in Edge extension local storage and sent only in the authorization header to `https://api.nomi.ai/v1`. It is excluded from GPT prompts, session snapshots, and troubleshooting reports. **Clear key** removes it. Access to the browser profile can expose locally stored data.

## Room messages and optional live monitoring

Each full GPT world message is sent in ordered, lossless chunks of at most **800 UTF-8 bytes**. There is no overall message-size limit imposed by the bridge, but browser storage is finite. In room-only operation, after every chunk is confirmed, the bridge requests a Nomi reply and forwards it to GPT.

Enable **Monitor Nomi live private chat** to observe a separate private-chat tab. Select that tab explicitly or let the bridge identify the selected Nomi's conversation. With usable, recently active monitoring, a world message receives an internal delivery acknowledgment instead of requesting a Nomi room reply. GPT can then listen for private-chat exchanges. This acknowledgment is a bridge notice, not Nomi speaking.

If monitoring is disabled, disconnected, or inactive beyond the configured threshold (default five minutes), future world events use room-only replies automatically. When usable live activity returns, monitoring resumes. Switching paths does not repost completed world events. The dashboard reports the effective path.

## GPT commands

Use one standalone command per reply, without code fences. For `[say room]`, only text after the tag is posted. A preamble before a single standalone tag is ignored; malformed or multiple commands are rejected internally. Three consecutive malformed commands stop the bridge.

| Command | Effect |
| --- | --- |
| `[say room] world event` | Deliver the event to the API room. Untagged replies remain supported as room messages. |
| `[listening]` | One observation request: return newly captured complete User → Nomi exchanges since the last acknowledged listen. If none completes within 12 seconds, return one internal status and wait for another explicit command. In room-only fallback, report that status immediately. |
| `[wait]` | Wait passively and indefinitely for a complete exchange; no Nomi send or reply request. |
| `[tail]` | Return the last ten locally recorded events without consuming the listening position. |
| `[history]`, `[history 2]` | Return retained history pages, with larger page numbers looking further back. |
| `[say chat]` | Disabled: private-chat access is read-only. |

Neither listening command posts to Nomi or requests a room reply. Catch-up includes all captured new completed exchanges, in order, subject to bounded packets. An unanswered user message remains buffered. The cursor advances only after delivery to GPT is confirmed; another `[listening]` can retrieve further packets. Monitoring alone does not schedule time-of-day world events.

## History and room management

The local journal retains the latest **500 events per API room**, each with up to 6,000 text characters, a speaker, source, and observation timestamp. It survives ordinary browser restart. Timestamps record when the bridge observed messages. The DOM monitor can see at most 50 recent private-chat messages at a time; it cannot reconstruct older, unrecorded conversation history after a restart.

While stopped, use **Clear local history** to erase the journal without deleting Nomi conversations. Room creation supports a name and description; descriptions are limited to 1,000 characters. Saving a description changes only the room note. New rooms retain enabled backchanneling.

**Delete room permanently** requires the exact room name and a final confirmation. It deletes the room and its history, not the Nomi. An unfinished checkpoint must first be recovered or abandoned. If deletion times out, refresh the list before trying again; its outcome may be uncertain.

## Interrupted delivery and recovery

Persistent local checkpoints record attempted and confirmed chunks and requested/saved replies. They survive browser shutdown. An interrupted request is not assumed to have failed.

| State | Recovery |
| --- | --- |
| Some chunks confirmed | Inspect the room; resume the first unconfirmed chunk. Confirmed chunks are not resent. |
| Chunk result uncertain | Inspect before explicitly authorizing retry; the last chunk may already exist in the room. |
| Reply request uncertain | Recover the reply separately. This does not resend the world message, but retrying may produce another Nomi reply. |
| Reply already saved | Restore the original GPT conversation and use **Recover Reply**. The saved response is delivered without another Nomi request. |
| Stopped during a request | Allow an in-flight result to settle and inspect the checkpoint before recovery. Stop cannot undo already submitted content. |

Do not Reset or Abandon a checkpoint you intend to recover. Abandoning local recovery data does not remove messages already sent to Nomi.

Read-only GET requests retry transient errors up to eight attempts. Content/creation POSTs, ambiguous reply POSTs, and room edits/deletions are not automatically repeated. An explicit Nomi not-ready, NoReply, or rate-limit response can retry the reply request with exponential backoff, capped at 30 seconds between attempts, until a reply or Stop. The world text is not resent. Activity/status show attempts, error type, and HTTP status without the key.

During an active API-room reply wait, the extension can reconnect the selected GPT tab for up to **120 seconds**, using the original exact conversation URL. A reply arriving meanwhile is saved. Once that original conversation is ready and draft-free, it is delivered once. If reconnection fails, use Recover Reply after restoring the original conversation. The retry targets the browser tab, not Nomi POSTs. A separately interrupted service worker with an in-flight API request still requires checkpoint recovery.

API mode does not use the browser relay's 15-minute idle watchdog. Temporary tab unavailability can pause progress while Play remains active; tab closure, uncertain sends, or repeated protocol errors can still stop it. Check Activity for the cause.

## Verification limits

Tests exercise command parsing, chunks, checkpoints, retries, recovery, and observation routing with mocked APIs and browser fixtures. They do not send live account messages. Nomi/ChatGPT page changes can break selectors; an unavailable monitor may fall back to room-only replies. Confirm the selected conversations and reported effective mode when running the extension.
