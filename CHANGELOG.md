# Release notes

## 0.4.3 — 2026-10-18

- Adds Heartbeat as the fourth mode: one ChatGPT tab, a user-defined phrase, startup instructions, a configurable 10-second default repeat delay, `[sleep]`, and `[sleep nHRS]`.
- Promotes the World Observer work from the 0.4.2 development branch: optional read-only Nomi private-chat monitoring, room-only fallback, retained history, one-shot listening, command validation, reply diagnostics, and original-GPT-tab reconnect/recovery.
- Replaces accumulated setup/version notes with current installation, mode, recovery, persistence, and development guides. Documents the existing one-session-per-profile limit.
- Preserves Direct Chat, Group room, and API Room management. The legacy Windows desktop wrapper is not upgraded by this release.
- Validation: 151 automated tests pass. These are fixture/mock tests; this release process does not send live ChatGPT or Nomi messages.

## Previous production versions

- **0.4.1:** API room description editing and confirmed room deletion.
- **0.4.0:** Persistent single-Nomi API Room mode and checkpoint recovery.
- Earlier versions introduced two-chat relay and browser group-room support. Historical source and notes remain in Git history.
