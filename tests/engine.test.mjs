import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { Engine, cleanTaxID, resolveRow, exactName, validID, auditReference, applyCompany } from '../assets/engine.js';
import { parseDelimited, detectMapping, buildRows, makeTSV, makeCSV, worksheetToSheet, bestWorksheetName, guardArchive, counts, reportCells } from '../assets/batch.js';

const root = path.resolve(import.meta.dirname, '..');
const datasets = ['listed', 'otc', 'emerging', 'public'].map(n => JSON.parse(fs.readFileSync(path.join(root, 'data', n + '.json'))));
const relationships = JSON.parse(fs.readFileSync(path.join(root, 'data/relationships_verified.json')));
const makeEngine = () => new Engine(datasets, relationships, new Date('2026-11-19T00:00:00+08:00'));
const row = (name, id = '') => ({ row: 1, name, id, rawID: id, kind: 'company', status: '等待查詢', audit: '', referenceCode: '', referenceMarket: '' });
const sandbox = { ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int32Array, Date, Buffer, console };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(root, 'vendor/xlsx.full.min.js'), 'utf8'), sandbox);
const XLSX = sandbox.XLSX;

test('以公司名稱、台／臺、全形及統編辨識官方掛牌本體', async () => {
  const engine = makeEngine(), c = engine.find('', '22099131')[0];
  assert.equal(c.code, '2330'); assert.equal(c.market, '上市'); assert(exactName(c, ' 台積電 '));
  const result = await resolveRow(engine, row('台積電', '２２０９９１３１'.normalize('NFKC')));
  assert.equal(result.status, '上市');
});
test('部分名稱只提供候選，不自動套用第一間公司', async () => {
  const result = await resolveRow(makeEngine(), row('統一企'));
  assert.match(result.status, /^待確認/); assert(result.candidates.length); assert.equal(result.company, undefined);
});
test('未知公司未查得不等於確認未上市；來源與限制留存', async () => {
  const result = await resolveRow(makeEngine(), row('測試不存在公司甲乙丙丁'));
  assert.equal(result.status, '未查得上市櫃紀錄'); assert.match(result.note, /不等同/); assert.match(result.source, /data.gov.tw/);
});
test('公司名稱與另一家公司統編衝突時待確認', async () => {
  const result = await resolveRow(makeEngine(), row('統一企業股份有限公司', '22099131'));
  assert.match(result.status, /^待確認/); assert(!result.company); assert.equal(result.candidates[0].code, '2330');
});
test('已查證關聯不繼承掛牌公司的股票代號或統編', async () => {
  const cases = [['明基健康生活股份有限公司', '52687620', ['4116']], ['保瑞聯邦股份有限公司', '52718898', ['1271', '6472']], ['保瑞聯邦股份有限公司新竹分公司', '28115186', ['1271', '6472']], ['英屬開曼群島商台南開曼股份有限公司台南分公司', '59031269', ['5906']], ['漢來美食股份有限公司高雄分公司', '80352955', ['1268']], ['英屬維京群島商克麗緹娜行銷有限公司台灣分公司', '53663007', ['4137']]];
  for (const [name, id, codes] of cases) {
    const result = await resolveRow(makeEngine(), row(name));
    assert.match(result.status, /關聯/); assert.equal(result.company.id, id); assert(!result.company.code);
    assert.deepEqual(result.company.relations.map(r => r.code).sort(), codes.sort()); assert.equal(result.company.selfMarket, '未查得本體掛牌紀錄');
  }
});
test('參考表誤填代號不能覆蓋本體，誤填總公司統編另列衝突', async () => {
  const input = { ...row('明基健康生活股份有限公司'), referenceCode: '8215', referenceMarket: '上市' };
  const result = await resolveRow(makeEngine(), input); assert.match(result.audit, /未與公司法律主體對應/); assert.equal(result.company.relations[0].code, '4116');
  const branch = await resolveRow(makeEngine(), row('保瑞聯邦股份有限公司新竹分公司', '52718898'));
  assert.equal(branch.status, '待確認（名稱與統編不同主體）'); assert.equal(branch.company.id, '28115186'); assert.equal(branch.id, '52718898');
});
test('未知分公司只提示疑似關係；不以名稱前綴自動當成上市', async () => {
  const result = await resolveRow(makeEngine(), row('漢來美食股份有限公司測試新分公司'));
  assert.match(result.status, /^待確認（疑似/); assert(!result.company);
});
test('關聯證據超過 90 日不繼續顯示已確認關聯', () => {
  const engine = new Engine(datasets, relationships, new Date('2027-03-01T00:00:00Z'));
  assert.match(engine.find('明基健康生活股份有限公司')[0].market, /^待複核/);
});
test('數值、科學記號與前導零精確處理，不四捨五入非整數統編', () => {
  assert.equal(cleanTaxID('7708830', true).id, '07708830');
  assert.equal(cleanTaxID('1.1347802E+7', true).id, '11347802');
  assert.equal(cleanTaxID('04742997').id, '04742997');
  assert(!validID(cleanTaxID('12345678.8', true).id));
  assert(!validID(cleanTaxID('99999999999999999E+50', true).id));
});
test('CSV 引號內逗號與換行、空白列及結尾空格不失真', () => {
  const sheet = parseDelimited('\ufeff公司名稱,統編\r\n"甲,乙公司",12345678\r\n\r\n"換行\n公司",04742997\r\n');
  assert.equal(sheet.lastRow, 4); assert.equal(sheet.rows[1][0], '甲,乙公司'); assert.equal(sheet.rows[2][0], ''); assert.equal(sheet.rows[3][0], '換行\n公司');
  assert.throws(() => parseDelimited('"未結束'), /引號/);
});
test('原列對齊：分批、純空白排除；有商店的缺少公司列保留提示', () => {
  const sheet = parseDelimited('shop id\t公司名稱\tshop name\n\t\t第一波11/5 下午5點\n123\t台積電\t商店\n\t\t\n124\t\t缺名商店\n125\t漢來美食股份有限公司高雄分公司\t商店');
  const rows = buildRows(sheet, detectMapping(sheet)); assert.equal(rows.length, 5); assert.equal(rows[0].kind, 'batch'); assert.equal(rows[2].kind, 'blank'); assert.equal(rows[3].kind, 'missing');
  assert.equal(rows[1].id, ''); assert.equal(rows[4].group, '第一波11/5 下午5點');
  rows[1].status = '上市'; rows[4].status = '上櫃關聯（分公司）';
  assert.equal(makeTSV(rows), '\r\n上市\r\n\r\n缺少公司名稱\r\n上櫃關聯（分公司）\r\n');
});
test('表頭原名稱／原統編自動辨識，名稱與統編不可選擇同欄', () => {
  const s = parseDelimited('原公司名稱,原統編,股票代號,市場\n台積電,22099131,2330,上市');
  const m = detectMapping(s); assert.equal(m.name, 0); assert.equal(m.id, 1); assert.equal(m.code, 2); assert.equal(m.market, 3);
  assert.throws(() => buildRows(s, { ...m, id: 0 }), /同一欄/);
});
test('網路補查失敗明確標示無法確認，不快取失敗或轉成未上市', async () => {
  const original = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new TypeError('CORS error'); };
  try {
    const engine = makeEngine();
    for (let i = 0; i < 2; i++) assert.match((await resolveRow(engine, row('測試未命中公司'), { online: true })).status, /^暫時無法確認/);
    assert.equal(calls, 2); assert.equal(engine.cache.size, 0);
  } finally { global.fetch = original; }
});
test('網路補查只查詢統編，外國雙語陣列與總公司欄可讀取', async () => {
  const engine = makeEngine();
  const c = engine.parseRegistration({ 公司名稱: ['英屬測試有限公司', 'Example Ltd'], 統一編號: '12345678' }); assert.equal(c.name, '英屬測試有限公司');
  const branch = engine.enrich(engine.parseRegistration({ 分公司名稱: '測試分公司', 統一編號: '12345678', '總(本)公司統一編號': '80352343' })); assert.equal(branch.market, '待確認（分公司總公司掛牌）'); assert.equal(branch.head.code, '1268');
  const original = global.fetch; let requested;
  global.fetch = async url => { requested = url; return { ok: true, json: async () => ({ data: { 公司名稱: '測試公司', 統一編號: '12345678' } }) }; };
  try { await engine.registry('12345678'); assert.equal(requested, 'https://company.g0v.ronny.tw/api/show/12345678'); } finally { global.fetch = original; }
});
test('完整 CSV 防止公式注入並保留來源、原值、關聯核對欄', () => {
  const input = { ...row('=HYPERLINK("bad")'), status: '未查得上市櫃紀錄', source: 'https://data.gov.tw/dataset/18419' };
  assert.match(makeCSV([input]), /'=HYPERLINK/); assert.equal(reportCells([input])[0].length, 26); assert.match(makeCSV([input]), /原始統編值/);
});
test('XLSX 讀寫：保留數值與文字統編、隱藏列、合併與公式缺快取', () => {
  const ws = XLSX.utils.aoa_to_sheet([['公司名稱', '統編'], ['甲', 7708830], ['乙', '04742997'], ['丙', '']]);
  ws.B4 = { t: 'n', f: '1+1' }; ws['!rows'] = [null, { hidden: true }]; ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
  const s = worksheetToSheet(ws, '名單', XLSX); assert(s.hidden.has(1)); assert(s.formulas.has('3:1')); assert(s.numeric.has('1:1'));
  const results = buildRows(s, detectMapping(s)); assert.equal(results[0].id, '07708830'); assert.equal(results[1].id, '04742997');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reportCells(results)), '完整比對報告');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); guardArchive(bytes);
  const parsed = XLSX.read(bytes, { type: 'array' }); const restored = XLSX.utils.sheet_to_json(parsed.Sheets['完整比對報告'], { header: 1, raw: true });
  assert.equal(restored[1][5], '07708830'); assert.equal(parsed.Sheets['完整比對報告'].F2.t, 's');
});
test('資料上限與來源儲存格錯誤會提示，不默默刪列', () => {
  const ws = { '!ref': 'A1:A20001' }; assert.throws(() => worksheetToSheet(ws, '大表', XLSX), /20,000/);
  const s = parseDelimited('公司名稱\n[儲存格錯誤：#N/A]'); const rows = buildRows(s, detectMapping(s)); assert.match(rows[0].status, /^待確認（來源/);
  assert.throws(() => parseDelimited(Array(20001).fill('測試').join('\n')), /20,000/);
});
test('人工選擇候選仍保留原名稱與統編、補上核對說明', () => {
  const r = { ...row('台積', '12345678'), referenceCode: '9999' }, c = makeEngine().byID.get('22099131');
  applyCompany(r, c, '使用者人工確認候選'); auditReference(r); assert.equal(r.name, '台積'); assert.equal(r.id, '12345678'); assert.equal(r.company.id, '22099131'); assert.match(r.audit, /9999/);
});

test('附件一回歸驗證：69 本體、8 關聯、1 缺名，78 原列保留', { skip: !process.env.CQC_AUDIT_CSV }, async () => {
  const sheet = parseDelimited(fs.readFileSync(process.env.CQC_AUDIT_CSV, 'utf8')), input = buildRows(sheet, detectMapping(sheet)), engine = makeEngine();
  const rows = []; for (const r of input) rows.push(await resolveRow(engine, r));
  const n = counts(rows); assert.equal(n.total, 78); assert.equal(n.official, 69); assert.equal(n.related, 8); assert.equal(n.missing, 1); assert.equal(n.excluded, 0); assert(!rows.some(r => r.status === '未查得上市櫃紀錄'));
});
test('附件二回歸驗證：錯誤分公司統編兩列標待確認', { skip: !process.env.CQC_AUDIT_XLSX }, async () => {
  const buffer = fs.readFileSync(process.env.CQC_AUDIT_XLSX); const wb = XLSX.read(buffer, { type: 'buffer' });
  const s = worksheetToSheet(wb.Sheets[wb.SheetNames[0]], wb.SheetNames[0], XLSX), input = buildRows(s, detectMapping(s)), engine = makeEngine();
  const rows = []; for (const r of input) rows.push(await resolveRow(engine, r));
  assert.equal(rows.filter(r => r.status === '待確認（名稱與統編不同主體）').length, 2);
  assert(rows.some(r => r.id === '07708830')); assert(rows.some(r => r.id === '04742997'));
});
test('原始分批商家表回歸：206 原列，80 公司、123 缺名、3 分批', { skip: !process.env.CQC_IMPORT_FIXTURE }, () => {
  const wb = XLSX.read(fs.readFileSync(process.env.CQC_IMPORT_FIXTURE), { type: 'buffer', cellStyles: true });
  const name = bestWorksheetName(wb, XLSX); assert.equal(name, 'POS LINE群組通知');
  const s = worksheetToSheet(wb.Sheets[name], name, XLSX), m = detectMapping(s), rows = buildRows(s, m);
  assert.equal(rows.length, 206); assert.equal(rows.filter(r => r.kind === 'company').length, 80); assert.equal(rows.filter(r => r.kind === 'missing').length, 123); assert.equal(rows.filter(r => r.kind === 'batch').length, 3);
});
