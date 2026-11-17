// Словари переводчика Chrome: общее у фона (createPack), offscreen и панели
// (workerPack, panelPack).
//
// Наше дело — заметить, что сети нет или загрузка идёт слишком долго. Тогда
// сбой и кнопка «Try again»: повторяет зритель, сами не повторяем.

// Сети нет: загрузка молчит или create() упал без сети (cutCreate, createPack).
export const PACK_OFFLINE = 'offline';
// Ход загрузки у Chrome — только 0 и 1 (07.11, Opera 138: пакет cs 0.6 с и
// 5.6 с, th на медленной сети 140 с между ними), так что обрыв виден только
// пробой сети (reach): событий нет и у страницы — с docker и tailscale ни
// offline, ни connection change (стенд, Wi-Fi выключен). Загрузка молчит
// PACK_QUIET_MS — смотрим сеть, дальше с шагом до PACK_NET_STEP_MS.
const PACK_QUIET_MS = 3000;
const PACK_NET_STEP_MS = 5000;
// Срок загрузки: дольше — сеть слишком медленная. Короче пяти минут, за
// которые Chrome гасит воркер, занятый одним событием: ответ WARM_PACK ждёт
// всё задание createPack.
export const PACK_STALL_MS = 4 * 60 * 1000;

// Сеть по факту. navigator.onLine врёт: при живых docker0, tailscale0, virbr0
// он true и без Wi-Fi, а offline и online не приходят вовсе (07.11, Opera
// пользователя), в воркере же на возврате сети он отстаёт. Ответил сервер
// Google (с него же Chrome качает пакеты) — сеть есть; без ответа за ms (обрыв
// выше роутера) — нет.
const PROBE_URL = 'https://www.gstatic.com/generate_204';
export async function reach(ms = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    await fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ac.signal });
    return true;
  } catch { return false; } finally { clearTimeout(timer); }
}

/**
 * create() словаря Chrome. Загрузка молчит — смотрим сеть по факту (reach):
 * нет — отказ PACK_OFFLINE. Не кончился к until (по умолчанию PACK_STALL_MS)
 * — обычный отказ. Брошенный create() не ждём.
 *
 * @param hold (look | null) => void — проверить сеть сейчас, пока create()
 *   идёт: страница услышала offline (NET_OFF фона, offline панели)
 * @param cuttable false — натив Android: качает сам и повторяет, сеть не
 *   смотрим и срока не ставим
 */
export async function cutCreate(T, pair, { hold, cuttable = true, until = Date.now() + PACK_STALL_MS }) {
  let stall = () => {}, over = false, probe, ceil;
  const made = T.create({ ...pair, monitor: (m) => m.addEventListener('downloadprogress', () => stall()) });
  const stop = () => { over = true; clearTimeout(probe); clearTimeout(ceil); stall = () => {}; hold(null); };
  try {
    return await Promise.race([made, new Promise((_, no) => {
      // Брошенный create(), если всё же вернётся, гасим: словарь при этом на
      // диске — «готово» о нём скажет сам create() обёртки (hostCreate).
      const drop = (why) => { stop(); made.then((t) => t?.destroy?.(), () => {}); no(new Error(why)); };
      // Ход загрузки (seen) отменяет пробу, начатую до него.
      let seen = 0;
      const look = async (ms) => {
        const at = seen;
        const on = await reach();
        if (over || at !== seen) return;
        if (!on) return drop(PACK_OFFLINE);
        // Проба по NET_OFF (hold) и по таймеру могли идти разом: цепочка одна.
        clearTimeout(probe);
        probe = setTimeout(look, Math.min(ms * 2, PACK_NET_STEP_MS), ms * 2);
      };
      stall = () => {
        seen++;
        clearTimeout(probe);
        if (cuttable) probe = setTimeout(look, PACK_QUIET_MS, PACK_QUIET_MS);
      };
      hold(cuttable ? () => { if (!over) look(500); } : null);
      stall();
      if (cuttable) ceil = setTimeout(drop, Math.max(0, until - Date.now()), 'language pack download is too slow');
    })]);
  } finally { stop(); }
}

/** availability() со сроком: у форков он бывает молчит — тогда, как и сбой, 'failed'. */
export async function canPair(T, pair) {
  let timer;
  try {
    return await Promise.race([T.availability(pair), new Promise((r) => { timer = setTimeout(r, 10 * 1000, 'failed'); })]);
  } catch { return 'failed'; } finally { clearTimeout(timer); }
}

/**
 * Translator браузера выключен целиком. Опера с WebAI (27.10.2026, Windows и
 * Mac) отдала его своей модели, а та по умолчанию выключена (Settings → Opera
 * AI → Enable Web AI API): API на месте, но на любую пару unavailable — 08.11
 * Opera 139 на Windows «не умею переводить с …» на всех языках. Так же
 * отвечает и Chrome под политикой TranslatorAPIAllowed=false. Такой браузер —
 * без переводчика: переводит bergamot, как Опера без API на Linux. Спрашиваем
 * en→es: её Chrome знает всегда, отказ на ней — не про пару. Отказ на
 * отдельной паре по-прежнему честная ошибка. Ответ один на страницу, но
 * запоминается сам ответ, а не вопрос: у форков availability() бывает
 * молчит, и повтор (offscreen, раз в MT_RECHECK_MS) спрашивает заново.
 *
 * @returns {Promise<boolean>}
 */
let off;
export async function translatorOff() {
  const T = self.Translator;
  if (!T || T.native) return false;
  if (off != null) return off;
  // Первый ответ окончателен: параллельная проба его не перепишет.
  const can = await canPair(T, { sourceLanguage: 'en', targetLanguage: 'es' });
  // Молчит или падает — не ответ: не запоминаем, спросим снова.
  if (can === 'failed') return false;
  return off ??= can === 'unavailable';
}

/** Статус нескачанной пары по ошибке загрузки: offline или failed. */
export const packFailure = (e) => e?.message === PACK_OFFLINE ? 'offline' : 'failed';

/**
 * Страница говорит фону, что сеть пропала (событие offline): в воркере
 * Chromium своего нет, и его загрузки (NET_OFF) смотрят сеть сразу.
 */
export function watchNet() {
  addEventListener('offline', () => chrome.runtime.sendMessage({ type: 'NET_OFF' }).catch(() => {}));
}

/**
 * Скачать словарь Chrome фоном (WARM_PACK): в воркере create() жеста не
 * требует. Сеть и срок решает фон.
 *
 * @returns {Promise<boolean>} false — в воркере форка нет Translator: качать
 *   пару странице самой
 */
export async function workerPack(from, to) {
  const r = await chrome.runtime.sendMessage({ type: 'WARM_PACK', from, to }).catch(() => null);
  if (r?.ok) return true;
  if (r?.error === 'no Translator') return false;
  throw new Error(r?.error || `pair ${from}>${to}: background did not answer`);
}
