// Перевод растущей строки — только её хвоста.
//
// Живая строка набирается словами: пока человек говорит, снимок за снимком
// приходит одна и та же фраза, каждый раз чуть длиннее. Переводился при этом
// каждый раз весь текст целиком, а перевод линеен по его длине — 83 мс на
// строке до десяти слов, 165 на десяти-двадцати, 335 на двадцати с лишним
// (медианы прогона 01.10). Платится это дважды: задержкой самой строки и
// выброшенными снимками — пока перевод идёт, следующий снимок не делается
// вовсе (partialBusy в offscreen.js).
//
// Резать текст на запросы можно без потери качества, и это замерено, а не
// предположено: встроенный в Chrome переводчик посентенциален и детерминирован
// — один и тот же текст, поданный по одной реплике и абзацами по двенадцать,
// переводится байт в байт одинаково (30 сентября на английском,
// 2 октября на французском, e2e/translate.mjs --ceiling). Значит перевод
// законченного предложения от соседей не зависит, и повторять его при каждом
// новом слове незачем.
//
// Поэтому здесь: что у строки уже переведено (до последней точки) и что
// осталось. Закрепляется только то, у чего предложения сошлись по числу с
// переводом, — иначе склейка перепутает порядок, а это хуже лишних 300 мс.

import { splitTail } from './carry.js';

/**
 * Разделить текст по последней границе предложения — теми же правилами, что
 * придержка хвоста перед переводом (`splitTail`): сокращения и инициалы
 * концом предложения не считаются. Второй набор правил здесь завести нельзя,
 * он однажды разъедется с первым и будет резать строку не там.
 *
 * @param {string} text
 * @returns {{done: string, tail: string, count: number}} done — законченные
 *   предложения вместе с пробелом после последнего (ровный префикс исходного
 *   текста, а не обрезанный), tail — незаконченный остаток, count — сколько
 *   предложений в done.
 */
export function sentences(text) {
  const src = text || '';
  const { ready } = splitTail(src, Infinity);
  if (!ready) return { done: '', tail: src, count: 0 };
  // `splitTail` отдаёт обрезанный текст, а кешу нужен ровный префикс: по нему
  // потом сверяется, что строка доросла, а не переписалась.
  const at = src.indexOf(ready);
  if (at < 0) return { done: '', tail: src, count: 0 };
  let end = at + ready.length;
  while (end < src.length && /\s/.test(src[end])) end++;
  return { done: src.slice(0, end), tail: src.slice(end), count: count(ready) };
}

/** Сколько законченных предложений в тексте. */
function count(text) {
  let n = 0;
  for (let s = text; s;) {
    const { ready } = splitTail(s, Infinity);
    if (!ready) break;
    n++;
    // Отрезаем последнее предложение и считаем остаток тем же правилом.
    const prev = splitTail(ready.slice(0, ready.length - 1), Infinity).ready;
    s = prev;
  }
  return n;
}

/** Нужен ли пробел между переведённым началом и переводом хвоста. */
function glue(left, right) {
  if (!left || !right) return '';
  if (/\s$/.test(left) || /^\s/.test(right)) return '';
  // В языках без пробелов (японский, китайский) склейка пробелом видна как
  // чужая: там его не ставят ни после точки, ни между словами.
  if (/[　-鿿＀-￯]$/.test(left)) return '';
  return ' ';
}

export class SentenceCache {
  /** @param {number} max сколько строк ленты помнить. */
  constructor(max = 32) {
    this.max = max;
    this.lines = new Map();
  }

  /**
   * Что из строки уже переведено и что осталось.
   *
   * @param {number|string|null} line номер строки ленты
   * @param {string} text весь текст строки, как он уйдёт на экран
   * @returns {{src: string, out: string, rest: string}} src/out — закреплённое
   *   начало и его перевод, rest — то, что надо перевести сейчас.
   */
  split(line, text) {
    const got = line == null ? null : this.lines.get(line);
    // Строку переписали с начала (точная модель, другая фраза) — помнить
    // нечего: кеш годен только для ровной приставки.
    if (!got || !text.startsWith(got.src) || text.length <= got.src.length) {
      return { src: '', out: '', rest: text };
    }
    let src = got.src;
    let rest = text.slice(src.length);
    // Пробел после точки — часть закреплённого начала, а не хвоста: подавать
    // переводчику строку, начинающуюся пробелом, значит просить перевести не
    // фразу, а отступ.
    const gap = rest.match(/^\s+/);
    if (gap) { src += gap[0]; rest = rest.slice(gap[0].length); }
    if (!rest) return { src: '', out: '', rest: text };
    return { src, out: got.out, rest };
  }

  /** Склеить перевод закреплённого начала с переводом хвоста. */
  join(out, restOut) {
    if (!out) return restOut;
    if (!restOut) return out;
    return out + glue(out, restOut) + restOut;
  }

  /**
   * Запомнить перевод законченных предложений хвоста.
   *
   * @param {number|string|null} line строка ленты
   * @param {string} src закреплённое начало (из split)
   * @param {string} out его перевод
   * @param {string} rest что переводили сейчас
   * @param {string} restOut что вышло
   */
  learn(line, src, out, rest, restOut) {
    if (line == null || !rest || !restOut) return;
    const a = sentences(rest);
    const b = sentences(restOut);
    // Предложений поровну — значит перевод режется там же, где источник, и
    // закреплённому началу можно верить. Не поровну (переводчик слил две фразы
    // в одну или наоборот) — оставляем как было: лучше перевести лишнее, чем
    // склеить не то.
    if (!a.count || a.count !== b.count) return;
    this.lines.set(line, { src: src + a.done, out: this.join(out, b.done) });
    // Лента уезжает, номера растут; держим последние.
    if (this.lines.size > this.max) {
      for (const k of this.lines.keys()) {
        if (this.lines.size <= this.max) break;
        this.lines.delete(k);
      }
    }
  }

  /** Забыть строку: её переписали целиком. */
  drop(line) {
    if (line != null) this.lines.delete(line);
  }

  clear() {
    this.lines.clear();
  }
}
