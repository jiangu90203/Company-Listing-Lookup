#!/usr/bin/env python3
"""Refresh only public issuer data. Never reads imported user spreadsheets."""
import argparse
import concurrent.futures
import csv
import datetime as dt
import io
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPECS = [
    ('listed', '上市', 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L', 'https://data.gov.tw/dataset/18419', 500),
    ('otc', '上櫃', 'https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv', 'https://data.gov.tw/dataset/25036', 400),
    ('emerging', '興櫃', 'https://mopsfin.twse.com.tw/opendata/t187ap03_R.csv', 'https://data.gov.tw/dataset/28568', 100),
    ('public', '公開發行但未上市櫃', 'https://openapi.twse.com.tw/v1/opendata/t187ap03_P', 'https://data.gov.tw/dataset/28567', 100),
]
FIELDS = {'name': '公司名稱', 'short': '公司簡稱', 'id': '營利事業統一編號', 'code': '公司代號', 'date': '出表日期', 'address': '住址', 'chairman': '董事長', 'website': '網址', 'phone': '總機電話'}

def issuer_date(value):
    value = re.sub(r'\D', '', str(value))
    if len(value) == 7:
        return dt.date(int(value[:3]) + 1911, int(value[3:5]), int(value[5:]))
    if len(value) == 8:
        return dt.date(int(value[:4]), int(value[4:6]), int(value[6:]))
    raise ValueError('出表日期格式異常')

def validate_dataset(data, spec, previous=None):
    key, market, url, reference, minimum = spec
    companies = data.get('companies', [])
    if data.get('key') != key or len(companies) < minimum:
        raise ValueError(f'{key}: 名單筆數或種類異常')
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
    dates, identities = [], set()
    for c in companies:
        if not c.get('name') or not re.fullmatch(r'[0-9A-Z]{4,8}', c.get('code', '')) or c.get('market') != market or c.get('source') != reference:
            raise ValueError(f'{key}: 公司欄位格式異常')
        identity = c['code']
        if identity in identities:
            raise ValueError(f'{key}: 重複公司代號')
        identities.add(identity)
        dates.append(issuer_date(c.get('date')))
    if max(dates) > today + dt.timedelta(days=1) or max(dates) < today - dt.timedelta(days=60):
        raise ValueError(f'{key}: 官方出表日期超出可接受範圍')
    if previous:
        old = previous.get('companies', [])
        if len(companies) < len(old) * .7:
            raise ValueError(f'{key}: 名單筆數減少超過 30%，保留前次名單')
        if old and max(dates) < max(issuer_date(c['date']) for c in old):
            raise ValueError(f'{key}: 不使用較舊的官方名單')
    return data

def fetch_dataset(spec):
    key, market, url, reference, minimum = spec
    req = urllib.request.Request(url, headers={'User-Agent': 'CompanyQuickCheck-Pages/1.3 public-data-sync'})
    with urllib.request.urlopen(req, timeout=35) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError('來源過大')
    text = raw.decode('utf-8-sig')
    rows = list(csv.DictReader(io.StringIO(text))) if url.endswith('.csv') else json.loads(text)
    if not isinstance(rows, list):
        raise ValueError('來源格式異常')
    companies = []
    for row in rows:
        c = {target: str(row.get(source) or '').strip() for target, source in FIELDS.items()}
        c.update(market=market, source=reference, sourceKey=key, listingDate=str(row.get('上市日期') or row.get('上櫃日期') or '').strip())
        companies.append(c)
    data = {'key': key, 'url': url, 'reference': reference, 'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'companies': companies}
    path = ROOT / 'data' / f'{key}.json'
    previous = json.loads(path.read_text()) if path.exists() else None
    return validate_dataset(data, spec, previous)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--strict', action='store_true', help='來源失敗時回傳非零結束碼')
    args = parser.parse_args()
    results, failures = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_dataset, spec): spec for spec in SPECS}
        for future in concurrent.futures.as_completed(futures):
            spec = futures[future]
            try:
                data = future.result()
                path = ROOT / 'data' / f'{spec[0]}.json'
                temp = path.with_suffix('.tmp')
                temp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                temp.replace(path)
                print(f'{spec[0]}: {len(data["companies"])} 筆，出表 {display_date(data)}')
                results[spec[0]] = 'updated'
            except Exception as exc:
                failures.append(spec[0]); results[spec[0]] = 'kept_previous'
                print(f'WARNING {spec[0]}: {exc}; 保留前次名單，沒有清空來源')
    manifest = {'updatedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sources': results, 'failed': failures}
    (ROOT / 'data' / 'sync-status.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.strict and failures:
        raise SystemExit(1)

def display_date(data):
    return max(issuer_date(c['date']) for c in data['companies']).isoformat()

if __name__ == '__main__':
    main()
