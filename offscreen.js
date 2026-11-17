// Offscreen-документ — единственное место в MV3, где есть Web Audio.
// Здесь: захват звука, границы фраз, распознавание и перевод.
//
// Распознаёт одна модель — потоковая nemotron (live-worker.js): звук течёт в
// неё непрерывно, и слово выходит на экран примерно через секунду после того,
// как прозвучало. Оконных моделей, которые ждут конца фразы и считают её
// целиком, больше нет: их текст приходил через пять, десять, двадцать пять
// секунд, а субтитры, которых надо столько ждать, никто не читает.
//
// Из chrome.* тут доступен только chrome.runtime, поэтому всё наружу уходит
// сообщениями в service worker.

import { Segmenter } from './lib/segmenter.js';
import { splitWord } from './lib/carry.js';
import { unloop } from './lib/repeat.js';
import { digits } from './lib/numerals.js';
import { unfill } from './lib/fillers.js';
import { DEFAULT_DRAFT, draftFor, findModel } from './lib/models.js';
import { sodaStreamer } from './lib/soda.js';
import { mtCode, TARGET_CODES } from './lib/languages.js';
import { Translator, downloads, race, PAGE } from './lib/firefox-mt.js';
import { guessLang, labelFits } from './lib/guesslang.js';
import { SentenceCache, sentences } from './lib/mt-cache.js';
import { words } from './lib/cues.js';
import { PACK_OFFLINE, canPair, packFailure, workerPack, watchNet, reach } from './lib/packs.js';
import { polish } from './lib/seam.js';

const SAMPLE_RATE = 16000;

let stream = null, ctx = null, tap = null, playback = null;
let segmenter = null;
let cfg = { draft: DEFAULT_DRAFT, source: 'auto', target: 'ru' };

// Номер фразы: растёт на каждой границе, которую нашёл сегментатор. По нему
// поток понимает, к какой строке ленты относится закрытый текст.
let phrase = 0;
// Сколько звука доехало из ворклета — и доехал ли он вообще.
//
// На прогоне 33 весь конвейер замолчал на двадцатой секунде ролика, и снаружи
// было не отличить «сегментатор придержал звук» от «звук перестал
// приходить». Считаем отсчёты на входе, а рядом — часы самого графа: если
// currentTime дошёл до конца ролика, а отсчётов набралось на двадцать секунд,
// значит ворклет крутился вхолостую и пропала дорожка; если встали оба —
// встал сам звуковой граф.
const fed = { chunks: 0, samples: 0, firstAt: 0, lastAt: 0, gaps: 0 };

// Отладочный слепок захваченного звука. Нужен ровно для одного вопроса:
// насколько звук, доехавший до нас, отстаёт от того, что в этот момент играет
// плеер. Ответ не вывести ни из счётчиков, ни из частоты — она ровно 16 кГц
// в любом случае, — его даёт только сверка самой волны с исходным файлом.
// Включается ключом tapDump в chrome.storage.local, в обычной работе мёртв.
const tapDump = { want: 0, buf: null, n: 0, sent: false, at: 0 };

// Сколько распознанных текстов прямо сейчас переводится и уходит наружу.
// Пустая очередь — ещё не конец работы: перевод асинхронный.
let inflight = 0;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
// Статус несёт номер сеанса: опоздавший статус прошлого сеанса (воркер дослал
// «loading» уже после стопа) фон отбрасывает, а не кладёт поверх «выключено».
const status = (patch) => send({ type: 'ASR_STATUS', token: сеанс, ...patch });
/**
 * Сеанс умер сам: модель отвалилась, звук вкладки кончился, запуск не вышел.
 * Фон снимает сеанс и показывает ошибку. Без этого сеанс оставался числиться
 * идущим, и клик по значку на той же вкладке не делал ничего («уже слушаем»):
 * у зрителя ошибка, и выхода из неё, кроме кнопки в панели, нет.
 */
// again — сломалось не по вине зрителя, и фон поднимает сеанс сам (revive в
// background.js); 'fresh' — с новым документом: этот повис.
function умер(error, token = сеанс, again = false) {
  if (!token) return;
  send({ type: 'SESSION_DEAD', token, error: String(error), again });
}

// --- Перевод встроенным в Chrome движком -------------------------------------

const translators = new Map();
// Номер сеанса: новый сеанс или новая цель. По нему пара на bergamot снова
// просит словарь Chrome (either).
let sessionGen = 0;

/**
 * Что из каждой строки ленты уже переведено.
 *
 * Живая строка набирается словами, и до сих пор при каждом новом слове в
 * переводчик уходила вся строка заново. Перевод линеен по длине (83 мс до
 * десяти слов, 335 на двадцати с лишним), и платилось это дважды: задержкой
 * строки и выброшенными снимками — пока перевод идёт, следующий не делается
 * (partialBusy). Законченные предложения переводятся один раз, см. lib/mt-cache.js.
 */
const mtCache = new SentenceCache();

// Пары, у которых готовый инстанс только что упал: пересобирать его чаще, чем
// раз в MT_COOLDOWN_MS, не даём — иначе при стойком отказе модели Chrome
// create() звался бы по разу на строку (несколько в секунду). Обычный сбой
// лечится первой же пересборкой и до cooldown не доходит.
const mtCooldown = new Map();
// Пары, у которых в этом сеансе (sessionGen) Chrome падал и на свежем инстансе:
// их переводит bergamot до следующего сеанса.
const chromeBroke = new Map();
const MT_COOLDOWN_MS = 4000;
// Сколько раз за сеанс пришлось выбросить умерший инстанс переводчика и собрать
// заново. Наружу — чтобы отличить «перевод шёл гладко» от «инстанс падал, но
// пересборка вытащила»: без счётчика это неотличимо (отказ перемежающийся).
let mtResets = 0;

// Пары, которые не скачались: ключ → когда. Сами заново не качаем — повтор
// за зрителем (кнопка в панели или новый выбор языка). Но раз в MT_RECHECK_MS
// смотрим в кеш: панель могла докачать пару сама, и перевод тогда идёт дальше
// без перезапуска сеанса.
const mtFailed = new Map();
const MT_RECHECK_MS = 3000;
// Сколько ждать create() пары, словарь которой уже на диске.
const CREATE_WAIT_MS = 30 * 1000;
// Сколько ждать availability() и translate() переводчика Chrome: зависший
// вызов иначе держал бы перевод (он один в полёте) и экран до конца сеанса.
const MT_CALL_MS = 10 * 1000;
// Пары, которые Chrome назвал неподдержанными: если позже он передумает
// (сервис перевода был занят), повторная проверка их снова соберёт.
const mtUnsupported = new Set();
// Пары, чья загрузка не вышла, → их статус (failed, offline): отказ
// показываем снова, когда речь к ним вернулась.
const mtLost = new Map();
// Пары, чей словарь сейчас качается (ring в makeTranslator): только им
// checkPack возвращает кольцо, а не всякой недособранной паре.
const mtFetching = new Set();
// Пары, чей словарь (движок Firefox) ждёт сети: так говорит сам загрузчик
// (offline в канале), до следующего хода загрузки.
const mtWaitNet = new Set();
// В воркере фона событий сети нет: offline ему шлёт страница (NET_OFF даёт его
// загрузкам словарей «нет интернета» сразу, без молчания загрузки).
watchNet();
// Ход загрузок всех страниц. Пару докачали (Retry в панели, клик по значку):
// отказ проверяем на ближайшей же строке, а не через MT_RECHECK_MS. Движок
// Firefox ждёт сети — «нет интернета», пошёл дальше — снова кольцо.
new BroadcastChannel('translator-mt').onmessage = ({ data }) => {
  if (!data?.from) return;
  const key = `${data.from}>${data.to}`;
  if (data.offline) {
    mtWaitNet.add(key);
    if (packKey === key && packCan === 'downloading') packStatus(data.from, data.to, 'offline');
    return;
  }
  mtWaitNet.delete(key);
  if (data.loaded != null && packKey === key && packCan === 'offline') packStatus(data.from, data.to, 'downloading');
  if (!data.done) return;
  // Пара на диске: отказ снят, следующая строка соберёт её (makeTranslator).
  // На availability() тут не полагаемся: скачанную пару, которой эта страница
  // не создавала, Chrome может назвать downloadable, если её языков нет в
  // accept-languages (translation_manager_impl.cc, mask_readily_result).
  mtFailed.delete(key);
  mtLost.delete(key);
  mtFetching.delete(key);
  // Словарь Chrome докачан мимо either (Retry панели, фон после срока), а пару
  // ведёт bergamot: переходим на Chrome сейчас, не в следующем сеансе. Свой
  // create() — не повод: опоздавший сверх CREATE_WAIT_MS звал бы again по кругу.
  if (data.chrome && data.chrome !== PAGE) translators.get(key)?.then((t) => t.again?.(true), () => {});
  // Её кольцо или отказ больше не правда. Собирается сейчас — статус снимет
  // сама сборка.
  if (packKey === key && !translators.has(key)) packStatus();
};
// Сколько раз подряд create() падал на паре, которая уже на диске. С
// MT_FAILS_SHOWN раз — ошибка с повтором в панели, а не молчаливый оригинал.
const createFails = new Map();
const MT_FAILS_SHOWN = 3;

/** Обещание со сроком: не успело — исключение why. */
function deadline(p, ms, why) {
  let timer;
  return Promise.race([p, new Promise((_, no) => { timer = setTimeout(no, ms, new Error(why)); })])
    .finally(() => clearTimeout(timer));
}
// Пары, у которых переводчик готов: пока пара качается, строки идут оригиналом,
// а не ждут загрузки (на десятках мегабайт это секунды и минуты).
const mtReady = new Set();
// Пара, про которую сейчас статус pack в панели (кольцо загрузки или ошибка).
// Под «авто» первая догадка о языке бывает ложной (английский назван «uk»):
// когда новый язык речи устоялся, кольцо прошлой пары снимает checkPack.
let packKey = '', packCan = '';
/**
 * Язык речи ещё не устоялся, а качается другая пара. Под «авто» модель метит
 * русскую речь чужим языком на фразу-другую: такая метка не просит свой
 * словарь и не перехватывает кольцо, иначе баннер закрывался и тут же
 * открывался снова с пустым кольцом (жалоба 30.10, в 0.8.15 такого не было).
 * Ждём, пока метка продержится LANG_SETTLE_MS: считать сообщения нельзя, липкая
 * метка едет в каждом live и closed, и вторая приходила через 0.3 с. Без метки
 * модели (язык от детектора) не ждём: там liveLang пуст.
 */
const LANG_SETTLE_MS = 2000;
let liveSince = 0, liveSettled = true;
function shaky(key) {
  return cfg.source === 'auto' && !!liveLang && !liveSettled
    && (packCan === 'downloading' || packCan === 'offline') && packKey !== key;
}
function packStatus(from, to, can) {
  // Сеанс погашен: поздний ответ его загрузки — уже ничей (stop снял статус).
  if (from && !сеанс) return;
  packKey = from ? `${from}>${to}` : '';
  packCan = from ? can : '';
  // at — когда: статус старше «готово» пары панель сочтёт запоздалым.
  status({ pack: from ? { from, to, can, at: Date.now() } : null });
}

// Собрать переводчик пары и положить обещание в кеш. Пары нет на диске — она
// качается тут же (словарь Chrome — фоном, workerPack); панель видит это
// статусом pack и рисует кольцо, а не скачалась — ошибку с повтором. Ошибку
// создания кеш не держит — чистится, чтобы следующий вызов попробовал заново.
function makeTranslator(source, target) {
  const key = `${source}>${target}`;
  // Статус pack один на панель и про текущую пару: пара, брошенная сменой
  // цели или языка речи, докачивается молча: её ошибка не про текущий выбор.
  const mine = () => target === cfg.target && source === sourceLang();
  const pair = { sourceLanguage: source, targetLanguage: target };
  const p = (async () => {
    // Молчащий или падающий availability() — как «пары нет» ('failed').
    const can = await canPair(Translator, pair);
    const no = can === 'unavailable' || can === 'failed';
    // Пары нет: повтор раз в MT_RECHECK_MS и ошибка с повтором в панели, а не
    // оригинал без объяснений. Ответа не было вовсе ('failed') — при повторе
    // пару собираем заново на любом ответе, кроме unavailable (как
    // неподдержанную): downloadable иначе ждал бы Retry, а его в Opera нет.
    const refuse = (e) => {
      mtFailed.set(key, performance.now());
      mtUnsupported.add(key);
      if (mine()) packStatus(source, target, can);
      throw e;
    };
    // Без Translator.gesture переводчик один (bergamot, натив телефона): его «нет» — отказ.
    if (no && !Translator.gesture) refuse(new Error(`pair ${key} is not supported`));
    // Кольцо — только пока что-то качается (downloads): иначе мигнуло бы.
    const ring = async (chromeWill) => {
      if (!await downloads(pair, chromeWill)) return;
      mtFetching.add(key);
      if (mine()) packStatus(source, target, 'downloading');
    };
    if (can !== 'available') await ring(can !== 'unavailable');
    // Словарь Chrome: здесь create() без жеста не качает (NotAllowedError), а
    // воркер фона качает и без жеста. В воркере форка API нет — create()
    // ниже соберёт пару, если она на диске, иначе ошибка с повтором, и
    // докачает её панель под жестом кнопки.
    // Без сети create() здесь пару и не скачал бы: «нет интернета».
    // Словарь на диске (available или докачал фон): create() качать нечего,
    // и дольше CREATE_WAIT_MS он не идёт, а висит — у форков бывает вечным.
    // По сроку — ошибка с повтором, а не вечная тишина. Просроченный, если
    // всё же вернётся, гасим.
    const chromeMade = async (fetchFirst) => {
      if (fetchFirst && !await workerPack(source, target) && !await reach()) throw new Error(PACK_OFFLINE);
      const made = Translator.create(pair);
      let timer;
      try {
        // Опоздавший create() — тот же Chrome, словарь на диске: его берёт either
        // (late), а гасит тот, кому он уже не нужен (сбой обоих, dead).
        return await Promise.race([made, new Promise((_, no) => { timer = setTimeout(() => {
          no(Object.assign(new Error('Chrome translator did not respond'), { late: made }));
        }, CREATE_WAIT_MS); })]);
      } finally { clearTimeout(timer); }
    };
    // Chrome пары: на диске — собрать, нет — скачать фоном и собрать. Спрашивает
    // сам: его зовут и позже (again), когда ответ availability мог смениться.
    const chrome = async () => {
      if (chromeBroke.get(key) === sessionGen) throw new Error(`Chrome translator broke on ${key}`);
      const now = await canPair(Translator, pair);
      if (now === 'failed') throw new Error('Chrome translator did not respond');
      if (now === 'unavailable') throw new Error(`pair ${key} is not supported`);
      return chromeMade(now !== 'available');
    };
    let t;
    try {
      if (!Translator.gesture) t = await Translator.create(pair);
      // Готовый Chrome упал — bergamot качается: кольцо, как у недокачанной пары.
      else t = await either(pair, chrome, can === 'available', () => ring(false));
    } catch (e) {
      e?.late?.then((x) => x?.destroy?.(), () => {});
      // Не вышло у обоих, а Chrome пары не знает — отказ «пары нет».
      if (no) refuse(e);
      // Пара на диске — сбой не загрузки (ниже); иначе причину несёт ошибка.
      const why = can === 'available' ? '' : packFailure(e);
      // Сети нет (до загрузки или посреди неё): «нет интернета», строки
      // оригиналом; повтор — кнопкой зрителя.
      if (why === 'offline') {
        mtFailed.set(key, performance.now());
        mtUnsupported.delete(key);
        mtLost.set(key, 'offline');
        if (mine()) packStatus(source, target, 'offline');
        else if (packKey === key) packStatus();
        throw e;
      }
      // Пара на диске, а create() упал — сбой не загрузки, а переводчика Chrome:
      // откат, как у пересборки в translate, а не ошибка загрузки в панели.
      // Падает раз за разом — зритель видит ошибку с повтором, а не оригинал
      // без объяснений; откат при этом идёт дальше и сам снимет её удачей.
      if (can === 'available') {
        mtCooldown.set(key, performance.now() + MT_COOLDOWN_MS);
        const n = (createFails.get(key) || 0) + 1;
        createFails.set(key, n);
        if (n >= MT_FAILS_SHOWN && mine()) packStatus(source, target, 'failed');
        else if (packKey === key && n < MT_FAILS_SHOWN) packStatus();
        throw e;
      }
      // Пара не докачалась (сеть слишком медленная, сбой Chrome): ошибка с
      // повтором, повтор — кнопкой зрителя.
      mtFailed.set(key, performance.now());
      mtUnsupported.delete(key);
      mtLost.set(key, 'failed');
      if (mine()) packStatus(source, target, 'failed');
      // Брошенная пара: её кольцо могло остаться (смена языка его не гасит).
      else if (packKey === key) packStatus();
      throw e;
    }
    // Пара на диске: кольцо снимаем сразу, как и панель, а не после warm.
    if (packKey === key) packStatus();
    mtFetching.delete(key);
    // Свой движок (Firefox) — в память до первой строки, см. warm(). Без срока:
    // упавший воркер отклоняет вызов сам (fail в firefox-mt.js), а пара,
    // отпущенная до конца загрузки, ждала бы её первой строкой.
    if (t.warm) await t.warm().catch(() => {});
    createFails.delete(key);
    mtReady.add(key);
    return t;
  })().catch(e => {
    translators.delete(key); mtReady.delete(key); mtFetching.delete(key);
    send({ type: 'DIAG', e: `mt ${key}: ${e?.message || e}` });
    throw e;
  });
  translators.set(key, p);
  return p;
}

/**
 * Переводит Chrome, если его словарь готов, иначе bergamot (race в
 * firefox-mt.js: оба качаются, берём готового первым). Chrome готов позже —
 * следующие строки идут в Chrome, bergamot пары выгружен и удалён. Chrome не
 * вышел (застрял, сеть, срок, пары не знает, сломан) — переводит bergamot без
 * ошибки, а Chrome просим снова на первой строке пары в следующем сеансе
 * (again, sessionGen) или сразу, как фон докачал его словарь (again(true)).
 *
 * ready — словарь Chrome на диске: bergamot не качаем, пока Chrome не упал;
 * упал — fallback() (кольцо) и гонка с его же ошибкой, она и уйдёт наружу.
 */
async function either(pair, chrome, ready, fallback) {
  let broke, asked = false;
  // Готовый Chrome уже упал: гонке первым ответом идёт этот отказ, повтором
  // (словарь докачали мимо гонки) — настоящий chrome().
  const after = () => asked ? chrome() : (asked = true, Promise.reject(broke));
  let first = ready ? await chrome().then((t) => ({ chrome: t }), (e) => { broke = e; return null; }) : null;
  if (!first) {
    if (ready) await fallback?.();
    first = await race(pair, ready ? after : chrome);
  }
  // Словарь Chrome готов: bergamot пары стёр сам его create() (hostCreate).
  if (first.chrome) return first.chrome;
  let cur = first.ff, dead = false, onChrome = false;
  const w = {
    again: null,
    translate: (s) => cur.translate(s),
    // Переводит уже Chrome (а не bergamot): его сбой — сбой Chrome.
    get onChrome() { return onChrome; },
    warm: async () => cur.warm?.(),
    destroy() { dead = true; w.again = null; cur.destroy?.(); }
  };
  // Chrome готов — переходим на него один раз; лишний (опоздавший и новый оба) гасим.
  const wait = (later) => later.then(async (c) => {
    if (dead || onChrome) return void c.destroy?.();
    onChrome = true;
    w.again = null;
    const old = cur;
    cur = c;
    // Замки пар отпущены — словарь bergamot стирает сам destroy (маршрут
    // снял forget того, кто собрал Chrome).
    await old.destroy?.();
  }, (e) => {
    // Chrome опоздал к сроку: ждём и его, но повтор взводим как обычно — у
    // форков опоздавший create() бывает не возвращается вовсе.
    if (e?.late) wait(e.late);
    const gen = sessionGen;
    if (!dead && !onChrome) w.again = (now) => {
      if (!now && gen === sessionGen) return;
      w.again = null;
      wait(chrome());
    };
  });
  wait(first.later);
  return w;
}

async function translate(text, source, target) {
  // Пустой source — «модель ещё не назвала язык»: переводить не с чего, и
  // спрашивать у Chrome пару ' >ru' значит получить исключение на каждой
  // строке до первой метки.
  if (!text || !source || source === target) return null;

  const key = `${source}>${target}`;
  // Пара не скачалась: оригинал, пока зритель не повторит. Раз в несколько
  // секунд — взгляд в кеш: докачанная панелью пара снимает отказ.
  const failedAt = mtFailed.get(key);
  if (failedAt != null) {
    if (performance.now() - failedAt < MT_RECHECK_MS) return null;
    mtFailed.set(key, performance.now());
    const can = await canPair(Translator, { sourceLanguage: source, targetLanguage: target });
    // Неподдержанная пара, которую Chrome теперь знает, собирается заново
    // (докачает её makeTranslator); скачанная с отказом ждёт повтора зрителя.
    const back = mtUnsupported.has(key) && can !== 'unavailable' && can !== 'failed';
    if (can !== 'available' && !back) return null;
    mtFailed.delete(key);
    mtUnsupported.delete(key);
    mtLost.delete(key);
    // Отказ снят: и из статуса, иначе панель так и показывала бы ошибку.
    if (packKey === key) packStatus();
  }
  // Пара в откате: готовый инстанс недавно падал, и пересобранный тоже не смог —
  // отказ переводчика Chrome затяжной. Пока окно не истекло, create() не трогаем
  // вовсе (иначе собирали бы инстанс на каждую строку, несколько в секунду,
  // добивая и без того перегруженную память), а строку отдаём оригиналом. По
  // истечении окна одна строка снова пробует пересобрать.
  if ((mtCooldown.get(key) || 0) > performance.now()) return null;
  if (!translators.has(key)) {
    if (shaky(key)) return null;
    makeTranslator(source, target).catch(() => {});
  }
  // Качается — строка уходит оригиналом, перевод начнётся со следующих.
  if (!mtReady.has(key)) return null;

  let t;
  const cur = translators.get(key);
  try {
    t = await cur;
    // Пара на bergamot, а Chrome в прошлом сеансе не докачал: просим снова.
    t.again?.();
    return await deadline(t.translate(text), MT_CALL_MS, 'Chrome translator did not respond');
  } catch (e) {
    // Переводчик Chrome иногда роняет ГОТОВЫЙ инстанс: «Other generic failures
    // occurred.» После этого инстанс мёртв насовсем — каждая следующая строка
    // падает той же ошибкой, и зритель до конца сеанса читает оригинал (это и
    // был баг «стоит русский, а на экране английский»: свежесозданный инстанс в
    // том же offscreen ту же строку переводит верно — доказано probe-translator).
    // Битый инстанс выбрасываем и пересобираем прямо здесь, чтобы и ЭТА строка
    // ушла переведённой, а не только следующая.
    // Пару уже пересобирает другая строка (упали обе разом) — не трогаем.
    if (translators.get(key) !== cur) return null;
    try { t.destroy?.(); } catch {}
    translators.delete(key);
    // Пока пара пересобирается, строки идут оригиналом, а не ждут сборку в очереди.
    mtReady.delete(key);
    status({ mtResets: ++mtResets });
    const next = makeTranslator(source, target);
    let fresh;
    // Свежий не собрался за срок строки (Chrome упал и на create(), качается
    // bergamot) — эта строка оригиналом, следующие возьмут его, когда готов.
    try { fresh = await deadline(next, MT_CALL_MS, 'Chrome translator did not respond'); } catch { return null; }
    try {
      return await deadline(fresh.translate(text), MT_CALL_MS, 'Chrome translator did not respond');
    } catch (e2) {
      // И свежий инстанс не смог — отказ не разовый. Пару уже пересобирает
      // другая строка — она же и добила свежий. Иначе добиваем сами, чтобы не
      // держал сессию Chrome.
      if (translators.get(key) !== next) return null;
      try { fresh.destroy?.(); } catch {}
      translators.delete(key);
      mtReady.delete(key);
      // Сломан Chrome: до конца сеанса пару переводит bergamot (chrome() в
      // makeTranslator отказывает сам), Chrome спросим в следующем сеансе.
      // Не вышло и так — откат: раз в MT_COOLDOWN_MS одна строка пробует снова.
      if (Translator.gesture && fresh.onChrome !== false && chromeBroke.get(key) !== sessionGen) {
        chromeBroke.set(key, sessionGen);
        makeTranslator(source, target).catch(() => {});
      } else mtCooldown.set(key, performance.now() + MT_COOLDOWN_MS);
      return null;
    }
  }
}

// --- Потоковая дорожка -------------------------------------------------------
//
// Воркер берёт звук как он идёт и дописывает строку каждые кусок звука.
// Очереди у него нет и быть не может: поток нельзя отложить, его можно
// только кормить.
//
// Границы фраз он всё-таки получает, но означают они здесь не «вот работа», а
// «тут была тишина»: по ним добивается неполный кусок. Кеши кодировщика паузу
// переживают — забывать контекст из-за неё значит начинать следующую фразу
// глухим.
//
// Строку ленты граница фразы не закрывает: закрывает конец предложения (см.
// LINE_MIN_WORDS ниже).
/** @type {{id: string, w: Worker, ready: boolean, device: string}|null} */ let streamer = null;
/** Строка ленты, которую поток сейчас набирает, и её текст целиком. */
let liveLine = 0;
let liveText = '';
/**
 * Окно ТОЛЬКО для определения языка: текст последних SNIFF_SEC секунд звука.
 * Под «авто» смена языка речи должна подхватываться за секунды, поэтому окно
 * короткое: 28.10 накопленные 120 слов английского ролика назвали следующую
 * за ним русскую речь «en», и перевод шёл кашей, пока русские слова не
 * перевесили бы. Куски — {at: секунда звука, text}. На перевод и нарезку окно
 * не влияет — только на sniffLang.
 *
 * Но латиницу офлайн-догадка узнаёт только с 8 слов (guessLang), а за 3 с их
 * столько нет, на пении тем более. Поэтому хранится и широкое окно: им язык
 * ДОБИРАЕТСЯ, пока он ещё не известен, а сменить уже известный может только
 * короткое — старый текст его не удержит.
 */
const SNIFF_SEC = 3;
const SNIFF_WIDE_SEC = 20;
// Поколение окна: ответ детектора Chrome, пришедший после сброса окна, — про
// прошлый язык, и писать его в detLang нельзя.
let sniffGen = 0;
// detLang — лишь затравка с прошлого сеанса (см. seedLang): её может сменить и
// широкое окно, иначе неверную латинскую затравку короткое окно не перебьёт.
let detSeeded = false;
let sniffBits = [];
/** Текст, распознанный с тех пор, как метки ушли от liveLang (heardLang); null — не уходили. */
let labelText = null;
/** Фраза, с которой строка началась: до конца строки она и остаётся её номером. */
let liveFrom = 0;
/** Живая строка продолжает фразу закрытой перед ней (та обрезана капом). */
let liveCont = false;
/**
 * Где кончается строка ленты.
 *
 * Раньше — на каждой границе фразы, а та почти всегда ставится таймером
 * сегментатора (maxMs 5 с), посреди предложения: на ролике-эталоне 45 строк
 * из 45 обрывались на полуслове. Переводчик Chrome переводит каждую строку
 * отдельно и обрывок достраивает до предложения сам: «начиная с Наш первый
 * дом», «посмотрите, какая она толстая», «Проект в истории YouTube» —
 * заглавные посреди фразы, род и падеж наугад.
 *
 * Теперь строка растёт через границы фраз и закрывается концом предложения,
 * как только за ним началось следующее (точка в конце ещё может оказаться
 * сокращением), или на границе фразы, если предложение уже договорено.
 * Предложение короче LINE_MIN_WORDS слов («Yes.») отдельной строкой не
 * уходит — едет со следующим. Речь без точек закрывается на LINE_MAX_WORDS
 * словах: длинный обрывок без точки переводчик Chrome теряет хвостом
 * («…working in the rain we finally» → «…работы под дождем.»), и до прибавки
 * к точкам (END_BIAS в lib/nemo.js) кап 16 переводился лучше 32. С точками кап
 * срабатывает уже не на сплошной речи, а посреди длинного предложения, и
 * обрывок стоит дороже хвоста: переигровка того же распознанного текста
 * (15.10, chrF против человека) — en→ru/es/fr/pt/ar/hi 66.8 при капе 16,
 * 68.2 при 24, 68.5 целыми предложениями; ru→en 58.3 → 59.4. Дальше 24 не
 * растим: живая строка длиннее — это три строки панели, переписываемые
 * каждым снимком. Резать по границе словосочетания пробовали — в шуме.
 * Последнюю строку сеанса закрывает последняя отметка (finalMark).
 * Перевод по-прежнему платит только за недоговорённый хвост: законченные
 * предложения строки помнит mtCache.
 */
const LINE_MIN_WORDS = 4;
const LINE_MAX_WORDS = 24;
/**
 * В японском и китайском words() считает знаки (см. lib/cues.js): шестнадцать
 * знаков — две секунды речи, и строка рвалась бы посреди слова («お願いいたしま»
 * | «す。»). Тем же пяти секундам речи там соответствует около сорока знаков.
 * Режем по последней «、», а без неё — по границе слова от Intl.Segmenter:
 * обрез по счёту знаков на живом прогоне рвал «20代30 | 代», «こういったこ |
 * とを». Ждать границы фразы нельзя: строка дорастала до 73 знаков, перевод —
 * до двадцати слов, панель делит такую на две и на каждом снимке двигает шов
 * (дрожь 3 раза за 2 минуты против 0). На эталоне ja→en перевод от нарезки
 * не хуже прежнего.
 */
const LINE_MAX_CJK = 40;
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;
const cjkWords = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ja', { granularity: 'word' })
  : null;
const overCap = (t) => words(t).length > (CJK.test(t) ? LINE_MAX_CJK : LINE_MAX_WORDS);
/** Отрезать недописанное последнее слово; в слитном письме его границу знает Intl.Segmenter. */
function splitLast(t) {
  const cut = splitWord(t);
  if (cut.tail || !CJK.test(t) || /[\p{P}\s]$/u.test(t)) return cut;
  const last = cjkWords && [...cjkWords.segment(t)].findLast(x => x.isWordLike);
  return last && last.index > 0 ? { ready: t.slice(0, last.index), tail: t.slice(last.index) } : cut;
}
/** Где резать строку, переросшую кап. */
function splitCap(t) {
  if (!CJK.test(t)) return splitWord(t);
  const at = Math.max(t.lastIndexOf('、'), t.lastIndexOf('，'));
  if (at > t.length / 3) return { ready: t.slice(0, at + 1), tail: t.slice(at + 1) };
  return splitLast(t);
}
/** Номер последней отметки сеанса (teardown): на ней строка закрывается в любом случае. */
let finalMark = -1;
/** Отсчётов звука, уже превращённых в текст: по ним считается отставание. */
let liveDone = 0;
/**
 * Номер последнего сброса потока и тот, что воркер подтвердил. Между ними его
 * реплики — про звук прошлого сеанса: start() стирает счётчики сразу, а RESET
 * уходит воркеру через несколько await, и всё, что он прислал в этом окне
 * (плюс кусок, который считался в миг сброса), несло старый consumed и старый
 * текст. На стенде после смены языка первая строка нового сеанса выходила
 * хвостом прошлого («building is gonna») с отставанием −91 с.
 */
let resetNo = 0, resetSeen = 0;
/**
 * Когда начался сеанс (Date.now()). Уходит в каждой реплике: панель стирает
 * ленту до перезапуска и всё, что начато раньше стирания, выбрасывает. Иначе
 * строка прошлой пары, чей перевод ещё ждали в миг смены языка, доезжала уже
 * в чистую ленту — и висела там непереведённой поверх новой пары.
 */
let sessionAt = 0;
/** Ждём ответа на последнюю отметку фразы — чтобы не оборвать сеанс раньше. */
let liveMarks = 0;
/** Сколько стоил последний проход и сколько звука он посчитал — для отчёта. */
let liveMs = 0;
let liveSec = 0;
/** Отсчётов, выброшенных из очереди потока: машина не успела за речью. */
let liveDropped = 0;
/** Отсчётов, отданных потоку, пока он ещё собирался, — он их не слышал. */
let liveSkipped = 0;
/**
 * Язык, который услышала модель, — с него и переводим.
 *
 * Пока зритель не назвал язык руками (а по умолчанию стоит «авто»), знает его
 * только распознавание: nemotron печатает метку <xx-XX> в поток, воркер
 * присылает её кодом языка. До первой метки переводить не с чего — и лучше
 * подождать её, чем объявить речь английской и получить кашу.
 */
let liveLang = '';

/**
 * Сколько сообщений подряд поток называет один и тот же язык.
 *
 * Под «авто» поток весь сеанс слушает слотом 101 («определи сам») и в конце
 * каждой фразы печатает метку языка. Слот найденного языка ему не называем.
 * Раньше называли (со второй метки), но под явным слотом модель метку не
 * печатает, и смену языка без паузы заметить было нечем: склейка ru→en под
 * слотом ru дала 117 слов транслита вместо 203 английских, и перевод так и шёл
 * с русского. Снятие слота на тишине 1.5 с (0.5.2.84) лечило это только там,
 * где пауза есть, а на сплошной речи под музыку её нет минутами.
 *
 * Цены у 101 нет. FLEURS, 34 языка, 1−CER: 101 весь сеанс 84.4, с постановкой
 * слота 84.5; v9 en 93.8 против 93.7, h9 ru и de те же, пение (drake1, pop1,
 * rap1) слово в слово. Запись 02.10 «под 101 модель глотает половину фраз на
 * fr» (165 слов против 341) на нынешней сборке не воспроизводится: 444 и 444.
 * Явный слот лучше 101 только там, где модель сама путает язык (ro метит bg,
 * he метит ru), и он стоит, когда язык выбран руками.
 */
let langSeen = 0;

/**
 * Язык устоялся: теперь он вправе снять кольцо прошлой пары и спросить свою
 * (см. shaky). Зовётся и пока новая метка ждёт подтверждения, иначе кольцо
 * прошлой пары висело бы, пока модель печатает ложную.
 */
function settle() {
  if (liveLang && !liveSettled && performance.now() - liveSince >= LANG_SETTLE_MS) { liveSettled = true; checkPack(); }
}

/**
 * Что слышит поток: язык перевода меняется с первой же метки нового языка.
 * Две метки подряд хуже: на стыке склейки ru→en модель дважды сказала vi, и
 * правило «две подряд» держало vi дольше (верный en с 52.5 с против 47.0).
 */
function heardLang(lang, text = '') {
  if (!lang) return;
  // Новая метка, которой противоречит сам текст (греческая на латинице,
  // эстонская на английском), — ложная: язык не меняем, словарь под неё не
  // качаем (labelFits). Метка липкая и едет в каждом сообщении, а текста в
  // одном мало, поэтому копим текст с тех пор, как метки ушли от liveLang:
  // старый язык до этого в счёт не идёт, а окно sniffBits не годится — за 20 с
  // медленной песни 12 слов не набиралось, и метка не проходила никогда. Общий
  // на все чужие метки: модель бывает метит фразы через одну (nb/nn), и
  // текст по каждой метке отдельно не набирал 12 слов. Пускает метку только
  // текст, который её подтвердил: выдержка по секундам пускала ложную после
  // паузы (тишина тоже секунды).
  if (lang === liveLang || cfg.source !== 'auto') labelText = null;
  else {
    // Последние 24 слова: иначе минуты ложной метки на английском перевешивали
    // бы потом настоящий язык.
    labelText = ((labelText ?? '') + text).split(/(?=\s)/).slice(-24).join('').slice(-2000);
    if (labelFits(lang, labelText) !== 'yes') return void settle();
    labelText = null;
  }
  if (lang !== liveLang) {
    // Речь сменила язык посреди сеанса (английский ролик, потом русский).
    // Накопленный текст и догадка по нему — про прошлый язык: 28.10 на
    // телефоне окно из английских слов назвал русскую речь «en», и
    // sourceLang() переводил русский как английский — каша на экране.
    if (liveLang) { sniffBits = []; sniffGen++; detLang = ''; }
    liveLang = lang; langSeen = 1;
    liveSince = performance.now(); liveSettled = false;
    checkPack();
  }
  else langSeen += 1;
  settle();
  // Подтверждённый язык (услышан дважды подряд) — запоминаем на будущий сеанс.
  if (langSeen >= 2) rememberSource(mtCode(lang));
  // Сколько звука прошло до того, как язык стал известен. Это и есть цена
  // режима «определить сам» в секундах: до этой секунды переводить не с чего.
  if (cfg.source === 'auto') langAt ||= +((liveSkipped + liveDropped + liveDone) / SAMPLE_RATE).toFixed(1);
}

/**
 * Определитель языка Chrome: кто говорит, пока модель этого не сказала.
 *
 * Под «авто» язык речи знает только распознавание, и узнаёт оно его не сразу:
 * метку <xx-XX> nemotron печатает с началом высказывания, и в прогоне
 * 9CZBIaaiPRI она пришла на 5.3 с. До неё переводить не с чего — зритель
 * пять секунд читает речь как есть.
 *
 * Но язык виден и по самому тексту: встроенный в Chrome `LanguageDetector`
 * отвечает «de 1.00» уже на четырёх словах (на двух — «de 0.27, en 0.27», то
 * есть ничего; замер в scratchpad/det-probe.mjs). Спрашиваем его, как только
 * строка набрала четыре слова.
 *
 * И делаем с ответом ровно одно: просим словарь переводчика для этой пары.
 * Слота модели детектор не касается — это проверено ценой целого прогона. На
 * немецком ролике 9CZBIaaiPRI детектор на первых четырёх словах сказал «fr» с
 * уверенностью 1.00 (поток ещё писал начало фразы, и в нём четыре слова ни на
 * что не похожи); слот `fr` был назван модели сразу — и поток замолчал
 * целиком: 0.0% на распознавании вместо 85.3%. Цена ошибки слота — весь
 * ролик, цена ошибки со словарём —
 * лишняя кнопка в шапке, поэтому детектор отвечает только за словарь, а язык
 * потоку называет метка модели (см. heardLang).
 *
 * Скачивание детектора, как и словаря переводчика, требует жеста зрителя —
 * его делает панель при включении субтитров (warmDetector). Если детектора в
 * профиле нет, молчим: словарь всё равно спросится, только позже.
 */
let detector = null;
let sniffing = false;
// Встроенный LanguageDetector в профиле недоступен (а флаги нельзя). Узнав это
// однажды, больше его не опрашиваем: каждый await availability() под охранником
// sniffing глушил офлайн-догадку и запирал язык на полпесни.
let detectorOff = false;
/**
 * Язык-ИСТОЧНИК ПЕРЕВОДА, когда модель язык меткой так и не назвала (код
 * переводчика Chrome, уже через mtCode). На пении модель часто молчит про язык
 * вовсе: pop1 (Adele) под слотом 101 выдал 83 слова текста, но heard=null —
 * метки <xx-XX> нет ни одной. Тогда liveLang пуст, sourceLang() пуст,
 * translate() переводить не с чего, и зритель видит голый английский (а на
 * звуке потруднее — пусто). Детектор язык этого текста знает — берём его ТОЛЬКО
 * на перевод. Слот модели им не трогаем (это глушит поток — см. heardLang и
 * memory/detector-only-asks-for-the-pack): модель остаётся под 101, а назовёт
 * метку позже — liveLang её перекроет (sourceLang отдаёт предпочтение liveLang).
 */
let detLang = '';
/** Секунда звука, на которой поток впервые назвал язык (см. heardLang). */
let langAt = 0;
/**
 * Когда закончился прошлый сеанс и какой язык он к тому мигу знал. На быстром
 * вкл/выкл (тот же ролик, секунды спустя) под «авто» передетекция с нуля стоит
 * зрителю ~2.5 с голого оригинала на КАЖДОМ включении: пока наберётся четыре
 * слова и сработает sniffLang. Язык прошлого сеанса берём как ЗАТРАВКУ перевода
 * (см. start). Окно короткое, но и ошибка не страшна: самокорректируется.
 */
let lastStopAt = 0;
const WARM_SEED_MS = 5 * 60 * 1000;
async function sniffLang(text, wide) {
  if (cfg.source !== 'auto' || sniffing) return;
  // Обычно, назвав язык меткой, модель избавляет нас от догадки по тексту. Но
  // если она назвала САМ язык перевода (<ru-RU> на ролике, который зритель
  // переводит на ru), перевод стал бы тождественным — translate() вернёт null,
  // и зритель читает оригинал, хотя речь, может, вовсе не на языке перевода
  // (nemotron под слотом 101 путает язык, memory/auto-slot-swallows-speech).
  // Тогда догадку по тексту продолжаем считать: sourceLang() поправит ей ложную
  // метку. При годной метке (язык ≠ перевод) догадка не нужна — выходим.
  if (liveLang && mtCode(liveLang) !== cfg.target) return;
  // Короткое окно (см. SNIFF_SEC) решает всегда; широкое — только пока язык
  // ещё не известен, иначе старый текст удерживал бы прошлый язык.
  let words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const wideWords = detLang && !detSeeded ? [] : String(wide || '').trim().split(/\s+/).filter(Boolean);
  // В японском, китайском и тайском пробелов между словами нет, и вся строка
  // была одним «словом»: догадка на таких языках не начиналась вовсе. Их
  // слово — пара знаков.
  const size = (ws) => ws.reduce((n, w) => n + (/[฀-๿぀-鿿가-힣]/.test(w) ? Math.ceil([...w].length / 2) : 1), 0);
  const enough = size(words) >= 4, wideEnough = size(wideWords) >= 4;
  if (!enough && !wideEnough) return;
  const gen = sniffGen;
  sniffing = true;
  try {
    // Офлайн-догадку по тексту считаем СРАЗУ и синхронно, до любого ожидания:
    // она не зависит от сети и компонента, и перевод не ждёт медленного
    // availability() детектора Chrome. Последние слова, а не первые: начало
    // песни бывает малословным («ла-ла», «о-о»), а свежая строка уже лексическая.
    let code = enough ? guessLang(words.join(' ')) : '';
    if (!code && wideEnough) {
      words = wideWords;
      code = guessLang(words.slice(-120).join(' '));
    }
    // Уточняем встроенным LanguageDetector Chrome — он точнее на коротком и
    // смешанном. Если его в профиле нет/он не готов — не зависаем на нём в цикле:
    // метим detectorOff и дальше живём офлайн-догадкой.
    if (self.LanguageDetector && !detectorOff) {
      try {
        if (!detector) {
          if (await self.LanguageDetector.availability() === 'available') detector = await self.LanguageDetector.create();
          else detectorOff = true;
        }
        if (detector) {
          const [top] = await detector.detect(words.slice(-12).join(' '));
          const c = top && top.confidence >= 0.9 && mtCode(top.detectedLanguage);
          if (c && TARGET_CODES.includes(c)) code = c;
        }
      } catch (e) {
        // Отказ детектора — не причина ронять субтитры: офлайн-догадка выше.
        detector = null; detectorOff = true;
      }
    }
    // Спрашиваем словарь и этим же языком переводим, пока модель не назвала свой.
    // Слот модели НЕ ставим (см. detLang): она слушает под 101, а назовёт метку —
    // liveLang перекроет detLang в sourceLang(). Цена ошибки — перевод не с того
    // языка до первой метки, не молчание потока. Язык, которого нет у переводчика
    // Chrome, в кнопку не просится: словаря такой пары не существует.
    // Пока ждали детектор, окно сбросили (новая метка или новый сеанс): ответ
    // про прошлый текст.
    if (gen !== sniffGen) return;
    // Короткое окно бывает из одних кандзи, и «китайский» говорят и догадка, и
    // детектор, хотя кана в широком окне выдаёт японскую речь.
    if (code === 'zh' && /[぀-ヿ]/.test(wideWords.join(''))) code = 'ja';
    if (code && TARGET_CODES.includes(code)) {
      // detLang до checkPack: его makeTranslator сверяет пару с sourceLang().
      detLang = code;
      checkPack(code);
      detSeeded = false;
      rememberSource(code);
    }
  } finally { sniffing = false; }
}

/**
 * Поднять потоковую дорожку. Веса она качает сама — см. live-worker.js.
 *
 * @param {string} id какую сборку: у карточки есть и адрес весов, и
 *   процессорная раскладка с длиной куска. Длина куска не свойство породы, а
 *   свойство экспорта, и воркер сам её не угадает.
 */
/** Кодировщик на видеокарте — выбор панели; в приложении Android его нет: там
 *  модель считает процессор процесса приложения, а WebView не тянет наш
 *  WebGPU (одна привязка до 128 МБ на Adreno, веса одним куском не читаются). */
const wantsGpu = () => cfg.device === 'gpu' && !self.__atNative;

function spawnStreamer(id) {
  // Стенд: распознавание Chrome вместо модели (lib/soda.js).
  if (id === 'soda') {
    return { id, ready: false, device: 'soda',
      w: sodaStreamer(stream.getAudioTracks()[0], (m) => onStreamerMessage(m)) };
  }
  const card = findModel(id);
  const w = new Worker(chrome.runtime.getURL('live-worker.js'), { type: 'module' });
  const gpu = wantsGpu();
  const slot = { id, w, ready: false, device: 'wasm', gpu };
  // Сообщения погашенного воркера (смена модели, отвал) в новый сеанс не идут.
  w.onerror = (e) => {
    if (streamer !== slot) return;
    w.terminate();
    streamer = null;
    умер(`speech model failed to start: ${e.message || 'module load error'}`, сеанс, true);
  };
  // Сторож загрузки: зависшая сборка (нет памяти, потоки не поднялись) иначе
  // держала бы «загружаю» вечно, и зритель видел «не переводит» без ошибки.
  // Порог с запасом на слабую машину: первая сборка там идёт минуту. Каждое
  // сообщение до готовности (докачка, стадия) взводит его заново: медленная
  // сеть качает долго, но качает.
  let loadTimer = 0;
  const watchLoad = () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      if (streamer !== slot || slot.ready) return;
      w.terminate();
      streamer = null;
      умер('Speech model did not load in 3 minutes. Not enough memory? Close some heavy tabs.', сеанс, true);
    }, 180000);
  };
  watchLoad();
  // Сторож после готовности: поток ядра, упавший посреди куска, оставляет
  // воркер навсегда в Atomics.wait, и ни ошибки, ни строк. Живой отвечает на
  // PING между кусками; занятый, но без единого пройденного куска за
  // STREAMER_HANG_MS, тоже считается вставшим.
  let aliveAt = 0, steps = -1, tickAt = 0;
  const pulse = setInterval(() => {
    if (streamer !== slot) return void clearInterval(pulse);
    if (!slot.ready) return;
    const now = performance.now();
    // Сон машины или замороженный документ: таймер стоял, и воркер тоже, —
    // отсчёт заново, а не «вставший».
    if (!aliveAt || now - tickAt > 15000) aliveAt = now;
    tickAt = now;
    if (now - aliveAt > STREAMER_HANG_MS) {
      clearInterval(pulse);
      w.terminate();
      streamer = null;
      return void умер('Speech model stopped responding.', сеанс, true);
    }
    w.postMessage({ type: 'PING' });
  }, 5000);
  w.onmessage = (ev) => {
    if (streamer !== slot) return;
    if (!slot.ready) watchLoad();
    if (ev.data?.type === 'pong') {
      if (!ev.data.busy || ev.data.steps !== steps) aliveAt = performance.now();
      steps = ev.data.steps;
      return;
    }
    if (ev.data?.type === 'native') relayNative(slot, ev.data);
    else onStreamerMessage(ev.data);
  };
  // Считает своим кодом: на Rust или кодировщик на видеокарте (live-worker.js).
  // В приложении Android — процессом приложения (lib/nemo-host.js).
  w.postMessage({
    type: 'LOAD',
    language: cfg.source,
    repo: card.id,
    cpu: card.cpu || null,
    gpu,
    native: !!self.__atNative
  });
  return slot;
}

const STREAMER_HANG_MS = 30000;

/** Вызов натива от воркера (у воркера своего AtNative нет): туда и ответ обратно. */
function relayNative(slot, m) {
  const reply = (r) => { if (streamer === slot) slot.w.postMessage({ type: 'NATIVE', id: m.id, ...r }); };
  self.__atNative(m.op, m.args).then(
    (value) => reply({ ok: true, value }),
    (e) => reply({ ok: false, error: String(e?.message || e) }));
}

async function onStreamerMessage(m) {
  if (m.type === 'reset') return void (resetSeen = m.no);
  if ((m.type === 'live' || m.type === 'closed') && resetSeen !== resetNo) return;
  // Воркер переживает сеанс: его загрузка и готовность после стопа в статус не
  // идут, иначе «loading» садился поверх «выключено».
  if (!сеанс && (m.type === 'progress' || m.type === 'status' || m.type === 'ready')) {
    if (m.type === 'ready' && streamer) { streamer.ready = true; streamer.device = m.device; }
    return;
  }
  if (m.type === 'progress') {
    return void status({ download: m });
  }
  if (m.type === 'status') {
    // Полосу загрузки гасим: статус приходит до скачивания и после него, и
    // докачанная полоса «36 / 36 MB» не должна висеть над сборкой сессий.
    return void status({ stage: m.stage, device: m.device, download: null,
      ...(m.pct != null ? { pct: m.pct } : {}) });
  }
  if (m.type === 'ready') {
    if (streamer) { streamer.ready = true; streamer.device = m.device; }
    // Полосу гасим и тут: веса процессорного счёта читаются после статуса
    // «loading», и «25 / 25 MB» висело над идущим переводом (04.11).
    return void status({ stage: 'ready', device: m.device, model: m.model, draftDevice: m.device,
      threads: m.threads, download: null });
  }
  if (m.type === 'strain') return void send({ type: 'STRAIN' });
  if (m.type === 'error') {
    console.error('потоковая дорожка отвалилась:', m.error);
    streamer?.w.terminate?.();
    streamer = null;
    return void умер(m.error || 'speech model failed', сеанс, true);
  }

  if (m.type === 'live') {
    liveDone = m.consumed;
    if (m.skipped != null) liveSkipped = m.skipped;
    heardLang(m.lang, m.text);
    liveText += m.text;
    // Пока модель не назвала язык сама — спрашиваем по тексту. Не ждём: ответ
    // нужен следующей строке, а не этой. Кормим текстом последних SNIFF_SEC
    // секунд звука, а не текущей фразой и не всем сеансом: старый текст держал
    // бы прошлый язык (см. sniffBits).
    const at = m.consumed / SAMPLE_RATE;
    if (m.text) sniffBits.push({ at, text: m.text });
    sniffBits = sniffBits.filter((b) => b.at >= at - SNIFF_WIDE_SEC);
    sniffLang(sniffBits.filter((b) => b.at >= at - SNIFF_SEC).map((b) => b.text).join(''),
      sniffBits.map((b) => b.text).join(''));
    liveMs = m.ms;
    liveSec = m.seconds;
    // Предложение договорено и следующее уже началось — строка закрывается
    // здесь, не дожидаясь границы фразы. Закрытую не ждём: перевод открытой
    // новой идёт рядом, а опоздавшее закрытие панель кладёт под новую строку
    // (under в lib/cues.js).
    const s = sentences(liveText);
    if (s.count && s.tail.trim() && words(s.done).length >= LINE_MIN_WORDS) {
      void closeLine(s.done, s.tail, m.phrase);
    } else if (overCap(liveText)) {
      // Посреди куска звука последнее слово может быть недосказано.
      const cut = splitCap(liveText);
      if (cut) void closeLine(cut.ready, cut.tail, m.phrase, true);
    }
    // Перевод идёт на устройстве и стоит времени. Поток приносит прибавку
    // каждый кусок, и если каждую гнать в переводчик, тот встаёт в очередь
    // сам с собой: показывать надо последнее, а не всё подряд. Пропущенный
    // кусок не теряется — он уже в liveText и уедет со следующим.
    if (partialBusy) { liveStale = true; return; }
    // Строка ленты одна и та же, пока фраза не закрылась: панель по номеру
    // line переписывает её на месте, а не кладёт рядом вторую такую же.
    return snapshot();
  }

  if (m.type === 'closed') {
    liveDone = m.consumed;
    if (m.skipped != null) liveSkipped = m.skipped;
    heardLang(m.lang);
    liveMs = m.ms;
    liveSec = m.seconds;
    liveMarks = Math.max(0, liveMarks - 1);
    // Про выброшенный звук надо сказать наружу: это дыра в тексте, и отличить
    // её от плохого распознавания иначе нечем.
    if (m.dropped > liveDropped) {
      status({ dropped: Math.round((m.dropped - liveDropped) / SAMPLE_RATE * 1000) });
      liveDropped = m.dropped;
    }
    // Предложение не договорено — строка растёт дальше, через границу фразы
    // (см. LINE_MIN_WORDS). Прибавку, пропущенную под переводом, показываем
    // сейчас: следующей может не быть до конца паузы.
    const ended = !!liveText.trim() && !sentences(liveText).tail.trim();
    if (m.phrase !== finalMark && !ended && !overCap(liveText)) {
      if (!liveStale) return;
      if (partialBusy) { partialAgain = true; return; }
      return snapshot();
    }
    // Разрез по часам приходится посреди слова: звук закрыт таймером, а не
    // речью, и добить его тишиной нельзя (см. mark() в live-worker.js). Хвост
    // слова досчитается уже после отметки — и уедет в начало следующей
    // строки, разорвав «bridge» на «bri» и «dge». Поэтому недописанное слово
    // в закрытую строку не отдаём: оно ждёт продолжения в следующей.
    const { ready, tail } = m.cut ? splitLast(liveText) : { ready: liveText, tail: '' };
    await closeLine(ready, tail, m.phrase);
  }
}

/**
 * Закрыть строку, которую набирает поток: ready уходит в ленту договорённым,
 * с tail начинается следующая. to — последняя фраза, услышанная потоком.
 */
function closeLine(ready, tail, to, mid = false) {
  // Новая строка начинается здесь, до всякого ожидания. Перевод закрытой
  // строки идёт полсекунды, и ждать его поток не станет: пока он шёл,
  // прибавка следующей фразы дописывалась в закрытую строку (та оживала и
  // договаривала чужими словами), а потом ещё и выбрасывалась строкой ниже.
  // Поэтому номер строки переводим сразу, а закрытую отдаём снимком: то,
  // что придёт за время перевода, ляжет уже в новую.
  // cont — строка продолжает фразу предыдущей, mid — сама оборвана капом
  // посреди фразы: шов оформляет polish (lib/seam.js).
  const was = { text: ready, line: liveLine, from: liveFrom, cont: liveCont, mid };
  liveText = tail;
  if (!ready.trim()) return;
  liveCont = mid;
  liveLine++;
  // Следующая строка начинается со следующей фразы. Без этого сдвига обе
  // строки приходят с одним номером, и лента вторую отбрасывает как повтор
  // уже показанного. Конец предложения бывает и посреди фразы — тогда номер
  // всё равно растёт: по нему (data-row) панель и стенд отличают строки.
  liveFrom = Math.max(to + 1, liveFrom + 1);
  return emitStream(false, Math.max(to, was.from), was);
}

/**
 * Отдать наружу то, что набрал поток.
 *
 * Отставание считается от конца звука, уже превращённого в текст: сколько
 * миллисекунд прошло с момента, когда слово прозвучало, до момента, когда его
 * можно прочитать.
 */
async function emitStream(open, to, was = null) {
  // Строка берётся снимком: перевод внутри — это ожидание, и за это время
  // поток успевает начать следующую строку (см. закрытие выше).
  // Зацикленный повтор снимаем перед показом: на растянутом «sooo» поток
  // печатает «so» девять раз подряд, и это одна из главных его ошибок на
  // ролике-эталоне (см. lib/repeat.js — там же, почему «yes yes yes» живёт).
  // Сам liveText не трогаем: по нему режется недописанное слово на стыке.
  // Числа модель пишет только словами, человек — цифрами: «fünf und dreißig»
  // против «35» и был весь разрыв с ютубом на немецком (см. lib/numerals.js).
  // До переводчика тоже идут цифры — «fünf und dreißig» он переводит как
  // «five and thirty». Хвост открытой строки не трогаем: число ещё растёт.
  // Междометия раздумья («euh», «äh») человек в субтитрах не пишет, а модель
  // пишет дословно (см. lib/fillers.js).
  const lang = sourceCode();
  const text = digits(unfill(unloop((was ? was.text : liveText).trim()), lang), lang, { open });
  const line = was ? was.line : liveLine;
  const from = was ? was.from : liveFrom;
  if (!text) return;
  // Звук, который поток не слышал — пропущенный на загрузке и выброшенный из
  // очереди, — в счёт всё равно идёт: он прозвучал, и зритель его ждал.
  const heard = liveSkipped + liveDropped + liveDone;
  const said = fed.firstAt ? fed.firstAt + heard / (SAMPLE_RATE / 1000) : 0;
  const lag = said ? Math.round(performance.now() - said) : null;
  inflight++;
  try {
    await emit({
      text, piece: text, phrase: from, endPhrase: Math.max(to, from),
      line, growing: open, model: cfg.draft,
      // Растущая строка оборвана по определению: точку переводчика ей не даём.
      cont: was ? was.cont : liveCont, mid: was ? was.mid : true,
      // Не длина строки, а последний проход: сколько звука он съел и во что
      // обошёлся. По ним видно, успевает ли поток за речью, — а это у него
      // единственная болезнь, которая всё решает.
      seconds: liveSec, ms: liveMs,
      via: open ? 'stream' : 'stream-closed'
    }, true, lag, open);
  } finally { inflight--; }
}
/** Перевод недосчитанной строки уже идёт: следующий кусок её пропускаем. */
let partialBusy = false;
/** Прибавку пропустили под переводом и ещё не показали. */
let liveStale = false;
/** Показать её сразу, как кончится идущий перевод (отметка посреди строки). */
let partialAgain = false;

/** Снимок живой строки в ленту; liveText берётся в момент вызова. */
async function snapshot() {
  partialBusy = true;
  try {
    do {
      partialAgain = false;
      liveStale = false;
      await emitStream(true, phrase);
    } while (partialAgain);
  } finally { partialBusy = false; }
}

// Признак живого звука для панели. Отправляем не каждый кадр (их 15 в секунду,
// и пересылка идёт через фоновый скрипт), а только на смену речь↔тишина и
// раз в BEAT_MS, чтобы панель знала: тик не пропал, слушаем.
const BEAT_MS = 400;
let beatVoice = null, beatAt = 0;
function beat(voice) {
  const now = performance.now();
  if (voice === beatVoice && now - beatAt < BEAT_MS) return;
  beatVoice = voice;
  beatAt = now;
  send({ type: 'LIVE_BEAT', voice });
}

/**
 * С какого языка переводить.
 *
 * Зритель по умолчанию стоит на «авто», и до сих пор это молча значило
 * «английский»: немецкую речь распознавали немецкой, а в переводчик Chrome
 * отдавали как английскую — тот возвращал её почти как есть. Теперь язык
 * называет сама модель (метка <xx-XX> в потоке), а «авто» остаётся только
 * до первой метки — там переводить ещё не с чего, и строка уходит на экран
 * как распознана, без перевода.
 */
/**
 * Язык речи узнан — качать его пару сразу, не дожидаясь первой строки.
 *
 * Ход загрузки и отказ панель видит статусом pack, который ставит
 * makeTranslator (словарь Chrome качает фон, workerPack). Один раз на пару
 * за сеанс: строк в секунду несколько, а загрузка у пары одна.
 */
const packAsked = new Set();
function checkPack(speech) {
  const from = speech || sourceLang(), to = cfg.target;
  // Язык речи сменился: кольцо и «пары нет у переводчика» прошлой пары больше
  // не про то, что слышно, и тогда, когда новый язык и есть язык перевода (uk,
  // потом ru при цели ru). Кольцо — только когда язык устоялся (shaky).
  // Сверка с sourceLang(), а не с from: догадка детектора при названном
  // моделью языке переводом не правит. Ошибку (failed) смена языка не
  // снимает: панель могла быть закрыта и прочтёт её, когда откроется.
  if (packKey && (packCan === 'unavailable' || ((packCan === 'downloading' || packCan === 'offline') && !shaky('')))
      && packKey !== `${sourceLang()}>${to}`) packStatus();
  if (!from || from === to) return;
  const key = `${from}>${to}`;
  // Пара ещё качается: с прошлого сеанса, прошлой цели или речь вернулась к
  // ней с другого языка — вернуть кольцо, а не молча показывать оригинал минутами.
  if (translators.has(key)) {
    if (mtFetching.has(key) && from === sourceLang() && packKey !== key && !shaky(key)) packStatus(from, to, mtWaitNet.has(key) ? 'offline' : 'downloading');
    return;
  }
  if (mtFailed.has(key) && mtLost.has(key) && from === sourceLang() && packKey !== key && !shaky(key)) {
    // Речь вернулась к паре, чья загрузка не вышла, пока звучал другой язык:
    // её отказ показать (Retry), а не молча вести оригинал.
    return void packStatus(from, to, mtLost.get(key));
  }
  if (packAsked.has(key) || mtFailed.has(key) || shaky(key)) return;
  packAsked.add(key);
  makeTranslator(from, to).catch(() => {});
}

// Запоминаем язык речи для СЛЕДУЮЩЕГО сеанса: панель погреет его словарь ещё на
// жесте включения (warmPairs), и под «авто» баннер докачки не всплывёт у того,
// кто смотрит на том же языке, что и прошлый раз (жалоба 07.10 «че сам не
// докачаешь»). В offscreen chrome.storage — TypeError (см. ниже, однажды уронил
// захват), поэтому пишет service worker: шлём ему код. Только годный к переводу
// и только при смене — дёргать на каждой фразе незачем.
let sentSource = '';
function rememberSource(mtc) {
  if (!mtc || mtc === sentSource || !TARGET_CODES.includes(mtc)) return;
  sentSource = mtc;
  send({ type: 'LAST_SOURCE', code: mtc });
}

/** Код языка речи, как его понимаем мы: названный руками или услышанный. */
function sourceCode() {
  return cfg.source === 'auto' ? liveLang : cfg.source;
}

function sourceLang() {
  const code = sourceCode();
  // Наш код и код переводчика — не всегда одно и то же: норвежский у Chrome
  // один, а модель различает букмол и нюнорск.
  if (code) {
    const mt = mtCode(code);
    // Модель могла пометить речь самим языком перевода — тогда translate()
    // вернёт null (source === target) и зритель видит оригинал. Если
    // офлайн-догадка по тексту зовёт другой язык, метка ложная: переводим
    // догадкой, а не молчим (см. sniffLang; memory/singing-needs-detlang-source).
    if (mt === cfg.target && detLang && detLang !== cfg.target) return detLang;
    return mt;
  }
  // Модель язык не назвала. Под «авто» переводим языком детектора (detLang —
  // уже код переводчика), если он есть: иначе пение, на котором модель молчит
  // про язык, не переведётся вовсе. Под явным слотом сюда не попадаем.
  return cfg.source === 'auto' ? detLang : '';
}

/**
 * @param partial строка ещё может перемениться: панель кладёт её в ленту через
 *   feed (дописать), а не fix (заменить). Поток отдаёт только такие.
 * @param lag мс от конца распознанного звука до готового текста. Это и есть
 *   отставание субтитров от речи — то самое, по чему их сравнивают с ютубом.
 * @param open фраза ещё не закрылась: человек продолжает говорить, и текст
 *   оборван не потому, что модель ошиблась. Оверлей рисует такую строку
 *   многоточием, законченную — без.
 */
async function emit(m, partial, lag, open = false) {
  let translated = null, error = null;
  // Сеанс — на входе: за время перевода start() мог начать уже следующий.
  const since = sessionAt;
  // Перевод стоит времени: lag снимается, когда готов текст распознавания, а
  // на экран уходит перевод. Меряем отдельно, иначе задержку нечем делить.
  const mtAt = performance.now();
  // Переводим не всю строку, а её незаконченный хвост: законченные
  // предложения уже переведены и от соседей не зависят (замер в lib/mt-cache.js).
  // Язык — тоже на входе. Под «авто» метка модели и догадка по тексту меняют
  // его посреди строки, и начало, переведённое с прежнего языка (затравка en,
  // а звучит испанский), иначе так и стояло бы кашей до закрытия строки: кеш
  // отдавал бы его как готовое и переводил только хвост. Поэтому строка в
  // кеше — вместе с языком.
  const src = sourceLang();
  const key = m.line == null ? null : `${m.line}|${src}`;
  const cut = mtCache.split(key, m.text);
  try {
    const restOut = await translate(cut.rest, src, cfg.target);
    // null значит «переводить не с чего» (языка нет, пара не поддерживается) —
    // тогда и склеивать нечего: строка уходит без перевода, как и раньше.
    translated = restOut == null ? null : mtCache.join(cut.out, restOut);
    // Пока шёл перевод, язык перевода могли сменить (retarget): прежний язык в
    // кеш новой пары класть нельзя, склеился бы с новым.
    if (restOut != null && since === sessionAt) mtCache.learn(key, cut.src, cut.out, cut.rest, restOut);
  } catch (e) {
    error = String(e.message || e);
    // Строку могли перевести наполовину; помнить такое начало нельзя.
    mtCache.drop(key);
  }
  if (translated) translated = polish(translated, m.text, { cont: m.cont, mid: m.mid, target: cfg.target });
  const mt = Math.round(performance.now() - mtAt);
  send({
    type: 'CAPTION',
    original: m.text,
    piece: m.piece ?? m.text,
    translated,
    partial,
    open,
    phrase: m.phrase,
    // Строка ленты, которой принадлежит текст. Поток дописывает одну и ту же
    // строку, пока фраза не закрылась, — панель по этому номеру и понимает,
    // что строку надо переписать, а не добавить новую.
    line: m.line,
    // ...и будет ли дописывать дальше. Пока будет, строка живая: её рано
    // гасить как прочитанную.
    growing: !!m.growing,
    // Строка, начатая на одной фразе, может закрыться на следующей.
    endPhrase: m.endPhrase ?? m.phrase,
    // Продолжает предложение предыдущей строки: панель рисует их одним абзацем.
    cont: !!m.cont,
    lag,
    // Сколько из задержки съел перевод. Живёт рядом с lag и меряется так же:
    // lag — распознавание, mt — перевод, остальное в сумме — сегментатор.
    mt,
    model: m.model,
    // С какого языка переведено. Под «авто» его называет модель, и наружу он
    // нужен затем же, зачем model: без него по строке не видно, определился
    // язык вообще или перевода не было именно поэтому.
    lang: src || null,
    // Частица потока ('stream') или закрытая строка ('stream-closed').
    via: m.via ?? null,
    // Длина распознанного куска. Вместе с lag она задаёт окно звука, к которому
    // относится текст, — без неё субтитры не с чем сверять по времени.
    seconds: m.seconds,
    // rtf < 1 означает, что распознавание идёт быстрее реального времени.
    rtf: m.seconds ? Math.round(m.ms / 10 / m.seconds) / 100 : null,
    ms: m.ms,
    since,
    error
  });
}

// --- Захват ------------------------------------------------------------------

/**
 * Номер сеанса, которым нас завели.
 *
 * Завести могут дважды одним и тем же заданием: фоновый скрипт и присылает
 * OFFSCREEN_CAPTURE, и держит задание в storage для OFFSCREEN_READY — на
 * случай, если скрипт тут ещё не повесил слушатель. Когда успевают оба, на
 * один клик поднимаются два набора воркеров; в прогоне это выглядело как
 * «шапка сама вернулась в „готовлюсь“» и сбитый счёт звука.
 *
 * И наоборот: остановка досчитывает последнюю фразу секунд пятнадцать, а
 * зритель за это время успевает включить субтитры заново — тогда её
 * OFFSCREEN_STOP гасит уже новый сеанс. Номер отвечает на оба вопроса: взяли
 * ли это задание и тот ли сеанс просят погасить.
 */
let сеанс = 0;

/**
 * Связь с фоновым скриптом на время сеанса. Порт рвётся вместе с документом,
 * и фон узнаёт о смерти захвата сразу, событием, без будильников. Фон сам
 * засыпает и рвёт порт со своей стороны: пока сеанс идёт, соединяемся заново,
 * это и будит его обратно.
 */
let связь = null;
function связаться() {
  if (связь || !сеанс || !chrome.runtime?.id || !chrome.runtime.connect) return;
  try { связь = chrome.runtime.connect({ name: 'offscreen' }); } catch { return; }
  // Не своя связь (стоп уже порвал её и завёл новую) — не трогаем.
  const моя = связь;
  моя.onDisconnect.addListener(() => { if (связь === моя) { связь = null; связаться(); } });
}

/**
 * Звук вкладки живёт дольше сеанса, которым заведён.
 *
 * Вкладку Chrome отдаёт одному потоку, и второй ключ на уже захваченную
 * вкладку он выдаёт, но негодный: getUserMedia отвечает «Invalid state», а
 * следующие попытки — «Error starting tab capture» (проверено: ни одна из
 * пятнадцати подряд, с паузами, не прошла). А перезапуск на той же вкладке —
 * обычное дело: клик по иконке включает захват сразу, не дожидаясь кнопки
 * (background.js), и кнопка «Включить» в панели заводит сеанс заново, уже со
 * свежими настройками из панели. Наружу это выглядело как «Invalid state» в
 * статусе при живых субтитрах, а стоило вместе с этим и самого звука.
 *
 * Поэтому поток вкладки — не часть сеанса, а то, что сеансы переиспользуют:
 * перезапуск на той же вкладке берёт его как есть, и гасят его только
 * остановка и переезд на другую вкладку.
 */
let вкладка = null;   // чей звук держим
let заявка = null;    // обещание этого потока: он мог ещё не доехать
let выдан = null;     // сам поток, когда доехал
let меткаЗаявки = null;  // чья заявка в полёте: отпустить могли и раньше ответа

/** Звук вкладки, выданный один раз на вкладку. */
function звукВкладки(tabId, streamId) {
  // Тот же номер вкладки — ещё не тот же звук: дорожку могли оборвать (закрытие
  // захвата Chrome'ом), а номер у вкладки остаётся прежний. Переход на другой
  // сайт сам по себе дорожку не глушит — проверено 11.10.
  // Такой поток переиспользовать нельзя — он молча пустой, и субтитры встали бы
  // без единой ошибки в статусе. Ключ при этом уже свежий: его дали по новому
  // клику на иконке, то есть на новой странице.
  const жив = !выдан || выдан.getAudioTracks()[0]?.readyState === 'live';
  if (вкладка === tabId && заявка && жив) return заявка;
  отпуститьВкладку();
  вкладка = tabId;
  const моя = меткаЗаявки = {};
  // Ключ от Chrome живёт считанные секунды, и просроченный он отвечает не
  // отказом, а молчанием: getUserMedia не возвращается вовсе. Поймано
  // 2 октября — прогон дважды встал на «беру звук» и простоял 700 с, в
  // offscreen не было ни элемента воспроизведения, ни ошибки, а
  // chrome.tabCapture.getCapturedTabs() показывал у вкладки status «stopped».
  // Съедали эти секунды сами модели: ключ брали до создания offscreen-
  // документа, а его первое создание — это разбор onnxruntime (теперь документ
  // поднимается раньше ключа, см. start в background.js).
  //
  // Поэтому ждём ограниченно и просим ключ заново: грант activeTab живёт до
  // перехода вкладки на другую страницу, то есть он ещё при нас, и второй ключ
  // Chrome выдаёт охотно. Зритель при этом не делает ничего.
  const взять = (ключ) => {
    let поздно = false;
    const запрос = navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: ключ } }
    }).then((п) => {
      // Опоздавший поток гасим: иначе вкладка осталась бы захваченной навсегда
      // — ни у нас, ни у неё.
      if (поздно) { п.getTracks().forEach((t) => t.stop()); throw new Error('ПРОСРОЧЕН'); }
      return п;
    });
    return Promise.race([запрос, new Promise((_, reject) => setTimeout(() => {
      поздно = true;
      reject(new Error('ПРОСРОЧЕН'));
    }, 20000))]);
  };
  заявка = взять(streamId).catch((e) => {
    if (!/ПРОСРОЧЕН/.test(String(e.message)) || tabId == null) throw e;
    status({ step: 'ключ захвата просрочен — прошу новый' });
    return chrome.runtime.sendMessage({ type: 'NEW_STREAM_ID', tabId })
      .catch(() => null)
      .then((ответ) => {
        if (!ответ?.streamId) {
          // «Вкладка уже захвачена» — держит её наш же повисший захват, грант
          // при этом жив: фон поднимет захват с новым документом сам. Иначе
          // грант ушёл (вкладка сменила страницу), и нужен клик зрителя.
          if (/active stream/i.test(String(ответ?.error))) {
            const e = new Error(`Chrome did not provide tab audio (${ответ.error}).`);
            e.again = 'fresh';
            throw e;
          }
          throw new Error('Chrome did not provide tab audio'
            + (ответ?.error ? ` (${ответ.error})` : '')
            + '. Click the extension icon on this tab again');
        }
        status({ step: 'беру звук по новому ключу' });
        // Ключ выдан — грант жив, повис сам захват: фон поднимет его заново
        // с новым документом, клик зрителя дал бы ту же попытку.
        return взять(ответ.streamId).catch(() => {
          const e = new Error('Chrome did not provide tab audio even with a fresh key.');
          e.again = 'fresh';
          throw e;
        });
      });
  }).then(async (поток) => {
    // Пока поток выдавали, вкладку могли отпустить: гасить его теперь некому,
    // кроме нас, иначе вкладка останется захваченной навсегда.
    if (меткаЗаявки !== моя) { поток.getTracks().forEach((t) => t.stop()); return поток; }
    // Звук забран у вкладки целиком, поэтому его надо вернуть человеку, иначе
    // вкладка замолкает. Играем отдельным элементом в исходном качестве — граф
    // ниже работает на 16 кГц и для прослушивания не годится.
    status({ step: 'возвращаю звук вкладке' });
    playback = new Audio();
    playback.srcObject = поток;
    await playback.play().catch(() => {});
    выдан = поток;
    return поток;
  });
  // Отказ помним, но не навсегда: следующий запуск обязан попробовать заново,
  // уже со свежим ключом.
  заявка.catch(() => { if (вкладка === tabId) { вкладка = null; заявка = null; } });
  return заявка;
}

/** Отпускает вкладку: только так её звук возвращается ей самой. */
function отпуститьВкладку() {
  const было = заявка;
  вкладка = null;
  заявка = null;
  выдан = null;
  меткаЗаявки = null;
  stream = null;
  if (playback) { playback.pause(); playback.srcObject = null; playback = null; }
  было?.then((п) => п.getTracks().forEach((t) => t.stop()), () => {});
}

/**
 * Граф звука вкладки: 16 кГц моно в смеситель под ключом 'tab'. Модели хотят
 * ровно 16 кГц моно — просим их у AudioContext напрямую, ресемплинг сделает
 * сам браузер, качественнее любого ручного.
 */
async function слушатьВкладку(поток) {
  закрытьГрафВкладки();
  const мой = сеанс;
  const c = ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await c.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
  if (ctx !== c || мой !== сеанс) return;
  const src = c.createMediaStreamSource(поток);
  tap = new AudioWorkletNode(c, 'tap', {
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });
  tap.port.onmessage = (ev) => влить('tab', ev.data);
  src.connect(tap);
  // Дорожка кончилась — вкладку закрыли или Chrome сам оборвал захват.
  // Переход вкладки на другой сайт её НЕ обрывает: взятая на «Новой вкладке»
  // дорожка слышит Apple Music, куда в ней ушли (стенд, 11.10). Закрытую
  // вкладку фоновый скрипт гасит сам (tabs.onRemoved), иначе панель подскажет
  // нажать значок: звук больше не приходит.
  поток.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (stream === поток) вкладкаУмерла();
  }, { once: true });
}

function закрытьГрафВкладки() {
  tap?.port.close();
  tap?.disconnect();
  tap = null;
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  источники.delete('tab');
}

function вкладкаУмерла() {
  закрытьГрафВкладки();
  отпуститьВкладку();
  // Слушать больше нечего: фон берёт новый ключ той же вкладки и поднимает
  // сеанс сам (закрытую вкладку он гасит по tabs.onRemoved).
  // 'key': звук кончился, поток мёртв — фону нужен новый ключ, а его Chrome
  // отдаёт не сразу после обрыва.
  умер('Tab audio stopped.', сеанс, 'key');
}

/** Клик по значку на другой вкладке посреди сеанса: меняем только её поток. */
async function взятьВкладку(streamId, tabId) {
  // Сеанса нет — переносить нечего. Отказ, а не молчаливый успех: фон иначе
  // записал бы в сеанс новую вкладку, которую никто не слушает.
  if (!segmenter) throw new Error('not listening');
  const мой = сеанс;
  const поток = await звукВкладки(tabId, streamId);
  if (мой !== сеанс || (поток === stream && tap)) return;
  stream = поток;
  await слушатьВкладку(поток);
}

// --- Смеситель ---------------------------------------------------------------
//
// Звук идёт в модель одной дорожкой. Источник сейчас один, вкладка ('tab'),
// но смеситель устроен под несколько: каждый шлёт
// куски по 1024 отсчёта в своём темпе; смеситель держит по очереди на
// источник и выдаёт сумму, как только кусок есть у всех, кто сейчас звучит.
// Ждать его лишнего не приходится: один источник — кусок уходит в тот же миг.
// Замолчавший источник ждём не дольше 150 мс, а через 300 мс забываем.

const MIX = 1024;
const SILENT = 1e-4;          // цифровая тишина, −80 дБ
const источники = new Map();  // ключ источника → { q, off, n, last }
let выдалиВ = 0;              // когда смеситель выдал последний кусок
let доложено = 0;             // сколько мс тишины доложено после звука
let метроном = null;

function пик(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    if (a > p) p = a;
  }
  return p;
}

function влить(key, chunk) {
  if (!segmenter) return;
  let s = источники.get(key);
  if (!s) источники.set(key, s = { q: [], off: 0, n: 0, last: 0 });
  s.q.push(chunk);
  s.n += chunk.length;
  s.last = performance.now();
  // Отстающий источник не копит задержку без меры: больше секунды — старое вон.
  while (s.n > SAMPLE_RATE) {
    s.n -= s.q.shift().length - s.off;
    s.off = 0;
  }
  смешать();
}

function взять(s, out) {
  let i = 0;
  while (i < MIX && s.q.length) {
    const head = s.q[0];
    const k = Math.min(MIX - i, head.length - s.off);
    for (let j = 0; j < k; j++) out[i + j] += head[s.off + j];
    i += k;
    s.off += k;
    s.n -= k;
    if (s.off === head.length) { s.q.shift(); s.off = 0; }
  }
}

function смешать() {
  if (!segmenter) return;
  const now = performance.now();
  for (const [k, s] of источники) if (!s.n && now - s.last > 300) источники.delete(k);
  for (;;) {
    let wait = false, any = false;
    for (const s of источники.values()) {
      if (s.n) any = true;
      if (s.n < MIX && now - s.last < 150) wait = true;
    }
    if (wait || !any) return;
    const out = new Float32Array(MIX);
    for (const s of источники.values()) взять(s, out);
    выдалиВ = now;
    доложено = 0;
    кормить(out);
  }
}

/**
 * Тишина, когда звука нет нигде. Поток договаривает последние слова только на
 * звуке, который идёт за ними, а сегментатор закрывает фразу только по паузе:
 * без этого конец каждой реплики висел бы до следующего звука в браузере. Но
 * не дольше трёх секунд — дальше считать нечего, и браузер, в котором ничего
 * не играет, видеокарту не греет.
 */
function тик() {
  if (!segmenter) return;
  смешать();
  // Пока узел вкладки жив, он шлёт куски и в тишине: молчит он, только когда
  // этот поток стоял (сборка мусора, перевод, свёрнутое окно). Источник за
  // 300 мс забыт, и раньше тут на всю стоянку подкладывались нули — посреди
  // фразы, перед её же звуком, который ждал в очереди порта. Модель слышала
  // обрыв, а сегментатор паузу.
  if (источники.size || tap) return;
  const step = MIX / (SAMPLE_RATE / 1000);
  while (performance.now() - выдалиВ >= step && доложено < 3000) {
    кормить(new Float32Array(MIX));
    выдалиВ += step;
    доложено += step;
  }
}

function развернуть(b64) {
  const bin = atob(b64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Float32Array(b.buffer);
}

async function start(streamId, config, kind, token = 0, tabId = null) {
  if (token && token === сеанс) return;   // то же задание, второй гонец
  // Сеанс ещё шёл — это перезапуск посреди звука (смена языка в панели), stop()
  // не звался и lastStopAt старый.
  const wasLive = !!сеанс;
  сеанс = token || сеанс + 1;
  const мой = сеанс;
  связаться();
  teardown(false);
  cfg = { ...cfg, ...config };
  cfg.target = mtCode(cfg.target);
  if (cfg.draft !== 'soda') cfg.draft = draftFor(cfg.draft);
  // Язык прошлого сеанса — ПОКА старое состояние не стёрто ниже. Берём его как
  // затравку перевода только на быстром перезапуске под «авто»: словарь пары с
  // прошлого сеанса ещё резидентен (translators не чистится), и перевод пойдёт с
  // первой же строки, без паузы на четыре слова. Сеем detLang, а НЕ слот модели:
  // ошибка слота глушит поток целиком (memory/auto-slot-swallows-speech), а
  // ошибка источника перевода самокорректируется — liveLang=='' оставляет
  // sniffLang включённым, и он переспросит язык по новому тексту.
  //
  // Перезапуск посреди сеанса — самый тёплый случай из всех: тот же звук, та же
  // секунда. Пока затравка ждала только стопа, смена языка перевода начинала
  // ленту строкой без языка, и она так и оставалась непереведённой.
  const seedLang = (config.source === 'auto' && (wasLive || Date.now() - lastStopAt < WARM_SEED_MS))
    ? (liveLang ? mtCode(liveLang) : detLang) : '';
  segmenter = new Segmenter({ sampleRate: SAMPLE_RATE });
  liveLine = 0;
  liveText = '';
  sniffBits = [];
  labelText = null;
  sniffGen++;
  liveFrom = 0;
  liveCont = false;
  liveStale = false;
  partialAgain = false;
  finalMark = -1;
  liveDone = 0;
  resetNo++;
  sessionAt = Date.now();
  liveMarks = 0;
  liveMs = 0;
  liveSec = 0;
  liveDropped = 0;
  liveSkipped = 0;
  // Начало отсчёта звука — тоже заново: услышанное (liveDone и прочие выше)
  // воркер после RESET считает с нуля, и со старым firstAt отставание после
  // смены языка выходило временем всего прошлого сеанса — 114 с на стенде.
  Object.assign(fed, { chunks: 0, samples: 0, firstAt: 0, lastAt: 0, gaps: 0 });
  liveLang = '';
  detLang = '';
  // Затравка перевода с прошлого сеанса (см. выше): переводим ею, пока модель
  // или sniffLang не назовут язык заново. Словарь по ней НЕ спрашиваем: язык
  // мог смениться, и баннер «⬇ EN → PL» на русской речи читается как ошибка
  // (жалоба пользователя 07.10). checkPack позовётся сам, когда реальный язык
  // этого сеанса услышан (heardLang/sniffLang), и покажет верную пару.
  detSeeded = !!seedLang;
  if (seedLang) detLang = seedLang;
  detectorOff = false;  // новая сессия: вдруг детектор Chrome уже докачался
  langSeen = 0;
  langAt = 0;
  // Номера строк начинаются заново, да и язык перевода у нового сеанса может
  // быть другой: переведённое начало прошлой строки с тем же номером склеилось
  // бы с новым хвостом.
  mtCache.clear();
  // Просьба о словаре относилась к прошлому сеансу и к прошлому языку: если
  // она нужна и теперь, checkPack() попросит заново.
  packAsked.clear();
  // Отказ загрузки — тоже прошлого сеанса: новый (зритель сменил язык или
  // включил заново) пробует пару снова.
  mtFailed.clear();
  mtLost.clear();
  mtWaitNet.clear();
  sessionGen++;
  // Запрет на пересборку переводчика — только на время недавнего отказа. Новый
  // сеанс встречает пару без долга: вдруг инстанс прошлого сеанса уже умер, и
  // первую же строку надо пересобрать сразу, не выжидая cooldown.
  mtCooldown.clear();
  mtResets = 0;
  packStatus();

  status({ stage: 'capturing', step: 'беру звук' });

  // Источник один: вкладка, на которой нажали значок. Chrome отдаёт её целиком,
  // через tabCapture: всё, что в ней звучит, с DRM и чужими файлами. Такой
  // поток забирает звук у вкладки, и его надо вернуть пользователю, иначе
  // вкладка замолкает. Ключа нет (Chrome не отдаёт эту страницу, или
  // «включить» нажали в панели, а грант клика ушёл с переходом вкладки) —
  // слушать нечего, это ошибка с подсказкой нажать значок.
  if (streamId) {
    let why = '', fail = null;
    stream = await звукВкладки(tabId, streamId).catch((e) => {
      console.warn('вкладку целиком не дали:', e?.message || e);
      why = String(e?.message || e || '');
      fail = e;
      return null;
    });
    if (мой !== сеанс) return;
    // Причина Chrome — в ошибку: «не дали звук» без неё не разобрать ни зрителю,
    // ни нам по отзыву (NotAllowedError, NotReadableError, просроченный ключ).
    if (!stream) {
      teardown(false);
      if (fail?.again) throw fail;
      // «Invalid state» и «active stream» — вкладку держит наш прежний захват,
      // а не отказ гранта: новый документ его отпустит, фон поднимет сам.
      if (/Invalid state|active stream|Error starting tab capture/i.test(why)) {
        const e = new Error(`Chrome gave no audio for this tab (${why}).`);
        e.again = 'fresh';
        throw e;
      }
      throw new Error(why.startsWith('Chrome did not provide') ? why
        : `Chrome gave no audio for this tab${why ? ` (${why})` : ''}. Click the extension icon on the tab that is playing.`);
    }
  } else {
    // Перезапуск без нового клика по значку: прежняя вкладка, если её поток
    // жив, слушается как слушалась.
    stream = выдан?.getAudioTracks()[0]?.readyState === 'live' ? выдан : null;
    if (!stream) отпуститьВкладку();
  }
  if (!stream) {
    teardown(false);
    throw new Error('Chrome gave no audio for this tab. Click the extension icon on the tab that is playing.');
  }
  // Каждый шаг — отдельной строкой в статусе, и не ради красоты. Любой из
  // await'ов ниже способен не вернуться вовсе (getUserMedia на отозванном
  // гранте, addModule на задушенной машине), и тогда снаружи видно только
  // «стадия capturing» — ни ошибки, ни логов, ни единого запроса в сеть. На
  // поиск такого молчания 2 октября ушло три прогона: виноват был кончившийся
  // лимит inotify, а искали регрессию в своей же правке.
  status({ step: 'строю граф звука' });

  // Сколько секунд снять — приезжает в конфиге, вместе со всем остальным.
  // Спросить самим негде: в offscreen-документе из расширенческих API живёт
  // один chrome.runtime, обращение к chrome.storage там — TypeError, и он
  // однажды уже уронил захват (стадия осталась «idle», два прогона в никуда).
  // Отдельное сообщение к service worker вместо этого тоже пробовал —
  // ответ приходил пустым, а ошибки не было; конфиг едет сюда и так.
  tapDump.want = Math.round((Number(config?.tapDump) || 0) * SAMPLE_RATE);
  tapDump.buf = tapDump.want ? new Float32Array(tapDump.want) : null;
  tapDump.n = 0;
  tapDump.sent = false;

  await слушатьВкладку(stream);
  if (мой !== сеанс) return;

  status({ step: 'поднимаю модель' });
  // Сборка сменилась (стенд выбрал другую). Старую гасим до того, как
  // поднимать новую: две модели, собирающиеся разом, в один процесс рендерера
  // не влезают (пик у каждой больше гигабайта, прогон 26 сентября встал на
  // этом намертво на полтора часа).
  // Так же со сменой процессора на видеокарту: устройство выбирается при сборке.
  if (streamer && (streamer.id !== cfg.draft || !!streamer.gpu !== wantsGpu())) {
    streamer.w.terminate();
    streamer = null;
  }
  streamer ??= spawnStreamer(cfg.draft);
  streamer.w.postMessage({ type: 'RESET', no: resetNo });
  streamer.w.postMessage({ type: 'LANGUAGE', language: cfg.source });
  выдалиВ = performance.now();
  доложено = 0;
  метроном ??= new Worker('clock.js');
  метроном.onmessage = тик;
  status({ step: '', source: 'tab' });
  return 'tab';
}

/**
 * Кусок звука, 1024 отсчёта на 16 кГц моно, — всё, что конвейеру нужно знать.
 *
 * Приходит он от узла звука вкладки через смеситель.
 */
function кормить(data) {
  // Порт закрывают на остановке, но куски, уже отданные узлом звука, ещё в
  // пути: сегментатора к их приходу нет, и push по нему падает. Сеанс
  // кончен, считать нечего — просто выходим.
  if (!segmenter) return;
  const now = performance.now();
  // Когда звука нет нигде, смеситель молчит (см. тик), и пауза в подаче — не
  // отставание: начало отсчёта сдвигаем на неё, иначе отставание строки
  // росло бы на каждую паузу в браузере.
  if (fed.firstAt) {
    const ahead = now - (fed.firstAt + (fed.samples + data.length) / (SAMPLE_RATE / 1000));
    if (ahead > 1000) { fed.firstAt += ahead; fed.gaps++; }
  }
  fed.chunks++;
  fed.samples += data?.length || 0;
  fed.lastAt = now;
  if (!fed.firstAt) fed.firstAt = fed.lastAt;
  if (tapDump.buf && !tapDump.sent) {
    // Ждём, пока в захвате появится звук. Захват встаёт по нажатию кнопки, а
    // ролик стенд пускает только после загрузки весов — между этим полминуты
    // тишины, и слепок из неё не сверить ни с чем: корреляция даёт ровный
    // ноль. Первый удавшийся слепок ушёл именно так.
    let writing = tapDump.n > 0;
    if (!writing) {
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > 0.01) { writing = true; break; }
      }
      // Время первого отсчёта, а не прихода куска: кусок доезжает уже
      // сыгранным, и его длина — это те самые десятки миллисекунд, ради
      // которых слепок и затеян.
      if (writing) tapDump.at = performance.timeOrigin + fed.lastAt - data.length / SAMPLE_RATE * 1000;
    }
    // Ни одного выхода из обработчика по дороге: ниже этого места звук
    // уходит в поток и в сегментатор, и отладочный слепок не имеет права
    // их обойти. Один `return` тут — это молчащий конвейер.
    if (writing) {
      const take = Math.min(data.length, tapDump.want - tapDump.n);
      tapDump.buf.set(data.subarray(0, take), tapDump.n);
      tapDump.n += take;
      if (tapDump.n >= tapDump.want) {
        tapDump.sent = true;
        const b = new Uint8Array(tapDump.buf.buffer);
        let bin = '';
        for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192));
        // Время первого отсчёта в той же шкале, что и Date.now() у стенда:
        // без него слепок не с чем сверять.
        send({ type: 'TAP_DUMP', at: Math.round(tapDump.at), pcm: btoa(bin) });
      }
    }
  }
  // Поток кормим сразу и своей копией: сегментатор держит оригинал, а буфер
  // уходит в воркер передачей — тот же самый отдать обоим нельзя.
  if (streamer) {
    // Звук, отданный потоку до того, как он собрался, он же и выбросил:
    // копить восемьсот мегабайт загрузки нечем. Считаем его отдельно —
    // иначе отставание строки окажется занижено ровно на время загрузки,
    // и мерить будет нечего.
    //
    // Это прикидка до первой строки: точный счёт ведёт воркер и присылает его с
    // каждой строкой (skipped), — отправленное до ready может дойти до модели
    // уже готовой, и наоборот. По at он отличает звук, застрявший в очереди.
    if (!streamer.ready) liveSkipped += data.length;
    const copy = data.slice();
    streamer.w.postMessage({ type: 'FEED', pcm: copy, at: performance.timeOrigin + performance.now() }, [copy.buffer]);
  }
  const seg = segmenter.push(data);
  // Панели нужен признак «слова считаются прямо сейчас», а не только готовый
  // текст: между прибавками потока проходит до полусекунды, а до первой
  // прибавки новой фразы — и вся её первая половина. Без этого признака
  // зритель не понимает, слушают ли его вообще, и любую паузу читает как
  // зависшую задержку.
  beat(segmenter.loud);
  if (!seg) return;
  const ph = phrase++;
  // Потоку граница фразы — не работа, а новость: строку он на ней закроет,
  // а неполный кусок тишиной не добьёт (см. mark в live-worker.js). cut
  // говорит, договорено ли последнее слово.
  if (streamer) {
    liveMarks++;
    streamer.w.postMessage({ type: 'MARK', phrase: ph, cut: seg.cut });
  }
}

/**
 * Рвёт захват. Незакрытая фраза при этом не пропадает: и на кнопке «стоп», и на
 * паузе в плеере человек обрывает речь ровно посередине, а сегментатор ждёт
 * тишины, которой уже не будет. keepTail=false нужен только при перезапуске:
 * там этот звук относится к прошлому сеансу.
 */
function teardown(keepTail) {
  // Последний неполный кусок звука ещё лежит в буфере потока. На остановке его
  // надо добить (end) — иначе последнее слово сеанса не выйдет наружу вовсе;
  // при перезапуске добивать нечего, поток начнётся заново. Конец звука — не
  // таймер, поэтому cut ложный.
  if (streamer && keepTail) {
    liveMarks++;
    finalMark = phrase++;
    streamer.w.postMessage({ type: 'MARK', phrase: finalMark, cut: false, end: true });
  }
  segmenter = null;
  if (метроном) метроном.onmessage = null;
  закрытьГрафВкладки();
  источники.clear();
  // Звук вкладки отпускаем только на остановке: при перезапуске он достаётся
  // новому сеансу, и повторно его у Chrome не выпросить (см. звукВкладки).
  if (keepTail) отпуститьВкладку();
}

/**
 * Захват уже оборван, но последний кусок ещё считается. Дожидаемся его — иначе
 * сразу после ответа на OFFSCREEN_STOP документ закрывают, вместе с ним умирает
 * воркер, и последняя фраза сеанса не доходит до субтитров вовсе.
 */
async function drain(ms = 15000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // Воркер умер — отметок он уже не закроет, ждать их незачем.
    if ((!liveMarks || !streamer) && !inflight) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Сменить язык перевода посреди сеанса, не трогая звук и распознавание.
 *
 * Раньше смена шла полным перезапуском (start): RESET потока, захват вкладки
 * заново, и лента секунд шесть стояла пустой с «ждём речь», пока поток снова
 * набирал слова (жалоба 27.10 «первые 6 секунд waiting вместо перевода»).
 * Распознаванию язык перевода не нужен, поэтому меняем только пару: строки
 * прежней пары панель и плашка отбросят по since (sessionAt новый), а живая
 * строка уходит заново сразу, уже на новом языке.
 */
function retarget(target, token = 0) {
  if (!сеанс || (token && token !== сеанс) || !target) return false;
  // Та же цель — всё равно заново: панель уже стёрла ленту, и без нового
  // sessionAt строки отсекались бы по since.
  cfg = { ...cfg, target: mtCode(target) };
  sessionAt = Date.now();
  // Всё про прошлую пару: кеш переведённых начал строк, просьбы, отказы.
  mtCache.clear();
  packAsked.clear();
  mtFailed.clear();
  mtLost.clear();
  mtWaitNet.clear();
  sessionGen++;
  mtCooldown.clear();
  packStatus();
  // Пара новой цели качается сразу (кольцо в панели), не дожидаясь строки.
  checkPack();
  if (liveText.trim()) {
    if (partialBusy) partialAgain = true;
    else snapshot();
  }
  return true;
}

async function stop(token = 0) {
  // Просят погасить не тот сеанс, который идёт, — значит его уже погасили, а
  // это дошёл запоздавший приказ. Молча соглашаемся.
  if (token && сеанс && token !== сеанс) return;
  сеанс = 0;
  // Статус пары — про этот сеанс: после стопа его кольцо или отказ ничьи.
  packKey = packCan = '';
  // Сеанса нет — и связь не нужна: иначе она будила бы уснувший фон.
  связь?.disconnect();
  связь = null;
  // Миг остановки — для затравки языка на быстром перезапуске (см. start).
  // liveLang/detLang переживают стоп в состоянии модуля, стирает их только start.
  lastStopAt = Date.now();
  // Снимаем показания звука до teardown: он закрывает AudioContext и глушит
  // дорожку, а нам нужно их состояние на момент конца сеанса, а не после.
  const t = stream?.getAudioTracks?.()[0];
  const g = ctx;
  fed.graphSec = +(g?.currentTime || 0).toFixed(1);
  fed.graph = g?.state || '?';
  fed.track = t ? `${t.readyState}${t.muted ? ' (заглушена)' : ''}` : 'нет';
  teardown(true);
  await drain();
  // Ждём подтверждения записи: сразу после нас отвечают на OFFSCREEN_STOP, и
  // стенд тут же читает storage. Без await он читает то, что было до нас.
  await status({
    // Какой язык услышали и на какой секунде назвали его модели.
    heard: liveLang,
    heardAt: langAt,
    fed: {
      seconds: +(fed.samples / SAMPLE_RATE).toFixed(1),
      chunks: fed.chunks,
      // Сколько времени прошло между первым и последним куском: если звук шёл
      // ровно, это почти равно секундам выше.
      spanSec: +((fed.lastAt - fed.firstAt) / 1000).toFixed(1),
      graphSec: fed.graphSec,
      graph: fed.graph,
      track: fed.track,
      // Взвели ли отладочный слепок и набрался ли он. Без этих двух чисел
      // непонятно, почему файла нет: ключ не доехал или звук не набрался.
      tapWant: tapDump.want,
      tapGot: tapDump.n
    }
  });
}

/**
 * Задание приходит двумя гонцами: OFFSCREEN_CAPTURE и OFFSCREEN_READY. Второй
 * получает обещание первого, а не пустой успех: иначе отказ запуска уходил
 * только тому гонцу, которого никто не слушает, а фон записывал сеанс живым.
 */
let запуск = null;
// Предел запуска здесь, а не только в фоне: фон за минуту ожидания может
// уснуть вместе со своим таймером, а путь OFFSCREEN_READY не ждёт никто.
// Повисший getUserMedia или addModule иначе держал сеанс «живым» без звука.
const START_LIMIT_MS = 80000;
function начать(m) {
  if (m.token && запуск?.token === m.token) return запуск.p;
  let timer;
  const p = Promise.race([
    start(m.streamId, m.config, m.kind, m.token, m.tabId),
    new Promise((_, no) => { timer = setTimeout(() => {
      const e = new Error('Audio capture did not start.');
      // Сеанс снимаем сами: опоздавший await старта иначе довёл бы его до
      // субтитров, о которых фон уже не знает. Запуск уже перебит новым
      // сеансом или стопом — отказ его тихий, как у любого перебитого.
      e.timedOut = !!m.token && m.token === сеанс;
      if (e.timedOut) { умер(e.message, m.token, 'fresh'); stop(m.token); }
      no(e);
    }, START_LIMIT_MS); }),
  ]).finally(() => clearTimeout(timer)).catch((e) => {
    // Отказ сообщаем один раз, здесь: гонцов двое (CAPTURE и READY), и первый,
    // сняв сеанс, выдал бы второму отказ за перебитый запуск — фон записал бы
    // мёртвый сеанс живым.
    if (!(e instanceof Error)) e = new Error(String(e));
    if (e.timedOut) e.reported = true;
    else if (m.token && m.token === сеанс) {
      умер(e.message, m.token, e.again || false);
      stop(m.token);
      e.reported = true;
    }
    throw e;
  });
  запуск = { token: m.token, p };
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_CAPTURE') {
    начать(msg)
      .then((source) => sendResponse({ ok: true, source }))
      .catch((e) => {
        // Отказ перебитого сеанса наружу не идёт. Новый сеанс закрывает и граф,
        // и воркеры прежнего (teardown), поэтому любой недоделанный await
        // старого отвечает отказом — то «Invalid state» на звуке вкладки, то
        // «Unable to load a worklet's module» на графе. Субтитры при этом идут,
        // и такая ошибка садилась в статус поверх живого захвата.
        // Отказ своего запуска начать() уже сообщил (SESSION_DEAD) и снял
        // сеанс. again — фон поднимет его сам; иначе ошибку покажет begin.
        if (e?.reported) return sendResponse({ ok: false, again: !!e.again || !!e.timedOut, error: String(e.message) });
        if (msg.token && msg.token !== сеанс) return sendResponse({ ok: true });
        status({ error: String(e.message || e) });
        sendResponse({ ok: false, error: String(e.message || e) });
      });
    return true;
  }
  if (msg.type === 'OFFSCREEN_TAB') {
    взятьВкладку(msg.streamId, msg.tabId)
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_TARGET') return void sendResponse({ ok: retarget(msg.target, msg.token) });
  if (msg.type === 'OFFSCREEN_STOP') { stop(msg.token).then(() => sendResponse({ ok: true })); return true; }
});

// createDocument() резолвится раньше, чем этот скрипт вешает onMessage,
// поэтому задание забираем сами, как только готовы.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' })
  .then(job => {
    if (!job?.kind) return;
    // Отказ этого пути никто не ждёт: фон уже записал сеанс живым. Сообщаем сами.
    // Свой отказ начать() сообщил сам, чужой (перебитый запуск) — тихий.
    return начать(job).catch(() => {});
  })
  .catch(() => {});
