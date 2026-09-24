import unittest
from unittest.mock import Mock, patch
import amo
import test_amo


class LeadFieldTests(unittest.TestCase):
    setUp = test_amo.ClientTests.setUp
    seed = test_amo.ClientTests.seed

    def test_paginated_metadata(self):
        self.client.get = Mock(side_effect=[
            {'_embedded': {'custom_fields': [{'id': 1}]}, '_links': {'next': {'href': 'https://evil.test'}}},
            {'_embedded': {'custom_fields': [{'id': 2}]}}])
        with patch('amo.time.sleep'):
            self.assertEqual(self.client.lead_fields(), [{'id': 1}, {'id': 2}])
        self.assertEqual(self.client.get.call_args.args[0], '/api/v4/leads/custom_fields?page=2&limit=50')

    def test_schema_writes_still_blocked(self):
        self.client.allow_writes = True
        self.client.opener = Mock()
        for method in ['POST', 'PATCH', 'DELETE']:
            with self.assertRaises(amo.AmoError):
                self.client.transport(method, '/api/v4/leads/custom_fields', [{'name': 'test'}])
        self.client.opener.open.assert_not_called()

    def test_metadata_get_is_allowed(self):
        response = Mock(status=200)
        response.read.return_value = b'{"_embedded":{"custom_fields":[]}}'
        self.client.opener.open = Mock()
        self.client.opener.open.return_value.__enter__ = Mock(return_value=response)
        self.client.opener.open.return_value.__exit__ = Mock(return_value=False)
        result = self.client.get('/api/v4/leads/custom_fields?page=1&limit=50')
        self.assertEqual(result['_embedded']['custom_fields'], [])

    def test_truncation_is_not_absence(self):
        self.client.get = Mock(return_value={'_links': {'next': {'href': '/next'}}})
        with patch('amo.time.sleep'), self.assertRaises(amo.AmoError):
            self.client.lead_fields()
