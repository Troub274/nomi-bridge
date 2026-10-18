# Browser group-room mode

Select **Group room** and choose ChatGPT first and a Nomi browser group room second. Press Play. The bridge sends GPT startup instructions and recent room context. Only room-message content is posted to Nomi; startup/help exchanges remain internal.

## GPT commands

Put each command at the start of its own line, without Markdown fences.

| Command | Effect |
| --- | --- |
| `[say] message` | Post text as the user in the room. |
| `[wait]` or `[listening]` | Observe further room activity. Resume Auto Chat if it is paused or waiting for the user's turn. |
| `[invite] exact member name` | Select which Nomi replies next. Ambiguous or missing members are rejected. |
| `[play]` | Resume Auto Chat and let the Nomis choose the next speaker. |
| `[pause]` | Pause room Auto Chat. |
| `[help]` | Send GPT the instructions again, internally. |

GPT can send several `[say]` blocks, followed optionally by a final `[play]` or `[invite]`. There is no total group-response length limit: each message is split into ordered chunks of at most 800 UTF-16 units, preserving text and surrogate pairs. Multi-message batches pause Auto Chat, confirm each send, then execute the final control.

Sending text and resuming Auto Chat are separate actions. The room can show Auto Chat enabled while waiting at the user's turn. The bridge's Stop button prevents further bridge actions but does not independently pause Nomi Auto Chat. Play resumes pending work; Reset starts fresh and resends startup context.

Group `[wait]`/`[listening]` behavior differs from the passive commands in [API Room mode](API-ROOM-MODE.md). Heartbeat's sleep commands are available only in [Heartbeat mode](HEARTBEAT.md).

See the [main guide](README.md) for installation, diagnostics, persistence, and single-session limitations.
