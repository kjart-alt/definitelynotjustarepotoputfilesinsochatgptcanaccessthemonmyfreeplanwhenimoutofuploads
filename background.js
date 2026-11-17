// Service worker: сводит вместе вкладку, offscreen-документ с моделью
// и боковую панель — единственное окно расширения.
//
// MV3 усыпляет воркер между сообщениями, поэтому всё состояние живёт
// в chrome.storage, а не в переменных модуля.

import { DEFAULT_DRAFT } from './lib/models.js';
import { mtCode, TARGET_PICKS } from './lib/languages.js';
import { feed, fix } from './lib/cues.js';
import { journal } from './lib/journal.js';
import { autosave } from './lib/autosave.js';
import { PACK_OFFLINE, PACK_STALL_MS, canPair, cutCreate, reach } from './lib/packs.js';
import { diagQuery } from './lib/diag.js';
import { FirefoxTranslator, Translator, pick, race, sweep } from './lib/firefox-mt.js';

// Панель живёт на вкладке, где нажали значок (movePanel), на прочих её нет.
// Общую выключаем на каждом пробуждении: Chrome держит это только в памяти, и
// после перезапуска браузера снова действует default_path из манифеста.
chrome.sidePanel?.setOptions({ enabled: false }).catch(() => {});

// Поставили — показываем, как закрепить значок: без него расширение не найти,
// а включается оно именно значком. Удалили — спрашиваем почему: страница на
// нашем сайте, своей странице расширения после удаления не открыться.
const UNINSTALL_URL = 'https://audio-translator.pages.dev/uninstall/';
// Адрес удаления (и железо в diag, его же берёт отзыв на 1–3 звезды) — на
// каждом старте фона: прослойка Android onInstalled не шлёт, и до первого
// сеанса отзыв ушёл бы без железа. Железо спрашивается один раз.
void uninstallUrl();
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) void welcome();
  clearStaleStatus();
  dropStaleOverlays();
  sweep(fetchPack).catch(() => {});
});

// Opera (138) расширению с командной строки шлёт INSTALL на каждом запуске, и
// storage.local при этом цел: приветствие — по отметке, раз на установку
// (06.11 в профиле скопилось 15 вкладок welcome).
async function welcome() {
  const { welcomed } = await chrome.storage.local.get('welcomed');
  if (welcomed) return;
  await chrome.storage.local.set({ welcomed: true });
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
}

// --- Что приложить к отзыву при удалении --------------------------------------
//
// Удалённое расширение уже ничего не отправит, но страницу удаления Chrome
// открывает по адресу, поставленному заранее, и страница сама отсылает то, что в
// нём лежит. Что именно — в lib/diag.js: то же едет и к отзыву на 1–3 звезды.
let diagChain = Promise.resolve();
let diagTimer = 0;
function noteDiag(fn) {
  diagChain = diagChain.then(async () => {
    const { diag = {} } = await chrome.storage.local.get('diag');
    if (fn(diag) === false) return;
    await chrome.storage.local.set({ diag });
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => void uninstallUrl(), 2000);
  }).catch(() => {});
}

// Железо не меняется: спрашиваем один раз и кладём к счётчикам.
async function hardware() {
  const hw = { mem: navigator.deviceMemory || 0, cpu: navigator.hardwareConcurrency || 0 };
  const ua = await navigator.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness', 'platformVersion'])
    .catch(() => null);
  if (ua) hw.arch = `${ua.architecture || ''}${ua.bitness || ''}`, hw.os = ua.platformVersion || '';
  const a = await navigator.gpu?.requestAdapter?.().catch(() => null);
  hw.gpu = a ? [a.info?.vendor, a.info?.architecture].filter(Boolean).join(' ') || 'yes' : 'no';
  return hw;
}

async function uninstallUrl() {
  const { diag = {} } = await chrome.storage.local.get('diag');
  // Железо пишем той же очередью, что и счётчики: на старте фона их правка
  // идёт рядом, и прямая запись затёрла бы её (или она — железо). Очередь сама
  // позовёт нас снова.
  if (!diag.hw) {
    const hw = await hardware().catch(() => ({}));
    return noteDiag((d) => { if (d.hw) return false; d.hw = hw; });
  }
  const q = diagQuery(diag, chrome.runtime.getManifest().version);
  // Chrome не берёт адрес длиннее 1023 знаков.
  const url = `${UNINSTALL_URL}?${q}`.slice(0, 1023);
  await chrome.runtime.setUninstallURL(url).catch(() => {});
}

// Статус лежит в storage.local и переживает перезапуск браузера, обновление и
// перезапуск приложения Android: ошибка прошлого запуска висела бы в панели,
// хотя захвата уже нет. Документа с моделью нет — нет и сеанса.
async function clearStaleStatus() {
  if (await chrome.offscreen.hasDocument().catch(() => false)) return;
  // pack тоже: «качается» без offscreen некому снять.
  await setStatus({ stage: 'idle', error: null, download: null, need: null, kind: null, source: null, step: '', pack: null });
}
chrome.runtime.onStartup.addListener(() => {
  void clearStaleStatus();
  // Остатки словарей bergamot: прежние файлы и пары, которые уже переводит Chrome.
  sweep(fetchPack).catch(() => {});
});

// Язык перевода до первого выбора — язык интерфейса браузера. Был зашит
// русский, и любой, кто поставил расширение не из России, получал на первом же
// ролике русские субтитры. Совпал язык браузера с языком звука — перевод
// тождественный, и на экране просто субтитры оригинала, это тоже верно.
// Языка интерфейса нет среди тех, на которые переводит Chrome, — английский.
function uiTarget() {
  const ui = (chrome.i18n.getUILanguage?.() || 'en').replace('_', '-');
  const base = ui.split('-')[0].toLowerCase();
  const code = base === 'zh' ? (/-(TW|HK|MO|Hant)/i.test(ui) ? 'zh-Hant' : 'zh')
    : base === 'iw' ? 'he' : base === 'no' ? 'nb' : base;
  return TARGET_PICKS.includes(code) ? code : 'en';
}

const DEFAULTS = {
  draft: DEFAULT_DRAFT,
  source: 'auto',
  target: uiTarget(),
  showOriginal: true,
  // Оригинал строкой над переводом — переключатель в настройках панели,
  // по умолчанию выключен.
  orig: false,
  // Где считает модель речи: cpu — своё ядро на Rust, gpu — свой кодировщик на
  // WebGPU (lib/nemo-gpu.js). Выбирают в настройках панели.
  device: 'cpu'
};

/**
 * Клик по иконке — это и «открой панель», и «слушай эту вкладку».
 *
 * Открывать панель надо первой же строчкой и не дожидаясь ничего:
 * sidePanel.open() пускают только под жестом пользователя, и любой await до
 * него жест съедает: с await setOptions впереди панель не открывается вовсе.
 * Без await можно: setOptions браузер исполняет сразу (RespondNow), и open()
 * следом застаёт панель этой вкладки уже включённой.
 *
 * Ради этого же обработчика попап и убран. Chrome умеет открывать панель по
 * клику и сам (setPanelBehavior), но тогда клик не считается вызовом
 * расширения: грант activeTab не выдаётся, и захват вкладки отказывает с
 * «Extension has not been invoked for the current page». Через onClicked грант
 * выдаётся — панель открыта и вкладку слушать можно.
 *
 * Захват запускаем тем же кликом, не дожидаясь кнопки в панели. Грант живёт до
 * перехода вкладки на другую страницу, а между «открыл панель» и «нажал
 * включить» зритель успевает и войти в встречу, и переключиться на соседнюю
 * вкладку — грант к этому времени уже отозван, и расширение отвечает отказом
 * на ровном месте. Здесь же грант заведомо свеж: это тот самый вызов.
 */
// Панель не открылась хоть раз (форк объявил API, а панели нет): ошибки тогда
// тоже показывает значок, см. setStatus.
let panelFailed = false;
// Флажок переживает сон воркера: иначе после пробуждения значок снова вёл бы
// себя как при панели (ни «ON», ни «!», клик не выключает).
chrome.storage.session.get('panelFailed').then((r) => { if (r.panelFailed) panelFailed = true; }, () => {});
// Режим без панели: и клик, и значок решают по одному признаку.
const noPanel = () => typeof chrome.sidePanel?.open !== 'function' || panelFailed;
chrome.action.onClicked.addListener((tab) => {
  if (noPanel()) {
    noPanelClick(tab).catch(async (e) => {
      await setStatus({ stage: 'idle', error: String(e.message || e) });
    });
    return;
  }
  try { chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true })?.catch?.(() => {}); } catch {}
  let armed = null;
  // Синхронный отказ (open есть, но бросает) — туда же, что и отказ обещанием.
  let opened;
  try { opened = Promise.resolve(chrome.sidePanel.open({ tabId: tab.id })); } catch (e) { opened = Promise.reject(e); }
  opened.catch(async (e) => {
    console.warn('панель не открылась:', e);
    panelFailed = true;
    chrome.storage.session.set({ panelFailed: true }).catch(() => {});
    noteDiag((d) => { d.e = `side panel: ${e?.message || e}`; });
    // Панели нет — нажать «включить» по флажку autostart некому, и клик молча
    // ничего не делал. Заводим захват сами, субтитры плашкой, как без
    // sidePanel вовсе (noPanelClick). Идущий сеанс armOrListen уже перенёс.
    // Флажок autostart armOrListen ставит после своих await: ждём его, иначе
    // снятый раньше флажок встал бы снова.
    await armed;
    await chrome.storage.session.remove('autostart').catch(() => {});
    // Сеанс уже идёт (armOrListen перенёс его сюда) — субтитры плашкой здесь же.
    await chrome.storage.session.set({ overlay: { tab: tab.id } });
    if (await getSession()) return;
    const res = await start(tab).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (res && !res.ok && !res.quiet) await setStatus({ stage: 'idle', error: res.error || 'could not start' });
  });
  clickTab(tab.id, 1);
  movePanel(tab.id);
  armed = armOrListen(tab).catch(async (e) => {
    await setStatus({ stage: 'idle', error: String(e.message || e) });
  });
  // Панель открылась, но «включить» не нажала (её скрипт не загрузился или
  // упал, панель закрыли до загрузки): флажок autostart лежит нетронутым, и
  // клик молча ничего не делал. Тогда заводим захват сами, субтитры плашкой.
  // Отсчёт — от взвода флажка, а не от клика: armOrListen может ждать подъём
  // сеанса (revive) дольше PANEL_START_MS.
  armed.then((r) => r?.at && setTimeout(async () => {
    if (panelFailed) return;
    const { autostart, session, pending } = await chrome.storage.session.get(['autostart', 'session', 'pending']);
    if (autostart?.at !== r.at || session || pending) return;
    await chrome.storage.session.remove('autostart');
    noteDiag((d) => { d.e = 'side panel did not start'; });
    await chrome.storage.session.set({ overlay: { tab: tab.id } });
    const res = await start(tab).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (res && !res.ok && !res.quiet) await setStatus({ stage: 'idle', error: res.error || 'could not start' });
  }, PANEL_START_MS));
});
// Сколько ждать, пока открытая кликом панель сама нажмёт «включить».
const PANEL_START_MS = 10000;

/**
 * Сеанс, если его offscreen-документ жив. Документ умирает и вместе с
 * процессом (нехватка памяти на слабой машине), SESSION_DEAD тогда прислать
 * некому, а сеанс в storage остаётся: клик по значку видел «идёт» и не делал
 * ничего. Такой сеанс снимаем.
 */
async function liveSession(out = {}) {
  // Номер до await: стоп или новый запуск, пришедшие пока мы ждали, — их
  // сеанс, не наш, и снимать его нельзя.
  const g0 = поколение;
  const session = await getSession();
  if (!session || !chrome.offscreen?.hasDocument) return session;
  // Документ жив — сеанс его: свой конец он сообщает сам (SESSION_DEAD), а
  // смерть документа фон слышит обрывом порта (onConnect ниже).
  if (await chrome.offscreen.hasDocument().catch(() => true)) return session;
  if (поколение !== g0) return getSession();
  // Номер снятия — для подъёма (revive сверит его со стопом после нас).
  out.gen = ++поколение;
  await chrome.storage.session.remove(['session', 'pending']);
  toPanel({ type: 'CAPTIONS_OFF' });
  return null;
}

/**
 * Браузер без боковых панелей (часть форков Chromium): панели нет, и
 * клик по значку сам включает захват этой вкладки, а субтитры идут плашкой
 * поверх страницы. Второй клик на той же вкладке выключает, на другой —
 * переносит. Ошибки показывает значок (см. setStatus): больше негде.
 */
async function noPanelClick(tab) {
  const session = await liveSession();
  if (session?.tabId === tab.id) return stop();
  // Запуск ещё идёт (модель грузится секунды, плашка пока пуста): второй
  // клик завёл бы второй захват той же вкладки, а его ключ Chrome не даёт, и
  // offscreen отпускал первый — «ошибка» вместо субтитров.
  const { pending } = await chrome.storage.session.get('pending');
  // Клик посреди запуска или перезапуска (revive) — «выключить», как и на идущем
  // сеансе: иначе он глотался, и выключить субтитры значком было нельзя.
  if (!session && (reviving || (pending && Date.now() - (pending.at || 0) < CLICK_FRESH_MS))) return stop();
  await chrome.storage.session.set({ overlay: { tab: tab.id }, [clickKey(tab.windowId)]: { tabId: tab.id, at: Date.now() } });
  if (session) return listen(tab);
  const res = await start(tab);
  if (res && !res.ok && !res.quiet) throw new Error(res.error || 'could not start');
  return res;
}

/**
 * Панель привязана к вкладке: что слушаем, видно там же, где слушаем. На
 * другой вкладке её нет, вернулись — она на месте с той же лентой: скрытую
 * панель Chrome держит живой, а не грузит заново.
 *
 * Модель от этого не двоится: она одна, в offscreen-документе, а панели только
 * рисуют. Нажали значок на другой вкладке — панель переезжает туда, прежнюю
 * гасим, когда на её вкладку вернутся (onActivated ниже).
 *
 * Вкладки с панелью — в panelTabs, текущая последней. Клики подряд идут
 * очередью: чтение и запись списка не должны перемешаться.
 */
let panelQueue = Promise.resolve();
// Вкладки, где значок уже нажат, а переезд панели ещё стоит в очереди. Клик
// сразу после возврата на вкладку: шаг onActivated, поставленный раньше, видит
// её ещё прежней и выключил бы только что открытую панель. Счёт, а не набор:
// второй клик той же вкладки ждёт в очереди своего переезда.
const clickedTabs = new Map();
const clickTab = (id, d) => {
  const n = (clickedTabs.get(id) || 0) + d;
  if (n > 0) clickedTabs.set(id, n); else clickedTabs.delete(id);
};
function movePanel(tabId) {
  panelQueue = panelQueue.then(async () => {
    const { panelTabs = [] } = await chrome.storage.session.get('panelTabs');
    await chrome.storage.session.set({ panelTabs: [...panelTabs.filter((id) => id !== tabId), tabId] });
  }).catch((e) => console.warn('панель не переехала:', e))
    .finally(() => clickTab(tabId, -1));
}

// Прежнюю панель гасим, когда на её вкладку вернулись, а не в момент переезда.
// Боковая панель Opera одна на окно: выключение панели фоновой вкладки прятало и
// только что открытую на текущей, и значок открывал её лишь со второго клика.
// Вкладку идущего сеанса не гасим: переезд захвата сюда мог не удаться, и
// сеанс остался на ней, а без панели его не видно и не выключить.
// Opera (138) открытую панель вкладки не прячет и здесь: ни выключение, ни
// close() её не закрывают (07.11, 08.11), прежняя остаётся до крестика
// зрителя. Ленты на ней нет: панель на вкладке без звука говорит, что слушаем
// другую, и даёт перенести звук к себе (away в ui/graphite.js).
chrome.tabs.onActivated.addListener(({ tabId }) => {
  panelQueue = panelQueue.then(async () => {
    const { panelTabs = [], session } = await chrome.storage.session.get(['panelTabs', 'session']);
    if (!panelTabs.includes(tabId) || panelTabs.at(-1) === tabId || session?.tabId === tabId || clickedTabs.has(tabId)) return;
    await chrome.storage.session.set({ panelTabs: panelTabs.filter((id) => id !== tabId) });
    // Клик мог прийти, пока писали список: проверка и выключение — без await
    // между ними, вклиниться ему некуда.
    if (clickedTabs.has(tabId)) return;
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  }).catch((e) => console.warn('прежняя панель не погасла:', e));
});

/**
 * Клик по значку без идущего сеанса: захват заводит сама панель, а не мы.
 *
 * Клик лишь открывает панель и оставляет ей флажок autostart — панель на
 * загрузке нажмёт «включить» сама, тем же путём, что и человек (START), и
 * слушает вкладку этого клика целиком.
 *
 * Идёт сеанс — клик переносит захват на эту вкладку (listen).
 */
async function armOrListen(tab) {
  // Сеанс сейчас поднимается сам: ждём его, а не заводим второй запуск поверх.
  // Тот перебил бы подъём и взял ключ без повтора, пока Chrome ещё держит
  // захват закрытого документа, — и вышла бы ошибка вместо субтитров.
  if (reviving) await reviving.catch(() => {});
  if (await liveSession()) {
    await chrome.storage.session.set({ [clickKey(tab.windowId)]: { tabId: tab.id, at: Date.now() } });
    return listen(tab);
  }
  // Словари перевода Chrome качает только под живым жестом пользователя
  // (NotAllowedError «Requires a user gesture», memory/mt-pack-needs-a-gesture).
  // Панель греет их на клике своей кнопки (warmPairs) — но значок запускает её
  // синтетическим els.go.click() без жеста (maybeAutostart), и там догрев молча
  // падал: перевода не было вовсе, пока зритель не трогал панель руками (это и
  // был баг «не переводит, переоткрою — переводит», и «ru→sl оставался
  // русским»). Единственный настоящий жест в пути значка — сам onClicked, а
  // Translator в воркере есть: качаем здесь. Докачается —
  // offscreen создаёт словарь уже без жеста ('available' его не требует).
  const [config, store] = await Promise.all([getConfig(), chrome.storage.local.get('lastSource')]);
  warmPacks(config, store.lastSource || '');
  // Вкладку клика запоминаем: «включить» панель нажмёт через секунду-другую, и
  // start() должен взять звук именно этой вкладки — грант activeTab выдан ей, а
  // «активная вкладка текущего окна» из воркера при двух окнах бывает чужой.
  // Флажок autostart панель стирает сразу, поэтому вкладка — отдельным ключом.
  const at = Date.now();
  await chrome.storage.session.set({ autostart: { at, windowId: tab.windowId }, [clickKey(tab.windowId)]: { tabId: tab.id, at } });
  return { ok: true, at };
}

// Пары, которые воркер качает сейчас. Все просьбы (клик по значку, панель,
// offscreen) ждут одну загрузку, и ход её идёт из одного monitor: прежде пару
// начинал warmPacks без monitor, а просьба offscreen той же пары хода от Chrome
// не получала — кольцо стояло на нуле до конца.
const packJobs = new Map();

/**
 * Скачать словарь пары. В воркере create() жеста не требует (замер 0.5.2.30),
 * поэтому качаем молча, без окна Chrome; инстанс сразу гасим — переводит
 * offscreen своим. Пара уже на диске — create() отвечает мгновенно. Ход,
 * «готово» (страницы переходят на Chrome) и стирание bergamot пути — в
 * Translator.create (firefox-mt.js), и когда ни панели, ни offscreen нет.
 */
function fetchPack(from, to) {
  const key = `${from}>${to}`;
  let job = packJobs.get(key);
  if (job) return job.p;
  job = { look: null };
  job.p = createPack(from, to, job)
    .then((t) => { t.destroy?.(); })
    .finally(() => packJobs.delete(key));
  packJobs.set(key, job);
  return job.p;
}

// Сколько create() может падать подряд, прежде чем сбой показан зрителю.
// С запасом на медленную сеть: библиотека перевода сама по себе десятки МБ.
const PACK_RETRY_MS = 3 * 60 * 1000;

/**
 * create() пары с повтором. Отказ create() не значит, что пары нет: в чистом
 * профиле Chrome сначала ставит саму библиотеку перевода (TranslateKit), и
 * первый create() ЛЮБОЙ пары, пока она ставится, падает NotSupportedError «Unable
 * to create translator» (замер 30.10: отказ на 4.2 с, повтор через 2 с
 * переводит). Так у каждого нового зрителя первая пара кончалась ошибкой в
 * панели. Поэтому сбой окончателен, только когда Chrome сам говорит, что пары
 * нет (unavailable), или create() падает дольше PACK_RETRY_MS.
 *
 * Сеть и срок загрузки (cutCreate) — здесь: offscreen и панель ждут ответа
 * WARM_PACK без своих. Срок один на всё задание (due) вместе с повторами:
 * ответ должен уйти раньше, чем Chrome погасит воркер. job.look смотрит сеть
 * задания сейчас (NET_OFF). Нативный переводчик Android качает сам и
 * повторяет — его не режем.
 */
async function createPack(from, to, job) {
  const pair = { sourceLanguage: from, targetLanguage: to };
  const cuttable = !self.Translator.native;
  const due = Date.now() + PACK_STALL_MS;
  for (const end = Date.now() + PACK_RETRY_MS; ;) {
    // Сеть до create() не спрашиваем: скачанную пару Chrome зовёт
    // downloadable (accept-languages), и без сети она бы не собралась.
    // Нескачанная без сети — молчание загрузки или отказ create(), ниже.
    try {
      // Докачал уже после срока — «готово» скажет сам create() (Translator).
      return await cutCreate(Translator, pair, { cuttable, until: due, hold: (look) => { job.look = look; } });
    } catch (e) {
      if (e?.message === PACK_OFFLINE) throw e;
      // create() упал, а сети уже нет: «нет интернета», а не сбой Chrome.
      if (cuttable && !await reach()) throw new Error(PACK_OFFLINE);
      // Пары нет или availability() молчит (падает) — повторять create() незачем.
      const can = await canPair(Translator, pair);
      if (can === 'unavailable' || can === 'failed' || Date.now() > end) throw e;
      if (cuttable && Date.now() + 2000 >= due) throw e;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

/**
 * Погреть словари перевода под жестом клика по значку (детектор — нет, см. ниже).
 *
 * Явный источник — его одного. Под «авто» язык речи ещё неизвестен, поэтому
 * греем самые вероятные пары: язык прошлого сеанса и английский (как warmPairs
 * в панели). Качаются оба словаря пары (race, как везде): переводить будет
 * offscreen, сессию bergamot здесь сразу отпускаем. Пара не поддерживается
 * или уже скачана — create() отвечает мгновенно, лишнего скачивания нет.
 */
async function warmPacks(config, lastSource) {
  // Переводит bergamot (Translator нет, выключен — Опера с WebAI, натив
  // телефона без своего движка): его качают страницы.
  const T = await pick();
  if (T === FirefoxTranslator) return;
  const target = mtCode(config.target);
  const froms = config.source === 'auto'
    ? [...new Set([lastSource, 'en'].filter(Boolean).map(mtCode))]
    : [mtCode(config.source)];
  for (const from of froms) {
    if (!from || from === target) continue;
    // Натив телефона — сам bergamot: движок один, качает его он.
    if (T.native) { fetchPack(from, target).catch(() => {}); continue; }
    const pair = { sourceLanguage: from, targetLanguage: target };
    // Словарь Chrome на диске — bergamot не качаем (остаток стирает сам ответ).
    canPair(Translator, pair).then((can) => can !== 'available'
      && race(pair, () => fetchPack(from, target)).then((r) => r.ff?.destroy()))
      .catch(() => {});
  }
  // LanguageDetector здесь НЕ создаём: Chromium 147 роняет весь процесс
  // расширения (SIGSEGV в «ServiceWorker thread», Terminate →
  // DispatchOnV8ContextDestroyed), когда гасит простаивающий воркер, в котором
  // детектор создавали, — даже уничтоженный. Расширение после этого выгружено
  // и пропадает из меню до ручного Reload. Бисекцией: только детектор — падает
  // на первой же остановке, только переводчик — нет. Язык под «авто» и так
  // берём офлайн из текста (lib/guesslang.js), детектор лишь просит словарь.
}

/**
 * Клик по значку посреди сеанса: слушать теперь эту вкладку.
 *
 * Панель уже переехала сюда (movePanel), за ней переезжает и звук: Chrome
 * отдаёт эту вкладку целиком (tabCapture, грант activeTab — тот самый клик).
 * Сеанс при этом не перезапускается — offscreen меняет только поток вкладки, а
 * модель, фраза и лента остаются как были. Нажали на той же вкладке — не
 * трогаем ничего. Выключают субтитры кнопкой в панели.
 */
async function listen(tab, say = true) {
  const session = await liveSession();
  if (!session) return start(tab);
  if (session.tabId === tab.id) {
    // Та же вкладка и сеанс жив — не трогаем. А с ошибкой в статусе клик по
    // значку — это «попробуй ещё раз»: прежде он молча возвращался, и зритель
    // оставался с ошибкой без выхода.
    const st = await getStatus();
    if (!st.error && st.stage !== 'idle') return { ok: true, tabId: tab.id };
    await stop();
    return start(tab);
  }
  const streamId = await tabStreamId(tab);
  if (!streamId) {
    // Сеанс остаётся на прежней вкладке. Отказ клика по значку — в шапку (и на
    // значок без панели); «Listen here» (say = false) показывает его у себя.
    const error = noTabAudio(tabStreamId.why);
    if (say) await setStatus({ error });
    return { ok: false, error };
  }
  const g = поколение;
  const res = await chrome.runtime
    .sendMessage({ type: 'OFFSCREEN_TAB', streamId, tabId: tab.id })
    .catch(() => null);
  if (res?.ok) {
    // Пока ждали offscreen, сеанс могли остановить, а умерший — поднять
    // заново: старый снимок не писать поверх (сеанс воскрес бы без захвата
    // или затёр бы номер нового). Смену языка (retarget) берём свежим чтением.
    const now = await getSession();
    if (g !== поколение || now?.token !== session.token) return { ok: true, tabId: tab.id };
    await chrome.storage.session.set({ session: { ...now, tabId: tab.id } });
    // Отказ прежнего переезда больше ни о чём: сеанс идёт здесь. Иначе ошибка
    // висела бы в шапке над субтитрами, а клик по значку на этой вкладке
    // принял бы её за сломанный сеанс и перезапустил его.
    if ((await getStatus()).error) {
      await setStatus({ error: null });
      if (noPanel() && !packBadge) chrome.action.setBadgeText({ text: 'ON' }).catch(() => {});
    }
    return { ok: true, tabId: tab.id };
  }
  // Прежнюю вкладку offscreen уже отпустил, а новую не взял: слушать нечего.
  // Сеанс снимаем и заводим заново на этой вкладке — грант клика ещё свеж.
  await stop();
  return start(tab);
}

/** Единственный слушатель — боковая панель; она же и страница расширения. */
const toPanel = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

const getConfig = async () => {
  // tapDump лежит отдельным ключом, а не внутри config: config переписывается
  // панелью на каждый запуск, и отладочный ключ там бы затирался. Подмешиваем
  // его на выходе — offscreen-документу конфиг едет сообщением, а до storage
  // он сам не дотянется.
  // benchDraft так же: стенд подменяет распознавание (--draft=soda), а панель
  // пишет config со своей моделью и затирает draft стенда.
  const { config, tapDump, benchDraft } = await chrome.storage.local.get(['config', 'tapDump', 'benchDraft']);
  return { ...DEFAULTS, ...config, ...(benchDraft ? { draft: benchDraft } : {}), tapDump: tapDump || 0 };
};
const getSession = async () => (await chrome.storage.session.get('session')).session || null;
const getStatus = async () => (await chrome.storage.local.get('status')).status || { stage: 'idle' };

// Правки статуса выстраиваем в очередь. Внутри два await — чтение и запись
// storage, — и два сообщения подряд («черновая на видеокарте», сразу за ним
// «готово») успевают прочитать одно и то же старое значение: запись второго
// затирает первое, и в панели черновая навсегда остаётся «на ?».
// Цепочка обещаний снимает это без блокировок: каждая правка видит результат
// предыдущей. Об ошибку цепочка не рвётся, но вызвавшему её отдаём.
let statusChain = Promise.resolve();
// «!» на значке сейчас от отказа словаря, а не от ошибки сеанса (режим без панели).
let packBadge = false;
function setStatus(patch) {
  if (patch.error) noteDiag((d) => { d.e = String(patch.error); });
  // Без боковой панели ошибку видно только на значке: «!» и текст в подсказке.
  if (noPanel() && 'error' in patch) {
    // Ошибка — «!», запуск — «…» (модель грузится секунды, плашка пока пуста),
    // остановка — пусто; «ON» ставит begin.
    const badge = patch.error ? '!' : patch.stage === 'idle' ? '' : patch.stage === 'starting' ? '…' : null;
    if (badge != null) chrome.action.setBadgeText({ text: badge }).catch(() => {});
    chrome.action.setTitle({ title: patch.error ? `Audio Translator: ${patch.error}` : '' }).catch(() => {});
  }
  if (patch.pack && /failed|unavailable/.test(patch.pack.can)) {
    noteDiag((d) => { d.e = `pack ${patch.pack.from}>${patch.pack.to} ${patch.pack.can}`; });
  }
  // Без панели отказ словаря тоже только на значке: иначе «ON», а субтитры
  // идут оригиналом без объяснений. Снят отказ — снова «ON».
  if (noPanel() && 'pack' in patch && !patch.error) {
    const { from, to, can } = patch.pack || {};
    if (can === 'failed' || can === 'offline' || can === 'unavailable') {
      packBadge = true;
      chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      chrome.action.setTitle({ title: can === 'failed'
        ? `Audio Translator: language pack ${from} → ${to} did not download, retrying`
        : can === 'offline'
          ? 'Audio Translator: no internet'
          : `Audio Translator: Chrome cannot translate ${from} → ${to}` }).catch(() => {});
    } else if (packBadge) {
      packBadge = false;
      chrome.storage.session.get('session').then(({ session }) => {
        if (!session) return;
        chrome.action.setBadgeText({ text: 'ON' }).catch(() => {});
        chrome.action.setTitle({ title: '' }).catch(() => {});
      }, () => {});
    }
  }
  if (patch.device) noteDiag((d) => { if (d.dev === patch.device) return false; d.dev = patch.device; });
  const next = statusChain.then(async () => {
    const status = { ...(await getStatus()), ...patch };
    await chrome.storage.local.set({ status });
    toPanel({ type: 'STATUS_UPDATE', status });
  });
  statusChain = next.catch(() => {});
  return next;
}

// Тёплый простой. На остановке документ с моделью НЕ закрываем: teardown в
// offscreen гасит только звук, а воркер с весами остаётся жив, и следующее
// включение переиспользует его мгновенно — без повторной загрузки на ~10 с
// (прежде каждое включение поднимало модель заново). Но держать веса в памяти
// видеокарты вечно незачем: после WARM_IDLE_MIN без сеанса документ закрываем
// будильником и память отдаём. Будильник переживает усыпление воркера, а
// setTimeout в MV3 — нет.
const COLD_ALARM = 'warm-idle';
const WARM_IDLE_MIN = 15;
const scheduleColdClose = () => chrome.alarms.create(COLD_ALARM, { delayInMinutes: WARM_IDLE_MIN });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== COLD_ALARM) return;
  // Снова слушаем — память нужна, не закрываем. Будильник на следующую
  // остановку поставит stop() заново.
  // Запуск в пути (pending) — тоже: документ подняли под него.
  const { session, pending } = await chrome.storage.session.get(['session', 'pending']);
  if (session || pending) return;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
});

// Два запуска подряд (клик и кнопка панели) создавали документ дважды, и второй
// падал «Only a single offscreen document may be created» — ошибкой запуска.
let creatingOffscreen = null;
function ensureOffscreen() {
  creatingOffscreen ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Захват звука вкладки, распознавание речи и воспроизведение звука обратно пользователю'
    }).catch(async (e) => { if (!(await chrome.offscreen.hasDocument())) throw e; });
  })().finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

/**
 * Ключ звука вкладки целиком — или null, если Chrome его не даёт.
 *
 * Даёт он его только с клика по значку на этой самой вкладке (грант
 * activeTab). Без ключа звука нет: offscreen ответит NO_TAB_AUDIO.
 *
 * Служебные страницы заранее НЕ отсекаем. Прежде здесь стоял фильтр по
 * chrome:// и about:, и это был баг 11.10: зритель открыл новое окно, нажал
 * значок на «Новой вкладке» и в ней же ушёл в Apple Music — ключа не было, а
 * превью Apple Music страница не отдаёт (чужой источник без CORS), и лента
 * стояла пустой под играющую песню. Chrome на chrome://newtab ключ выдаёт, и
 * захват переживает переход вкладки на другой сайт — проверено на стенде. Где
 * не выдаёт (chrome://extensions и т. п.), скажет сам, отказ пишем в журнал.
 * Ни url, ни его отсутствие (без разрешения tabs у служебных страниц url пуст)
 * ничего не решают.
 */
const noTabAudio = (why) => 'Chrome gave no audio for this tab'
  + (why ? ` (${why})` : '') + '. Click the extension icon on the tab that is playing.';
async function tabStreamId(tab) {
  tabStreamId.why = '';
  if (tab?.id == null) return null;
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch((e) => {
    console.warn('ключ вкладки не выдан:', tab.id, tab.url || '', e?.message || e);
    // Причину Chrome несём в ошибку: «нельзя захватить страницу расширения» и
    // «нет гранта» зрителю подсказывают разное.
    tabStreamId.why = String(e?.message || e || '');
    return null;
  });
}

/**
 * Вкладка, звук которой брать при «включить» из панели.
 *
 * Свежий клик по значку (≤ CLICK_FRESH_MS) — его вкладка: только на ней есть
 * грант. Клик помним по окнам: клик в другом окне не отменяет грант вкладки
 * этого. Иначе — активная вкладка окна, где нажали кнопку (панель шлёт его
 * windowId), а без него — последнего окна в фокусе.
 */
const CLICK_FRESH_MS = 60000;
const clickKey = (windowId) => `clicked:${windowId}`;
async function chosenTab(windowId) {
  const win = windowId ?? (await chrome.windows?.getLastFocused().catch(() => null))?.id;
  const key = clickKey(win);
  const { [key]: clicked } = await chrome.storage.session.get(key);
  if (clicked && Date.now() - clicked.at <= CLICK_FRESH_MS) {
    const tab = await chrome.tabs.get(clicked.tabId).catch(() => null);
    // Вкладку могли унести в другое окно.
    if (tab && tab.windowId === win) return tab;
  }
  const q = win != null ? { active: true, windowId: win } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(q).catch(() => []);
  return tab || null;
}
chrome.windows?.onRemoved?.addListener((windowId) => chrome.storage.session.remove(clickKey(windowId)).catch(() => {}));

/**
 * Включить субтитры: слушать вкладку, на значке которой нажали, целиком.
 *
 * Только её, как и панель живёт только на ней: что видно, то и слышно. Скрипты
 * страниц, слушавшие все вкладки разом, убраны: на чужой вкладке
 * их субтитры уходили в скрытую панель.
 */
/**
 * Дождаться, пока Chrome снимет прежний захват вкладки: событие
 * tabCapture.onStatusChanged, без опроса. Захвата нет — сразу.
 */
async function captureReleased(tabId) {
  const tc = chrome.tabCapture;
  if (!tc?.getCapturedTabs || !tc.onStatusChanged) return;
  let on, wake;
  const done = new Promise((ok) => {
    on = (info) => { if (info.tabId === tabId && (info.status === 'stopped' || info.status === 'error')) ok(); };
    tc.onStatusChanged.addListener(on);
    // Стоп зрителя будит ожидание: перезапуск после него и так не нужен.
    wake = ok;
    releaseWaits.add(ok);
  });
  // Слушатель повешен до вопроса: снятие между ними не потеряется.
  const held = (await tc.getCapturedTabs().catch(() => []))
    .some((t) => t.tabId === tabId && (t.status === 'pending' || t.status === 'active'));
  if (held) await done;
  tc.onStatusChanged.removeListener(on);
  releaseWaits.delete(wake);
}
const releaseWaits = new Set();

async function start(known, windowId, prev = null) {
  ovlRenew();
  // Новый запуск (и смена языка) — новый сеанс в журнале, как и в ленте.
  clearTimeout(jTail);
  jrnl.end();
  const tab = known || await chosenTab(windowId);
  const config = await getConfig();
  // Перезапуск перебит (стоп, другой запуск): документ, поднятый под него, без
  // сеанса держал бы модель до следующего стопа — отдаём его будильнику простоя.
  const quit = async () => {
    const now = await chrome.storage.session.get(['session', 'pending']);
    if (!now.session && !now.pending) scheduleColdClose();
    return { ok: false, quiet: true };
  };

  // Документ поднимаем раньше ключа, а не внутри begin(). Ключ от Chrome живёт
  // считанные секунды, и просроченный он отвечает не отказом, а молчанием:
  // getUserMedia не возвращается вовсе (поймано 2 октября — 700 с на стадии
  // «беру звук», ни ошибки, ни элемента воспроизведения). Первое создание
  // offscreen-документа — это разбор offscreen.html и onnxruntime, то есть
  // ровно те секунды, которых ключу не хватает. Вызов идемпотентный:
  // hasDocument() внутри, а begin() позовёт его ещё раз и просто вернётся.
  await ensureOffscreen();
  // Перезапуск перебит: зритель нажал «стоп» или запустил другую вкладку.
  if (prev && prev.gen !== поколение) return quit();

  // Документ только что закрыт (revive fresh) или звук вкладки только что
  // оборвался: захват Chrome снимает не сразу и в эти мгновения на ключ
  // отвечает «вкладка уже захвачена». Ждём его же события о снятии.
  if (prev?.retry) await captureReleased(tab.id);
  let streamId = await tabStreamId(tab);
  if (prev && prev.gen !== поколение) return quit();
  // Без ключа offscreen ещё может отдать поток прежней вкладки (перезапуск
  // сменой языка), поэтому запускаем всё равно; причину отказа ключа begin
  // покажет, если и потока нет.
  // Без ключа слушается прежняя вкладка — её номер и пишем в сеанс: с null
  // следующий клик по значку на ней считал её чужой и захватывал заново.
  // В перезапуске сеанс уже снят — вкладку несёт prev.
  const tabId = streamId ? tab.id : prev?.tabId ?? (await getSession())?.tabId ?? null;
  return begin({ streamId, kind: 'browser', tabId, config, why: tabStreamId.why, gen: prev?.gen, own: prev });
}

/**
 * Сменить язык перевода в идущем сеансе без перезапуска (см. retarget в
 * offscreen.js): звук и распознавание остаются, лента и журнал начинаются
 * заново, как при смене языка раньше. Сеанса нет или offscreen не взял —
 * false, и панель перезапускает сеанс по-старому.
 */
async function retarget(target) {
  const session = await getSession();
  if (!session?.token || !target) return false;
  const g = поколение;
  ovlRenew();
  clearTimeout(jTail);
  jrnl.end();
  const res = await chrome.runtime
    .sendMessage({ type: 'OFFSCREEN_TARGET', target, token: session.token })
    .catch(() => null);
  if (!res?.ok) return false;
  // Пока ждали offscreen, сеанс могли остановить или начать новый (он взял
  // конфиг уже с новой целью): не воскрешать старый записью и не перезапускать.
  // Стоп меняет номер раньше, чем снимает сеанс: сверяем и его, иначе запись
  // между его чтением и снятием вернула бы сеанс.
  const now = await getSession();
  if (g !== поколение || now?.token !== session.token) return true;
  await chrome.storage.session.set({ session: { ...now, config: { ...now.config, target } } });
  return true;
}

/**
 * Номер сеанса.
 *
 * Остановка не отвечает сразу: offscreen досчитывает фразу, на которой нажали
 * «стоп», и это секунды. За них зритель успевает включить субтитры заново — и
 * тогда хвост старой остановки гасит уже новый сеанс: закрывает его offscreen
 * и шлёт панели CAPTIONS_OFF, от которого кнопка говорит «Включить». Поймано
 * так: субтитры шли, а кнопка стояла выключенной. Поэтому после каждого ожидания сверяемся с
 * номером и, если он сменился, тихо уходим — всё уже сделано за нас.
 */
// С метки времени, а не с нуля: воркер засыпает и просыпается с новым счётом,
// а offscreen помнит номер прошлого сеанса, и первый же новый номер совпал бы с
// ним — offscreen принял бы запуск за второго гонца того же задания.
let поколение = Date.now();

async function begin({ streamId, kind, tabId, config, why = '', gen, own }) {
  if (gen != null && gen !== поколение) return { ok: false, quiet: true };
  const token = ++поколение;
  // Подъёму (revive) — свой номер: по нему он отличит свой отказ от перебоя.
  if (own) own.token = token;
  // «Компьютер не успевает» — про этот сеанс, а не навсегда: старая отметка
  // висела и после перезапуска браузера на свободной машине.
  chrome.storage.local.remove('strainAt').catch(() => {});
  // Модель снова в деле — отменяем закрытие тёплого документа по простою.
  chrome.alarms.clear(COLD_ALARM);
  // tabId едет и в offscreen: там по нему видно, что перезапуск пришёлся на ту
  // же вкладку, и её звук надо оставить как есть — второй раз Chrome его не
  // отдаёт (см. звукВкладки в offscreen.js).
  await chrome.storage.session.set({ pending: { streamId, config, kind, token, tabId, at: Date.now() } });
  // Статус ставим до запуска offscreen: иначе его собственное «слушаю вкладку»
  // прилетит раньше и будет затёрто нашим «запускаюсь».
  // Запуск, упавший здесь, не должен оставить pending: свежий pending глушит
  // клики по значку (noPanelClick) ещё CLICK_FRESH_MS.
  try {
    await setStatus({ stage: 'starting', error: null, download: null, need: null, kind, source: null, pack: null });
    await ensureOffscreen();
  } catch (e) {
    const { pending } = await chrome.storage.session.get('pending');
    if (pending?.token === token) await chrome.storage.session.remove('pending');
    throw e;
  }

  // Ответа может не быть, если документ ещё не повесил слушатель — тогда он
  // сам заберёт задание через OFFSCREEN_READY. Повисший захват документ
  // снимает сам (START_LIMIT_MS в offscreen.js) и отвечает again.
  const res = await chrome.runtime
    .sendMessage({ type: 'OFFSCREEN_CAPTURE', streamId, config, kind, token, tabId })
    .catch(() => null);
  // Ответа нет и документа нет — он умер посреди запуска (нехватка памяти),
  // а не просто не успел повесить слушатель. Поднимаем захват с новым.
  if (!res && chrome.offscreen?.hasDocument && !(await chrome.offscreen.hasDocument().catch(() => true))) {
    if (token !== поколение) return superseded(token);
    // Сеанс, поверх которого шёл перезапуск, умер с документом тоже.
    await chrome.storage.session.remove(['session', 'pending']);
    // Это запуск самого подъёма (own) — второй не заводим (ждали бы сами
    // себя): он повторит попытку сам, если они ещё остались.
    if (own) return { ok: false, again: 'fresh', error: 'capture document died' };
    // Перебитый нами подъём ещё может идти: revive отдал бы его обещание, а
    // оно кончится тихо — и ни сеанса, ни ошибки. Ждём его и заводим свой.
    if (reviving) await reviving.catch(() => {});
    const again = await revive(tabId, 'capture document died', 'fresh', token);
    if (again?.ok || again?.quiet) return again;
    if (again?.gone) {
      await setStatus({ stage: 'idle', error: null });
      return { ok: false, quiet: true };
    }
    throw new Error(again?.error || 'Audio capture did not start.');
  }
  // Отказ устаревшего поколения в статус не пишем: пока мы ждали ответа, запуск
  // мог начаться заново (клик по иконке и кнопка в панели — это два запуска на
  // один жест), и чужая ошибка села бы поверх живых субтитров.
  if (res && res.ok === false) {
    if (token !== поколение) return superseded(token);
    // Запуск снял себя сам и прислал SESSION_DEAD: задание оставляем die,
    // по нему он поднимет сеанс заново.
    if (res.again) return { ok: false, quiet: true };
    // Отказ окончательный: задание не оставляем, иначе пересозданный документ
    // подобрал бы его через OFFSCREEN_READY с протухшим ключом. Документ с
    // моделью без сеанса отдаём простою (COLD_ALARM снят выше). Сеанс, поверх
    // которого шёл перезапуск, документ уже снял у себя.
    await chrome.storage.session.remove(['session', 'pending']);
    scheduleColdClose();
    // Ключа не было, а поток прежней вкладки offscreen не нашёл: причина отказа
    // ключа понятнее его «не дали звук».
    throw new Error(!streamId && why ? noTabAudio(why) : res.error);
  }
  if (token !== поколение) return superseded(token);

  await chrome.storage.session.set({ session: { tabId, config, kind, token, at: Date.now() } });
  // Задание убираем, только если документ его точно взял (ответил). Иначе
  // оставляем: его заберёт OFFSCREEN_READY, когда скрипт там наконец повесит
  // слушатель. А если взял — забытое задание заведёт сеанс во второй раз, и
  // модели поднимутся дважды (ловил: два набора воркеров на один клик).
  if (res?.ok) await chrome.storage.session.remove('pending');
  // Панель про начало сеанса сама не узнает, если его начала не её кнопка:
  // клик по иконке открывает панель и включает захват одновременно, и
  // GET_STATE из панели успевает прийти раньше этой строчки.
  toPanel({ type: 'CAPTIONS_ON' });
  if (noPanel()) chrome.action.setBadgeText({ text: 'ON' }).catch(() => {});
  return { ok: true, tabId, config, kind };
}

/**
 * Запуск перебит: новым запуском (тогда сеанс есть, и панель права, считая
 * его идущим) или снятием сеанса — стопом или его смертью (SESSION_DEAD). Во
 * втором случае «успех» включал бы кнопку панели при мёртвом захвате; quiet —
 * ошибку уже показал статус, панели добавлять нечего.
 */
async function superseded(token) {
  if (await getSession()) return { ok: true };
  // Стоп пришёл, пока задание летело в offscreen: тот поднял захват и модель
  // уже после стопа, и о них никто не знает. Гасим своим номером: чужой,
  // более новый сеанс offscreen по номеру не тронет. Только после стопа: die
  // перебивает нас, чтобы перезапуск забрал живой звук вкладки, а стоп
  // старого номера его бы отпустил.
  if (stoppedGen > token) chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', token }).catch(() => {});
  return { ok: false, quiet: true };
}
let stoppedGen = 0;

/**
 * Перезапуск сломавшегося сеанса без зрителя: модель встала или не
 * собралась, документ захвата умер, звук вкладки оборвался, запуск повис.
 * Раньше всё это кончалось ошибкой «кликните значок» — то есть чинить
 * предлагали зрителю. Ключ вкладки Chrome выдаёт и без нового клика, пока
 * грант клика жив (вкладку не уводили на другой сайт). Не чаще REVIVE_MAX раз
 * за REVIVE_WINDOW_MS: стойкий отказ (нет памяти) крутил бы перезапуски
 * вечно — тогда ошибка. mode 'fresh' — документ пересоздать: он повис или
 * чужой; 'key' — документ цел, но поток вкладки мёртв: ключ нужен новый.
 *
 * @returns {Promise<object|null>} ответ start, или null — поднимать нечего
 */
const REVIVE_MAX = 2;
// С запасом на сторож загрузки (3 мин): иначе на слабой машине модель
// собиралась бы и падала по кругу вечно.
const REVIVE_WINDOW_MS = 10 * 60 * 1000;
let reviving = null;
let revTab = null;
function revive(tabId, why, mode = '', gen = поколение) {
  // gen — номер, взятый при снятии сеанса: стоп между снятием и этим вызовом
  // его уже сменил.
  if (gen !== поколение) return Promise.resolve({ ok: false, quiet: true });
  if (!reviving) {
    let own = null;
    const p = (async () => {
      revTab = tabId;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      // Вкладку закрыли — поднимать нечего, и это не ошибка.
      if (tabId != null && !tab) return { ok: false, gone: true };
      for (;;) {
        const fresh = mode === 'fresh';
        const now = Date.now();
        const { revives = [] } = await chrome.storage.session.get('revives');
        const recent = revives.filter((t) => now - t < REVIVE_WINDOW_MS);
        if (!tab || recent.length >= REVIVE_MAX) return null;
        await chrome.storage.session.set({ revives: [...recent, now] });
        noteDiag((d) => { d.e = `revived: ${why}`; });
        // Пока читали storage, могли запустить новый сеанс: его документ не закрывать.
        if (gen !== поколение) return { ok: false, quiet: true };
        if (fresh && await chrome.offscreen.hasDocument().catch(() => false)) {
          await chrome.offscreen.closeDocument().catch(() => {});
        }
        if (gen !== поколение) return { ok: false, quiet: true };
        // Ключ переспрашиваем, только когда прежний поток отпущен (fresh, key):
        // живой поток в документе Chrome второй раз не выдаёт, а offscreen берёт его сам.
        own = { tabId: tab.id, gen, retry: fresh || mode === 'key' };
        const r = await start(tab, undefined, own)
          .catch((e) => ({ ok: false, error: String(e?.message || e) }));
        // Документ умер посреди этого подъёма (begin) — следующая попытка здесь
        // же, пока они не кончились. Номер сменился не нашим begin — перебили.
        if (!r?.again || поколение !== own.token) return r;
        ({ again: mode, error: why } = r);
        gen = own.token;
        own = null;
      }
    })()
      // Перебитый подъём (стоп, новый запуск) молчит: его отказ сел бы ошибкой
      // и CAPTIONS_OFF поверх нового сеанса. Свой begin номер сменил сам
      // (own.token) — это не перебой.
      .then((r) => (поколение !== (own?.token ?? gen) && !r?.ok ? { ok: false, quiet: true } : r))
      // Стоп сбрасывает reviving сразу (см. stop): чистим, только если он ещё наш.
      .finally(() => { if (reviving === p) { reviving = null; revTab = null; } });
    reviving = p;
  }
  return reviving;
}

/**
 * Жив ли сеанс (порвался порт документа). Умер —
 * поднимаем заново; не вышло — причина в статус.
 */
async function checkSession() {
  // Сеанс сейчас поднимается заново: он ещё будет.
  if (reviving) return true;
  const was = await getSession();
  if (!was) {
    // Запуск в полёте — сеанс ещё будет.
    if ((await chrome.storage.session.get('pending')).pending) return true;
    toPanel({ type: 'CAPTIONS_OFF' });
    return false;
  }
  const out = {};
  if (await liveSession(out)) return true;
  // Снял не liveSession (сеанс сменился или его сняли) — поднимать нечего.
  if (out.gen == null) return false;
  return reviveDead(was.tabId, out.gen);
}

/**
 * Сеанс для GET_STATE. Умерший тут же и поднимаем, а не молча снимаем: иначе
 * панель, открытая раньше будильника, гасила его без подъёма. Подъём не ждём —
 * это секунды, панель узнает о нём по статусу и CAPTIONS_ON.
 */
async function stateSession() {
  if (reviving) return null;
  const was = await getSession();
  const out = {};
  const session = await liveSession(out);
  if (!session && was && out.gen != null) reviveDead(was.tabId, out.gen);
  return session;
}

/** Поднять сеанс, чей документ умер; не вышло — причина в статус. */
async function reviveDead(tabId, gen) {
  const res = await revive(tabId, 'capture document died', 'fresh', gen);
  if (res?.ok) return true;
  if (res?.quiet) return false;
  // Документ мог остаться с захватом и моделью без сеанса: отдаём его простою.
  scheduleColdClose();
  // Панель, открытая во время подъёма, считала сеанс идущим (running||reviving).
  toPanel({ type: 'CAPTIONS_OFF' });
  if (res?.gone) await setStatus({ stage: 'idle', error: null });
  else if (!((st) => st?.error && st.stage === 'idle')(await getStatus())) {
    await setStatus({ stage: 'idle', error: res?.error || 'Subtitles stopped.' });
  }
  return false;
}

/**
 * Сеанс умер сам (offscreen, SESSION_DEAD): снять его, показать причину и
 * отпустить звук. Номер сверяем и с идущим сеансом, и с заданием в полёте:
 * запуск мог умереть раньше, чем begin записал сеанс.
 */
async function die(token, error, again = false) {
  const g0 = поколение;
  const { session, pending } = await chrome.storage.session.get(['session', 'pending']);
  if (!token || (session?.token !== token && pending?.token !== token)) return;
  // Пока читали, нажали «стоп» или начали новый запуск: состояние уже их.
  if (поколение !== g0) return;
  const gen = ++поколение;
  await chrome.storage.session.remove(['session', 'pending']);
  // Сломалось не по вине зрителя — поднимаем сами, на той же вкладке. Стоп
  // старому сеансу не шлём: новый запуск в offscreen сам гасит прежний и
  // оставляет живой звук вкладки себе (второй ключ на неё Chrome не даёт).
  if (again) {
    const tabId = session?.token === token ? session.tabId : pending?.tabId;
    // Умер сам перезапуск: он выйдет тихо (поколение уже не его, а begin
    // оставляет повтор нам), и следующую попытку заводим за ним. Прежде здесь
    // сдавались сразу — ошибка вставала, хотя из REVIVE_MAX ушла одна попытка.
    if (reviving) await reviving.catch(() => {});
    const res = await revive(tabId, error, again === true ? '' : again, gen);
    if (res?.ok || res?.quiet) return;
    if (res?.gone) error = null;
    else if (res?.error) error = res.error;
  }
  // CAPTIONS_OFF гасит шапку панели — поэтому он первым, а ошибка за ним.
  toPanel({ type: 'CAPTIONS_OFF' });
  await setStatus({ stage: 'idle', error, download: null, need: null, kind: null, source: null, pack: null });
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', token }).catch(() => {});
  scheduleColdClose();
  clearTimeout(jTail);
  jTail = setTimeout(() => jrnl.end(), 10000);
}

async function stop() {
  const моё = ++поколение;
  stoppedGen = моё;
  for (const ok of releaseWaits) ok();
  releaseWaits.clear();
  // Перебитый подъём ещё может ждать ответа захвата десятки секунд: всё это
  // время клик значком без панели выключал бы, а панель ждала бы его. Он и так
  // выйдет тихо (quit, superseded) — забываем его сразу.
  reviving = null;
  revTab = null;
  const session = await getSession();
  await chrome.storage.session.remove(['session', 'pending']);

  // Статус гасим сразу: захват обрывается первой же строчкой в offscreen, и
  // ждать досчёта последней фразы интерфейсу незачем.
  await setStatus({ stage: 'idle', error: null, download: null, need: null, kind: null, source: null, pack: null });

  if (await chrome.offscreen.hasDocument()) {
    // Ответ приходит не когда оборван захват, а когда досчитан последний кусок:
    // закрыть документ раньше — значит потерять фразу, на которой нажали «стоп».
    // Номер сеанса едет с остановкой: пока она досчитывает фразу, зритель
    // успевает включить субтитры заново, и offscreen по номеру видит, что
    // гасить просят уже не тот сеанс, который у него идёт.
    await chrome.runtime
      .sendMessage({ type: 'OFFSCREEN_STOP', token: session?.token ?? null })
      .catch(() => {});
    if (моё !== поколение) return { ok: true };
    // Документ не закрываем — модель в нём остаётся загруженной, и следующее
    // включение мгновенно (см. scheduleColdClose). Память отдаём по простою.
    scheduleColdClose();
  }
  if (моё !== поколение) return { ok: true };
  // Последняя фраза досчитывается и приходит секунды спустя: сеанс в журнале
  // закрываем, когда она точно легла.
  clearTimeout(jTail);
  jTail = setTimeout(() => jrnl.end(), 10000);
  // Ленту в панели не стираем — её дочитывают уже после остановки; панели
  // достаётся только новость о том, что вкладку больше никто не слушает.
  toPanel({ type: 'CAPTIONS_OFF' });
  return { ok: true };
}

// Реплики показываем строго в порядке прихода: обработчик асинхронный, и
// черновик следующей строки иначе мог обогнать готовую фразу прошлой.
let captionChain = Promise.resolve();
function onCaption(msg) {
  captionChain = captionChain.then(() => showCaption(msg)).catch((e) => console.warn('caption', e));
  return captionChain;
}

async function showCaption(msg) {
  const session = await getSession();
  // Реплику пересылаем целиком, а не по выбранным полям. Список полей тут уже
  // один раз отстал от протокола, и молча: лента ждёт open (снимок незакрытой
  // фразы), endPhrase (кусок, слитый из нескольких фраз), line и growing
  // (строка, которую быстрая модель ещё дописывает) — а доезжали до неё только
  // четыре поля из списка. Наружу это выглядело так, что лента не переписывает
  // строку на месте ни разу за прогон, хотя и offscreen, и сама лента делали
  // всё правильно. Сверху добавляем только то, чего offscreen знать не может:
  // настройку вкладки.
  const full = { ...msg, type: 'CAPTION', showOriginal: !!session?.config.showOriginal };
  // В storage кладём только готовые фразы: панель могли открыть уже после того,
  // как всё посчиталось, и показывать ей недосчитанный черновик незачем.
  // Сперва на экран, запись потом и без ожидания: в Firefox storage.local —
  // это IndexedDB, и ждать её перед показом значило добавлять к каждой
  // готовой фразе от единиц до десятков мс.
  toPanel(full);
  ovlTake(full);
  // Реплика прошлого сеанса (начата до перезапуска) журналу не нужна, как и плашке.
  if (!(msg.since && msg.since < ovlClearedAt)) jrnl.take(full);
  if (!msg.partial) {
    chrome.storage.local.set({ lastCaption: { ...full, type: undefined, ts: Date.now() } }).catch(() => {});
    noteDiag((d) => {
      d.n = (d.n || 0) + 1;
      if (msg.translated) d.t = (d.t || 0) + 1;
      if (msg.error) d.e = `mt: ${msg.error}`;
      if (msg.lang && session?.config.target) d.pair = `${msg.lang}>${session.config.target}`;
    });
  }
}

// --- Плашка поверх страницы (ui/overlay.js) ---------------------------------
//
// Плашку кормит фоновый скрипт, а не панель: панель закрыли — захват и перевод
// идут дальше (offscreen), и субтитры поверх страницы должны идти тоже. Раньше
// плашка брала строки из ленты панели и с её закрытием гасла.
//
// Где плашку хотят видеть — session.overlay = { tab }: ставит и снимает кнопка
// панели, крестик плашки (OVERLAY_CLOSED) и закрытие вкладки. Желание живёт и
// там, куда скриптам нельзя (новая вкладка, страницы Chrome): плашка встанет,
// как только вкладка дойдёт до обычной страницы. Ошибок зритель не видит.
//
// Лента тут своя, короткая, по тем же feed/fix, что у панели (take в
// sidepanel.js).
const OVL_ROWS = 6;
// Журнал для копии и файла (lib/journal.js): строки устаиваются здесь, а не в
// панели, — панель переезжает и закрывается, перевод идёт дальше.
const jrnl = journal(() => ovlDual);
let jTail = 0;
// Файл сеанса в «Загрузках» (lib/autosave.js) пишется отсюда же, панель не нужна.
autosave();
let ovlCues = [], ovlClearedAt = 0, ovlTab = 0, ovlDual = false, ovlLost = false;
// Плашка стоит на странице, только пока идёт сеанс (или его запуск). После
// конца она уходит: висела бы поверх страницы без дела, а уснувший фон
// не услышал бы и удаления расширения («hovering tab blocking view. even
// after uninstalling», отзыв 05.11). Желание (overlay) при этом остаётся —
// следующий сеанс поставит её снова.
let ovlSession = false, ovlPending = false;
const ovlLive = () => ovlSession || ovlPending;
const ovlReady = Promise.all([
  chrome.storage.session.get(['overlay', 'session', 'pending']).then((r) => {
    ovlTab = r.overlay?.tab || 0;
    ovlSession = !!r.session;
    ovlPending = !!r.pending;
  }),
  chrome.storage.local.get('config').then((r) => { ovlDual = r.config?.orig === true; })
]).catch(() => {});
/** Новый сеанс нумерует строки с нуля: прежняя лента плашке больше не нужна. */
function ovlRenew() {
  ovlClearedAt = Date.now();
  ovlCues = [];
  ovlPush(true);
}
function ovlTake(msg) {
  if (msg.since && msg.since < ovlClearedAt) return;
  const ph = msg.phrase ?? 0;
  const cue = {
    from: ph, to: msg.endPhrase ?? ph, line: msg.line ?? null, growing: !!msg.growing,
    text: msg.translated || msg.original, orig: msg.translated ? msg.original : '',
    open: !!msg.open, exact: !msg.partial, lag: msg.lag, cont: !!msg.cont
  };
  if (!(msg.partial ? feed(ovlCues, cue, 24) : fix(ovlCues, cue))) return;
  ovlPush();
}
/**
 * Плашки прошлой версии расширения. После обновления они остаются на открытых
 * вкладках мёртвыми: строк не получают и не закрываются, а Firefox новой
 * версии их и не показывает (у каждой версии своя песочница, overlay.js их
 * не видит). Снимаем сразу при обновлении, не дожидаясь, пока плашку включат
 * снова. Узнаём так же, как overlay.js: по метке, у старых (0.9.76 и раньше) —
 * по шрифту в теневом дереве.
 */
async function dropStaleOverlays() {
  if (!chrome.scripting) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => {
      globalThis.__atOverlay?.drop();
      for (const el of document.querySelectorAll('[data-audio-translator-overlay], div[style*="2147483647"]'))
        if (el.hasAttribute('data-audio-translator-overlay') || el.openOrClosedShadowRoot?.innerHTML.includes('Audio Translator Pixel')) el.remove();
    } }).catch(() => {});
  }
}
const ovlInject = (tab) => chrome.scripting
  ? chrome.scripting.executeScript({ target: { tabId: tab }, files: ['overlay.js'] }).then(() => true, () => false)
  : Promise.resolve(false);
/**
 * Последние строки — на вкладку плашки. Плашки там нет (страница сменилась,
 * только что поставили желание) — ставим её один раз и шлём снова; нельзя —
 * ждём загрузки следующей страницы. force — слать и пустую ленту: новый сеанс
 * её стирает. Без force пустую не шлём: после перезапуска фонового скрипта
 * своя лента пуста, а на плашке ещё стоит прочитанное.
 */
async function ovlPush(force = false) {
  await ovlReady;
  const tab = ovlTab;
  if (!tab || !ovlLive() || (!force && !ovlCues.length)) return;
  // id — номер строки потока: номера фраз у соседних строк совпадают (feed).
  // Хвост короткий: старые строки плашка помнит сама, слать нужно только
  // те, что ещё могут поменяться.
  const rows = ovlCues.slice(-OVL_ROWS)
    .map((c) => ({ id: c.line ?? c.from, text: c.text, orig: c.orig, open: !!c.open }));
  const ok = await chrome.tabs.sendMessage(tab, { type: 'OVERLAY_ROWS', rows }).then(() => true, () => false);
  if (ok) { ovlLost = false; return; }
  if (ovlLost || tab !== ovlTab) return;
  ovlLost = true;
  if (await ovlInject(tab) && tab === ovlTab) { ovlLost = false; ovlPush(true); }
}
/** Новая попытка: страница загрузилась, выдан грант или доступ к сайтам. */
function ovlRetry() {
  if (!ovlTab) return;
  ovlLost = false;
  ovlPush(true);
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.config) {
    ovlDual = ch.config.newValue?.orig === true;
    ovlPush();
  }
  if (area !== 'session') return;
  if (ch.session || ch.pending) {
    const was = ovlLive();
    if (ch.session) ovlSession = !!ch.session.newValue;
    if (ch.pending) ovlPending = !!ch.pending.newValue;
    if (was && !ovlLive() && ovlTab) chrome.tabs.sendMessage(ovlTab, { type: 'OVERLAY_OFF' }).catch(() => {});
    // Запуск пошёл — плашка встаёт сразу, пустой, не дожидаясь первой строки.
    if (!was && ovlLive()) ovlRetry();
  }
  if (ch.overlay) {
    const was = ovlTab;
    ovlTab = ch.overlay.newValue?.tab || 0;
    if (was && was !== ovlTab) chrome.tabs.sendMessage(was, { type: 'OVERLAY_OFF' }).catch(() => {});
    ovlRetry();
  }
  // Плашка живёт только на слушаемой вкладке. Захват ушёл на другую (новый
  // сеанс в start() или клик по значку посреди сеанса в listen()) — снимаем её
  // со старой (OVERLAY_OFF шлёт ветка выше), кнопка панели гаснет и включается
  // заново уже здесь. Иначе плашка застревала на прошлой вкладке.
  const heard = ch.session?.newValue?.tabId;
  if (heard) ovlReady.then(() => { if (ovlTab && ovlTab !== heard) chrome.storage.session.remove('overlay'); });
  // Клик по значку снова выдал грант вкладке.
  if (Object.keys(ch).some((k) => k.startsWith('clicked:'))) ovlRetry();
});
// Наслушанное (heardMs, просьба об оценке в graphite.js) — по концу сеанса:
// at пишет begin, переезд вкладки и смена языка его сохраняют. Прежде считала
// каждая открытая панель таймером раз в минуту, и две панели писали поверх
// друг друга. Ключ свой и пишет его только фон: в общем rated запись панели
// (asked, skips) и наша затирали бы одна другую.
chrome.storage.onChanged.addListener((ch, area) => {
  const was = area === 'session' && ch.session?.oldValue?.at;
  if (!was || ch.session.newValue?.at === was) return;
  chrome.storage.local.get('heardMs').then(({ heardMs = 0 }) =>
    chrome.storage.local.set({ heardMs: heardMs + Date.now() - was })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, info) => { if (id === ovlTab && info.status === 'complete') ovlRetry(); });
chrome.tabs.onRemoved.addListener((id) => { if (id === ovlTab) chrome.storage.session.remove('overlay'); });
chrome.permissions?.onAdded.addListener(ovlRetry);
// Плашка держит соединение, чтобы уйти со страницы, когда расширение удалят
// (см. link в overlay.js): принять его — и всё. Документ захвата держит своё
// на время сеанса (связаться в offscreen.js): порвал он — значит, документ
// умер или закрыт, и сеанс проверяем сразу. Чужие порты не трогаем: в Firefox
// на этой же странице свой слушатель у отвода звука ('tap', ff.js). В
// Android-прослойке onConnect нет вовсе.
chrome.runtime.onConnect?.addListener((port) => {
  if (port.name === 'offscreen') {
    port.onDisconnect.addListener(async () => { if (await getSession()) checkSession(); });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // Стендам: подать реплику в журнал и закрыть сеанс, минуя offscreen.
    case 'JOURNAL_TAKE':
      jrnl.take(msg.caption).then(() => sendResponse(true));
      return true;
    case 'JOURNAL_END':
      jrnl.end().then(() => sendResponse(true));
      return true;
    // Копия расшифровки для панели.
    case 'JOURNAL_TEXT':
      jrnl.text().then((text) => sendResponse({ text }), () => sendResponse({ text: '' }));
      return true;
    // Крестик на плашке: здесь её больше не хотят.
    case 'OVERLAY_CLOSED':
      if (sender.tab?.id && sender.tab.id === ovlTab) chrome.storage.session.remove('overlay');
      return false;
    // Свежий ключ захвата по просьбе offscreen: его прошлый ключ мог
    // просрочиться, пока поднимались модели, и тогда getUserMedia молчит
    // навсегда. Грант activeTab при этом ещё жив (вкладка не уходила с
    // страницы), и второй ключ Chrome выдаёт охотно.
    case 'NEW_STREAM_ID':
      chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId })
        .then(streamId => sendResponse({ streamId }),
              e => sendResponse({ error: String(e.message || e) }));
      return true;

    case 'OFFSCREEN_READY':
      chrome.storage.session.get('pending').then(({ pending }) => sendResponse(pending || null));
      return true;

    case 'START': {
      // Во время подъёма (revive) — дождаться его, второй запуск поверх не нужен.
      // Ждём, пока подъёмы не кончатся совсем: за умершим подъёмом die заводит
      // следующий, и запуск рядом с ним делил бы документ (тот закрывает его
      // под нашим begin).
      (async () => {
        let waited = false;
        for (;;) {
          while (reviving) { waited = true; await reviving.catch(() => {}); }
          if (waited && await getSession()) return { ok: true };
          if (!reviving) return start(null, msg.windowId);
        }
      })()
        .then(sendResponse).catch(async (e) => {
        console.error('захват вкладки не вышел:', e?.name, e?.message, e?.stack);
        await setStatus({ stage: 'idle', error: String(e.message || e) });
        sendResponse({ ok: false, error: String(e.message || e) });
      });
      return true;
    }

    // «Listen here» на панели, которую браузер оставил на вкладке без звука
    // (ui/graphite.js): переезд сюда тем же путём, что и клик по значку на ней.
    // Грант этой вкладки — от прежнего клика по значку на ней: он жив, пока
    // вкладка не ушла на другую страницу, а нет — отказ ключа покажет кнопка.
    case 'LISTEN_HERE':
      (async () => {
        const tab = await chrome.tabs.get(msg.tabId);
        clickTab(tab.id, 1);
        movePanel(tab.id);
        if (reviving) await reviving.catch(() => {});
        await chrome.storage.session.set({ [clickKey(tab.windowId)]: { tabId: tab.id, at: Date.now() } });
        return listen(tab, false);
      })().then(sendResponse, async (e) => {
        await setStatus({ stage: 'idle', error: String(e?.message || e) });
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
      return true;

    case 'STOP':
      stop().then(sendResponse);
      return true;

    case 'RETARGET':
      retarget(msg.target).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
      return true;

    case 'GET_STATE':
      Promise.all([getConfig(), getStatus(), stateSession(), chrome.storage.local.get('lastCaption')])
        // rows — лента плашки: панель, открытая посреди сеанса, встаёт сразу с
        // теми же строками, а не пустой с «Starting…», пока не придёт новая.
        .then(([config, status, session, { lastCaption }]) =>
          sendResponse({ running: !!session || !!reviving, config, status, lastCaption, rows: session ? ovlCues : [] }));
      return true;

    // Поверх сохранённого, а не вместо: форма sidepanel.js знает не все ключи
    // (device ставит лист настроек графита), и полная замена стирала бы чужие.
    case 'SET_CONFIG':
      chrome.storage.local.get('config')
        .then(({ config }) => chrome.storage.local.set({ config: { ...config, ...msg.config } }))
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'ASR_STATUS': {
      const { type, token, ...patch } = msg;
      // Отвечаем после записи, а не молчим. Последний статус сеанса — тот, что
      // с воротами, — уходит из offscreen перед самым ответом на OFFSCREEN_STOP,
      // а стенд читает storage сразу за этим ответом. Без подтверждения гонку
      // выигрывает чтение: прогон 35 остался без единой цифры по воротам.
      //
      // Статус чужого сеанса (снятого или перебитого) не пишем: он садился
      // поверх «выключено» или поверх ошибки, и зритель видел «loading…» навсегда.
      chrome.storage.session.get(['session', 'pending']).then(({ session, pending }) => {
        // Свой — и номер живого сеанса, и номер задания: перезапуск посреди
        // сеанса (смена языка) шлёт статусы нового номера раньше, чем begin
        // запишет его в session.
        if (token && token !== session?.token && token !== pending?.token) return;
        return setStatus(patch);
      }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    }

    case 'SESSION_DEAD':
      die(msg.token, msg.error, msg.again).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    // Отладочный слепок захваченного звука — кладём отдельным ключом, а не в
    // статус: он в сотни раз больше всего остального, и мешать его в объект,
    // который переписывается на каждое событие, незачем.
    case 'TAP_DUMP':
      chrome.storage.local.set({ tapDumped: { at: msg.at, pcm: msg.pcm } });
      return;

    // Язык речи, услышанный в этом сеансе: держим его отдельным ключом, чтобы на
    // следующем включении панель погрела этот словарь ещё на жесте (warmPairs) и
    // под «авто» не вылезал баннер докачки. Отдельно от status — тот сбрасывается
    // в idle на остановке, а язык должен пережить её.
    case 'LAST_SOURCE':
      chrome.storage.local.set({ lastSource: msg.code });
      return;

    // Словарь пары по просьбе offscreen или панели: там create() без жеста
    // отвечает NotAllowedError, а в воркере жеста не требует вовсе (замер
    // 0.5.2.30, texts/fix.0.5.2.30.verify.txt). Ответ — когда скачался или нет.
    case 'WARM_PACK':
      // Форк без Translator в воркере: качать странице самой.
      if (!self.Translator) {
        sendResponse({ ok: false, error: 'no Translator' });
        return;
      }
      fetchPack(msg.from, msg.to).then(() => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;

    // Страница услышала offline (в воркере такого события нет): идущие
    // загрузки словарей Chrome смотрят сеть сразу, не ждут своего молчания.
    case 'NET_OFF':
      for (const job of packJobs.values()) job.look?.();
      return;

    // Машина не успела за речью: выбросила звук или ушла с занятой видеокарты
    // на процессор. Панель по этой отметке предупреждает до следующего
    // включения (checkStrain в sidepanel.js).
    case 'STRAIN':
      chrome.storage.local.set({ strainAt: Date.now() });
      return;

    case 'CAPTION':
      onCaption(msg);
      return;

    // Перевод не вышел — строка ушла оригиналом молча. В панели этого не
    // видно, а к отзыву при удалении это главное.
    case 'DIAG':
      noteDiag((d) => { d.e = String(msg.e || ''); });
      return;

    // Признак живого звука. В storage не кладём и ответа не ждём: он ценен
    // только сейчас, а опоздавший тик врёт сильнее, чем его отсутствие.
    case 'LIVE_BEAT':
      toPanel(msg);
      return;
  }
});

// Закрыли вкладку, которую слушали, или ту, где была панель: слушать и
// показывать больше негде — гасим.
chrome.tabs.onRemoved.addListener(async (id) => {
  const step = panelQueue.then(async () => {
    const { panelTabs = [] } = await chrome.storage.session.get('panelTabs');
    if (!panelTabs.includes(id)) return false;
    await chrome.storage.session.set({ panelTabs: panelTabs.filter((t) => t !== id) });
    return panelTabs.at(-1) === id;
  });
  panelQueue = step.catch(() => {});
  const current = await step.catch(() => false);
  const { session, pending } = await chrome.storage.session.get(['session', 'pending']);
  // Без сеанса — запуск или подъём на этой вкладке: гасим и их, иначе подъём
  // на закрытой вкладке кончался ошибкой.
  if (!session) {
    if (pending?.tabId === id || (reviving && revTab === id)) await stop();
    return;
  }
  if (current || session.tabId === id) await stop();
});
