export const VERSION = '1.4.0';
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\u200b\ufeff]/gu, '').replaceAll('臺', '台').toLowerCase();
export const validID = value => /^\d{8}$/.test(value) && value !== '00000000';
export const exactName = (company, name) => !!normalize(name) && [company.name, company.short?.replace(/\*+$/, ''), ...(company.aliases || [])].some(v => normalize(v) === normalize(name));
export function displayDate(value) {
  const s = String(value || '');
  if (/^\d{7}$/.test(s)) return `${Number(s.slice(0, 3)) + 1911}/${s.slice(3, 5)}/${s.slice(5)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6)}`;
  return s.slice(0, 10).replaceAll('-', '/') || '未提供';
}
export function cleanTaxID(value, numeric = false) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  let id = raw.replace(/\s/g, ''), note = '';
  const match = id.match(/^([+]?)((?:\d+)(?:\.\d*)?)(?:[eE]([+-]?\d+))?$/);
  if (match && (numeric || /[.eE]/.test(id))) {
    const [whole, fraction = ''] = match[2].split('.');
    const exponent = Number(match[3] || 0) - fraction.length;
    if (Math.abs(exponent) <= 30 && whole.length + fraction.length <= 32) {
      let n = BigInt(whole + fraction);
      if (exponent >= 0) n *= 10n ** BigInt(exponent);
      else {
        const divisor = 10n ** BigInt(-exponent);
        if (n % divisor !== 0n) return { id, raw, note: '統編包含非整數，未四捨五入' };
        n /= divisor;
      }
      id = n.toString();
      if (id.length <= 8) id = id.padStart(8, '0');
    }
  }
  if (id !== raw) note = `統編原值「${raw}」轉為「${id}」；請核對前導零`;
  return { id, raw, note };
}

export class Engine {
  constructor(datasets, relationships, now = new Date()) {
    this.datasets = structuredClone(datasets);
    this.relationships = structuredClone(relationships);
    this.now = now;
    const map = new Map();
    for (const dataset of datasets) for (const row of dataset.companies) {
      const c = { ...row, selfMarket: row.market, relations: [] };
      const key = validID(c.id) ? c.id : `${c.sourceKey}:${c.code}:${c.name}`;
      if (!map.has(key) || String(c.date) > String(map.get(key).date)) map.set(key, c);
    }
    this.official = [...map.values()];
    this.byID = new Map(this.official.filter(c => validID(c.id)).map(c => [c.id, c]));
    this.registered = relationships.registrations.map(r => this.enrich({ ...r, market: '未查得上市櫃紀錄', sourceKey: 'registry' }));
    this.all = [...this.official, ...this.registered.filter(c => !this.byID.has(c.id))];
    this.cache = new Map();
    this.knownRemote = new Map();
  }
  enrich(input) {
    if (this.byID.has(input.id)) {
      const issuer = this.byID.get(input.id);
      return { ...issuer, aliases: [...(issuer.aliases || []), input.name, ...(input.aliases || [])], registrationSource: input.source, taxDate: input.taxDate };
    }
    const registration = this.relationships.registrations.find(r => r.id === input.id);
    const c = { ...input, ...(registration || {}), aliases: [...(input.aliases || []), ...(registration?.aliases || [])], selfMarket: '未查得本體掛牌紀錄', relations: [] };
    const queue = [{ id: c.id, depth: 0, kinds: [], sources: [] }], visited = new Set([c.id]);
    while (queue.length) {
      const current = queue.shift();
      if (current.depth >= 4) continue;
      for (const edge of this.relationships.edges.filter(e => e.childID === current.id)) {
        if (visited.has(edge.parentID)) continue;
        visited.add(edge.parentID);
        const kinds = [...current.kinds, edge.kind], sources = [...current.sources, edge.source, edge.additionalSource].filter(Boolean);
        const parent = this.byID.get(edge.parentID);
        if (parent && ['上市', '上櫃', '興櫃'].includes(parent.market)) c.relations.push({ ...parent, kind: kinds.join('→'), source: [...sources, parent.source].join('；'), checkedAt: this.relationships.checkedAt });
        queue.push({ id: edge.parentID, kinds, sources, depth: current.depth + 1 });
      }
    }
    if (c.relations.length) {
      const markets = ['上市', '上櫃', '興櫃'].filter(m => c.relations.some(r => r.market === m));
      const first = c.relations[0].kind;
      const kind = first.includes('分公司') ? '分公司' : first.includes('集團') ? '集團企業' : '子公司';
      c.market = `${markets.join('／')}關聯（${kind}）`;
      if (this.now - new Date(`${this.relationships.checkedAt}T00:00:00+08:00`) > 90 * 86400000) c.market = '待複核（關聯資料逾期）';
    } else if (this.byID.has(c.registeredHeadID)) {
      c.market = '待確認（分公司總公司掛牌）';
      c.head = this.byID.get(c.registeredHeadID);
    }
    return c;
  }
  find(name, id = '') { return this.all.filter(c => id ? c.id === id : exactName(c, name)); }
  suggest(query, limit = 40) {
    const q = normalize(query); if (!q) return [];
    const score = c => {
      if (q === c.id || q === c.code || exactName(c, query)) return 100;
      const keys = [c.name, c.short, ...(c.aliases || [])].map(normalize);
      return keys.some(k => k.startsWith(q)) ? 80 : keys.some(k => k.includes(q)) ? 60 : 0;
    };
    return this.all.map(c => [score(c), c]).filter(([s]) => s).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'zh-Hant')).slice(0, limit).map(([, c]) => c);
  }
  suspectedBranch(name) {
    const q = normalize(name);
    return q.endsWith('分公司') ? this.official.filter(c => q.startsWith(normalize(c.name)) && q !== normalize(c.name)) : [];
  }
  async registry(input, signal) {
    const key = normalize(input);
    const query = validID(key) ? key : String(input).normalize('NFKC').trim();
    let tax = [], indexError;
    if (this.taxLookup) {
      try { tax = (await this.taxLookup(query)).map(c => this.enrich(c)); }
      catch (error) { indexError = error; }
      if (signal?.aborted) throw signal.reason;
      if (tax.some(c => c.id === query || exactName(c, query))) return tax;
      // Omitting a legal prefix can identify several entities. Offer the choices immediately.
      if (tax.some(c => normalize(c.name).replace(/^(社團法人|財團法人)/u, '') === key)) return tax;
    }
    try {
      const learned = [...this.knownRemote.values()].filter(c => c.id === query || exactName(c, query));
      const remote = [...learned, ...await this.remoteRegistry(query, signal)];
      if (indexError && !remote.some(c => c.id === query || exactName(c, query))) throw indexError;
      return [...new Map([...remote, ...tax].map(c => [c.id, c])).values()];
    } catch (error) {
      if (tax.length && !signal?.aborted) return tax;
      throw error;
    }
  }
  async remoteRegistry(query, signal) {
    if (this.cache.has(query)) return structuredClone(this.cache.get(query));
    const url = validID(query) ? `https://company.g0v.ronny.tw/api/show/${query}` : `https://company.g0v.ronny.tw/api/search?q=${encodeURIComponent(query)}`;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const envelope = await response.json();
      if (!Object.hasOwn(envelope, 'data')) throw new Error('資料格式異常');
      let rows = envelope.data;
      if (validID(query)) {
        if (rows && !Array.isArray(rows) && typeof rows === 'object') {
          if (rows.統一編號 && String(rows.統一編號) !== query) throw new Error('來源回傳不同統編');
          rows = [{ ...rows, 統一編號: query }];
        } else if (!rows || (Array.isArray(rows) && !rows.length)) rows = [];
        else throw new Error('統編查詢格式異常');
      }
      if (!Array.isArray(rows)) throw new Error('資料格式異常');
      const result = rows.map(r => this.parseRegistration(r)).filter(c => c.name && validID(c.id)).map(c => this.enrich(c));
      if (rows.length && !result.length) throw new Error('登記資料缺少可核對的名稱或統編');
      if (result.length) {
        this.cache.set(query, result);
        for (const c of result) this.knownRemote.set(c.id, c);
      }
      return structuredClone(result);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  parseRegistration(r) {
    const first = (object, ...keys) => {
      for (const key of keys) {
        const value = object?.[key], v = Array.isArray(value) ? value.find(x => typeof x === 'string' && x.trim()) : value;
        if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
      }
      return '';
    };
    const c = { name: first(r, '公司名稱', '分公司名稱', '商業名稱', '營業人名稱', '名稱'), id: first(r, '統一編號'), address: first(r, '公司所在地', '分公司所在地', '地址'), chairman: first(r, '代表人姓名', '負責人姓名'), aliases: [], market: '未查得上市櫃紀錄', sourceKey: 'registry', registeredHeadID: first(r, '總(本)公司統一編號', '總公司統一編號') };
    const head = this.byID.get(c.registeredHeadID), branch = first(r, '分公司名稱');
    if (head && !first(r, '公司名稱') && branch) c.name = head.name + branch;
    const taxName = first(r['財政部'], '營業人名稱');
    if (taxName && (!c.name || taxName.includes('分公司'))) { if (c.name) c.aliases.push(c.name); c.name = taxName; }
    if (taxName && taxName !== c.name) c.aliases.push(taxName);
    c.address ||= first(r['財政部'], '營業地址');
    c.source = `https://company.g0v.ronny.tw/id/${c.id}`;
    return c;
  }
  sources() { return this.datasets.map(d => d.reference).join('；'); }
  dates() { return this.datasets.map(d => `${d.companies[0]?.market} ${displayDate(d.companies.map(c => c.date).sort().at(-1))}`).join('；'); }
}

export function applyCompany(row, company, method) {
  row.company = company; row.status = company.market; row.method = method;
  row.source = [company.source, company.registrationSource].filter(Boolean).join('；');
  row.date = displayDate(company.date || company.taxDate);
  if (company.relations?.length) {
    row.source = [company.source, ...company.relations.map(r => r.source)].join('；');
    row.note = '已查證企業關係；關聯公司掛牌，不表示輸入公司本身掛牌';
    row.date = `關係查證 ${company.relations[0].checkedAt}`;
  } else if (company.head) row.note = '登記資料指向掛牌總公司，尚待核對最新分公司登記';
  else if (company.sourceKey === 'registry') row.note = '一般公司統編未命中官方名單；未查得不等同已確認未上市櫃';
  return row;
}
export function auditReference(row) {
  const c = row.company, expected = ['上市', '上櫃', '興櫃'].includes(row.referenceMarket);
  const notes = [row.audit || ''];
  if (row.referenceCode && c) {
    if (c.sourceKey !== 'registry' && c.code === row.referenceCode) {
      if (expected && c.market !== row.referenceMarket) notes.push(`原表市場與官方「${c.market}」不同`);
    } else {
      const related = c.relations?.find(r => r.code === row.referenceCode);
      if (related) {
        notes.push('原表股票代號屬已查證關聯公司，並非輸入公司獨立掛牌代號');
        if (expected && related.market !== row.referenceMarket) notes.push(`該代號官方市場為「${related.market}」`);
      } else notes.push(`原表代號 ${row.referenceCode} 未與公司法律主體對應${c.relations?.length ? '；已查證關聯：' + c.relations.map(r => `${r.name} ${r.code}`).join('、') : ''}`);
    }
  }
  if (expected && row.status === '未查得上市櫃紀錄') { row.status = '待確認（原表市場與查核不一致）'; notes.push('原表標示掛牌，尚未驗證本體或關聯'); }
  row.audit = notes.filter(Boolean).join('；'); return row;
}
export async function resolveRow(engine, input, { online = false, signal } = {}) {
  let row = { ...input, candidates: [], source: engine.sources(), date: engine.dates() };
  const finish = () => auditReference(row);
  if (row.excluded || row.kind === 'missing' || row.status?.startsWith('待確認（來源')) return row;
  if (row.id && !validID(row.id)) { row.status = '待確認（統編格式錯誤）'; row.note = '統編需為 8 碼；shop id 不可當統編'; return finish(); }
  const named = engine.registered.find(c => exactName(c, row.name));
  if (named && row.id && row.id !== named.id) {
    applyCompany(row, named, '登記名稱與原統編交叉核對'); row.status = '待確認（名稱與統編不同主體）';
    row.note = `登記名稱對應 ${named.id}，原表提供 ${row.id}；請核對原統編`; return finish();
  }
  // Pasted, headerless columns may mix names and eight-digit IDs. Keep the original cell for export.
  const lookupID = row.id || (validID(normalize(row.name)) ? normalize(row.name) : '');
  const exact = engine.find(row.name, lookupID);
  const assignPrecise = (precise, method) => {
    if (precise.length !== 1) return false;
    if (row.name && row.id && !exactName(precise[0], row.name)) {
      row.status = '待確認（統編與名稱不符）'; row.candidates = precise; row.note = '未自動採用不同登記名稱';
    } else applyCompany(row, precise[0], method);
    return true;
  };
  if (assignPrecise(exact, '官方／已查證名稱或統編精準比對')) return finish();
  if (exact.length > 1) { row.status = '待確認（同名候選）'; row.candidates = exact; return finish(); }
  const query = lookupID || row.name;
  let candidates = engine.suggest(query);
  if (online) {
    try {
      const remote = await engine.registry(query, signal);
      const all = new Map([...candidates, ...remote].map(c => [c.id || c.code, c])); candidates = [...all.values()];
    } catch (error) {
      if (signal?.aborted) { row.status = '未查詢（已取消）'; return finish(); }
      row.status = '暫時無法確認（連線失敗）'; row.note = '公司補查連線失敗或遭瀏覽器限制，未視為未上市櫃'; row.candidates = candidates; return finish();
    }
    const precise = candidates.filter(c => lookupID ? c.id === lookupID : exactName(c, row.name));
    if (assignPrecise(precise, '登記資料確認統編後比對官方名單')) {
      if (row.company?.sourceKey === 'registry') row.source += '；' + engine.sources();
      return finish();
    }
    if (precise.length > 1) {
      row.status = '待確認（同名候選）'; row.candidates = precise; return finish();
    }
  }
  if (candidates.length) { row.status = '待確認（名稱不完整或不一致）'; row.candidates = candidates; row.note = '請依統編與地址選擇，未自動採用第一筆'; return finish(); }
  const parents = engine.suspectedBranch(row.name);
  if (parents.length) { row.status = '待確認（疑似掛牌公司分公司）'; row.note = `可能對應 ${parents.map(c => c.name + ' ' + c.code).join('、')}；缺少分公司登記證據`; return finish(); }
  row.status = online ? '待確認（未找到登記資料）' : '未查得上市櫃紀錄'; row.method = online ? '官方名單及一般公司補查未命中' : '僅比對網站官方名單';
  row.note = '未查得不等同已確認未上市櫃' + (online ? '' : '；可開啟網路補查或前往商工登記確認');
  return finish();
}
