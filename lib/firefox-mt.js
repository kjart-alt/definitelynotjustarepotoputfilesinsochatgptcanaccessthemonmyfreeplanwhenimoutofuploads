// Перевод моделями Firefox: bergamot в wasm, тем же API, что Translator у Chrome.
//
// На Chrome переводит встроенный Translator самого Chrome: по смыслу он точнее
// (сравнение 30.10, texts/mt-chrome-vs-firefox.2026-10-30.txt), но словарь пары
// качает только под жестом зрителя, и загрузка у него бывает застревает до
// перезапуска браузера. Поэтому пока словарь Chrome не скачан, переводит этот
// модуль (race): Chrome готов — bergamot пары удаляется. Там, где Translator у
// Chrome нет, он единственный, а на телефоне — основной: модели Firefox Android берёт
// нативной сборкой (shim.js ставит свой Translator с native: true), а где натива
// нет — тот же движок, собранный в wasm (vendor/bergamot, из Firefox).
//
// Пары лежат на huggingface (vendor/bergamot/mt.json: файлы .gz с размером и
// sha256 до и после распаковки), качаются без всякого жеста и живут в Cache
// API — общем для фона, панели и offscreen. Две вкладки расширения не качают
// одну пару дважды: загрузка идёт под navigator.locks, второй ждёт первого и
// находит файлы в кеше; ход загрузки слышат все через BroadcastChannel.
//
// Сам движок — в воркере (mt-worker.js) и только у того, кто переводит: панель
// и фон лишь качают, а service worker воркеров заводить не умеет вовсе.

import { canPair, reach, translatorOff } from './packs.js';

const INDEX = new URL('../vendor/bergamot/mt.json', import.meta.url).href;
const WORKER = new URL('../mt-worker.js', import.meta.url).href;
const CACHE = 'translator-mt-v1';
const LOCK = 'translator-mt:';
// Пару переводит живая сессия (в любой странице): общий замок на пару, пока
// сессия жива. forget удаляет только пары без него — en-ru нужна и en>ru, и
// de>ru (через английский), и панели, и offscreen.
const USE = 'translator-mt-use:';
// Маршруты, ради которых лежат пары: запись на каждый путь bergamot (de→ru),
// пары его — route() (de-en и en-ru). Пару держит любой записанный путь через
// неё; путь стирается, когда его переводит Chrome, — тогда и пары, что больше
// никто не держит.
const ROUTES = 'translator-mt-routes';
const routeKey = (src, dst) => `https://route.invalid/${ff(src)}/${ff(dst)}`;
const endsOf = (url) => new URL(url).pathname.split('/').slice(1);
async function heldPairs() {
  const held = new Set();
  for (const r of await (await caches.open(ROUTES)).keys()) for (const p of await route(...endsOf(r.url)) ?? []) held.add(p);
  return held;
}

let index = null;
const getIndex = () => index ??= fetch(INDEX).then(r => {
  if (!r.ok) throw new Error(`mt.json: ${r.status}`);
  return r.json();
}).catch(e => { index = null; throw e; });

/** Код языка у Firefox: китайский у него двумя письменностями, норвежский — букмолом. */
function ff(code) {
  const c = String(code || '');
  if (c === 'zh-Hant' || c === 'zh-TW' || c === 'zh-HK') return 'zh-Hant';
  const base = c.split('-')[0].toLowerCase();
  if (base === 'zh') return 'zh-Hans';
  if (base === 'no' || base === 'nn') return 'nb';
  return base;
}

/** Пары Firefox на путь src→dst: прямая, иначе через английский. null — не умеем. */
async function route(src, dst) {
  const { pairs } = await getIndex();
  const s = ff(src);
  const d = ff(dst);
  if (!s || !d || s === d) return null;
  if (pairs[`${s}-${d}`]) return [`${s}-${d}`];
  if (s !== 'en' && d !== 'en' && pairs[`${s}-en`] && pairs[`en-${d}`]) return [`${s}-en`, `en-${d}`];
  return null;
}

/**
 * Файлы пары: адрес .gz, ключ распакованного в кеше, размеры и sha256. Пара из
 * local (сборка для ПК кладёт .gz в пакет: vendor/bergamot/pairs) — ещё и
 * pack, адрес в пакете: её не качают, воркер читает и распаковывает сам.
 */
async function files(pair) {
  const { base, pairs, local } = await getIndex();
  const own = local?.includes(pair);
  // Шортлист (lex.*) не берём вовсе: он режет словарь вывода, и модель
  // собирает несуществующие слова — «Самые сысые продукты» вместо «сочные»,
  // «падся падся падся» (05.11, en→ru). Без него перевод медленнее примерно
  // в полтора раза (76→118 мс на длинной фразе), зато без выдумок.
  return Object.entries(pairs[pair].files).filter(([name]) => !name.startsWith('lex.')).map(([name, [gzSize, , size, sha]]) => {
    const raw = name.replace(/\.gz$/, '');
    return {
      name: raw,
      type: raw.split('.')[0],
      url: `${base}/${pair}/${name}`,
      key: `${base}/${pair}/${raw}`,
      pack: own ? new URL(`pairs/${pair}/${name}`, INDEX).href : null,
      gzSize, size, sha
    };
  });
}

async function cached(pair) {
  // В пакете — только если файл там правда есть: архив без словарей (tar.gz
  // вне Flatpak) качает их, как Chrome.
  if ((await getIndex()).local?.includes(pair)) {
    const f = (await files(pair))[0];
    if (await fetch(f.pack, { method: 'HEAD' }).then(r => r.ok, () => false)) return true;
  }
  const store = await caches.open(CACHE);
  for (const f of await files(pair)) if (!await store.match(f.key)) return false;
  return true;
}

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('translator-mt') : null;
// Эта страница — в сообщениях о словаре Chrome (done.chrome).
export const PAGE = Math.random().toString(36).slice(2);
const listeners = new Set();
channel?.addEventListener('message', (e) => { for (const f of listeners) f(e.data); });
const tell = (msg) => { channel?.postMessage(msg); for (const f of listeners) f(msg); };
// Сеть у загрузки под замком пары ({pair, offline, part — доля пары}): её ждут другие просьбы той
// же пары (ensure), у них свой ключ from→to — свой канал, не onProgress.
const lockChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('translator-mt-lock') : null;
const lockers = new Set();
lockChannel?.addEventListener('message', (e) => { for (const f of lockers) f(e.data); });
const lockTell = (msg) => { lockChannel?.postMessage(msg); for (const f of lockers) f(msg); };
// Пару стёрли в любой странице: веса в памяти здешнего воркера про неё больше
// не нужны. Живой сессии у пары нет нигде — иначе drop её не тронул бы.
lockers.add((m) => { if (m.forgot) void unload([m.forgot]); });

/**
 * Ход загрузки любой пары в любой странице расширения:
 * {from, to, loaded: 0…1}, {from, to, offline: true} (ждёт сети) и
 * {from, to, done: true}; chrome у done — докачал словарь Chrome
 * (страница PAGE).
 */
export function onProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Сеть замолчала на столько — соединение мертво, файл качаем заново: без срока
// зависшее соединение держало бы замок пары и кольцо до конца сеанса. До
// заголовков срок длиннее: редирект huggingface на CDN бывает долгим.
const IDLE_MS = 10000;
const HEAD_MS = 15000;
// Столько тишины — на экране уже «нет интернета», а соединение пока держим:
// сеть вернулась с тем же адресом — оно оживёт само, и кольцо пойдёт дальше.
const HUSH_MS = 4000;
// Повтор файла после сбоя сети: 1, 2, 4, 5, 5… с. Ждать одного online нельзя:
// с docker, VPN или tailscale navigator.onLine не падает и при выключенном
// Wi-Fi (07.11, Opera), и ни offline, ни online не приходят.
const RETRY_MAX_MS = 5000;
// События сети — только у страниц (и воркеров Firefox): в воркере Chromium их
// нет, там сбой ловят лишь срок и повтор.
const netEvents = 'ononline' in self;
// Пауза до повтора: срок или online, что раньше. Без срока — до online.
// Брошенная загрузка (signal) паузу прерывает.
const pause = (ms, signal) => new Promise((res) => {
  const go = () => { clearTimeout(timer); self.removeEventListener('online', go); signal?.removeEventListener('abort', go); res(); };
  const timer = ms == null ? 0 : setTimeout(go, ms);
  if (netEvents) self.addEventListener('online', go);
  signal?.addEventListener('abort', go);
});
// Сбой сети, а не файла: повторяем, пока сеть не вернётся.
const netError = (msg, cause) => Object.assign(new Error(msg, { cause }), { net: true });

async function fetchFile(f, onBytes, onHush, signal) {
  const ac = new AbortController();
  let timer = 0, hush = 0;
  // До заголовков «нет интернета» не говорим: долгий редирект — не обрыв.
  // Мёртвую сеть там ловит сам fetch (ошибка сразу) или срок HEAD_MS.
  const idle = (ms = IDLE_MS, quiet = true) => {
    clearTimeout(timer);
    clearTimeout(hush);
    timer = setTimeout(() => ac.abort(), ms);
    if (quiet) hush = setTimeout(onHush, HUSH_MS);
  };
  // Сеть пропала: соединение мертво сразу, а не через IDLE_MS тишины.
  const off = () => ac.abort();
  self.addEventListener('offline', off);
  signal?.addEventListener('abort', off);
  const gz = new Uint8Array(f.gzSize);
  let at = 0;
  idle(HEAD_MS, false);
  try {
    let res;
    try { res = await fetch(f.url, { signal: ac.signal }); } catch (e) { throw netError(`${f.name}: network error`, e); }
    // Ответ сервера с ошибкой — не «нет интернета»: сбой с повтором.
    if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      idle();
      let part;
      try { part = await reader.read(); } catch (e) { throw netError(`${f.name}: network ${ac.signal.aborted ? 'stalled' : 'error'}`, e); }
      const { done, value } = part;
      if (done) break;
      if (at + value.length > gz.length) throw new Error(`${f.name}: larger than expected`);
      gz.set(value, at);
      at += value.length;
      onBytes(value.length);
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(hush);
    self.removeEventListener('offline', off);
    signal?.removeEventListener('abort', off);
    // Брошенный посреди ответ (ошибка, лишние байты) не докачивается впустую.
    ac.abort();
  }
  // Соединение закрылось раньше конца файла — тоже сеть.
  if (at !== gz.length) throw netError(`${f.name}: truncated (${at} of ${gz.length})`);
  const raw = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (raw.byteLength !== f.size) throw new Error(`${f.name}: unpacked size mismatch`);
  if (hex(await crypto.subtle.digest('SHA-256', raw)) !== f.sha) throw new Error(`${f.name}: sha256 mismatch`);
  return raw;
}

/**
 * Скачать пары пути, если их нет в кеше. Прогресс 0…1 — по сжатым байтам всего
 * пути. Уже идёт загрузка той же пары в другой странице — ждём её под замком.
 * onWait — ждём сети: до неё загрузка стоит, со следующим onLoaded идёт дальше.
 * signal — загрузку бросили (словарь Chrome готов раньше): AbortError.
 */
async function ensure(pairs, onLoaded, onWait, signal) {
  const todo = [];
  for (const p of pairs) if (!await cached(p)) todo.push(p);
  if (!todo.length) return;
  const all = (await Promise.all(todo.map(files))).flat();
  const total = all.reduce((s, f) => s + f.gzSize, 0) || 1;
  let done = 0;
  for (const pair of todo) {
    const pf = await files(pair);
    const own = pf.reduce((s, f) => s + f.gzSize, 0);
    // Пару качает другая просьба (другой путь через en, другая страница): её
    // «нет сети» и ход загрузки идут с её ключом, этой просьбе их пересказывает
    // держатель замка (lockTell). События offline у ждущего нет вовсе, если
    // navigator.onLine не падает (см. RETRY_MAX_MS).
    const heard = (m) => {
      if (m.pair !== pair) return;
      if (m.offline) onWait();
      else onLoaded((done + m.part * own) / total);
    };
    if (netEvents && !navigator.onLine) onWait();
    lockers.add(heard);
    await navigator.locks.request(LOCK + pair, signal ? { signal } : {}, async () => {
      lockers.delete(heard);
      if (await cached(pair)) return;
      const store = await caches.open(CACHE);
      let got = 0, off = false, told = -1;
      // Ждём сети: «нет интернета» и себе, и ждущим замка.
      const stuck = () => { off = true; onWait(); lockTell({ pair, offline: true }); };
      // Ход загрузки — себе на каждый кусок, ждущим замка на каждый процент и
      // на возврате сети.
      const step = () => {
        const pc = Math.floor(got / (own || 1) * 100);
        if (off || pc !== told) { off = false; told = pc; lockTell({ pair, offline: false, part: got / (own || 1) }); }
        onLoaded((done + got) / total);
      };
      for (const f of pf) {
        signal?.throwIfAborted();
        const hit = await store.match(f.key);
        if (hit) { got += f.gzSize; step(); continue; }
        // Сети нет или она пропала посреди файла: «нет интернета», и файл
        // качаем заново, пока сеть не вернётся. Вернул её зритель — загрузка
        // идёт дальше сама, без Retry; кольцо вернёт первый же пришедший кусок.
        const before = got;
        let raw, wait = 0;
        for (;;) {
          signal?.throwIfAborted();
          if (netEvents && !navigator.onLine) {
            stuck();
            await pause(null, signal);
            continue;
          }
          try {
            raw = await fetchFile(f, (n) => { got += n; step(); }, stuck, signal);
            break;
          } catch (e) {
            signal?.throwIfAborted();
            if (!e?.net) throw e;
            got = before;
            stuck();
            wait = Math.min(wait * 2 || 1000, RETRY_MAX_MS);
            await pause(wait, signal);
          }
        }
        await store.put(f.key, new Response(raw, { headers: { 'content-length': String(raw.byteLength) } }));
      }
    }).finally(() => lockers.delete(heard));
    done += own;
    onLoaded(done / total);
  }
}

async function downloading(pairs) {
  try {
    const { held = [], pending = [] } = await navigator.locks.query();
    return [...held, ...pending].some(l => pairs.some(p => l.name === LOCK + p));
  } catch { return false; }
}

// --- Движок ------------------------------------------------------------------

/**
 * Веса пар — из памяти воркера этой страницы. Пар не осталось — воркер с кучей
 * wasm не нужен (память wasm не сжимается). Идёт чужой вызов — оставляем:
 * следующий сам поднимет новый.
 */
async function unload(pairs) {
  const e = engine;
  if (!e) return;
  const left = await e.call({ op: 'drop', pairs }).catch(() => null);
  if (left === '0' && engine === e && e.idle()) { engine = null; e.w.terminate(); }
}

let engine = null;
function getEngine() {
  if (engine) return engine;
  if (typeof Worker !== 'function') throw new Error('translation engine needs a page, not a service worker');
  const w = new Worker(WORKER);
  const calls = new Map();
  let seq = 0;
  const fail = (err) => {
    for (const { reject } of calls.values()) reject(err);
    calls.clear();
    if (engine?.w === w) engine = null;
    w.terminate();
  };
  w.onmessage = ({ data }) => {
    const c = calls.get(data.id);
    if (!c) return;
    calls.delete(data.id);
    if (data.error) c.reject(new Error(data.error));
    else c.resolve(data.text);
  };
  // wasm упал целиком (abort, нехватка памяти) — воркер мёртв: следующий
  // перевод поднимет новый, а offscreen пересоберёт инстанс по ошибке.
  w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'translation engine crashed')); };
  const call = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
  return engine = { w, call, idle: () => calls.size === 0 };
}

class Session {
  constructor(sourceLanguage, targetLanguage, pairs) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.pairs = pairs;
    this.dead = false;
    // Замки отпускает destroy(); held — когда отпущены все.
    let gone;
    const end = new Promise((res) => { gone = res; });
    this.gone = gone;
    // taken — замки выданы: до этого пару может стирать drop другой страницы.
    const taken = [];
    this.held = Promise.all(pairs.map((p) => {
      let got;
      taken.push(new Promise((r) => { got = r; }));
      const free = navigator.locks ? navigator.locks.request(USE + p, { mode: 'shared' }, () => { got(); return end; }).catch(() => {}) : Promise.resolve();
      return free.finally(got);
    }));
    this.taken = Promise.all(taken);
  }

  async translate(text) {
    if (this.dead) throw new Error('The translator has been destroyed.');
    const s = String(text ?? '');
    if (!s.trim()) return s;
    const models = await Promise.all(this.pairs.map(async (pair) => ({ pair, files: await files(pair) })));
    return getEngine().call({ op: 'run', models, text: s });
  }

  // Холодный движок (wasm, веса пары, при переводе через английский две)
  // грузится секундами, и первая строка ждала его под тем же сроком, что и
  // сам перевод (MT_CALL_MS в offscreen): не успевала, инстанс пересобирался,
  // и строки шли оригиналом. Зовёт только offscreen, пока строки и так идут
  // без перевода (mtReady): панель create() лишь качает словари, и движок с
  // весами в её памяти не нужен. Не вышло — загрузит первая строка.
  async warm() {
    if (this.dead) return;
    const models = await Promise.all(this.pairs.map(async (pair) => ({ pair, files: await files(pair) })));
    await getEngine().call({ op: 'load', models });
  }

  async *translateStreaming(text) { yield await this.translate(text); }
  async measureInputUsage() { return 0; }
  get inputQuota() { return Infinity; }
  /**
   * Пары, которых уже не держит ни один маршрут (Chrome перевёл путь, пока
   * сессия жила, и forget застал их занятыми), стираются тут же.
   * @returns {Promise} замки пар отпущены
   */
  destroy() { this.dead = true; this.gone(); return this.held.then(() => loose(this.pairs)).catch(() => {}); }
}

/** То же, что Translator у Chrome: availability() и create({…, monitor}). */
export const FirefoxTranslator = {
  async availability({ sourceLanguage, targetLanguage } = {}) {
    const pairs = await route(sourceLanguage, targetLanguage).catch(() => null);
    if (!pairs) return 'unavailable';
    if ((await Promise.all(pairs.map(cached))).every(Boolean)) return 'available';
    return await downloading(pairs) ? 'downloading' : 'downloadable';
  },

  /**
   * hush {on, waiting} — молчать в канал о «нет сети», пока on: пару качает и
   * Chrome (race), «нет интернета» — его, пока он жив; полоса — всегда наша,
   * Chrome шлёт лишь 0 и 1. waiting — ждём сети: race скажет «нет интернета»
   * сам, когда Chrome отказал.
   */
  async create({ sourceLanguage, targetLanguage, monitor, signal, hush } = {}) {
    const mon = new EventTarget();
    try { monitor?.(mon); } catch (e) { console.error(e); }
    signal?.throwIfAborted();
    const pairs = await route(sourceLanguage, targetLanguage);
    if (!pairs) throw new DOMException(`${sourceLanguage}→${targetLanguage} is not supported`, 'NotSupportedError');
    const from = sourceLanguage, to = targetLanguage;
    let last = -1;
    const progress = (loaded) => {
      // Каждый процент, не каждый кусок сети: сообщений иначе тысячи.
      const p = Math.floor(loaded * 100);
      if (p === last) return;
      last = p;
      mon.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: p / 100, total: 1 }));
      if (hush) hush.waiting = false;
      tell({ from, to, loaded: p / 100 });
    };
    // Ждём сети: страницы рисуют «нет интернета» до следующего хода.
    const wait = () => {
      last = -1;
      if (hush) hush.waiting = true;
      if (!hush?.on) tell({ from, to, offline: true });
    };
    // Сессия — до загрузки: её замки (USE) держат уже скачанную половину пары
    // через английский, пока качается вторая, и forget/sweep её не сотрут.
    // Сбой — замки отпускаем до ответа: forget после него их уже не застанет.
    // Запись не легла (квота) — перевод не ломаем: на Chrome пару без записи
    // сотрёт уборка, понадобится — скачается заново.
    await (await caches.open(ROUTES)).put(routeKey(from, to), new Response('')).catch(() => {});
    const s = new Session(sourceLanguage, targetLanguage, pairs);
    try { await s.taken; await ensure(pairs, progress, wait, signal); } catch (e) { await s.destroy(); throw e; }
    // at — когда: панель отличит запоздалый статус «качается» от новой загрузки.
    tell({ from, to, done: true, at: Date.now() });
    return s;
  },

  /**
   * Путь src→dst переводит Chrome: запись маршрута — долой, его пары, которых
   * не держит другой маршрут, — из кеша и из памяти всех страниц.
   */
  async forget({ sourceLanguage, targetLanguage } = {}) {
    const pairs = await route(sourceLanguage, targetLanguage).catch(() => null);
    if (!pairs || !navigator.locks) return;
    await (await caches.open(ROUTES)).delete(routeKey(sourceLanguage, targetLanguage));
    await loose(pairs);
  }
};

/**
 * Пары из pairs, которых не держит ни один записанный маршрут, — стереть.
 * Только там, где переводит Chrome: без него bergamot — единственный движок.
 */
async function loose(pairs) {
  if (!navigator.locks || typeof caches === 'undefined' || !await chromeOn()) return;
  const held = await heldPairs();
  const store = await caches.open(CACHE);
  for (const p of new Set(pairs)) if (!held.has(p)) await drop(store, p);
}

// Пара файла в кеше: ключ — `${base}/${pair}/${файл}`.
const pairOf = (url) => new URL(url).pathname.split('/').slice(-2)[0];

/**
 * Стереть пару из кеша целиком: и нынешние файлы, и прежние (шортлисты,
 * старые ревизии). Пару держит живая сессия (общая через en, другая
 * страница; качает её ensure тоже только под ней) — не трогаем.
 */
function drop(store, p) {
  return navigator.locks.request(USE + p, { ifAvailable: true }, async (use) => {
    if (!use) return;
    let gone = false;
    for (const r of await store.keys()) if (pairOf(r.url) === p) gone = await store.delete(r) || gone;
    // Все страницы (и эта) выгружают её веса из памяти (lockers выше).
    if (gone) lockTell({ forgot: p });
  });
}

/**
 * Словарь Chrome пары не готов (Translator.gesture): качаем
 * сразу и его (chrome), и bergamot той же пары. Готов первым — его и берём;
 * Chrome готов (сразу или позже) — bergamot пары бросаем: загрузку обрываем,
 * словарь удаляем (forget). Сбой — только если не вышло у обоих, и причина
 * тогда — от Chrome. Пару bergamot не знает — ждём одного Chrome, как раньше.
 *
 * @param chrome () => Promise<T> — словарь Chrome (и инстанс, если он нужен)
 * @returns {Promise<{ chrome: T } | { ff: Session, later: Promise<T> }>}
 *   ff — переводит bergamot, later — когда (и если) готов Chrome
 */
export async function race(pair, chrome) {
  const ac = new AbortController();
  const hush = { on: true, waiting: false };
  const ff = FirefoxTranslator.create({ ...pair, signal: ac.signal, hush });
  const { sourceLanguage: from, targetLanguage: to } = pair;
  // Chrome отказал — дальше говорит bergamot; ждёт сети уже сейчас — скажем за
  // него. Пока bergamot качается, словарь Chrome могут докачать мимо гонки
  // (Retry панели, фон после срока, done.chrome): тогда берём Chrome сразу, не
  // дожидаясь bergamot. bergamot кончился — ждать нечего, отказ Chrome в силе.
  const c = chrome().catch((e) => new Promise((res, no) => {
    hush.on = false;
    if (hush.waiting) tell({ from, to, offline: true });
    // Докачал кто-то ещё — повтор, а опоздавший create() этого отказа гасим.
    // done этой страницы при late — от него самого: его ждём ниже.
    const hear = (m) => {
      if (!m?.done || !m.chrome || (e?.late && m.chrome === PAGE) || m.from !== from || m.to !== to) return;
      listeners.delete(hear);
      e?.late?.then((x) => x?.destroy?.(), () => {});
      chrome().then(res, no);
    };
    listeners.add(hear);
    // Опоздавший create() (late, offscreen) и есть Chrome: вернулся — берём его,
    // даже если его done ушёл раньше, чем мы стали слушать.
    e?.late?.then((t) => { if (listeners.delete(hear)) res(t); }, () => {});
    ff.finally(() => { if (listeners.delete(hear)) no(e); }).catch(() => {});
  }));
  // Сессия отпускает замки пар раньше, чем forget их спросит.
  const drop = () => {
    ac.abort();
    ff.then((s) => s.destroy(), () => {}).finally(() => FirefoxTranslator.forget(pair).catch(() => {}));
  };
  c.then(drop, () => {});
  try {
    return await Promise.any([c.then((t) => ({ chrome: t })), ff.then((s) => ({ ff: s, later: c }))]);
  } catch (e) {
    // Оба отказали: причина — от Chrome (сеть, срок), bergamot её не уточнит.
    throw e.errors?.[0] ?? e;
  }
}

/**
 * Переводчик расширения: на Chrome — его Translator, на телефоне — натив
 * Android, если shim его поставил и нативная сборка движка есть (usable),
 * иначе свой wasm. Translator браузера, выключенный целиком (translatorOff:
 * Опера с WebAI), — всё равно что его нет.
 */
const host = self.Translator || null;
let hostOff = false;
export const pick = async () => {
  if (!host) return FirefoxTranslator;
  if (host.native) return await Promise.resolve(host.usable).catch(() => false) ? host : FirefoxTranslator;
  hostOff = await translatorOff();
  return hostOff ? FirefoxTranslator : host;
};
/** Переводит словарь Chrome (не bergamot, не натив телефона): bergamot ему уступает. */
const chromeOn = async () => !!host && !host.native && await pick() === host;

/**
 * Кольцо загрузки: правда что-то качается — bergamot не в кеше и качать есть
 * кому: Chrome (chromeWill — пару знает или молчит) или сам bergamot.
 */
export async function downloads(pair, chromeWill) {
  const ff = Translator.gesture ? await FirefoxTranslator.availability(pair).catch(() => '') : 'unavailable';
  return ff !== 'available' && (chromeWill || ff !== 'unavailable');
}

// Chrome и натив качают пару сами: их ход загрузки — в тот же канал, что у
// wasm, иначе панель не видит загрузки, начатой offscreen.
async function hostCreate(o = {}) {
  const { sourceLanguage: from, targetLanguage: to } = o;
  let last = -1;
  const monitor = (m) => {
    m.addEventListener('downloadprogress', (e) => {
      const p = Math.floor((e.loaded || 0) * 100);
      if (p !== last) { last = p; tell({ from, to, loaded: p / 100 }); }
    });
    o.monitor?.(m);
  };
  const t = await host.create({ ...o, monitor });
  // chrome — докачал Chrome (не bergamot), и в какой странице: offscreen
  // переводит пару на него (again), а свои create() ведёт сам.
  tell({ from, to, done: true, chrome: PAGE, at: Date.now() });
  // Словарь Chrome на диске — bergamot пути не нужен (живую сессию forget не тронет).
  FirefoxTranslator.forget(o).catch(() => {});
  return t;
}

// Код языка у Chrome для пары Firefox (обратное ff).
const chromeCode = (c) => c === 'zh-Hans' ? 'zh' : c === 'nb' ? 'no' : c;

/**
 * Уборка кеша: на старте браузера (фон) и при открытии панели (у форков вроде
 * Vivaldi Translator есть только в ней). Файлы вне нынешнего списка (шортлисты
 * lex.* сняты 05.11, прежние ревизии) не читает никто — стираем. Пары без
 * маршрута не нужны никому (прошлые версии качали их сами) — тоже. Маршрут,
 * который Chrome может скачать, — качаем (chrome, фон): докачал — его create()
 * и сотрёт bergamot; на диске — сотрёт сам ответ availability.
 *
 * @param [chrome] (from, to) => Promise — словарь Chrome пары
 */
export async function sweep(chrome) {
  if (!navigator.locks || typeof caches === 'undefined') return;
  const { pairs } = await getIndex();
  const store = await caches.open(CACHE);
  const keys = await store.keys();
  const have = new Set(keys.map((r) => pairOf(r.url)));
  const live = new Set();
  for (const p of have) if (pairs[p]) for (const f of await files(p)) live.add(new URL(f.key).href);
  for (const r of keys) if (!live.has(r.url)) await store.delete(r);
  await loose([...have]);
  if (!await chromeOn()) return;
  let net;
  for (const r of await (await caches.open(ROUTES)).keys()) {
    const [a, b] = endsOf(r.url);
    const pair = { sourceLanguage: chromeCode(a), targetLanguage: chromeCode(b) };
    const can = await canPair(Translator, pair);
    // Сеть — до create(): без неё Chrome портит пакет на часы (06.11).
    if (chrome && (can === 'downloadable' || can === 'downloading') && await (net ??= reach())) chrome(pair.sourceLanguage, pair.targetLanguage).catch(() => {});
  }
}

export const Translator = host
  ? {
      // Словарь Chrome в странице качается только под жестом: create() без
      // него на «downloadable» отвечает NotAllowedError. По этому флагу панель и
      // offscreen просят загрузку у фонового скрипта (WARM_PACK), там жест не нужен.
      // Смотрят его после availability(): к тому времени pick() знает, не
      // выключен ли Translator, а bergamot качает сам, без жеста и фона.
      get gesture() { return !host.native && !hostOff; },
      // Chrome ответил «на диске» — bergamot пути не нужен (как и при create()).
      availability: async (o) => {
        const T = await pick();
        const can = await T.availability(o);
        if (T === host && can === 'available') FirefoxTranslator.forget(o).catch(() => {});
        return can;
      },
      create: async (o) => (await pick()) === host ? hostCreate(o) : FirefoxTranslator.create(o)
    }
  : FirefoxTranslator;
