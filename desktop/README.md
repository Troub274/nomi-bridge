# Chat Bridge for Windows

Extract the ZIP, then double-click `ChatBridge.exe`. It is a single portable executable. Microsoft Edge must be installed. Python, Node, an extension, and API keys are not required on the receiving computer. The first launch can take a few seconds while the bundled runtime unpacks.

On the first launch, the app opens two **ordinary Edge windows for sign-in**, without browser automation. Sign into Nomi and ChatGPT there, close both of these windows completely, then launch the app again. Google can reject sign-in in automated browsers; doing the initial sign-in in ordinary Edge avoids attempting Google authentication inside the automation session. If you need to sign in again later, close the bridge and run `Set up logins.cmd`.

These profiles are separate from your usual browser: its saved credentials are not automatically imported. Each account window retains the logins you establish during setup. The app then opens two account windows and a controls tab. Select any two connected chats: ChatGPT ↔ Nomi, ChatGPT ↔ ChatGPT, or Nomi ↔ Nomi. Select which chat's existing reply starts the exchange, then press Play.

The bridge starts ordinary Edge and connects through its local debugging interface. It keeps Edge's normal browser settings rather than applying the automation launcher defaults. This still uses browser automation; Cloudflare verification may remain unsupported and must be checked on the real website. The app does not solve verification challenges. Sign-in setup remains available for reauthentication.

Stop prevents additional sends. Play resumes. Reset starts again from the selected first speaker's latest reply and may repeat it. Keep the app's Edge windows open and the computer awake. Closing the controls or an account window shuts down the app. If delivery is uncertain, check both chats before Reset. Never run two copies at the same time.

Replies sent to Nomi are capped at 750 characters. Long ChatGPT replies sent to Nomi trigger a reminder on the next return to ChatGPT. Text only; website changes can break response detection or sending.

Logins and browser data are stored on your own computer in `%LOCALAPPDATA%\ChatBridge\profiles\A` and `B`, outside the distributed app folder. Do not share those profile folders. The app opens its own Edge windows; it does not attach to your existing browser windows. Both accounts use the same computer/network connection.

This executable is unsigned, so Windows may display an unknown-publisher warning. It is an initial build; logged-in ChatGPT/Nomi operation still needs live verification.

## Build from source on Windows

Install Python 3.12 or later, then run `powershell -ExecutionPolicy Bypass -File build.ps1` from this directory. The output is `dist/ChatBridge-Windows.zip`. The package includes the Playwright driver but uses installed Edge, avoiding a bundled browser download.

For a local browser integration test: `python app.py --smoke-test --profile-dir ./smoke-profiles`. Run with the installed requirements available. This test uses intercepted local fixture pages and sends no messages to real accounts.
