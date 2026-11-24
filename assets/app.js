import { normalize, Engine, displayDate, exactName, applyCompany, auditReference, resolveRow } from './engine.js?v=1.4.0';
import { TaxIndex } from './tax.js?v=1.4.0';
import { parseDelimited, detectMapping, buildRows, worksheetToSheet, bestWorksheetName, guardArchive, columnName, makeTSV, makeCSV, reportCells, alignedCells, counts } from './batch.js';

const $ = id => document.getElementById(id);
const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
let engine, book, sheet, mapping, preview = [], results = [], running = false, controller, page = 0, selectedCompany, searchToken = 0, toastTimer;
const message = (text, type = '') => { $('global-message').className = `notice ${type}`; $('global-message').textContent = text; };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function badge(status) { return node('span', status || '保留空格', 'badge ' + (/^(待|暫時|未查詢|缺少)/.test(status) ? 'pending' : status?.includes('關聯') ? 'related' : ['上市', '上櫃', '興櫃'].includes(status) ? '' : 'unknown')); }
function safeLink(url, label) {
  try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) return node('span', label); } catch { return node('span', label); }
  const a = node('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function sourceLinks(source, label = '資料來源') {
  const div = node('div', '', 'source-links'), urls = [...new Set(String(source || '').split('；').filter(v => /^https?:\/\//.test(v)))];
  urls.forEach((url, i) => div.append(safeLink(url, urls.length === 1 ? label : `${label} ${i + 1}`))); return div;
}
function companyCopy(c) {
  return [`公司：${c.name}`, `統編：${c.id || '未提供'}`, `查核分類：${c.market}`, `本體：${c.selfMarket || c.market}`, `本體股票代號：${c.code || '無獨立掛牌代號'}`, `資料日期：${displayDate(c.date || c.taxDate)}`, `來源：${c.source}`, ...c.relations.map(r => `關聯：${r.name} ${r.code}（${r.market}）｜${r.kind}｜查證 ${r.checkedAt}\n${r.source}`)].join('\n');
}
async function copyText(text, html) {
  try {
    if (html && navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('Clipboard unavailable');
    toast('已複製，可貼回試算表');
  } catch {
    $('clipboard-text').value = text; $('clipboard-dialog').showModal(); $('clipboard-text').focus(); $('clipboard-text').select();
  }
}
function showCompany(c) {
  selectedCompany = c;
  const box = $('company-result'); box.hidden = false; box.className = 'card result-card'; box.replaceChildren();
  const heading = node('div', '', 'result-heading'), left = node('div'), copy = node('button', '複製查詢結果', 'secondary');
  left.append(node('h2', c.name));
  if (c.sourceKey === 'registry') left.append(node('p', c.taxDate ? '已找到稅籍登記資料' : '已找到登記資料', 'registered'));
  left.append(badge(c.market));
  copy.addEventListener('click', () => copyText(companyCopy(c))); heading.append(left, copy); box.append(heading);
  const grid = node('div', '', 'detail-grid');
  for (const [label, value] of [['統一編號', c.id || '未提供'], ...(c.code ? [['股票代號', c.code]] : []), ...(c.area ? [['登記地區', c.area]] : []), ...(c.address ? [['地址', c.address]] : []), ...(c.chairman ? [['董事長／代表人', c.chairman]] : []), ...(c.taxDate ? [['稅籍資料日期', displayDate(c.taxDate)]] : []), ...(c.date ? [['名單出表日期', displayDate(c.date)]] : [])]) {
    const dl = node('dl'); dl.append(node('dt', label), node('dd', value)); grid.append(dl);
  }
  box.append(grid);
  if (c.relations.length) {
    const relations = node('div', '', 'relation-box'); relations.append(node('h3', '已查證的掛牌公司關聯'), node('p', '以下市場身分屬於關聯公司，不表示目前輸入公司本身掛牌。', 'muted'));
    c.relations.forEach(r => { const item = node('div', '', 'relation-item'); item.append(node('strong', `${r.name} · ${r.code} · ${r.market}`), node('p', `${r.kind}｜關係查證 ${r.checkedAt}`, 'muted'), sourceLinks(r.source, '查證來源')); relations.append(item); });
    box.append(relations);
  } else if (c.head) box.append(node('p', `登記資料指向總公司 ${c.head.name}（${c.head.code}）；仍需核對最新分公司登記。`, 'notice warn'));
  if (c.sourceKey === 'registry' && !c.relations.length) box.append(node('p', '未查得紀錄只表示官方名單沒有對應統編，不等同已確認未上市櫃。', 'notice subtle'));
  box.append(sourceLinks(c.source, c.taxDate && c.sourceKey === 'registry' ? '財政部稅籍資料來源' : c.sourceKey === 'registry' ? '登記資料來源' : '官方掛牌名單來源'));
  if (c.registrationSource) box.append(sourceLinks(c.registrationSource, '登記資料來源'));
  if (c.sourceKey === 'registry') {
    const links = node('div', '', 'source-links');
    for (const d of engine.datasets) links.append(safeLink(d.reference, d.companies[0].market + '名單'));
    box.append(links);
  }
}
function renderSuggestions(companies, limit = 12) {
  $('suggestions').replaceChildren();
  for (const c of companies.slice(0, limit)) {
    const btn = node('button', '', 'suggestion'), div = node('div'); btn.type = 'button';
    div.append(node('strong', c.name), node('small', `${c.id || '境外登錄'}${c.area ? ' · ' + c.area : ''}${c.code ? ' · ' + c.code : ''}${c.short ? ' · ' + c.short : ''}`));
    btn.append(div, badge(c.market)); btn.addEventListener('click', () => { searchToken++; $('query').value = c.name; showCompany(c); renderSuggestions([]); $('search-note').textContent = '已採用你選擇的公司。'; });
    $('suggestions').append(btn);
  }
  if (companies.length > limit) {
    const more = node('button', '顯示更多建議', 'secondary');
    more.type = 'button';
    more.addEventListener('click', () => {
      renderSuggestions(companies, limit + 12);
      $('suggestions').children[limit]?.focus();
    });
    $('suggestions').append(more);
  }
}
function clearCompany() {
  selectedCompany = undefined;
  $('company-result').hidden = true;
}
async function search() {
  if (!engine) return;
  const input = $('query').value.trim(), query = normalize(input); if (!query) { $('query').focus(); return; }
  const token = ++searchToken, local = engine.suggest(query);
  renderSuggestions(local);
  const precise = local.filter(c => c.id === query || c.code === query || exactName(c, query));
  if (precise.length === 1) { renderSuggestions([]); showCompany(precise[0]); $('search-note').textContent = '找到精準公司，已顯示身分與來源。'; return; }
  clearCompany();
  if (!$('single-online').checked) {
    $('search-note').textContent = local.length ? '找到名稱建議，請選擇符合的公司；不會自動採用第一筆。' : '網站名單未命中。可開啟「同時查詢一般公司與團體」，或前往商工登記確認。';
    if (!local.length) showNoMatch(input);
    return;
  }
  $('search-note').textContent = '正在補查公司登記資料…';
  try {
    const remote = await engine.registry(input); if (token !== searchToken) return;
    const companies = [...new Map([...local, ...remote].map(c => [c.id || c.code, c])).values()];
    companies.sort((a, b) => Number(exactName(b, input)) - Number(exactName(a, input)));
    renderSuggestions(companies);
    const exact = companies.filter(c => c.id === query || c.code === query || exactName(c, query));
    if (exact.length === 1) { renderSuggestions([]); showCompany(exact[0]); $('search-note').textContent = '已確認登記名稱與統編，並比對官方名單。'; }
    else if (companies.length) $('search-note').textContent = exact.length > 1 ? '找到多筆同名登記，請依統編或地區選擇。' : '請點選符合的名稱，並核對統編。';
    else { $('search-note').textContent = '未找到精準公司，不等同已確認未上市櫃。'; showNoMatch(input); }
  } catch {
    if (token === searchToken) { $('search-note').textContent = '暫時無法確認：公司補查連線失敗或遭瀏覽器限制，請稍後重試或查詢商工登記。'; if (!local.length) showNoMatch(input, true); }
  }
}
function showNoMatch(query, failed = false) {
  const box = $('company-result'); box.hidden = false; box.className = 'card result-card';
  box.replaceChildren(node('h2', failed ? '暫時無法完成查詢' : '未找到相符的登記資料'), node('p', `查詢「${query}」。` + (failed ? '資料來源無法連線，請稍後重試。' : '可改用登記全名或 8 碼統編再查一次。')), safeLink('https://findbiz.nat.gov.tw/fts/query/QueryBar/queryInit.do', '前往經濟部商工登記查詢'));
  selectedCompany = undefined;
}
function renderData() {
  $('data-sources').replaceChildren(); let stale = false;
  for (const d of engine.datasets) {
    const date = d.companies.map(c => c.date).sort().at(-1), pretty = displayDate(date), age = Date.now() - new Date(pretty.replaceAll('/', '-') + 'T00:00:00+08:00').getTime();
    if (age > 3 * 86400000) stale = true;
    const item = node('div', '', 'source-card'); item.append(safeLink(d.reference, d.companies[0]?.market || d.key), node('strong', `${d.companies.length.toLocaleString()} 家`), node('p', `出表 ${pretty}`), node('p', `取得 ${displayDate(d.fetchedAt)}`)); $('data-sources').append(item);
  }
  $('relationship-date').textContent = `關係補充查證日：${engine.relationships.checkedAt}；超過 90 天列待複核。`;
  message(stale ? '部分官方名單出表日期已超過 3 天，請查看下方日期。重新載入只會取得此網站已發布的名單。' : '官方名單已就緒。試算表在本機處理，查詢結果會附資料日期與來源。', stale ? 'warn' : '');
}
async function loadData() {
  $('reload-data').disabled = true;
  try {
    const files = ['listed', 'otc', 'emerging', 'public', 'relationships_verified'];
    const data = await Promise.all(files.map(async name => { const r = await fetch(new URL(`../data/${name}.json`, import.meta.url), { cache: 'no-store' }); if (!r.ok) throw new Error(`${name} 讀取失敗`); return r.json(); }));
    if (data.slice(0, 4).some(d => !Array.isArray(d.companies) || !d.companies.length)) throw new Error('官方名單格式異常');
    engine = new Engine(data.slice(0, 4), data[4]);
    let taxIndex;
    const openTax = () => taxIndex ||= TaxIndex.open().catch(error => { taxIndex = undefined; throw error; });
    engine.taxLookup = async query => (await openTax()).lookup(query);
    renderData();
    openTax().then(index => {
      $('tax-date').replaceChildren(safeLink(index.manifest.source, '財政部營業中稅籍'), document.createTextNode(` · ${displayDate(index.manifest.date)} · ${index.manifest.count.toLocaleString()} 筆`));
    }).catch(() => { $('tax-date').textContent = '稅籍索引暫時無法載入，查詢時會重試。'; });
    $('query').disabled = false; $('search-btn').disabled = false;
    if (selectedCompany) {
      const refreshed = engine.all.find(c => c.id === selectedCompany.id);
      if (refreshed) showCompany(refreshed);
      else if (selectedCompany.sourceKey === 'registry') showCompany(engine.enrich(selectedCompany));
      else showNoMatch(selectedCompany.name);
    }
    if (sheet) refreshPreview();
  } catch { message('無法載入網站名單。請確認 data 資料夾有一起上傳，並從 GitHub Pages 網址開啟；不要直接雙擊本機 HTML。', 'error'); }
  finally { $('reload-data').disabled = false; }
}
function mappingFromControls() { return { ...mapping, name: Number($('name-col').value), id: Number($('id-col').value), code: Number($('code-col').value), market: Number($('market-col').value), start: Number($('start-row').value), end: Number($('end-row').value) }; }
function populateMapping() {
  mapping = detectMapping(sheet);
  for (const [id, field] of [['name-col', 'name'], ['id-col', 'id'], ['code-col', 'code'], ['market-col', 'market']]) {
    const select = $(id); select.replaceChildren(new Option(field === 'name' ? '無名稱欄（僅統編）' : '無此欄位', '-1'));
    for (let col = 0; col < sheet.lastCol; col++) {
      const label = mapping.header ? sheet.rows[mapping.header - 1]?.[col] : sheet.rows[0]?.[col];
      select.add(new Option(`${columnName(col)}${label ? ' · ' + String(label).slice(0, 32) : ''}`, String(col)));
    }
    select.value = String(mapping[field]);
  }
  $('start-row').value = Math.min(mapping.start, Math.max(1, sheet.lastRow)); $('end-row').value = sheet.lastRow;
  $('start-row').max = sheet.lastRow; $('end-row').max = sheet.lastRow;
  $('mapping-card').hidden = false; $('file-info').textContent = `${book.label} · ${sheet.lastRow.toLocaleString()} 列 / ${sheet.lastCol} 欄${book.hidden?.has(sheet.name) ? ' · 此工作表原為隱藏' : ''}`;
  refreshPreview();
}
function selectSheet(name) {
  if (book.rawSheets) sheet = book.rawSheets[name]; else sheet = worksheetToSheet(book.workbook.Sheets[name], name, window.XLSX);
  populateMapping();
}
function refreshPreview() {
  if (!sheet || running) return;
  if (results.length) { results = []; $('batch-results').hidden = true; toast('匯入資料或比對範圍已變更，請重新比對'); }
  try {
    preview = buildRows(sheet, mappingFromControls());
    const n = counts(preview), companyCount = preview.filter(r => !r.excluded && r.kind !== 'missing').length;
    $('preview-note').className = 'notice subtle'; $('preview-note').textContent = `共 ${n.total} 列：${companyCount} 列待比對、${n.missing} 列缺少公司名稱、${n.excluded} 列分批／空白保留。shop id 不會自動視為統編。`;
    $('preview-body').replaceChildren();
    for (const row of preview.slice(0, 8)) {
      const tr = node('tr'); [row.row, row.name || '（空白）', row.id, row.excluded ? '排除查詢，貼回保留空格' : row.status === '缺少公司名稱' ? row.status : '參與比對'].forEach(text => tr.append(node('td', String(text)))); $('preview-body').append(tr);
    }
    $('run-batch').disabled = !engine || !preview.length;
  } catch (error) { preview = []; $('preview-note').className = 'notice error'; $('preview-note').textContent = error.message; $('preview-body').replaceChildren(); $('run-batch').disabled = true; }
}
async function importFile(file) {
  if (running || !file) return;
  if (file.size > 50 * 1024 * 1024) { toast('檔案超過 50 MB，請先拆分'); return; }
  try {
    toast('正在讀取試算表…');
    const buffer = await file.arrayBuffer();
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      const bytes = new Uint8Array(buffer), encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      let text; try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); } catch { throw new Error('文字編碼無法辨識，請另存為 UTF-8 CSV 或 XLSX'); }
      const parsed = parseDelimited(text); parsed.name = '文字名單'; book = { label: file.name, names: [parsed.name], rawSheets: { [parsed.name]: parsed } };
    } else if (/\.(xlsx|xls)$/i.test(file.name)) {
      if (!window.XLSX) throw new Error('試算表元件尚未就緒，請重新整理');
      guardArchive(buffer);
      const workbook = window.XLSX.read(buffer, { type: 'array', cellFormula: true, cellStyles: true, cellHTML: false });
      if (!workbook.SheetNames.length) throw new Error('工作簿沒有工作表');
      book = { label: file.name, names: workbook.SheetNames, workbook, hidden: new Set(workbook.Workbook?.Sheets?.filter(s => s.Hidden).map(s => s.name) || []) };
    } else throw new Error('請匯入 XLSX、XLS、CSV 或 TSV 檔案');
    let selected = book.names.find(n => !book.hidden?.has(n)) || book.names[0];
    if (book.workbook) selected = bestWorksheetName(book.workbook, window.XLSX);
    $('sheet-select').replaceChildren(...book.names.map(name => new Option(name + (book.hidden?.has(name) ? '（隱藏）' : ''), name))); $('sheet-select').value = selected;
    selectSheet(selected); toast('已讀取，請確認公司欄與起訖列');
  } catch (error) { toast(error.message || '無法讀取檔案，請另存為 XLSX 重試'); }
}
function setRunning(value) {
  running = value;
  ['file-input', 'use-paste', 'paste-input', 'sheet-select', 'name-col', 'id-col', 'code-col', 'market-col', 'start-row', 'end-row', 'batch-online', 'reload-data'].forEach(id => $(id).disabled = value);
  ['copy-batch', 'export-tsv', 'export-xlsx', 'export-csv'].forEach(id => $(id).disabled = value);
  $('run-batch').hidden = value; $('stop-batch').hidden = !value;
}
const delay = (ms, signal) => new Promise(resolve => { if (signal?.aborted) return resolve(); const abort = () => { clearTimeout(timer); resolve(); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms); signal?.addEventListener('abort', abort, { once: true }); });
async function runBatch() {
  if (!engine || running) return;
  try { results = buildRows(sheet, mappingFromControls()); } catch (e) { toast(e.message); return; }
  const snapshot = new Engine(engine.datasets, engine.relationships), memo = new Map(); controller = new AbortController();
  const signal = controller.signal, online = $('batch-online').checked; let lastRequest = 0;
  snapshot.taxLookup = engine.taxLookup;
  const registry = snapshot.remoteRegistry.bind(snapshot);
  snapshot.remoteRegistry = async (query, requestSignal) => { if (!snapshot.cache.has(query)) { await delay(Math.max(0, 900 - (Date.now() - lastRequest)), requestSignal); lastRequest = Date.now(); } return registry(query, requestSignal); };
  setRunning(true); page = 0; $('batch-results').hidden = false; $('batch-progress').max = results.length;
  const map = mappingFromControls(); $('paste-location').textContent = `貼回位置：原表「${sheet.name}」空白欄的第 ${map.start} 列開始，共 ${results.length} 列。請先取消原表篩選；不要排序或刪列。`;
  $('snapshot-note').textContent = '本批次使用同一份名單快照';
  let completed = 0;
  try {
    for (let i = 0; i < results.length; i++) {
      if (signal.aborted) break;
      const row = results[i];
      if (!row.excluded && row.kind !== 'missing') {
        const key = JSON.stringify([row.name, row.id, row.referenceCode, row.referenceMarket]);
        if (memo.has(key)) {
          const resolved = structuredClone(memo.get(key)); results[i] = { ...row, ...resolved, row: row.row, group: row.group, shop: row.shop, store: row.store, hidden: row.hidden, rawID: row.rawID, audit: [row.audit, resolved.audit].filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join('；') };
        } else {
          results[i] = await resolveRow(snapshot, { ...row, audit: '' }, { online, signal }); if (!results[i].status.startsWith('暫時')) memo.set(key, structuredClone(results[i]));
          results[i].audit = [row.audit, results[i].audit].filter(Boolean).join('；');
        }
      }
      completed = i + 1; $('batch-progress').value = completed;
      if (i % 25 === 0 || i === results.length - 1) { renderResults(); await delay(0); }
    }
  } catch (e) { toast(`批次暫停：${e.message}`); }
  finally {
    for (let i = completed; i < results.length; i++) if (!results[i].excluded && results[i].kind !== 'missing' && results[i].status === '等待查詢') results[i].status = '未查詢（已取消）';
    setRunning(false); renderResults(); toast(signal.aborted || completed < results.length ? '已停止，保留完成結果；未處理列已標示' : '批次比對完成，可複製貼回或匯出');
  }
}
function filteredResults() {
  const filter = $('result-filter').value;
  return results.filter(r => filter === 'all' || filter === 'pending' && /^(待|暫時|缺少|未查詢)/.test(r.status) || filter === 'related' && r.status.includes('關聯') || filter === 'official' && ['上市', '上櫃', '興櫃'].includes(r.status) || filter === 'excluded' && r.excluded);
}
function renderResults() {
  const n = counts(results); $('count-official').textContent = n.official; $('count-related').textContent = n.related; $('count-pending').textContent = n.pending; $('count-excluded').textContent = n.excluded;
  $('result-summary').textContent = `共 ${n.total} 列 · 缺少名稱 ${n.missing} 列${running ? ` · 比對中 ${$('batch-progress').value}/${results.length}` : ' · 點選「核對」可查看來源與候選'}`;
  const filtered = filteredResults(), pages = Math.max(1, Math.ceil(filtered.length / 100)); page = Math.min(page, pages - 1); $('results-body').replaceChildren();
  for (const row of filtered.slice(page * 100, (page + 1) * 100)) {
    const tr = node('tr'), name = node('td', row.name || (row.kind === 'batch' ? row.group : '（空白）')), status = node('td'), detail = node('td'), action = node('td');
    if (row.id) name.append(node('span', row.id, 'muted'));
    status.append(badge(row.status));
    detail.textContent = row.company?.relations?.length ? row.company.relations.map(r => `${r.name} ${r.code}（${r.market}）`).join('；') : row.company?.name || row.note || '';
    if (row.audit) detail.append(node('span', row.audit, 'muted'));
    const review = node('button', '核對', 'row-review'); review.disabled = running; review.addEventListener('click', () => reviewRow(row)); action.append(review);
    tr.append(node('td', String(row.row)), name, status, detail, action); $('results-body').append(tr);
  }
  if (!filtered.length) { const td = node('td', '此篩選沒有符合資料'); td.colSpan = 5; const tr = node('tr'); tr.append(td); $('results-body').append(tr); }
  $('page-label').textContent = `${page + 1} / ${pages} 頁 · ${filtered.length} 列`; $('prev-page').disabled = page === 0; $('next-page').disabled = page >= pages - 1;
}
function reviewRow(row) {
  $('review-title').textContent = `原表第 ${row.row} 列`; const body = $('review-body'); body.replaceChildren(node('h3', row.name || '缺少公司名稱'), badge(row.status));
  body.append(node('p', [`原統編：${row.rawID || row.id || '未提供'}`, row.note, row.audit, row.hidden ? '原表隱藏列，仍保留位置' : ''].filter(Boolean).join('\n'), 'review-meta'));
  if (row.company) { body.append(node('p', `本體：${row.company.name}／${row.company.id}／${row.company.selfMarket || row.company.market}`, 'review-meta')); row.company.relations?.forEach(r => { body.append(node('p', `${r.name} ${r.code}（${r.market}）｜${r.kind}｜查證 ${r.checkedAt}`, 'review-meta')); }); }
  body.append(sourceLinks(row.source));
  if (row.candidates?.length) {
    body.append(node('h3', '候選公司'), node('p', '確認原資料確實屬同一法律主體後再採用。原輸入名稱與統編仍會保留。', 'muted'));
    for (const c of row.candidates) {
      const card = node('div', '', 'candidate'); card.append(node('strong', c.name), badge(c.market), node('p', `統編 ${c.id || '未提供'}${c.code ? ' · 代號 ' + c.code : ''}\n${c.address || '來源未提供地址'}`, 'review-meta'), sourceLinks(c.source));
      const use = node('button', '確認同一主體並採用', 'secondary'); use.addEventListener('click', () => { applyCompany(row, c, '使用者人工確認候選'); row.audit = [row.audit, '使用者已人工採用候選；保留原輸入供追溯'].filter(Boolean).join('；'); row.candidates = []; auditReference(row); renderResults(); $('review-dialog').close(); toast('已採用候選並更新結果'); }); card.append(use); body.append(card);
    }
  }
  $('review-dialog').showModal();
}
function download(name, content, type, bom = false) {
  const blob = new Blob(bom ? ['\ufeff', content] : [content], { type }); const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportXLSX() {
  try {
    const XLSX = window.XLSX; if (!XLSX) throw new Error('試算表元件未載入');
    const wb = XLSX.utils.book_new(), full = XLSX.utils.aoa_to_sheet(reportCells(results)); full['!cols'] = Array.from({ length: 26 }, (_, i) => ({ wch: [0, 2, 5, 7, 8, 15, 16, 19, 24].includes(i) ? 15 : 35 }));
    const range = XLSX.utils.decode_range(full['!ref']); full['!autofilter'] = { ref: XLSX.utils.encode_range(range) };
    XLSX.utils.book_append_sheet(wb, full, '完整比對報告');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alignedCells(results)), `貼回分類_原表第${results[0].row}列`);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alignedCells(results, true)), `分類及來源_原表第${results[0].row}列`);
    download('公司比對結果.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (e) { toast(e.message); }
}
const escapeHTML = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function copyBatch() {
  const source = $('copy-mode').value === 'source', cells = alignedCells(results, source), html = `<table>${cells.map(row => `<tr>${row.map(v => `<td>${escapeHTML(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  copyText(makeTSV(results, source), html);
}

for (const mode of ['single', 'batch']) $(`tab-${mode}`).addEventListener('click', () => {
  for (const name of ['single', 'batch']) { $(`tab-${name}`).classList.toggle('active', name === mode); $(`tab-${name}`).setAttribute('aria-selected', String(name === mode)); $(`${name}-panel`).hidden = name !== mode; }
});
let suggestionTimer;
function suggestInput() {
  const token = ++searchToken, input = $('query').value;
  clearTimeout(suggestionTimer);
  clearCompany();
  const local = engine?.suggest(input) || [];
  renderSuggestions(local);
  $('search-note').textContent = local.length ? '請點選建議，或按查詢。' : '輸入名稱前幾個字查看建議，或按查詢。';
  if (!engine || !$('single-online').checked || normalize(input).length < 2) return;
  suggestionTimer = setTimeout(async () => {
    try {
      const tax = await engine.taxLookup(input);
      if (token !== searchToken) return;
      const all = [...new Map([...local, ...tax.map(c => engine.enrich(c))].map(c => [c.id || c.code, c])).values()];
      all.sort((a, b) => Number(exactName(b, input)) - Number(exactName(a, input)));
      renderSuggestions(all);
      if (all.length) $('search-note').textContent = '請點選建議，或按查詢。';
    } catch { /* Submit retries the index and can consult the external registry. */ }
  }, 260);
}
$('query').addEventListener('input', suggestInput);
$('single-online').addEventListener('change', suggestInput);
$('search-form').addEventListener('submit', e => { e.preventDefault(); search(); });
document.querySelectorAll('[data-query]').forEach(b => b.addEventListener('click', () => { $('query').value = b.dataset.query; search(); }));
$('reload-data').addEventListener('click', loadData);
$('file-input').addEventListener('change', e => importFile(e.target.files[0]));
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, e => { e.preventDefault(); if (!running) $('dropzone').classList.add('drag'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, e => { e.preventDefault(); $('dropzone').classList.remove('drag'); if (name === 'drop') importFile(e.dataTransfer.files[0]); });
$('use-paste').addEventListener('click', () => { if (running) return; try { const parsed = parseDelimited($('paste-input').value); book = { label: '貼上名單', names: [parsed.name], rawSheets: { [parsed.name]: parsed } }; $('sheet-select').replaceChildren(new Option(parsed.name, parsed.name)); selectSheet(parsed.name); } catch (e) { toast(e.message); } });
$('sheet-select').addEventListener('change', () => { try { selectSheet($('sheet-select').value); } catch (e) { toast(e.message); $('run-batch').disabled = true; } });
['name-col', 'id-col', 'market-col', 'code-col', 'start-row', 'end-row'].forEach(id => $(id).addEventListener('change', refreshPreview));
$('run-batch').addEventListener('click', runBatch); $('stop-batch').addEventListener('click', () => { controller?.abort(); $('stop-batch').disabled = true; setTimeout(() => $('stop-batch').disabled = false, 1000); });
$('result-filter').addEventListener('change', () => { page = 0; renderResults(); });
$('prev-page').addEventListener('click', () => { page--; renderResults(); }); $('next-page').addEventListener('click', () => { page++; renderResults(); });
$('copy-batch').addEventListener('click', copyBatch);
$('export-tsv').addEventListener('click', () => download(`貼回${$('copy-mode').value === 'source' ? '分類及來源' : '分類'}_原表第${results[0].row}列開始.tsv`, makeTSV(results, $('copy-mode').value === 'source'), 'text/tab-separated-values;charset=utf-8', true));
$('export-csv').addEventListener('click', () => download('公司比對完整報告.csv', makeCSV(results), 'text/csv;charset=utf-8', true)); $('export-xlsx').addEventListener('click', exportXLSX);
$('close-review').addEventListener('click', () => $('review-dialog').close()); $('close-clipboard').addEventListener('click', () => $('clipboard-dialog').close()); $('select-clipboard').addEventListener('click', () => { $('clipboard-text').focus(); $('clipboard-text').select(); });
window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });
loadData();
