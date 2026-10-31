import unittest
from drift import drift

class DriftTests(unittest.TestCase):
    def test_no_change(self):
        self.assertEqual(drift({'cidr': '10.0.0.0/16'}, {'cidr': '10.0.0.0/16'}), [])

    def test_added_deleted_changed(self):
        actual = drift({'network': 'old', 'encryption': True}, {'network': 'new', 'ingress': 'public'})
        self.assertEqual([d['field'] for d in actual], ['encryption', 'ingress', 'network'])
        self.assertEqual(actual[0]['desired'], True)
        self.assertIsNone(actual[0]['observed'])

if __name__ == '__main__':
    unittest.main()
