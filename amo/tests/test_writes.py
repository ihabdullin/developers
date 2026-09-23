import unittest
from unittest.mock import Mock
import amo
import test_amo

class WriteTests(unittest.TestCase):
    setUp = test_amo.ClientTests.setUp
    seed = test_amo.ClientTests.seed
    pair = test_amo.ClientTests.pair
    def test_create_and_update(self):
        self.client.allow_writes = True
        self.client.transport = Mock(return_value={'_embedded': {'leads': [{'id': 123}]}})
        self.assertEqual(self.client.write('leads', {'name': 'Test'})['id'], 123)
        self.assertEqual(self.client.transport.call_args.args[0], 'POST')
        self.client.write('leads', {'price': 0}, 123)
        self.assertEqual(self.client.transport.call_args.args[:3], ('PATCH', '/api/v4/leads', [{'price': 0, 'id': 123}]))

    def test_no_retry_ambiguous_write(self):
        self.client.allow_writes = True
        self.client.transport = Mock(side_effect=amo.AmoError('Network'))
        with self.assertRaises(amo.AmoError):
            self.client.write('leads', {'name': 'Test'})
        self.assertEqual(self.client.transport.call_count, 1)

    def test_write_401_refresh(self):
        self.client.allow_writes = True
        self.client.transport = Mock(side_effect=[amo.HTTPError(401), self.pair(), {'_embedded': {'tasks': [{'id': 22}]}}])
        self.assertEqual(self.client.write('tasks', {'text': 'Test', 'complete_till': 1900000000})['id'], 22)
        self.assertEqual(self.client.transport.call_count, 3)

    def test_invalid_fields_and_bulk(self):
        self.client.allow_writes = True
        self.client.opener = Mock()
        for record in ([{}, {}], [{'name': 'Test', 'id': 1}], [{'name': 'Test', 'price': -1}]):
            with self.assertRaises(amo.AmoError):
                self.client.transport('POST', '/api/v4/leads', record)
        with self.assertRaises(amo.AmoError):
            self.client.transport('DELETE', '/api/v4/leads/1')
        self.client.opener.open.assert_not_called()

    def test_all_resource_validation(self):
        for resource in ('leads', 'contacts', 'companies'):
            amo.validate_record(resource, {'name': 'Test'})
            amo.validate_record(resource, {'id': 1, 'name': 'Updated'}, True)
        amo.validate_record('tasks', {'text': 'Test', 'complete_till': 1900000000})
        amo.validate_record('tasks', {'id': 1, 'is_completed': True, 'result': {'text': 'Done'}}, True)
