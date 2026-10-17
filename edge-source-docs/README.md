# Chat Bridge — Microsoft Edge add-in

Source handoff, October 15, 2026. Version 0.2.0.

This package contains the Edge browser extension and its source code. It supports ChatGPT ↔ Nomi, ChatGPT ↔ ChatGPT, and Nomi ↔ Nomi, forwarding one text reply per turn with Play, Stop, and Reset controls. No executable, Python installation, API key, or local server is required. The extension files are the editable source; there is no compilation step.

## Install in Edge

1. Extract this ZIP to a permanent folder. Keep that folder in place after installation.
2. Open `edge://extensions` in Microsoft Edge.
3. Enable **Developer mode** and click **Load unpacked**.
4. Choose the extracted **extension** folder containing `manifest.json`. Do not select the ZIP or its parent folder.
5. Open the ChatGPT or Nomi conversations you want to connect in that same Edge profile. Sign in normally and refresh both chat tabs after installation.
6. Open the add-in from Edge's Extensions menu and click **Open Play / Stop controls**. Pin it to the toolbar if useful.

## Use the bridge

Select two different conversation tabs as **First chat** and **Second chat**. Choose which chat supplies the first reply. That chat must already have an AI reply; send an opening message yourself if needed. Press **Play** to alternate replies. Keep Edge open and the computer awake, and avoid typing in the selected chats while the bridge runs.

**Stop** prevents further sends, although an already-submitted message may still receive a reply. **Play** resumes the pending turn. **Reset** starts from the selected speaker's latest reply again and may repeat a message. If delivery was uncertain, check both chats before Reset.

Both tabs use the same Edge profile and therefore share that profile's website logins. Two tabs do not give you two different ChatGPT accounts. This extension does not connect separate browser profiles or browsers.

## Message length and supported content

Text only: audio, images, attachments, and other non-text content are not forwarded. Replies sent to Nomi are capped at the implementation's 750-character limit and truncated rather than split into multiple messages. A confirmed truncated ChatGPT reply causes the next return to ChatGPT to include a reminder to keep subsequent replies short. ChatGPT-to-ChatGPT forwards the full text subject to the destination website's own limits.

## Troubleshooting

- **A chat is missing:** refresh that tab after loading or reloading the extension. Confirm it is a supported ChatGPT or Nomi conversation in the same Edge profile.
- **Reply preview or page controls are wrong:** open the add-in on that chat, expand **Set up this chat's page controls**, and use Preview to inspect the detected reply and controls. Reply selectors should capture only complete AI replies. Verify the preview and generation detection before saving custom selectors.
- **Play stops or sending is uncertain:** check both chats, read Activity, and use **Copy troubleshooting status** to collect a report. Inspect the chats before Reset so you do not repeat a message.
- **A website changed its layout:** selectors or response-completion detection may need a source update. Local fixture tests do not prove compatibility with every live website layout or authentication challenge.
- **After editing source:** click Reload on the extension at `edge://extensions`, refresh both chat tabs, and reopen the controls.

The extension saves recent chat snapshots and relay state in Edge's extension session storage and custom selectors in local extension storage. It sends forwarded text through the selected websites; there is no separate relay server. No browser profiles, cookies, passwords, personal conversations, or installed dependencies are included in this source package.

See **DEVELOPMENT.md** for the code map and test commands.
