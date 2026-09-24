/**
 * presets.js — клиент REST API пресетов (PHP) с офлайн-запасом в localStorage.
 * presets.js — presets REST API client (PHP) with a localStorage offline fallback.
 *
 * Типы пресетов / preset kinds:
 *   'eq'      — Movexe EQ 24:  { name, category, plugin:'eq', eq:{ mode, bands:[…] } }
 *   'deesser' — Movexe DeEss:  { name, category, plugin:'deesser', mode, frequency, range, … }
 *   'lite'    — Movexe EQ Lite: { name, category, plugin:'lite', bands:[{freq,gain}×10], mode, bypass, upsampling }
 *
 * Без PHP (статический хостинг / офлайн PWA) заводские пресеты берутся из
 * presets/index.json и presets/deesser/index.json, а свои хранятся на устройстве.
 */
import { sanitizeDeEss, DS_ENUMS } from './detection.js';
import { sanitizeLite, liteToPreset, LITE_MODES } from './api560.js';
import { LITE_FREQS } from './proportionalq.js';
import { sanitizeDenoise, DN_ENUMS } from './spectral.js';

const LS_KEY = 'proeq.userPresets.v1';
// Красивый URL (.htaccess) и прямой вызов скрипта / pretty URL and direct script call
const API_CANDIDATES = ['api/presets', 'php/api.php/presets'];
const FACTORY_DIR = { eq: 'presets/', deesser: 'presets/deesser/', lite: 'presets/lite/', denoise: 'presets/denoise/' };
const LS_NOISE = 'proeq.noiseProfiles.v1';

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function lsWrite(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}

export const kindOf = (p) => (p && ['deesser', 'lite', 'denoise'].includes(p.plugin) ? p.plugin : 'eq');

/** Проверка на клиенте (повторяет PHP) / client-side validation (mirrors PHP). */
export function validatePreset(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['пресет должен быть объектом'];
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 64) errors.push('название: от 1 до 64 символов');
  if (kindOf(p) === 'denoise') {
    if (p.algorithm && !DN_ENUMS.algorithm.includes(p.algorithm)) errors.push('неизвестный алгоритм');
    if (p.channelMode && !DN_ENUMS.channelMode.includes(p.channelMode)) errors.push('неизвестный режим каналов');
    for (const k of ['reduction', 'threshold']) if (p[k] !== undefined && !Number.isFinite(Number(p[k]))) errors.push(`${k}: нужно число`);
  } else if (kindOf(p) === 'lite') {
    if (!Array.isArray(p.bands) || !p.bands.length) errors.push('нет списка полос');
    else if (p.bands.some((b) => !LITE_FREQS.includes(Number(b.freq)) || !Number.isFinite(Number(b.gain)) || Math.abs(b.gain) > 12)) errors.push('полосы: частоты 31…16000 Гц, усиление ±12 дБ');
    if (p.mode && !LITE_MODES.includes(p.mode)) errors.push('неизвестный режим обработки');
  } else if (kindOf(p) === 'deesser') {
    if (p.mode && !DS_ENUMS.mode.includes(p.mode)) errors.push('неизвестный режим детекции');
    if (p.channelMode && !DS_ENUMS.channelMode.includes(p.channelMode)) errors.push('неизвестный режим каналов');
    for (const k of ['frequency', 'range', 'threshold']) if (p[k] !== undefined && !Number.isFinite(Number(p[k]))) errors.push(`${k}: нужно число`);
  } else {
    const eq = p.eq;
    if (!eq || !Array.isArray(eq.bands)) errors.push('нет списка полос эквалайзера');
    else if (eq.bands.length > 24) errors.push('не более 24 полос');
  }
  return errors;
}

export class PresetStore {
  constructor() {
    this.base = null;
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
        // Без PHP сервер отдаёт исходник/HTML 404 — это не наш API.
        if (!ct.includes('application/json')) throw new Error(`Сервер пресетов недоступен (${res.status})`);
        const data = await res.json();
        if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка сервера ${res.status}`), { status: res.status, api: true });
        this.base = b;
        this.online = true;
        return data;
      } catch (e) {
        lastErr = e;
        if (e.api) throw e; // настоящая ошибка API — другой URL не пробуем
      }
    }
    this.online = false;
    throw lastErr || new Error('Сервер пресетов недоступен');
  }

  async list(kind = 'eq') {
    try {
      const data = await this._fetch(`?plugin=${kind}`);
      return data.presets;
    } catch (e) {
      if (e.api) throw e;
      let factory = [];
      try {
        const r = await fetch(FACTORY_DIR[kind] + 'index.json');
        factory = (await r.json()).presets || [];
      } catch { /* офлайн без кеша */ }
      const local = lsRead().filter((p) => kindOf(p) === kind).map(({ eq, ...meta }) => ({ ...meta, local: true }));
      return [...factory.map((p) => ({ ...p, factory: true })), ...local];
    }
  }

  async get(id, kind = 'eq') {
    const local = lsRead().find((p) => p.id === id);
    if (local) return local;
    try {
      return (await this._fetch('/' + encodeURIComponent(id))).preset;
    } catch (e) {
      if (e.api) throw e;
      const r = await fetch(`${FACTORY_DIR[kind]}${encodeURIComponent(id)}.json`);
      if (!r.ok) throw new Error('Пресет не найден');
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

  /* ---------------- профили шума / noise prints (/api/noise-profiles) ---------------- */

  /** Запрос к API профилей шума (тот же сервер, другой путь) / noise-profile API call. */
  async _noiseFetch(path = '', opts = {}) {
    if (!this.base) { try { await this._fetch('?plugin=denoise'); } catch { /* офлайн */ } }
    if (!this.base) throw new Error('Сервер недоступен');
    const res = await fetch(this.base.replace(/presets$/, 'noise-profiles') + path, {
      ...opts, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка сервера ${res.status}`), { api: true });
    return data;
  }

  async saveNoiseProfile(json) {
    try {
      return (await this._noiseFetch('', { method: 'POST', body: JSON.stringify(json) })).profile;
    } catch (e) {
      if (e.api) throw e;
      // Офлайн — на устройстве / offline — on the device
      let list = [];
      try { list = JSON.parse(localStorage.getItem(LS_NOISE) || '[]'); } catch { /* noop */ }
      const item = { ...json, id: `local-${Date.now().toString(36)}`, local: true };
      list.push(item);
      try { localStorage.setItem(LS_NOISE, JSON.stringify(list.slice(-20))); } catch { /* переполнено */ }
      return item;
    }
  }

  async getNoiseProfile(id) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(LS_NOISE) || '[]'); } catch { /* noop */ }
    const local = list.find((p) => p.id === id);
    if (local) return local;
    try { return (await this._noiseFetch('/' + encodeURIComponent(id))).profile; }
    catch (e) {
      if (e.api) throw e;
      const r = await fetch(`noise-profiles/${encodeURIComponent(id)}.json`);
      if (!r.ok) throw new Error('Профиль шума не найден');
      return r.json();
    }
  }

  async listNoiseProfiles() {
    try { return (await this._noiseFetch('')).profiles; }
    catch {
      try { return (await (await fetch('noise-profiles/index.json')).json()).profiles || []; } catch { return []; }
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
    const { local, factory, id, ...clean } = preset;
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const ext = { deesser: 'deess', lite: 'eqlite', eq: 'eq', denoise: 'denoise' }[kindOf(preset)];
    downloadBlob(blob, `${(preset.name || 'preset').replace(/[^\w\-а-яё ]+/gi, '_')}.movexe-${ext}.json`);
  }

  /** Импорт из файла; тип определяется по содержимому / import; kind detected from content. */
  async importFile(file, expectedKind) {
    const text = await file.text();
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error('Файл не является корректным JSON'); }
    // «Голый» EQ-state или «голые» параметры де-эссера / bare EQ state or bare de-esser params
    const isLiteBands = Array.isArray(obj.bands) && obj.bands.length && obj.bands.every((b) => LITE_FREQS.includes(Number(b.freq)) && b.type === undefined);
    if (Array.isArray(obj.bands) && !isLiteBands && !obj.plugin) obj = { name: file.name.replace(/\..*$/, ''), plugin: 'eq', eq: obj };
    if (!obj.plugin && obj.frequency !== undefined && !obj.eq) obj.plugin = 'deesser';
    // Формат из ТЗ Lite: bands:[{freq,gain}] на частотах 31…16000 / Lite format
    if (!obj.plugin && Array.isArray(obj.bands) && obj.bands.every((b) => LITE_FREQS.includes(Number(b.freq)))) obj.plugin = 'lite';
    if (!obj.name) obj.name = file.name.replace(/\..*$/, '').slice(0, 64);
    if (expectedKind && kindOf(obj) !== expectedKind) {
      const names = { eq: 'Movexe EQ 24', deesser: 'Movexe DeEss', lite: 'Movexe EQ Lite', denoise: 'Movexe DeNoise' };
      throw new Error(`Это пресет для ${names[kindOf(obj)]}, а открыт ${names[expectedKind]}`);
    }
    if (kindOf(obj) === 'deesser') obj = { name: obj.name, category: obj.category || 'Custom', plugin: 'deesser', ...sanitizeDeEss(obj) };
    if (kindOf(obj) === 'lite') obj = { name: obj.name, category: obj.category || 'Custom', plugin: 'lite', ...liteToPreset(sanitizeLite(obj)) };
    if (kindOf(obj) === 'denoise') {
      const { bypass, freeze, ...params } = sanitizeDenoise(obj);
      obj = { name: obj.name, category: obj.category || 'Custom', plugin: 'denoise', ...params,
        reductionCurve: obj.reductionCurve || null, profileOffset: obj.profileOffset || null,
        noiseProfile: typeof obj.noiseProfile === 'string' ? obj.noiseProfile : null, ...(obj.profile ? { profile: obj.profile } : {}) };
    }
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
