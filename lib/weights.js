// Веса потоковой модели: качаем и храним сами.
//
// Ей нужны три отдельных графа формата onnxruntime-genai и словарь, и ни одна
// готовая сборка о таких файлах не знает. Поэтому тут маленький свой
// загрузчик: код — из пакета, веса — из пакета или с huggingface, между ними
// Cache API.
//
// Почему не отдать ссылку прямо в ORT. Отдать можно, он скачает сам — но
// молча, без единого байта наружу, и заново при каждом запуске: у HTTP-кеша
// на семьсот мегабайт надежды нет. Полоса загрузки и повторный запуск без
// сети стоят этих тридцати строк.

import { fromPlanes } from './planes.js';

const CACHE = 'translator-weights-v1';
const HF = 'https://huggingface.co';

/**
 * Адрес файла весов: в пакете у своих сборок, на huggingface у чужих.
 *
 * Свои сборки (id вида `local/…`) едут внутри расширения, и это не экономия
 * трафика, а условие работы: зритель нажимает иконку на первом попавшемся
 * сайте и ждёт субтитров сейчас, а не через гигабайт загрузки. Чужие сборки
 * остаются за сетью — их в пакет не положишь, он и так в гигабайт.
 *
 * Адрес считаем от самого модуля, а не от страницы: weights.js лежит в lib/, а
 * зовут его и воркеры из корня, и панель, и offscreen.
 */
export const hfUrl = (repo, file, rev = 'main') => repo.startsWith('local/')
  ? new URL(`../models/${repo.slice(6)}/${file}`, import.meta.url).href
  : `${HF}/${repo}/resolve/${rev}/${file}`;

/** Вес лежит внутри пакета — качать нечего и класть в кеш незачем. */
const packed = (url) => url.startsWith('chrome-extension:');

/**
 * fp32-тензоры в пакете лежат плоскостями (lib/planes.js): карта на папку
 * модели, planes.json рядом с весами. Нет записи о файле — он как есть.
 */
const planeMaps = new Map();
function planes(url) {
  const at = new URL('planes.json', url).href;
  if (!planeMaps.has(at)) planeMaps.set(at, fetch(at).then(r => r.ok ? r.json() : {}).catch(() => ({})));
  return planeMaps.get(at);
}

/**
 * Файл весов байтами: из кеша, если он там есть, иначе из сети — и в кеш.
 *
 * @param {string} url
 * @param {(p: {file: string, loaded: number, total: number, cached?: boolean}) => void=} onProgress
 * @returns {Promise<Uint8Array>}
 */
export async function weight(url, onProgress) {
  const file = url.split('/').pop();
  // Своё из пакета читаем мимо кеша: копировать полгигабайта из расширения в
  // Cache API значит занять то же место второй раз без единой выгоды.
  const store = packed(url) ? null : await caches.open(CACHE).catch(() => null);
  const hit = await store?.match(url).catch(() => null);
  if (hit) {
    // Про кеш тоже говорим: чтение семисот мегабайт с диска — это секунды,
    // и без строки прогресса они выглядят как зависание.
    onProgress?.({ file, loaded: 0, total: Number(hit.headers.get('content-length')) || 0, cached: true });
    const buf = new Uint8Array(await hit.arrayBuffer());
    onProgress?.({ file, loaded: buf.length, total: buf.length, cached: true });
    return buf;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`);
  const map = packed(url) ? planes(url) : null;
  const total = Number(res.headers.get('content-length')) || 0;

  // Буфер под весь файл выделяем сразу, если размер известен, и читаем прямо
  // в него. Собирать список кусков и потом склеивать — значит на последнем
  // шаге держать в памяти два кодировщика по 690 МБ одновременно; на машине,
  // где рядом уже лежит точная модель, это разница между «работает» и
  // «вкладка убита».
  const reader = res.body.getReader();
  let out = total ? new Uint8Array(total) : null;
  let parts = out ? null : [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Сервер соврал о длине — дальше идём списком кусков, это редкий случай.
    if (out && loaded + value.length > out.length) { parts = [out.subarray(0, loaded)]; out = null; }
    if (out) out.set(value, loaded); else parts.push(value);
    loaded += value.length;
    // Из пакета — не скачивание: 04.11 в приложении для ПК полоса
    // «downloading model» читалась как «модель качается из сети».
    onProgress?.({ file, loaded, total, cached: packed(url) });
  }
  if (!out || loaded !== out.length) {
    const all = out ? [out.subarray(0, loaded)] : parts;
    out = new Uint8Array(loaded);
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
  }

  // Класть в кеш — не повод падать: кончилось место, приватный режим, что
  // угодно. Модель уже скачана, работать она будет и без записи.
  if (store) {
    await store.put(url, new Response(out, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(out.length) }
    })).catch(() => {});
  }
  const ranges = (await map)?.[file];
  if (ranges) fromPlanes(out, ranges);
  return out;
}

/**
 * Несколько файлов весов подряд одним блоком прямо в чужую память: alloc(n)
 * даёт место (у ядра на Rust это его память, lib/nemo-rs.js reserve). Копии
 * в JS нет, и пик памяти при загрузке вдвое ниже: раньше кодировщик лежал и
 * в куче JS, и в памяти модуля, а WebView на телефоне 1.1 ГБ разом не даёт
 * («Array buffer allocation failed»).
 *
 * Так — только для своего из пакета с известной длиной. Остальное (кеш,
 * сервер без длины) читаем обычным weight() и копируем.
 *
 * @param {string[]} urls
 * @param {(n: number) => Uint8Array} alloc
 * @param {(p: {file: string, loaded: number, total: number, cached?: boolean}) => void=} onProgress
 * @returns {Promise<Uint8Array>} блок из alloc
 */
export async function weightsInto(urls, alloc, onProgress) {
  const res = await Promise.all(urls.map(u => packed(u) ? fetch(u).catch(() => null) : null));
  const sizes = res.map(r => r?.ok ? Number(r.headers.get('content-length')) || 0 : 0);
  if (!sizes.every(Boolean)) {
    for (const r of res) r?.body?.cancel().catch(() => {});
    const bs = [];
    for (const u of urls) bs.push(await weight(u, onProgress));
    const block = alloc(bs.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of bs) { block.set(b, at); at += b.length; }
    return block;
  }
  const block = alloc(sizes.reduce((n, x) => n + x, 0));
  let at = 0;
  for (let i = 0; i < urls.length; i++) {
    const file = urls[i].split('/').pop(), total = sizes[i];
    const out = block.subarray(at, at + total);
    const reader = res[i].body.getReader();
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > total) { reader.cancel().catch(() => {}); throw new Error(`${file}: longer than ${total} bytes`); }
      out.set(value, loaded);
      loaded += value.length;
      onProgress?.({ file, loaded, total, cached: true });
    }
    if (loaded !== total) throw new Error(`${file}: ${loaded} of ${total} bytes`);
    const ranges = (await planes(urls[i]))?.[file];
    if (ranges) fromPlanes(out, ranges);
    at += total;
  }
  return block;
}

/** Есть ли файл в кеше — чтобы не обещать пользователю загрузку, которой нет. */
export async function cached(url) {
  if (packed(url)) return true;
  const store = await caches.open(CACHE).catch(() => null);
  return !!(await store?.match(url).catch(() => null));
}
