import { normalize, Engine, displayDate, exactName, applyCompany, auditReference, resolveRow } from './engine.js?v=1.5.2';
import { TaxIndex } from './tax.js?v=1.5.2';
import { parseDelimited, detectMapping, buildRows, worksheetToSheet, bestWorksheetName, guardArchive, columnName, makeTSV, makeCSV, reportCells, alignedCells, counts } from './batch.js';

const $ = id => document.getElementById(id);
const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
let engine, book, sheet, mapping, preview = [], results = [], running = false, controller, page = 0, toastTimer;
const message = (text, type = '') => { $('global-message').className = `notice ${type}`; $('global-message').textContent = text; $('global-message').hidden = !text; };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function lookupProgress(container, label, signal) {
  const wrap = node('div', '', 'lookup-progress');
  const title = node('span', label, 'lookup-label');
  const percentage = node('span', '0%', 'lookup-percent');
  const track = node('div', '', 'lookup-track');
  const fill = node('div', '', 'lookup-fill');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  percentage.setAttribute('aria-hidden', 'true');
  track.append(fill);
  wrap.append(title, percentage, track);
  wrap.hidden = true;
  container.append(wrap);
  let interval, dismiss, displayed = -1;

  function setProgress(value) {
    if (value === displayed) return;
    displayed = value;
    percentage.textContent = value + '%';
    track.setAttribute('aria-valuenow', String(value));
    track.setAttribute('aria-valuetext', value === 100 ? '完成' : `預估 ${value}%`);
    fill.style.transform = `scaleX(${value / 100})`;
  }

  function clear() {
    clearTimeout(start);
    clearInterval(interval);
    clearTimeout(dismiss);
    signal?.removeEventListener('abort', clear);
    wrap.remove();
  }

  const start = setTimeout(() => {
    const began = performance.now();
    setProgress(0);
    wrap.hidden = false;
    interval = setInterval(() => {
      const elapsed = performance.now() - began;
      setProgress(Math.min(94, Math.floor(100 * (1 - Math.exp(-elapsed / 2200)))));
    }, 125);
  }, 260);
  signal?.addEventListener('abort', clear, { once: true });

  return (success = true) => {
    if (!success || wrap.hidden || signal?.aborted) {
      clear();
      return;
    }
    clearInterval(interval);
    title.textContent = '完成';
    setProgress(100);
    dismiss = setTimeout(clear, 350);
  };
}
function badge(status) { return node('span', status || '保留空格', 'badge ' + (/^(待|暫時|未查詢|缺少)/.test(status) ? 'pending' : status?.includes('關聯') ? 'related' : ['上市', '上櫃', '興櫃'].includes(status) ? '' : 'unknown')); }
function safeLink(url, label) {
  try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) return node('span', label); } catch { return node('span', label); }
  const a = node('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function sourceLinks(source, label = '資料來源') {
  const div = node('div', '', 'source-links'), urls = [...new Set(String(source || '').split('；').filter(v => /^https?:\/\//.test(v)))];
  urls.forEach((url, i) => div.append(safeLink(url, urls.length === 1 ? label : `${label} ${i + 1}`))); return div;
}
async function copyText(text, html) {
  try {
    if (html && navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('Clipboard unavailable');
    toast('已複製到剪貼簿');
  } catch {
    $('clipboard-text').value = text; $('clipboard-dialog').showModal(); $('clipboard-text').focus(); $('clipboard-text').select();
  }
}
function fieldCopy(label, value) {
  const button = node('button', '複製', 'field-copy');
  button.type = 'button';
  button.setAttribute('aria-label', `複製${label}`);
  button.addEventListener('click', () => copyText(value));
  return button;
}

function companyFields(c, tax) {
  const invoice = { Y: '是', N: '否' }[tax?.invoice];
  const address = c.address && c.address !== c.area ? c.address : '';
  return [
    ['統一編號', c.id, c.code ? '' : 'wide'], ['股票代號', c.code],
    ['營業地址（稅籍）', tax?.address || c.taxAddress, 'wide'],
    [c.sourceKey === 'registry' ? '登記地址' : '公司地址（掛牌名單）', address && address !== tax?.address && address !== c.taxAddress ? address : '', 'wide'],
    ['股票簡稱', c.short], ['組織類型', tax?.organization], ['稅籍設立日期', tax?.founded ? displayDate(tax.founded) : ''],
    ['稅籍資本額', /^\d+$/.test(tax?.capital || '') ? `NT$ ${BigInt(tax.capital).toLocaleString('en-US')}` : tax?.capital],
    ['使用統一發票', invoice], ['總機構統編', c.registeredHeadID],
    ['董事長／代表人', c.chairman], ['公司電話', c.phone],
    ['公司網站', c.website, 'wide', true],
    ['稅籍資料日期', tax?.date || c.taxDate], ['掛牌名單日期', c.date ? displayDate(c.date) : '']
  ].filter(([, value]) => value);
}

function appendFields(container, fields) {
  for (const [label, value, width = '', link = false] of fields) {
    const pair = node('div', '', 'record-field ' + width);
    const dd = node('dd');
    dd.append(link ? safeLink(value, value) : node('span', value));
    pair.append(node('dt', label), dd, fieldCopy(label, value));
    container.append(pair);
  }
}

function companySources(c, tax) {
  const sources = new Map();
  if (tax?.source) sources.set(tax.source, tax.date ? '財政部稅籍登記' : '稅籍補查來源');
  if (c.registrationSource) sources.set(c.registrationSource, '登記資料');
  for (const url of String(c.source || '').split('；').filter(Boolean)) {
    if (!sources.has(url)) sources.set(url, c.sourceKey === 'registry' ? '登記資料' : c.market + '名單');
  }
  if (c.sourceKey === 'registry') {
    for (const d of engine.datasets) sources.set(d.reference, d.companies[0].market + '名單');
  }
  return [...sources].map(([url, label]) => [label, url]);
}

function showCompany(box, c, completeProgress) {
  const heading = node('div', '', 'result-heading');
  const name = node('div', '', 'record-name');
  const nameRow = node('div', '', 'name-row');
  nameRow.append(node('h3', c.name), fieldCopy('名稱', c.name));
  name.append(nameRow);
  const market = node('div', '', 'market-row');
  market.append(badge(c.market), fieldCopy('掛牌狀態', c.market));
  name.append(market);
  const copy = node('button', '複製整筆', 'secondary');
  heading.append(name, copy);
  const grid = node('dl', '', 'detail-grid');
  const detailStatus = node('p', '', 'muted detail-status');
  const sources = node('dl', '', 'detail-grid source-records');
  const sourceDetails = node('details', '', 'record-sources');
  sourceDetails.append(node('summary', '資料來源'), sources);
  box.replaceChildren(heading, grid, detailStatus);
  if (c.relations.length || c.head) {
    const related = node('details', '', 'relation-box');
    related.append(node('summary', c.head ? '總公司掛牌資料' : '已查證的掛牌公司關聯'));
    const rows = node('dl', '', 'detail-grid');
    const fields = c.relations.map(r => ['關聯公司', `${r.name} · ${r.code} · ${r.market} · ${r.kind} · ${r.checkedAt}`]);
    if (c.head) fields.push(['總公司', `${c.head.name} · ${c.head.code} · ${c.head.market}`]);
    appendFields(rows, fields);
    related.append(rows);
    for (const r of c.relations) {
      const links = node('dl', '', 'detail-grid');
      appendFields(links, r.source.split('；').map(url => [`${r.name}查證來源`, url, 'wide', true]));
      related.append(links);
    }
    box.append(related);
  }
  box.append(sourceDetails);
  let fields, links;
  function renderDetails(tax) {
    fields = companyFields(c, tax);
    links = companySources(c, tax);
    grid.replaceChildren();
    sources.replaceChildren();
    appendFields(grid, fields);
    appendFields(sources, links.map(([label, url]) => [label, url, 'wide', true]));
    detailStatus.textContent = c.sourceKey === 'registry' && !fields.some(([label]) => label.includes('地址'))
      ? (c.area ? `登記地區 ${c.area}（缺完整地址）` : '來源缺少完整地址。')
      : '';
  }
  copy.addEventListener('click', () => copyText([
    ['名稱', c.name], ['掛牌狀態', c.market], ...fields, ...links,
    ...c.relations.map(r => ['關聯公司', `${r.name} · ${r.code} · ${r.market} · ${r.kind}\n${r.source}`])
  ].map(([label, value]) => `${label}：${value}`).join('\n')));
  renderDetails(c.remoteTax);
  if (!c.id) {
    completeProgress?.();
    return;
  }
  const finish = completeProgress || lookupProgress(box, '稅籍明細 · 預估進度');
  const currentEngine = engine;
  currentEngine.taxDetails(c.id).then(tax => {
    if (grid.isConnected && box.contains(grid)) renderDetails(tax || c.remoteTax);
    finish();
  }).catch(() => {
    finish(false);
    if (!grid.isConnected || !box.contains(grid)) return;
    detailStatus.textContent = '稅籍明細暫時無法載入。';
    const retry = node('button', '重試', 'field-copy');
    retry.addEventListener('click', () => showCompany(box, c));
    detailStatus.append(retry);
  });
}

const recentKey = 'company-quickcheck.recent';
let recent = [];
try {
  const stored = JSON.parse(localStorage.getItem(recentKey) || '[]');
  if (Array.isArray(stored)) recent = stored.filter(item => typeof item?.name === 'string' && typeof item.query === 'string').slice(0, 8);
} catch { /* History stays in memory if browser storage is unavailable. */ }

function renderRecent() {
  const container = $('recent-list');
  container.replaceChildren();
  $('clear-recent').hidden = !recent.length;
  if (!recent.length) container.append(node('p', '尚無查詢紀錄', 'muted'));
  for (const entry of recent) {
    const button = node('button', entry.name, 'recent-item');
    button.type = 'button';
    button.title = entry.query;
    button.addEventListener('click', () => {
      $('query').value = entry.query;
      search();
    });
    container.append(button);
  }
}

function saveRecent() {
  try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch { /* Keep in-memory history. */ }
  renderRecent();
}

function rememberCompany(company) {
  const query = company.id || company.code || company.name;
  recent = [{ name: company.name, query }, ...recent.filter(entry => entry.query !== query)].slice(0, 8);
  saveRecent();
}

function renderSuggestions(container, companies, select, limit = 10) {
  container.replaceChildren();
  for (const c of companies.slice(0, limit)) {
    const btn = node('button', '', 'suggestion');
    const info = node('div');
    btn.type = 'button';
    info.append(node('strong', c.name), node('small', [c.id, c.area || c.address, c.code].filter(Boolean).join(' · ')));
    btn.append(info, badge(c.market));
    btn.addEventListener('click', () => select(c));
    container.append(btn);
  }
  if (companies.length > limit) {
    const more = node('button', '顯示更多建議', 'secondary');
    more.type = 'button';
    more.addEventListener('click', () => {
      renderSuggestions(container, companies, select, limit + 10);
      container.children[limit]?.focus();
    });
    container.append(more);
  }
}

const searchHelp = '多筆請用逗號分隔。';
let searchController, searchTimer;
function resetSearch() {
  searchController?.abort();
  clearTimeout(searchTimer);
  $('company-result').replaceChildren();
  $('company-result').hidden = true;
}

async function search({ live = false } = {}) {
  if (!engine) return;
  const queries = $('query').value.split(/[,，]/u).map(value => value.trim()).filter(Boolean);
  resetSearch();
  if (queries.length > 50) {
    $('search-note').textContent = '每次最多 50 筆，更多請用試算表比對。';
    return;
  }
  if (!queries.length) {
    $('search-note').textContent = searchHelp;
    if (!live) $('query').focus();
    return;
  }

  searchController = new AbortController();
  const { signal } = searchController;
  const currentEngine = engine;
  const online = $('single-online').checked;
  const region = $('company-result');
  region.hidden = false;
  const overview = node('div', '', 'results-title');
  const count = node('span', '', 'results-count');
  count.setAttribute('role', 'status');
  overview.append(node('h2', '查詢結果'), count);
  region.append(overview);
  const cards = queries.map(query => {
    const article = node('article', '', 'card result-card');
    const body = node('div');
    if (queries.length > 1) article.append(node('p', query, 'query-label'));
    const progress = node('div', '', 'query-progress');
    article.append(progress, body);
    body.append(node('p', '查詢中…', 'muted lookup-placeholder'));
    region.append(article);
    return { body, progress };
  });
  $('search-note').textContent = searchHelp;

  let next = 0, complete = 0;
  count.textContent = `查詢中 · 0 / ${queries.length}`;
  async function worker() {
    while (!signal.aborted && next < queries.length) {
      const index = next++;
      const input = queries[index], key = normalize(input);
      const { body, progress } = cards[index];
      const finish = lookupProgress(progress, '查詢 · 預估進度', signal);
      const local = currentEngine.suggest(input);
      const exact = c => c.id === key || c.code === key || exactName(c, input);
      let candidates = local, failed = false;
      const partialNumber = live && /^\d+$/u.test(key) && key.length < 8;
      const shortName = live && !/^\d+$/u.test(key) && [...key].length < 2;
      if (online && !local.some(exact) && !partialNumber && !shortName) {
        try {
          const extra = await currentEngine.registry(input, signal, {
            remote: !live || local.length === 0,
            preferSuggestions: live
          });
          candidates = [...new Map([...local, ...extra].map(c => [c.id || c.code || c.name, c])).values()];
        } catch { failed = true; }
      }
      if (signal.aborted) return;
      const matches = candidates.filter(exact);
      const select = (c, pending) => { rememberCompany(c); showCompany(body, c, pending); };
      if (matches.length === 1) select(matches[0], finish);
      else if (candidates.length) {
        const options = node('div', '', 'suggestions');
        body.replaceChildren(node('h3', matches.length ? '同名結果' : '建議結果'), options);
        renderSuggestions(options, matches.length ? matches : candidates, select);
      } else if (partialNumber || shortName) {
        body.replaceChildren(node('p', partialNumber ? '請輸入完整 8 碼統編。' : '請繼續輸入名稱。', 'muted'));
      } else {
        body.replaceChildren(node('h3', failed ? '資料暫時無法取得' : '查無相符資料'));
        body.append(safeLink('https://findbiz.nat.gov.tw/fts/query/QueryBar/queryInit.do', '商工登記查詢'));
      }
      if (matches.length !== 1) finish(!failed);
      body.classList.add('lookup-settled');
      complete++;
      count.textContent = complete === queries.length ? `共 ${complete} 筆` : `查詢中 · ${complete} / ${queries.length}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queries.length) }, worker));
}

function renderData() {
  $('data-sources').replaceChildren(); let stale = false;
  for (const d of engine.datasets) {
    const date = d.companies.map(c => c.date).sort().at(-1), pretty = displayDate(date), age = Date.now() - new Date(pretty.replaceAll('/', '-') + 'T00:00:00+08:00').getTime();
    if (age > 3 * 86400000) stale = true;
    const item = node('div', '', 'source-card'); item.append(safeLink(d.reference, d.companies[0]?.market || d.key), node('strong', `${d.companies.length.toLocaleString()} 家`), node('p', `出表 ${pretty}`), node('p', `取得 ${displayDate(d.fetchedAt)}`)); $('data-sources').append(item);
  }
  $('relationship-date').textContent = `關聯查證日 ${engine.relationships.checkedAt}`;
  message(stale ? '部分名單已超過 3 天。' : '', stale ? 'warn' : '');
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
    engine.taxDetails = async id => (await openTax()).details(id);
    renderData();
    openTax().then(index => {
      $('tax-date').replaceChildren(safeLink(index.manifest.source, '財政部營業中稅籍'), document.createTextNode(` · ${displayDate(index.manifest.date)} · ${index.manifest.count.toLocaleString()} 筆`));
    }).catch(() => { $('tax-date').textContent = '稅籍索引載入失敗。'; });
    $('query').disabled = false; $('search-btn').disabled = false;
    if (!$('company-result').hidden) search();
    if (sheet) refreshPreview();
  } catch { message('名單載入失敗，請重新載入。', 'error'); }
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
    $('preview-note').className = 'notice subtle'; $('preview-note').textContent = `${n.total} 列 · 待比對 ${companyCount} · 缺名稱 ${n.missing} · 保留空白／分批 ${n.excluded}`;
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
  setRunning(true); page = 0; $('batch-results').hidden = false; $('batch-progress').max = results.length; $('batch-progress').value = 0;
  const map = mappingFromControls(); $('paste-location').textContent = `貼回「${sheet.name}」空白欄第 ${map.start} 列，共 ${results.length} 列。請先取消篩選並保留列順序。`;
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
          const finish = lookupProgress($('batch-row-progress'), `第 ${row.row} 列 · 預估進度`, signal);
          try {
            results[i] = await resolveRow(snapshot, { ...row, audit: '' }, { online, signal });
          } catch (error) {
            finish(false);
            throw error;
          }
          const failed = results[i].status.startsWith('暫時');
          finish(!failed);
          if (!failed && !signal.aborted) memo.set(key, structuredClone(results[i]));
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
  $('result-summary').textContent = `共 ${n.total} 列 · 缺少名稱 ${n.missing} 列${running ? ` · 比對中 ${$('batch-progress').value}/${results.length}` : ''}`;
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
  if (row.company) {
    const record = node('div', '', 'card');
    body.append(record);
    showCompany(record, row.company);
  }
  body.append(sourceLinks(row.source));
  if (row.candidates?.length) {
    body.append(node('h3', '候選公司'), node('p', '確認原資料確實屬同一法律主體後再採用。原輸入名稱與統編仍會保留。', 'muted'));
    for (const c of row.candidates) {
      const card = node('div', '', 'candidate'); card.append(node('strong', c.name), badge(c.market), node('p', `統編 ${c.id || '未提供'}${c.code ? ' · 代號 ' + c.code : ''}\n${c.address || c.taxAddress || (c.area ? '登記地區 ' + c.area : '來源未提供地址')}`, 'review-meta'), sourceLinks(c.source));
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

const tabs = ['single', 'batch'];
function switchTab(mode) {
  const switcher = $('tab-switch');
  if (switcher.dataset.active === mode) return;
  switcher.dataset.active = mode;
  for (const name of tabs) {
    const selected = name === mode;
    const button = $(`tab-${name}`);
    const panel = $(`${name}-panel`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.classList.toggle('panel-enter', selected);
    panel.hidden = !selected;
  }
}

for (const mode of tabs) {
  $(`tab-${mode}`).addEventListener('click', () => switchTab(mode));
  $(`tab-${mode}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'single' : event.key === 'End' ? 'batch' : mode === 'single' ? 'batch' : 'single';
    switchTab(next);
    $(`tab-${next}`).focus();
  });
}
let composing = false;

function queueSearch() {
  resetSearch();
  $('search-note').textContent = searchHelp;
  if (!composing && $('query').value.trim()) {
    searchTimer = setTimeout(() => search({ live: true }), 320);
  }
}
$('query').addEventListener('compositionstart', () => {
  composing = true;
  resetSearch();
});
$('query').addEventListener('compositionend', () => {
  composing = false;
  queueSearch();
});
$('query').addEventListener('input', event => {
  if (!event.isComposing) queueSearch();
});
$('single-online').addEventListener('change', queueSearch);
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!composing) search();
});
$('clear-recent').addEventListener('click', () => { recent = []; saveRecent(); });
renderRecent();
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
