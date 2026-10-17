"""Portable Windows bridge. Edge handles login; no extension or API key required."""
import argparse
import asyncio
import json
import os
import subprocess
import socket
import time
import urllib.request
from pathlib import Path
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
ASSETS = ROOT / 'extension' if getattr(sys, 'frozen', False) else ROOT.parent / 'extension'
CONTROL_URL = 'https://bridge.local/'


def edge_executable():
    candidates = [Path(os.environ.get(name, '')) / 'Microsoft/Edge/Application/msedge.exe'
                  for name in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA')]
    edge = next((path for path in candidates if path.is_file()), None)
    if not edge:
        raise RuntimeError('Microsoft Edge is not installed.')
    return edge


def setup_logins(profiles):
    """Sign in using ordinary Edge before attaching browser automation."""
    edge = edge_executable()
    for label in ('A', 'B'):
        folder = (profiles / label).resolve()
        folder.mkdir(parents=True, exist_ok=True)
        subprocess.Popen([str(edge), '--user-data-dir=' + str(folder), '--disable-background-mode', '--new-window',
                          'https://nomi.ai/', 'https://chatgpt.com/'])
    (profiles / 'login-setup-opened').touch()


def debug_endpoint(port):
    # Local browser metadata only; never send this through a configured proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:%d/json/version' % port, timeout=1) as response:
        return json.load(response)['webSocketDebuggerUrl']


async def ordinary_edge(playwright, folder, smoke):
    folder.mkdir(parents=True, exist_ok=True)
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    args = [str(edge_executable()), '--user-data-dir=' + str(folder.resolve()),
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + str(port),
            '--disable-background-mode', '--no-first-run', '--new-window', 'about:blank']
    if smoke:
        args.insert(-1, '--headless=new')
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Account profile %s is already open. Close its sign-in/setup Edge windows and any older ChatBridge instance, then try again.' % folder.name)
        try:
            endpoint = await asyncio.to_thread(debug_endpoint, port)
        except Exception:
            await asyncio.sleep(0.25)
            continue
        try:
            browser = await playwright.chromium.connect_over_cdp(endpoint, no_defaults=True)
            return browser, browser.contexts[0]
        except Exception:
            process.terminate()
            raise
    process.terminate()
    raise RuntimeError('Edge did not open its local connection. Close the setup windows and try again.')


def is_chat(url):
    parsed = urlparse(url)
    host = parsed.hostname or ''
    return parsed.scheme == 'https' and (host in ('chatgpt.com', 'chat.openai.com', 'nomi.ai') or host.endswith('.nomi.ai'))


class DesktopBridge:
    def __init__(self):
        self.pages = {}
        self.profiles = {}
        self.control = None
        self.lock = asyncio.Lock()
        self.closed = asyncio.Event()

    def page_id(self, page):
        if page not in self.pages:
            self.pages[page] = str(len(self.pages) + 1)
        return self.pages[page]

    async def engine(self, method, *args):
        return await self.control.evaluate('({method,args}) => window.bridge[method](...args)', {'method':method, 'args':args})

    async def wake_chats(self, contexts):
        # Ordinary Edge can throttle timers in inactive windows. Poll from the
        # native host so that both sides keep reporting while another tab is active.
        while not self.closed.is_set():
            for context in contexts:
                for page in context.pages:
                    if is_chat(page.url):
                        try:
                            await page.evaluate('window.__bridgeWake?.()')
                        except Exception:
                            pass
            await asyncio.sleep(1)

    async def wait_engine(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = await self.engine('state')
            if predicate(state):
                return state
            await asyncio.sleep(0.25)
        raise RuntimeError('Fixture relay timed out: ' + json.dumps(await self.engine('state')))

    async def verify(self):
        command = await self.control.evaluate('window.bridge.command')
        if not command:
            return False
        source = next((p for p, id in self.pages.items() if id == command['source']), None)
        try:
            result = await source.evaluate('window.__bridgeInspect()') if source and not source.is_closed() else None
            return await self.engine('validateSource', command['id'], result.get('snapshot') if result else None)
        except Exception:
            await self.engine('stop', 'Cannot verify the source reply. Check both chats, then press Play.')
            return False

    async def dispatch(self, source, message):
        async with self.lock:
            page = source['page']
            path = message.get('path', '')
            data = message.get('data') or {}
            try:
                if page == self.control and source['frame'] == page.main_frame and source['frame'].url == CONTROL_URL:
                    if path == '/api/state':
                        return await self.engine('state')
                    if path in ('/api/play', '/api/stop', '/api/reset'):
                        await self.engine({'/api/play':'start', '/api/stop':'stop', '/api/reset':'reset'}[path], *([data] if path == '/api/play' else []))
                        return await self.engine('state')
                    raise ValueError('Unknown control action')
                if not is_chat(source['frame'].url) or source['frame'] != page.main_frame:
                    raise ValueError('Unsupported chat page')
                id = self.page_id(page)
                if path == '/api/heartbeat':
                    snapshot = dict(data['snapshot'], browser='Edge · account ' + self.profiles[page.context], window=self.profiles[page.context])
                    result = await self.engine('heartbeat', id, snapshot)
                    if result.get('command'):
                        if not await self.verify():
                            return {}
                        await page.bring_to_front()
                    return result
                if path == '/api/claim':
                    if data.get('checkOnly') and not await self.verify():
                        return {'allowed':False}
                    return await self.engine('claim', id, data['id'], data.get('checkOnly', False))
                if path == '/api/ack':
                    return await self.engine('acknowledge', id, data)
                raise ValueError('Unknown chat action')
            except Exception as exc:
                return {'error':str(exc)}

    async def serve(self, route):
        name = urlparse(route.request.url).path.strip('/') or 'dashboard.html'
        if name not in ('dashboard.html', 'dashboard.js', 'style.css'):
            await route.abort()
            return
        text = (ASSETS / name).read_text(encoding='utf-8')
        if name == 'dashboard.html':
            text = text.replace('<script src="dashboard.js">', '<script>' + (ASSETS / 'engine.js').read_text(encoding='utf-8') + '\nwindow.bridge = new Bridge();</script><script src="dashboard.js">')
            text = text.replace('BROWSER BRIDGE', 'DESKTOP BRIDGE').replace('Open any two ChatGPT or Nomi conversations in separate Edge tabs and sign in normally. Refresh both tabs once after installing the extension, then select them above.', 'Use the two Edge account windows opened by this app. Open ChatGPT or Nomi in each window and sign in. These windows keep separate logins. Then select the two chats above.')
            text = text.replace('open the extension on that chat and use its setup preview', 'check that you are on a conversation page and send an opening message')
        elif name == 'dashboard.js':
            text = text.replace('Reload the bridge at edge://extensions, then reopen these controls.', 'Close the bridge and launch ChatBridge again.')
        await route.fulfill(status=200, content_type={'dashboard.html':'text/html','dashboard.js':'application/javascript','style.css':'text/css'}[name], body=text)

    async def run(self, profile_root, smoke=False):
        async with async_playwright() as playwright:
            contexts = []
            browsers = []
            wake_task = None
            try:
                for label in ('A', 'B'):
                    browser, context = await ordinary_edge(playwright, profile_root / label, smoke)
                    browsers.append(browser)
                    contexts.append(context)
                    self.profiles[context] = label
                    await context.expose_binding('desktopBridge', self.dispatch)
                    await context.add_init_script(script=(ROOT / 'adapter.js').read_text(encoding='utf-8') + "\nif (['chatgpt.com','chat.openai.com','nomi.ai'].includes(location.hostname) || location.hostname.endsWith('.nomi.ai')) {" + (ASSETS / 'content.js').read_text(encoding='utf-8') + '}')
                    await context.route('https://bridge.local/**', self.serve)
                self.control = await contexts[0].new_page()
                await self.control.goto(CONTROL_URL)
                await self.control.wait_for_function('window.bridge && document.getElementById("status").textContent !== "Connecting…"')
                wake_task = asyncio.create_task(self.wake_chats(contexts))
                if smoke:
                    return await self.smoke(contexts)
                for context in contexts:
                    page = context.pages[0]
                    await page.goto('https://chatgpt.com/', wait_until='domcontentloaded', timeout=60000)
                await self.control.bring_to_front()
                self.control.on('close', lambda _: self.closed.set())
                for context in contexts:
                    context.on('close', lambda _: self.closed.set())
                await self.closed.wait()
            finally:
                if wake_task:
                    wake_task.cancel()
                    try:
                        await wake_task
                    except asyncio.CancelledError:
                        pass
                for browser in reversed(browsers):
                    try:
                        # Close only the two browser processes opened by this app.
                        session = await browser.new_browser_cdp_session()
                        await session.send('Browser.close')
                    except Exception:
                        pass
                    await browser.close()

    async def smoke(self, contexts):
        reports = []
        fixture = '<textarea id="prompt-textarea" aria-label="Chat Input"></textarea><button data-testid="send-button" aria-label="Send message">Send</button><article data-testid="conversation-turn-1"><div data-message-author-role="assistant" class="MessageBubble_nomiContent__fixture">Opening reply</div><button data-testid="copy-turn-action-button">Copy</button></article><script>document.querySelector("[data-testid=send-button]").onclick=()=>{document.querySelector("textarea").value="";document.querySelector("[data-message-author-role]").textContent="Next reply "+Date.now();};</script>'
        for context in contexts:
            for domain in ('chatgpt.com', 'nomi.ai'):
                await context.route('https://' + domain + '/**', lambda route: route.fulfill(status=200, content_type='text/html', body=fixture))
        for sites in (('chatgpt','chatgpt'), ('nomi','nomi'), ('chatgpt','nomi')):
            await self.engine('stop')
            await self.engine('reset')
            for index, (context, site) in enumerate(zip(contexts, sites)):
                domain = 'chatgpt.com' if site == 'chatgpt' else 'nomi.ai'
                await context.pages[0].goto('https://' + domain + '/c/fixture-' + str(index))
            ids = [self.page_id(context.pages[0]) for context in contexts]
            expected = dict(zip(ids, sites))
            await self.wait_engine(lambda state: len(state['tabs']) == 2 and all(t['ready'] and t['site'] == expected[t['id']] for t in state['tabs']))
            await self.engine('start', {'tabs':ids, 'settle':3})
            state = await self.wait_engine(lambda state: state['turns'] >= 2)
            assert state['running'] and state['turns'] >= 2, state
            await self.engine('stop')
            report = {'smoke':'PASS', 'pair':sites, 'turns':state['turns'], 'profiles':len(contexts)}
            reports.append(report)
            if sys.stdout:
                print(json.dumps(report), flush=True)
        return reports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--smoke-test', action='store_true')
    parser.add_argument('--setup-logins', action='store_true')
    parser.add_argument('--profile-dir', type=Path)
    parser.add_argument('--smoke-report', type=Path)
    args = parser.parse_args()
    profiles = args.profile_dir or Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'ChatBridge' / 'profiles'
    try:
        if args.setup_logins or (sys.platform == 'win32' and not args.smoke_test and not (profiles / 'login-setup-opened').exists()):
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,
                'Sign into Nomi and ChatGPT in the two ordinary Edge windows that open next. Each window has its own account profile.\n\nAfter signing in, CLOSE both of those Edge windows completely, then run ChatBridge.exe again to start the bridge.\n\nThese are separate profiles from your usual browser, so your usual saved logins are not automatically available.',
                'Chat Bridge: set up sign-ins', 0x40)
            setup_logins(profiles)
            return 0
        result = asyncio.run(DesktopBridge().run(profiles, args.smoke_test))
        if args.smoke_report and args.smoke_test:
            args.smoke_report.write_text(json.dumps(result, indent=2), encoding='utf-8')
    except Exception as exc:
        if args.smoke_test:
            import traceback
            if args.smoke_report:
                args.smoke_report.write_text(json.dumps({'error':traceback.format_exc()}), encoding='utf-8')
            if sys.stderr:
                traceback.print_exc()
            return 1
        text = 'Could not start the bridge. Make sure Microsoft Edge is installed and no other ChatBridge instance is using its account windows.\n\n' + str(exc)
        if sys.platform == 'win32':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, 'Chat Bridge', 0x10)
        elif sys.stderr:
            print(text, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
