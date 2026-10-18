# Heartbeat (0.4.3)

Select **Heartbeat** as the fourth conversation mode, select one ChatGPT tab,
enter a phrase, and press Play. No Nomi tab or API key is required.

The first prompt includes instructions explaining the controls below. Subsequent
prompts contain just the chosen phrase. Each waits for a new, completed ChatGPT
response, the existing completion quiet-time check, then the configured delay
(10 seconds by default). It does not send while a reply is streaming or a draft
is in the editor.

GPT can respond with exactly one of these commands, without other text or code fences:

- `[sleep]`: stop Heartbeat until the human presses Play.
- `[sleep 2HRS]`: suspend for two hours, then send the phrase again.
- `[sleep 0.5HRS]`: suspend for thirty minutes.

Stop prevents all scheduled sends until Play. Timed sleep survives extension
service-worker suspension through existing session storage. Edge must remain
running; a sleeping computer cannot send, and overdue prompts wait for the tab
to reconnect. Closing Edge or reloading the extension clears session storage;
start again manually. Phrase and delay are retained in the dashboard's local
storage. Reset starts a fresh session and includes startup instructions again.

Only completed replies to heartbeat prompts are interpreted as commands; old
history, streaming fragments, and command examples within prose are ignored.
Uncertain delivery stops instead of risking a duplicate prompt.
