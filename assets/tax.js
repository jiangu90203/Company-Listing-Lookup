const normalizeKey = name => String(name).normalize('NFKC').replace(/[\s\u200b\ufeff]/gu, '').replaceAll('臺', '台').toLowerCase();
const prefixKey = key => key.replace(/^(社團法人|財團法人)/u, '') || key;

function nameBucket(key) {
  let hash = 0;
  for (const char of Array.from(key).slice(0, 2)) hash = hash * 31 + char.codePointAt(0);
  return hash % 64;
}

export class TaxIndex {
  constructor(manifest, read) {
    const partCount = { 1: 80, 2: 208 }[manifest?.schema];
    if (!partCount || Object.keys(manifest.parts || {}).length !== partCount) throw new Error('稅籍索引不完整');
    this.manifest = manifest;
    this.read = read;
    this.cache = new Map();
  }

  static async open() {
    const base = new URL('../data/tax/', import.meta.url);
    async function get(path) {
      const r = await fetch(new URL(path, base), { cache: path === 'manifest.json' ? 'no-cache' : 'default' });
      if (!r.ok) throw new Error('無法載入稅籍索引');
      return r;
    }
    const manifest = await (await get('manifest.json')).json();
    return new TaxIndex(manifest, async key => (await get(key + '.txt?v=' + manifest.parts[key])).text());
  }

  part(key) {
    if (!this.cache.has(key)) {
      const pending = this.read(key).then(text => {
        if (!/^\d{8}\t/.test(text)) throw new Error('稅籍索引格式異常');
        return text.replace(/\r?\n$/, '').split('\n').map(line => line.split('\t'));
      });
      this.cache.set(key, pending);
      pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); });
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(key);
  }

  async details(id) {
    if (this.manifest.schema < 2 || !/^\d{8}$/.test(id)) return undefined;
    const entry = (await this.part('d' + Number(id) % 128)).find(row => row[0] === id);
    if (!entry) return undefined;
    const [, address, organization, founded, capital, invoice] = entry;
    return { address, organization, founded, capital, invoice, date: this.manifest.date, source: this.manifest.source };
  }

  async lookup(input) {
    const key = normalizeKey(input), prefix = prefixKey(key);
    const byID = /^\d{8}$/.test(key);
    let section;
    if (byID) {
      const ids = await this.part('i' + Number(key) % 16);
      const match = ids.find(([id]) => id === key);
      if (!match) return [];
      section = match[1];
    } else {
      if (!prefix) return [];
      section = nameBucket(prefix);
    }
    const exact = [], suggestions = [];
    const allowPrefix = Array.from(prefix).length >= 2;
    for (const [id, name, area, head] of await this.part('n' + section)) {
      if (byID && id !== key) continue;
      const n = normalizeKey(name);
      const precise = byID || n === key;
      if (!precise && (!allowPrefix || suggestions.length >= 36 || !prefixKey(n).startsWith(prefix))) continue;
      (precise ? exact : suggestions).push({ id, name, area, registeredHeadID: head, aliases: [], market: '未查得上市櫃紀錄', sourceKey: 'registry', source: this.manifest.source, taxDate: this.manifest.date });
    }
    if (byID && !exact.length) throw new Error('稅籍索引資料不同步');
    return [...exact, ...suggestions];
  }
}
