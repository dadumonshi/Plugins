/**
 * presets.js — клиент REST API пресетов (PHP) с офлайн-фолбэком на localStorage.
 * presets.js — presets REST API client (PHP) with an offline localStorage fallback.
 *
 * Если PHP недоступен (статический хостинг / офлайн PWA), заводские пресеты
 * читаются из presets/index.json, а пользовательские хранятся локально.
 * Without PHP (static hosting / offline PWA) factory presets come from
 * presets/index.json and user presets are stored locally.
 */

const LS_KEY = 'proeq.userPresets.v1';
// Красивый URL (.htaccess) и прямой вызов скрипта / pretty URL (.htaccess) and direct script call
const API_CANDIDATES = ['api/presets', 'php/api.php/presets'];

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function lsWrite(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* приватный режим / private mode */ }
}

/** Клиентская валидация (зеркалит PHP) / client-side validation (mirrors PHP). */
export function validatePreset(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['preset must be an object'];
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 64) errors.push('name: 1–64 chars');
  const eq = p.eq;
  if (!eq || !Array.isArray(eq.bands)) errors.push('eq.bands must be an array');
  else if (eq.bands.length > 24) errors.push('max 24 bands');
  return errors;
}

export class PresetStore {
  constructor() {
    this.base = null;       // рабочий URL API / working API URL
    this.online = false;
  }

  async _fetch(path = '', opts = {}) {
    const bases = this.base ? [this.base] : API_CANDIDATES;
    let lastErr;
    for (const b of bases) {
      try {
        const res = await fetch(b + path, {
          ...opts,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) }
        });
        const ct = res.headers.get('content-type') || '';
        // Без PHP сервер отдаёт исходник/404 HTML — это не наш API.
        // Without PHP the server returns source/404 HTML — not our API.
        if (!ct.includes('application/json')) throw new Error(`Not an API response (${res.status})`);
        const data = await res.json();
        if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, api: true });
        this.base = b;
        this.online = true;
        return data;
      } catch (e) {
        lastErr = e;
        if (e.api) throw e; // настоящая ошибка API — не пробуем другой URL
      }
    }
    this.online = false;
    throw lastErr || new Error('API unavailable');
  }

  async list() {
    try {
      const data = await this._fetch('');
      return data.presets;
    } catch (e) {
      if (e.api) throw e;
      let factory = [];
      try {
        const r = await fetch('presets/index.json');
        factory = (await r.json()).presets || [];
      } catch { /* офлайн без кеша / offline without cache */ }
      return [...factory.map((p) => ({ ...p, factory: true })), ...lsRead().map(({ eq, ...meta }) => ({ ...meta, local: true }))];
    }
  }

  async get(id) {
    const local = lsRead().find((p) => p.id === id);
    if (local) return local;
    try {
      return (await this._fetch('/' + encodeURIComponent(id))).preset;
    } catch (e) {
      if (e.api) throw e;
      const r = await fetch(`presets/${encodeURIComponent(id)}.json`);
      if (!r.ok) throw new Error('Preset not found');
      return r.json();
    }
  }

  async save(preset) {
    const errs = validatePreset(preset);
    if (errs.length) throw new Error(errs.join('; '));
    try {
      if (preset.id && !preset.factory && !preset.local) {
        return (await this._fetch('/' + encodeURIComponent(preset.id), { method: 'PUT', body: JSON.stringify(preset) })).preset;
      }
      const { id, factory, local, ...body } = preset;
      return (await this._fetch('', { method: 'POST', body: JSON.stringify(body) })).preset;
    } catch (e) {
      if (e.api) throw e;
      const list = lsRead();
      const id = preset.local && preset.id ? preset.id : `local-${Date.now().toString(36)}`;
      const item = { ...preset, id, local: true, factory: false, updated: new Date().toISOString() };
      const i = list.findIndex((p) => p.id === id);
      if (i >= 0) list[i] = item; else list.push(item);
      lsWrite(list);
      return item;
    }
  }

  async remove(id) {
    const list = lsRead();
    if (list.some((p) => p.id === id)) { lsWrite(list.filter((p) => p.id !== id)); return true; }
    await this._fetch('/' + encodeURIComponent(id), { method: 'DELETE' });
    return true;
  }

  /** Экспорт в файл .json / export to a .json file. */
  exportFile(preset) {
    const { local, ...clean } = preset;
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${(preset.name || 'preset').replace(/[^\w\-а-яё ]+/gi, '_')}.proeq.json`);
  }

  /** Импорт из файла / import from a file. */
  async importFile(file) {
    const text = await file.text();
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error('Некорректный JSON / Invalid JSON'); }
    // Допускаем «голый» EQ-state / accept a bare EQ state
    if (Array.isArray(obj.bands)) obj = { name: file.name.replace(/\..*$/, ''), eq: obj };
    const errs = validatePreset(obj);
    if (errs.length) throw new Error(errs.join('; '));
    const { id, factory, ...rest } = obj;
    return this.save(rest);
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
