import importlib.util
import unittest
import datetime as dt
from pathlib import Path

spec = importlib.util.spec_from_file_location('update_data', Path(__file__).resolve().parents[1] / 'scripts/update_data.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class DataValidationTest(unittest.TestCase):
    def sample(self):
        day = dt.date.today()
        date = f'{day.year - 1911:03d}{day.month:02d}{day.day:02d}'
        return {'key': 'listed', 'companies': [{'name': f'測試公司 {i}', 'code': str(1000 + i), 'market': '上市', 'date': date, 'source': mod.SPECS[0][3]} for i in range(500)]}

    def test_valid_and_roc_dates(self):
        data = self.sample()
        self.assertIs(mod.validate_dataset(data, mod.SPECS[0]), data)
        self.assertEqual(mod.issuer_date('1151119'), dt.date(2026, 11, 19))

    def test_truncated_and_duplicate_not_accepted(self):
        data = self.sample()
        data['companies'][1]['code'] = data['companies'][0]['code']
        with self.assertRaises(ValueError): mod.validate_dataset(data, mod.SPECS[0])
        with self.assertRaises(ValueError): mod.validate_dataset({'key': 'listed', 'companies': []}, mod.SPECS[0])

    def test_stale_and_future_not_accepted(self):
        for date in ['1000101', '9990101']:
            data = self.sample()
            for c in data['companies']: c['date'] = date
            with self.assertRaises(ValueError): mod.validate_dataset(data, mod.SPECS[0])

    def test_shrink_and_older_data_not_accepted(self):
        data = self.sample()
        previous = {'companies': data['companies'] * 2}
        with self.assertRaises(ValueError): mod.validate_dataset(data, mod.SPECS[0], previous)
        previous = {'companies': [{**c, 'date': '9990101'} for c in data['companies']]}
        with self.assertRaises(ValueError): mod.validate_dataset(data, mod.SPECS[0], previous)

if __name__ == '__main__': unittest.main()
