// Журнал субтитров: копия в буфер обмена и автосохранение в файл.
//
// Ведёт его фоновый скрипт, а не панель. Панель переезжает за значком на
// другую вкладку (это новый документ), её закрывают, а перевод и плашка идут
// дальше. Журнал в панели жил её жизнью: переехала — копия начиналась заново,
// а в файл не писалось, пока в новой панели не щёлкнут. Теперь строки лежат в
// session-хранилище: переживают и панель, и усыпление воркера, а перезапуск
// браузера или расширения их стирает — копия после него пустая, как и должна.
//
// Текст режем кусками ровно по CHUNK знаков: кусок i — знаки [i·CHUNK,
// (i+1)·CHUNK) журнала, дописывается только последний. Старые куски уходят
// целиком, когда журнал длиннее MAX.
import { feed, fix } from './cues.js';

const CHUNK = 1 << 16;
// Около 4 млн знаков — десятки часов речи; у session-хранилища всего 10 МБ.
const MAX = 4 << 20;
const key = (i) => `j${i}`;
const S = () => chrome.storage.session;

/**
 * {first, len, sessionAt, t0, started}: первый живой кусок, длина журнала, где
 * начался последний сеанс и когда (t0 = 0 — сеанс кончился, started остаётся:
 * по нему назван файл сеанса).
 */
export const journalMeta = () => S().get('jmeta')
  .then((r) => r.jmeta || { first: 0, len: 0, sessionAt: 0, t0: 0, started: 0 });

/** Журнал от смещения from до конца: { text, to }. */
export async function journalSlice(from) {
  const m = await journalMeta();
  from = Math.max(from, m.first * CHUNK);
  if (from >= m.len) return { text: '', to: Math.max(from, m.len) };
  const a = Math.floor(from / CHUNK), b = Math.floor((m.len - 1) / CHUNK);
  const keys = [];
  for (let i = a; i <= b; i++) keys.push(key(i));
  const got = await S().get(keys);
  // Кусок мог дорасти между двумя чтениями: берём ровно до длины из meta.
  const text = keys.map((k) => got[k] || '').join('').slice(from - a * CHUNK, m.len - a * CHUNK);
  return { text, to: m.len };
}

const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return (hh ? `${hh}:` : '') + `${two(mm)}:${two(ss)}`;
};
/** Заголовок сеанса. */
const head = (t0) => {
  const d = new Date(t0);
  return `--- ${d.toLocaleDateString()} ${d.toLocaleTimeString()} ---\n\n`;
};
/**
 * Строка ленты: время от начала сеанса; оригинал — когда его показывают, файл
 * повторяет экран. Оригинал в квадратных скобках: по одному отступу его от
 * перевода было не отличить.
 */
const fmt = (c, t0, dual) => {
  const at = `[${clock((c.at ?? t0) - t0)}] `;
  return dual && c.orig
    ? `${at}[${c.orig}]\n${' '.repeat(at.length)}${c.text}\n`
    : `${at}${c.text}\n`;
};

/**
 * Лента журнала по тем же feed/fix, что у панели. Устоявшаяся строка — та, под
 * которой лежат ещё две: глубже лента не меняется, и строка уходит в журнал
 * ровно раз и уже в окончательном виде.
 *
 * @param {() => boolean} dual показывать ли оригинал (настройка og)
 */
export function journal(dual) {
  // t0 — начало текущего сеанса (0 — сеанса нет); с прошлой жизни воркера берём из meta.
  let cues = [], chain = Promise.resolve(), t0 = 0;
  const ready = journalMeta().then((m) => { t0 = m.t0; }, () => {});

  /** Дописать текст; open — время начала нового сеанса, close — сеанс кончился. */
  const append = (text, open = 0, close = false) => (chain = chain.then(async () => {
    const m = await journalMeta();
    if (open) { m.sessionAt = m.len; m.t0 = m.started = open; }
    if (close) m.t0 = 0;
    const put = { jmeta: m };
    let i = Math.floor(m.len / CHUNK);
    let cur = m.len % CHUNK ? (await S().get(key(i)))[key(i)] || '' : '';
    for (let rest = text; rest;) {
      const n = CHUNK - cur.length;
      cur += rest.slice(0, n);
      rest = rest.slice(n);
      put[key(i)] = cur;
      if (cur.length === CHUNK) { i++; cur = ''; }
    }
    m.len += text.length;
    const drop = [];
    while (m.len - m.first * CHUNK > MAX) drop.push(key(m.first++));
    await S().set(put);
    if (drop.length) await S().remove(drop);
  }).catch((e) => console.warn('журнал не дописан:', e)));

  // Хвост — строки, которые ещё могут перемениться: в журнал их рано, а на
  // экране они уже стоят. Автосохранение дописывает его в файл поверх журнала,
  // иначе файл отставал от плашки на две строки, а в паузе или под музыкой —
  // на всё сказанное до неё: строку журнал берёт, только когда под ней две.
  let tailText = null;
  const tail = (text) => {
    if (text === tailText) return;
    tailText = text;
    // В той же очереди, что и журнал: строка, ушедшая из хвоста, не должна
    // пропасть из файла, пока журнал её ещё не дописал.
    const started = t0;
    chain = chain.then(() => S().set({ jtail: { started, text } })).catch(() => {});
  };

  /** Сеанс начинается первой строкой с текстом: заголовок — сразу. */
  function open() {
    if (t0 || !cues.some((c) => c.text)) return;
    t0 = cues.find((c) => c.text).at ?? Date.now();
    append(head(t0), t0);
  }

  function settle(all = false) {
    const end = all ? cues.length : cues.length - 2;
    let out = '', rest = '';
    open();
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (c.saved || !c.text) continue;
      if (i < end) { c.saved = true; out += fmt(c, t0, dual()); } else rest += fmt(c, t0, dual());
    }
    if (out) append(out);
    tail(rest);
  }

  return {
    /** Реплика offscreen, как её получает лента панели (take в sidepanel.js). */
    take: (msg) => ready.then(() => {
      const ph = msg.phrase ?? 0;
      const cue = {
        from: ph, to: msg.endPhrase ?? ph, line: msg.line ?? null, growing: !!msg.growing,
        text: msg.translated || msg.original, orig: msg.translated ? msg.original : '',
        open: !!msg.open, exact: !msg.partial, lag: msg.lag, cont: !!msg.cont
      };
      if (!(msg.partial ? feed(cues, cue, 24) : fix(cues, cue))) return;
      // Время строки — миг первого показа; растущая строка его не меняет.
      const now = Date.now();
      for (let i = Math.max(0, cues.length - 2); i < cues.length; i++) cues[i].at ??= now;
      settle();
    }),
    /** Сеанс кончился: дописать всё, живую строку тоже, и закрыть его. */
    async end() {
      await ready;
      settle(true);
      cues = [];
      if (t0) { t0 = 0; append('\n', 0, true); }
      tail('');
      await chain;
    },
    /** Вся расшифровка для копии: журнал и ещё не устоявшиеся строки. */
    async text() {
      await ready;
      await chain;
      let { text } = await journalSlice(0);
      let at = t0;
      for (const c of cues) {
        if (c.saved || !c.text) continue;
        if (!at) text += head(at = c.at ?? Date.now());
        text += fmt(c, at, dual());
      }
      return text;
    }
  };
}
