import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock, MagicMock
from types import SimpleNamespace

from app import setup_logins, ordinary_edge


class LoginSetupTests(unittest.TestCase):
    def test_login_uses_ordinary_edge_and_the_same_two_profile_directories(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root = Path(temp)
            edge = root / 'Microsoft/Edge/Application/msedge.exe'
            edge.parent.mkdir(parents=True)
            edge.touch()
            profiles = root / 'profiles'
            with patch.dict(os.environ, {'PROGRAMFILES(X86)':str(root)}), patch('app.subprocess.Popen') as launch:
                setup_logins(profiles)
            self.assertEqual(launch.call_count, 2)
            for label, call in zip(('A','B'), launch.call_args_list):
                self.assertEqual(call.args[0], [str(edge), '--user-data-dir=' + str((profiles / label).resolve()),
                                               '--disable-background-mode', '--new-window', 'https://nomi.ai/', 'https://chatgpt.com/'])
            self.assertTrue((profiles / 'login-setup-opened').exists())


class BrowserLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_production_launch_preserves_normal_browser_defaults(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            context = object()
            browser = SimpleNamespace(contexts=[context])
            connect = AsyncMock(return_value=browser)
            playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
            process = MagicMock()
            process.poll.return_value = None
            with patch('app.edge_executable', return_value=Path('msedge.exe')), patch('app.subprocess.Popen', return_value=process) as launch, patch('app.debug_endpoint', return_value='ws://127.0.0.1/browser/test'):
                result = await ordinary_edge(playwright, Path(temp) / 'A', False)
            self.assertEqual(result, (browser, context))
            args = launch.call_args.args[0]
            self.assertNotIn('--enable-automation', args)
            self.assertFalse(any(arg.startswith('--headless') for arg in args))
            self.assertIn('--remote-debugging-address=127.0.0.1', args)
            connect.assert_awaited_once_with('ws://127.0.0.1/browser/test', no_defaults=True)


if __name__ == '__main__':
    unittest.main()
