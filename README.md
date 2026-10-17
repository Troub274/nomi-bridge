# Chat Bridge — Edge extension and Windows desktop app

## Current Edge extension: 0.4.0

**Three modes:** Direct Chat (two chat tabs), Group Chat (ChatGPT and a Nomi group room in Edge), and **API Room** (one ChatGPT tab + a separate persistent Nomi API room).

API Room uses the locally saved Nomi API key. Choose one Nomi, then select or create one room. Each complete ChatGPT turn—including arbitrarily long World Engine output—is sent in lossless, ordered submissions of up to **800 UTF-8 bytes**. After **all** chunks are confirmed, the bridge requests **one Nomi reply** and forwards it to ChatGPT. The Nomi's private chat is untouched. See [API-ROOM-MODE.md](API-ROOM-MODE.md) for setup, limits, and safety precautions.

The older setup/version notes follow below.

---

# Chat Bridge — Edge extension and Windows desktop app

Version 0.2.0 supports ChatGPT ↔ Nomi, ChatGPT ↔ ChatGPT, and Nomi ↔ Nomi. Select **First chat** and **Second chat**, then choose which starts. Both must be different tabs with an existing reply in the starting chat. Nomi destinations retain the 750-character limit; ChatGPT-to-ChatGPT forwards the full reply.

The extension connects tabs in one browser profile. Tabs in that profile share website logins; separate tabs do not provide separate accounts. For different accounts, use the standalone Windows app, which opens two independent Edge profiles. See [desktop instructions](desktop/README.md). The portable app package is `desktop/dist/ChatBridge-Windows.zip`; the updated extension package is `ChatBridge-Edge.zip`.

The notes below document the extension's setup and version history.

## Install once

1. In Edge, open edge://extensions.
2. Turn on Developer mode.
3. Click Load unpacked and select:
   C:\home\stecla\coding\nomi\browser_bridge\extension
4. Open your ChatGPT and Nomi conversations in two Edge tabs. Refresh both once.
5. Open the ChatGPT ↔ Nomi Bridge extension from Edge's Extensions menu.
6. Click Open Play / Stop controls.

## Start chatting

Select the ChatGPT tab and the Nomi tab, choose whose latest reply starts the conversation, and press Play. The first speaker must already have a reply in its chat. If necessary, send it an opening message yourself first.

The bridge alternates text replies indefinitely while Edge is open and the computer is awake. Stop prevents further sends; something already submitted can still receive a reply. Play resumes the pending turn. Reset discards the pending position and starts again from the selected speaker's latest reply, which may repeat that reply.

If a send is uncertain or a selected chat is reloaded, navigated, or closed, check both chats before using Reset. Do not type in the selected chats while the bridge runs. If a website rejects a long reply, the bridge stops rather than silently truncating it.

## Check the live chat controls

Open the extension on either chat tab and expand Set up this chat's page controls. Preview shows the latest AI reply and whether generation is detected. Verify it shows the complete newest AI reply, without your own text or sidebar content. If a site changes its controls, adjust them there.

Reply completion uses the website's visible generation indicator plus a quiet-time delay (8 seconds by default). A quiet period alone is not a guarantee that a reply is finished. The supplied Nomi controls were derived from its public site code, not a verified logged-in session.

This version connects tabs in the same Edge profile. It does not connect separate browsers or profiles. It forwards text only. It needs no Python, WSL, API key, or local server.

## Validation

Nine automated checks pass: continuous alternation, streaming waits, Stop/Resume, uncertain sends, navigation during a send, drafts, session restoration, wrong-tab delivery, and storage-update feedback prevention. All JavaScript files pass syntax checks. Installation and real ChatGPT/Nomi sending in your logged-in Edge tabs still need live testing.

## Files and data

Load the extension folder, not this parent folder or the zip file. Keep that folder in place after installation. The extension holds recent chat snapshots and relay state in Edge session storage and saves custom control selectors in local extension storage. It has no remote relay server.

Version 0.1.4 sends one message per turn. ChatGPT replies longer than 750 characters are cut to 750 for Nomi, with no extra parts sent. Each Nomi reply goes back to ChatGPT next. The receiving tab is selected automatically before Send to avoid inactive-tab delays. Use Activity → Copy troubleshooting status to report a stall; it excludes message text.

ChatGPT replies now require completion controls on the current response and no streaming marker. Multiple assistant text blocks in that response are read together. If completion cannot be detected, the bridge waits rather than forwarding a partial reply. Twenty-one automated checks pass; the actual page still needs live verification.


Version 0.1.6: after a shortened message is confirmed sent to Nomi, the next Nomi reply forwarded to ChatGPT includes a clearly labeled bridge reminder to keep entire replies within 750 characters. The reminder is added once per truncation and is not added to Nomi's chat itself.


Version 0.1.7 checks streaming markers on the response container itself. Activity records source and outgoing character counts; Copy troubleshooting status includes the last delivery's counts. Live short-fragment diagnosis remains open.


Version 0.1.8 makes Play show immediate progress and errors beside the button, handles unavailable selection storage, and times out unresponsive extension requests. Nomi's input/send/reply selectors were checked against the live logged-in page on October 9. The cause of the user's inert Play button has not yet been confirmed.

