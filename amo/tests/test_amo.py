import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
import amo

CONFIG = {'AMO_BASE_URL': 'https://personal-test.amocrm.ru', 'AMO_CLIENT_ID': 'test-id',
          'AMO_CLIENT_SECRET': 'SECRET', 'AMO_REDIRECT_URI': 'http://localhost:8765/callback'}

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = amo.Client(CONFIG, Path(self.tmp.name))
        self.seed()

    def seed(self, expires=None):
        amo.private_write(self.client.token_path, json.dumps(dict(access_token='old-access',
            refresh_token='old-refresh', expires_at=expires or time.time() + 3600,
            account=CONFIG['AMO_BASE_URL'], client_id=CONFIG['AMO_CLIENT_ID'])))

    def pair(self):
        return dict(access_token='new-access', refresh_token='new-refresh', expires_in=86400)

    def test_exchange_and_permissions(self):
        self.client.transport = Mock(return_value=self.pair())
        self.client.authorize('one-time-code')
        data = self.client.read_tokens()
        self.assertEqual(data['refresh_token'], 'new-refresh')
        self.assertEqual(self.client.token_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.client.transport.call_args.args[2]['grant_type'], 'authorization_code')

    def test_expiry_rotates_both_tokens(self):
        self.seed(time.time() - 10)
        self.client.transport = Mock(return_value=self.pair())
        self.assertEqual(self.client.access_token(), 'new-access')
        self.assertEqual(self.client.read_tokens()['refresh_token'], 'new-refresh')
        self.assertEqual(self.client.transport.call_args.args[2]['refresh_token'], 'old-refresh')
        self.client.access_token()
        self.assertEqual(self.client.transport.call_count, 1)

    def test_401_refreshes_once(self):
        self.client.transport = Mock(side_effect=[amo.HTTPError(401), self.pair(), {'ok': True}])
        self.assertEqual(self.client.get('/api/v4/leads'), {'ok': True})
        self.assertEqual(self.client.transport.call_count, 3)

    def test_second_401_stops(self):
        self.client.transport = Mock(side_effect=[amo.HTTPError(401), self.pair(), amo.HTTPError(401)])
        with self.assertRaises(amo.HTTPError):
            self.client.get('/api/v4/leads')
        self.assertEqual(self.client.transport.call_count, 3)

    def test_failed_refresh_preserves_file(self):
        before = self.client.token_path.read_bytes()
        self.client.transport = Mock(side_effect=amo.HTTPError(400))
        with self.assertRaises(amo.HTTPError):
            self.client.access_token(force=True)
        self.assertEqual(self.client.token_path.read_bytes(), before)

    def test_other_process_already_refreshed(self):
        self.client.transport = Mock()
        self.assertEqual(self.client.access_token(rejected='previous-access'), 'old-access')
        self.client.transport.assert_not_called()

    def test_writes_and_foreign_paths_blocked(self):
        self.client.opener = Mock()
        for method, path in [('POST', '/api/v4/leads'), ('PATCH', '/api/v4/contacts'),
                             ('DELETE', '/api/v4/tasks'), ('GET', '//evil.example'),
                             ('GET', '/api/v4/leads/../users'), ('POST', '/oauth2/access_token?x=1')]:
            with self.assertRaises(amo.AmoError):
                self.client.transport(method, path)
        self.client.opener.open.assert_not_called()

    def test_pagination_does_not_follow_foreign_url(self):
        self.client.get = Mock(side_effect=[{'_embedded': {'leads': [{'id': 1}]},
            '_links': {'next': {'href': 'https://evil.example'}}}, {'_embedded': {'leads': [{'id': 2}]}}])
        self.assertEqual(len(self.client.listing('leads', 2)), 2)
        self.assertEqual(self.client.get.call_args.args[0], '/api/v4/leads?page=2&limit=50')

    def test_all_resource_routes_and_empty_response(self):
        self.client.get = Mock(return_value={})
        for resource, path in amo.RESOURCES.items():
            self.assertEqual(self.client.listing(resource), [])
            self.assertTrue(self.client.get.call_args.args[0].startswith('/api/v4/' + path))
        self.client.listing('statuses', pipeline=123)
        self.assertEqual(self.client.get.call_args.args[0], '/api/v4/leads/pipelines/123/statuses')

    def test_config_mismatch(self):
        self.client.config = dict(CONFIG, AMO_CLIENT_ID='different')
        with self.assertRaises(amo.AmoError):
            self.client.read_tokens()

    def test_oauth_diagnostics_hide_server_values(self):
        secret = 'SENSITIVE-EXAMPLE'
        for body in ({'error': 'invalid_client', 'detail': secret},
                     {'error': 'invalid_grant', 'hint': secret},
                     {'detail': 'redirect_uri mismatch ' + secret}):
            hint = amo.oauth_error_hint(json.dumps(body))
            self.assertTrue(hint)
            self.assertNotIn(secret, hint)
        self.assertIsNone(amo.oauth_error_hint('not json'))
        self.assertIsNone(amo.oauth_error_hint(json.dumps({'detail': secret})))

    def test_no_redirect(self):
        self.assertIsNone(amo.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example'))

if __name__ == '__main__':
    unittest.main()
