"""Build the two public lookup indexes from the same Ministry of Finance CSV."""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import re
import shutil
import tempfile
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://eip.fia.gov.tw/data/BGMOPEN1.zip'
REFERENCE = 'https://data.gov.tw/dataset/9400'
SPACE = re.compile(r'[\s\u200b\ufeff]+')
LEGAL = re.compile(r'^(社團法人|財團法人)')
AS_OF = re.compile(r'\d{2}-[A-Z]{3}-\d{2}')


def bucket(name):
    key = SPACE.sub('', unicodedata.normalize('NFKC', name)).replace('臺', '台').lower()
    key = LEGAL.sub('', key) or key
    value = 0
    for char in key[:2]:
        value = value * 31 + ord(char)
    return value % 64


def build(archive, out):
    names = [[] for _ in range(64)]
    ids = [[] for _ in range(16)]
    total = 0
    with zipfile.ZipFile(archive) as z, z.open('BGMOPEN1.csv') as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8-sig', newline=''))
        required = {'營業人名稱', '統一編號', '營業地址', '總機構統一編號'}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError('Unexpected tax register columns')
        date = None
        for row in reader:
            uid = row['統一編號'].strip()
            name = re.sub(r'[\t\r\n]+', ' ', row['營業人名稱']).strip()
            address = row['營業地址'].strip()
            if not uid and AS_OF.fullmatch(address):
                date = dt.datetime.strptime(address, '%d-%b-%y').date().isoformat()
                continue
            if not re.fullmatch('[0-9]{8}', uid) or not name:
                continue
            section = bucket(name)
            area = re.match(r'^.{2,3}[市縣].{1,5}?[鄉鎮市區]', SPACE.sub('', address))
            head = row['總機構統一編號'].strip()
            names[section].append('\t'.join((uid, name, area[0] if area else '', head)))
            ids[int(uid) % 16].append(uid + '\t' + str(section))
            total += 1
    if total < 1_000_000 or not date or dt.date.fromisoformat(date) > dt.date.today() + dt.timedelta(days=1):
        raise ValueError('Incomplete or undated tax register')
    parts = {}
    out.mkdir()
    for prefix, sections in [('n', names), ('i', ids)]:
        for i, rows in enumerate(sections):
            key = f'{prefix}{i}'
            payload = ('\n'.join(sorted(rows)) + '\n').encode()
            parts[key] = hashlib.sha256(payload).hexdigest()[:16]
            (out / (key + '.txt')).write_bytes(payload)
    manifest = dict(schema=1, count=total, date=date, source=REFERENCE, parts=parts)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    dest = ROOT / 'data' / 'tax'
    old = json.loads((dest / 'manifest.json').read_text()) if dest.exists() else {}
    if not args.archive and old and (dt.date.today() - dt.date.fromisoformat(old['date'])).days < 7:
        return
    with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
        stage = Path(tmp)
        archive = args.archive or stage / 'tax.zip'
        if not args.archive:
            with urllib.request.urlopen(SOURCE, timeout=150) as r, archive.open('wb') as f:
                shutil.copyfileobj(r, f)
        new = build(archive, stage / 'new')
        if old and (new['count'] < old['count'] * .95 or new['date'] < old['date']):
            raise ValueError('Unexpected loss of records or older source')
        if dest.exists():
            dest.rename(stage / 'previous')
        try:
            (stage / 'new').rename(dest)
        except OSError:
            if (stage / 'previous').exists():
                (stage / 'previous').rename(dest)
            raise
        print(f"Tax register {new['date']}: {new['count']:,} rows")


if __name__ == '__main__':
    main()
