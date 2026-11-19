import { cleanTaxID, normalize } from './engine.js';
export const MAX_ROWS = 20000, MAX_COLS = 256;
const titlePattern = /^第[一二三四五六七八九十百\d]+[波批]/;
const key = v => normalize(v).replace(/[_\-（）()]/g, '');
const headerKinds = {
  name: new Set(['公司名稱', '公司全名', '原公司名稱', '企業名稱', '登記名稱', '公司名', 'companyname', 'company']),
  id: new Set(['統編', '統一編號', '原統編', '公司統編', '營利事業統一編號', 'ubn', 'taxid']),
  shop: new Set(['shopid', 'sid', '商店id']), store: new Set(['shopname', '店名', '商店名稱', '門市名稱']),
  code: new Set(['公司代號', '股票代號', '原表股票代號', 'stockcode']), market: new Set(['市場', '原表市場', '掛牌市場'])
};
export function columnName(index) {
  let result = '', n = index + 1;
  while (n) { n--; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); }
  return result;
}
export function parseDelimited(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0], delimiter = first.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else field += ch;
    } else if (ch === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length > MAX_ROWS) throw new Error(`最多支援 ${MAX_ROWS.toLocaleString()} 列`);
    } else field += ch;
  }
  if (quoted) throw new Error('CSV 引號未結束，請重新匯出 UTF-8 CSV');
  if (field || row.length || !rows.length) { row.push(field); rows.push(row); }
  if (rows.length > MAX_ROWS) throw new Error(`最多支援 ${MAX_ROWS.toLocaleString()} 列`);
  if (rows.some(r => r.length > MAX_COLS)) throw new Error('最多支援 256 欄');
  return { name: '貼上或文字資料', rows, lastRow: rows.length, lastCol: Math.max(1, ...rows.map(r => r.length)), numeric: new Set(), formulas: new Set(), merges: [], hidden: new Set() };
}
export function detectMapping(sheet) {
  let best = { name: -1, id: -1, shop: -1, store: -1, code: -1, market: -1, header: 0, start: 1, end: sheet.lastRow }, high = 0;
  for (let r = 0; r < Math.min(30, sheet.lastRow); r++) {
    const result = { name: -1, id: -1, shop: -1, store: -1, code: -1, market: -1, header: r + 1, start: r + 2, end: sheet.lastRow };
    for (let col = 0; col < sheet.lastCol; col++) for (const [kind, names] of Object.entries(headerKinds)) {
      if (names.has(key(sheet.rows[r]?.[col])) && result[kind] === -1) result[kind] = col;
    }
    const score = (result.name >= 0 ? 10 : 0) + (result.id >= 0 ? 5 : 0) + (result.shop >= 0 ? 1 : 0);
    if (score > high) { high = score; best = result; }
  }
  if (!high) best.name = 0;
  return best;
}
export function buildRows(sheet, mapping) {
  if (mapping.name < 0 && mapping.id < 0) throw new Error('請至少選擇公司名稱或統編欄');
  if (mapping.name >= 0 && mapping.id === mapping.name) throw new Error('公司名稱與統編不可選擇同一欄');
  if (!Number.isInteger(mapping.start) || !Number.isInteger(mapping.end) || mapping.start < 1 || mapping.end < mapping.start || mapping.end > sheet.lastRow) throw new Error(`起訖列請介於 1 至 ${sheet.lastRow}`);
  const output = []; let group = '';
  for (let r = 1; r <= mapping.end; r++) {
    const cells = sheet.rows[r - 1] || [], cell = c => c < 0 ? '' : String(cells[c] ?? '').trim();
    const name = cell(mapping.name), cleaned = cleanTaxID(cell(mapping.id), sheet.numeric.has(`${r - 1}:${mapping.id}`));
    const title = titlePattern.test(name) ? name : !name && !cleaned.id ? cells.map(v => String(v || '').trim()).find(v => titlePattern.test(v)) : '';
    if (title) group = title;
    if (r < mapping.start) continue;
    const row = { row: r, group, name, id: cleaned.id, rawID: cleaned.raw, audit: cleaned.note, referenceCode: cell(mapping.code), referenceMarket: cell(mapping.market), shop: cell(mapping.shop), store: cell(mapping.store), kind: 'company', status: '等待查詢', excluded: false, hidden: sheet.hidden.has(r - 1), note: '' };
    if (r <= mapping.header || headerKinds.name.has(key(name)) || headerKinds.id.has(key(cleaned.id))) Object.assign(row, { kind: 'header', excluded: true, status: '', note: '欄位標題；貼回保留空格' });
    else if (title) Object.assign(row, { kind: 'batch', excluded: true, status: '', note: '分批標題；貼回保留空格' });
    else if (!cells.some(v => String(v ?? '').trim())) Object.assign(row, { kind: 'blank', excluded: true, status: '', note: '空白列；貼回保留空格' });
    else if (!name && !cleaned.id) {
      Object.assign(row, { kind: 'missing', status: '缺少公司名稱', note: '仍有其他商家資料，未排除也未向下沿用上一列公司' });
      if (sheet.merges.some(m => r - 1 >= m.s.r && r - 1 <= m.e.r && mapping.name >= m.s.c && mapping.name <= m.e.c)) row.note = '名稱位於合併儲存格延伸列；未自動向下填入，請人工確認';
      if (sheet.formulas.has(`${r - 1}:${mapping.name}`)) row.note = '名稱公式沒有快取值；請先於試算表重新計算後匯出';
    } else if (name.startsWith('[儲存格錯誤：')) Object.assign(row, { status: '待確認（來源儲存格錯誤）', note: name });
    output.push(row);
  }
  return output;
}
export function worksheetToSheet(ws, name, XLSX) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLS) throw new Error('工作表超過 20,000 列或 256 欄，請先縮小範圍再匯入');
  const sheet = { name, rows: [], lastRow: range.e.r + 1, lastCol: range.e.c + 1, numeric: new Set(), formulas: new Set(), merges: ws['!merges'] || [], hidden: new Set() };
  for (let r = 0; r <= range.e.r; r++) {
    const row = [];
    if (ws['!rows']?.[r]?.hidden) sheet.hidden.add(r);
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t === 'n') sheet.numeric.add(`${r}:${c}`);
      if (cell?.f && (cell.v === undefined || cell.v === '')) sheet.formulas.add(`${r}:${c}`);
      row.push(cell?.t === 'e' ? `[儲存格錯誤：${cell.w || cell.v}]` : String(cell?.v ?? ''));
    }
    sheet.rows.push(row);
  }
  return sheet;
}
export function bestWorksheetName(workbook, XLSX) {
  const hidden = new Set(workbook.Workbook?.Sheets?.filter(s => s.Hidden).map(s => s.name) || []);
  let selected = workbook.SheetNames.find(n => !hidden.has(n)) || workbook.SheetNames[0], best = 0;
  for (const name of workbook.SheetNames) {
    if (hidden.has(name)) continue;
    const ws = workbook.Sheets[name], range = XLSX.utils.decode_range(ws['!ref'] || 'A1'), rows = [];
    if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLS) continue;
    const lastCol = range.e.c + 1, lastRow = Math.min(30, range.e.r + 1);
    for (let r = 0; r < lastRow; r++) { const row = []; for (let c = 0; c < lastCol; c++) row.push(String(ws[XLSX.utils.encode_cell({ r, c })]?.v ?? '')); rows.push(row); }
    const m = detectMapping({ rows, lastCol, lastRow });
    const score = m.header ? (m.name >= 0 ? 10 : 0) + (m.id >= 0 ? 5 : 0) + (m.shop >= 0 ? 1 : 0) : 0;
    if (score > best) { best = score; selected = name; }
  }
  return selected;
}
export function guardArchive(buffer) {
  const data = new DataView(buffer);
  if (data.byteLength < 4 || data.getUint32(0, true) !== 0x04034b50) return;
  let expanded = 0, entries = 0;
  for (let i = Math.max(0, data.byteLength - 65557); i + 22 <= data.byteLength; i++) {
    if (data.getUint32(i, true) !== 0x06054b50) continue;
    let pos = data.getUint32(i + 16, true); const count = data.getUint16(i + 10, true);
    if (count === 65535 || count > 4096) throw new Error('工作簿結構過大或為 ZIP64，請另存為一般 XLSX');
    while (entries++ < count) {
      if (pos + 46 > data.byteLength || data.getUint32(pos, true) !== 0x02014b50) throw new Error('XLSX 封裝損毀');
      expanded += data.getUint32(pos + 24, true);
      pos += 46 + data.getUint16(pos + 28, true) + data.getUint16(pos + 30, true) + data.getUint16(pos + 32, true);
    }
    if (expanded > 128 * 1024 * 1024) throw new Error('工作簿解壓縮內容超過 128 MB，請先拆分');
    return;
  }
  throw new Error('無法辨識 XLSX 封裝');
}
export const formulaSafe = value => /^[\s]*[=+@-]/.test(String(value ?? '')) ? "'" + value : String(value ?? '');
const flatten = value => String(value ?? '').replace(/[\t\r\n]/g, ' ');
export function alignedCells(rows, includeSource = false) {
  return rows.map(r => r.excluded ? (includeSource ? ['', ''] : ['']) : (includeSource ? [r.status, r.source || ''] : [r.status]));
}
export function makeTSV(rows, includeSource = false) { return alignedCells(rows, includeSource).map(cells => cells.map(v => formulaSafe(flatten(v))).join('\t')).join('\r\n') + '\r\n'; }
export function reportCells(rows) {
  return [['原列號', '分批', 'shop id', 'shop name', '原公司名稱', '原統編', '比對公司名稱', '比對統編', '股票代號', '市場分類', '查詢方式', '資料日期', '資料來源', '備註', '候選公司', '排除', '原始統編值', '本體掛牌身分', '關聯公司', '關聯股票代號', '關聯市場', '關係類型', '關係來源', '原表市場', '原表股票代號', '原表核對說明'], ...rows.map(r => {
    const c = r.company, rel = c?.relations || [];
    return [String(r.row), r.group, r.shop, r.store, r.name, r.id, c?.name, c?.id, c?.code, r.status, r.method, r.date, r.source, [r.note, r.hidden ? '原列為隱藏列' : ''].filter(Boolean).join('；'), r.candidates?.map(x => `${x.name}／${x.id}／${x.market}`).join('；'), r.excluded ? '是' : '', r.rawID, c?.selfMarket || (c?.sourceKey !== 'registry' ? c?.market : ''), rel.map(x => x.name).join('；'), rel.map(x => x.code).join('；'), rel.map(x => x.market).join('；'), rel.map(x => x.kind).join('；'), rel.map(x => x.source).join('；'), r.referenceMarket, r.referenceCode, r.audit].map(v => String(v ?? ''));
  })];
}
export function makeCSV(rows) {
  return reportCells(rows).map(cells => cells.map(v => `"${formulaSafe(v).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}
export function counts(rows) {
  return { total: rows.length, official: rows.filter(r => ['上市', '上櫃', '興櫃'].includes(r.status)).length, related: rows.filter(r => r.status.includes('關聯') && !r.status.startsWith('待')).length, pending: rows.filter(r => /^(待|等待|暫時|未查詢)/.test(r.status)).length, missing: rows.filter(r => r.kind === 'missing').length, excluded: rows.filter(r => r.excluded).length };
}
