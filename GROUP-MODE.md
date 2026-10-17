# Chat Bridge 0.3.9

Load the extension folder with Edge's Load unpacked button at edge://extensions. Disable any older Chat Bridge first,  open the extension controls, and select Group room mode. Select ChatGPT first and the Nomi group room second.

Group mode sends GPT startup instructions automatically. Commands: [say] text, [wait], [listening], [invite] exact member name, [play], [pause], [help]. Only [say] text reaches the room. Help/startup acknowledgments stay internal.

There is no total text-length limit imposed on group responses. The bridge splits each [say] into ordered messages of at most 800 UTF-16 units, preferring word boundaries and preserving surrogate pairs and all text. Nothing is truncated. GPT may also use multiple [say] blocks. Each command tag starts on a new line. An optional final [play] lets the Nomis choose the next speaker; [invite] name chooses a specific member. A multi-message batch first pauses Auto Chat, confirms each message in order, then executes the final control. Stop preserves the pending queue and prevents further actions. Nomi Auto Chat operates independently of bridge Stop.

Private two-chat mode retains its previous 750-character truncation policy.

72 automated tests pass, including group engine, simulated DOM controls, chunk preservation, message ordering, stop/resume, and direct-chat regression tests. Live Edge end-to-end testing remains; no test messages were sent to the live room. This build updates the browser extension, not the desktop wrapper. Keep Edge running and the computer awake.

Open chat tabs are now discovered automatically across windows in the same Edge profile. Missing content scripts are injected without a page refresh. Sleeping tabs are listed. Play activates the two selected tabs and waits for their editors to connect. Stop cancels startup. Reload the extension once for this update; Edge may ask to approve the new scripting/site permissions.

Listening/wait now resumes Auto Chat when paused or waiting for the user turn. Internal startup/help acknowledgments do not resume it.
