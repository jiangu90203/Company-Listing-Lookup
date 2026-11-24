import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TaxIndex } from '../assets/tax.js';
import { Engine, resolveRow } from '../assets/engine.js';

const dir = new URL('../data/tax/', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', dir)));
const register = new TaxIndex(manifest, key => fs.readFile(new URL(key + '.txt', dir), 'utf8'));
function makeEngine() {
  const engine = new Engine([], { registrations: [], edges: [] });
  engine.taxLookup = q => register.lookup(q);
  engine.remoteRegistry = async () => { throw new Error('模擬外部服務離線'); };
  return engine;
}
const name = '社團法人嘉義市建築師公會', id = '26413625';
test('獨立冷啟動，以全名、全形統編及混合單欄均能找到相同公會', async () => {
  for (const input of [{ name }, { id: '26413625' }, { name: '２６４１ ３６２５' }]) {
    const r = await resolveRow(makeEngine(), input, { online: true });
    assert.equal(r.company?.id, id); assert.equal(r.company?.name, name); assert.equal(r.company.source, manifest.source);
  }
  assert.equal((await makeEngine().registry('２６４１ ３６２５'))[0].name, name);
});
test('省略法人前綴只提供候選，衝突的名稱與統編要人工確認', async () => {
  const r = await resolveRow(makeEngine(), { name: '嘉義市建築師公會' }, { online: true });
  assert(!r.company); assert(r.candidates.some(c => c.id === id));
  const conflict = await resolveRow(makeEngine(), { name: '其他公會', id }, { online: true });
  assert(!conflict.company); assert.match(conflict.status, /不符/);
});
test('實際同名不同統編完整保留，前導零可雙向查詢', async () => {
  const records = (await fs.readFile(new URL('n12.txt', dir), 'utf8')).trim().split('\n').map(l => l.split('\t'));
  const seen = new Map();
  for (const [uid, title] of records) {
    if (seen.has(title) && seen.get(title) !== uid) {
      const r = await resolveRow(makeEngine(), { name: title }, { online: true });
      assert(!r.company); assert.equal(r.status, '待確認（同名候選）');
      assert(r.candidates.some(c => c.id === uid)); assert(r.candidates.some(c => c.id === seen.get(title)));
      break;
    }
    seen.set(title, uid);
  }
  const [uid, title] = records.find(([n]) => n.startsWith('0'));
  assert.equal((await register.lookup(uid))[0].name, title);
  assert((await register.lookup(title)).some(c => c.id === uid));
});
test('分檔失敗可直接重試，完整來源未查得與斷線分開', async () => {
  let fail = true;
  const retry = new TaxIndex(manifest, async key => {
    if (fail) { fail = false; throw Error('offline'); }
    return fs.readFile(new URL(key + '.txt', dir), 'utf8');
  });
  await assert.rejects(retry.lookup(id)); assert.equal((await retry.lookup(id))[0].name, name);
  const engine = makeEngine(); engine.taxLookup = async () => [];
  assert.match((await resolveRow(engine, { name: '查詢測試' }, { online: true })).status, /連線失敗/);
  engine.remoteRegistry = async () => [];
  assert.match((await resolveRow(engine, { name: '查詢測試' }, { online: true })).status, /未找到登記/);
});

test('每筆名稱及統編都可路由到相同分檔，沒有漏列或錯列', async () => {
  // A packed array keeps the complete cross-check fast enough for every deployment.
  const locations = new Uint8Array(100_000_000);
  let names = 0, ids = 0;
  for (let n = 0; n < 64; n++) {
    const text = await fs.readFile(new URL('n' + n + '.txt', dir), 'utf8');
    for (const line of text.trimEnd().split('\n')) {
      const [uid, name] = line.split('\t');
      const key = name.normalize('NFKC').replace(/[\s\u200b\ufeff]/gu, '').replaceAll('臺', '台').toLowerCase();
      const prefix = key.replace(/^(社團法人|財團法人)/u, '') || key;
      let hash = 0;
      for (const c of Array.from(prefix).slice(0, 2)) hash = hash * 31 + c.codePointAt(0);
      assert.equal(hash % 64, n);
      assert.equal(locations[Number(uid)], 0, '統編重複 ' + uid);
      locations[Number(uid)] = n + 1; names++;
    }
  }
  for (let i = 0; i < 16; i++) {
    const text = await fs.readFile(new URL('i' + i + '.txt', dir), 'utf8');
    for (const line of text.trimEnd().split('\n')) {
      const [uid, section] = line.split('\t').map(Number);
      assert.equal(uid % 16, i);
      assert.equal(locations[uid], section + 1);
      locations[uid] = 0; ids++;
    }
  }
  assert.equal(names, manifest.count); assert.equal(ids, names);
});

test('公司名稱與統編皆對到同一筆完整稅籍明細', async () => {
  const [result] = await register.lookup(name);
  const full = await register.details(result.id);
  assert.equal(full.address.normalize('NFKC').replace(/\s/g, ''), '嘉義市西區竹圍里友愛路288號5樓之5');
  assert.equal(full.organization, '其他');
  assert.equal(full.capital, '3000');
  assert.equal(full.invoice, 'Y');
  assert.equal(full.date, manifest.date);
  assert.deepEqual(await register.details((await register.lookup(id))[0].id), full);
});
