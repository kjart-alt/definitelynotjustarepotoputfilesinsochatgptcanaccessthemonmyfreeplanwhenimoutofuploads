// Распознавание: nemotron-3.5-asr-streaming, единственная модель расширения.
//
// У оконных моделей, которые тут были раньше, протокол был «дай кусок звука —
// получи текст»: кусок вырезает сегментатор, каждый проход начинается с
// чистого листа, и раньше конца куска сказать нечего. Здесь звук течёт
// непрерывно, состояние кодировщика живёт между вызовами, и текст прирастает
// каждый кусок — вне всякой связи с тем, где сегментатор проведёт границу
// фразы.
//
// Границы фраз сюда всё-таки приходят — сообщением MARK, — но означают другое:
// не «вот тебе работа», а «начни строку заново». Строку, не поток: кеши
// кодировщика паузу переживают. Неполный кусок добивается тишиной только в
// конце звука (end).

import { NemoStream, WIRE, weightFiles } from './lib/nemo.js';
import { weight, weightsInto, hfUrl, cached } from './lib/weights.js';
import { DEFAULT_DRAFT, findModel } from './lib/models.js';
import { rustEngine } from './lib/nemo-rs.js';
import { hostEngine } from './lib/nemo-host.js';

// По умолчанию считает процессор, своим кодом на Rust (lib/nemo-rs.js): кодировщик и
// жадный RNN-T на int4-весах. В настройках можно отдать кодировщик видеокарте
// (lib/nemo-gpu.js, свои шейдеры, не ORT). Кусок 320 мс стоит ~31 мс в четыре потока
// (i5-13500H, Chrome 155, 22.10), быстрее ORT на видеокарте и без её отказов:
// ни чёрного списка, ни subgroups на Iris Xe, ни чужой нейросети на той же
// карте, ни видео на странице, которое душило очередь WebGPU.
//
// Какую сборку грузить, говорит offscreen сообщением LOAD (lib/models.js).
// Пока LOAD не пришёл, держим сборку по умолчанию — ту, что едет в пакете.
const card = findModel(DEFAULT_DRAFT);
let repo = card.id;
// Процессорная часть карточки: раскладка весов, добавка к ним и длина куска.
let cpuBuild = card.cpu || null;
// Кодировщик на видеокарте (настройка панели). Веса и раскладка те же, что у
// Rust; жадный RNN-T остаётся на процессоре: он на кусок стоит ~13 мс, а
// гонять его шаги через видеокарту дороже самого счёта.
let wantGpu = false;
/** Где на деле считает кодировщик: 'webgpu', если видеокарта поднялась. */
let device = 'wasm';
/** Приложение Android: модель считает его 64-битный процесс (lib/nemo-host.js). */
let native = false;

// Вызовы натива через страницу: {type: 'native', id, op, args} туда,
// {type: 'NATIVE', id, ok, value | error} обратно (offscreen.js relayNative).
const calls = new Map();
let callNo = 0;
function host(op, args = {}) {
  return new Promise((ok, bad) => {
    const id = ++callNo;
    calls.set(id, { ok, bad });
    self.postMessage({ type: 'native', id, op, args });
  });
}

// ORT здесь больше нет, а NemoStream берёт у него только конструктор тензора:
// входы кодировщика и его кеши. Своему кодировщику нужны лишь поля.
class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

const post = (type, data) => self.postMessage({ type, ...data });

/**
 * Сколько потоков дать счёту на Rust.
 *
 * Не больше четырёх, и два логических ядра оставляем браузеру: в том же
 * процессе играет вкладка, идёт захват и переводчик, а счёт во все ядра душит
 * захват (memory cpu-work-strangles-capture).
 */
// Без SharedArrayBuffer (WebView Android: COOP он не слушает) общую память
// помощникам не передать: считаем в один поток.
const cpuThreads = () => typeof SharedArrayBuffer === 'undefined' ? 1
  : Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 2));

let nemo = null;
let loading = null;
// Язык держим отдельно от модели: сказать его могут раньше, чем она соберётся,
// и тогда применить его будет некуда. Начальное значение — «auto»: у модели
// это настоящий слот подсказки (101), то есть «определи сама», а не отсутствие
// языка. Ставить сюда 'en' значит объявлять английской любую речь, пока зритель
// не выберет язык руками, — а по умолчанию он стоит как раз на «авто».
let lang = 'auto';
/** Сколько отсчётов уже превращено в текст: по ним снаружи считают отставание. */
let done = 0;
/**
 * Сколько настоящего звука отдано модели. done его не обгоняет: кусок модели
 * считается целиком, а по паузе flush() добивает его тишиной, которой не
 * звучало. Без потолка каждая пауза приписывала к услышанному до целого куска
 * (на процессоре это 1.12 с), и отставание уходило в минус — −0.4 с на стенде.
 */
let pushed = 0;
/** Номер фразы, к которой относится текст, который сейчас набирается. */
let phrase = 0;
/**
 * Сколько отсчётов выброшено, не дойдя до модели: пока она грузилась, те, что
 * отправлены до готовности, а дошли после, и паузы, отданные под перегрузкой
 * (squeeze).
 *
 * Считать их здесь, а не в offscreen: там «пропущено» — это то, что ушло до
 * сообщения ready, но сборка сессий держит поток воркера секундами, сообщения
 * копятся в очереди и разбираются уже с готовой моделью. Offscreen записывал
 * их в пропущенные, модель их же досчитывала, и отставание строки выходило на
 * эти секунды отрицательным (−4 с на процессоре, стенд 10.10).
 */
let skipped = 0;
/**
 * Миг готовности модели: звук, отправленный раньше, — уже прошлое. Часы
 * монотонные (wallNow), а не Date.now(): перевод системных часов назад
 * выбрасывал бы весь звук до прежнего мига, молча.
 */
const wallNow = () => performance.timeOrigin + performance.now();
let readyAt = 0;

/**
 * Веса и словарь — из пакета или кеша.
 *
 * Полосу загрузки ведём по именам файлов: offscreen показывает их одной
 * строкой — «качаю модель: файл — сколько из скольких».
 */
async function load() {
  if (nemo) return;
  if (loading) return loading;
  loading = (async () => {
    if (!cpuBuild) throw new Error('Speech recognition could not start: this model has no CPU version.');
    // Не чаще раза в 100 мс на файл (начало и конец файла — всегда; без
    // content-length конца не знаем — тогда тоже раз в 100 мс). Firefox
    // отдаёт поток мелкими кусками: ~8000 отметок на полгигабайта, и каждая в
    // фоне — запись статуса в storage. Очередь записей отставала на 14 с:
    // модель давно писала текст, а панель всё показывала загрузку.
    let progAt = 0, progFile = '';
    const onProgress = (p) => {
      const now = performance.now();
      if (p.file === progFile && p.loaded > 0 && !(p.total && p.loaded >= p.total) && now - progAt < 100) return;
      progFile = p.file;
      progAt = now;
      post('progress', p);
    };
    // Телефон: веса уже в APK, натив читает их сам; не вышло (эмулятор x86,
    // старая сборка без ядра) — тот же wasm, что в Chrome.
    if (native) {
      post('status', { stage: 'loading', device });
      const eng = await hostEngine(host).catch((e) => {
        console.warn('натив не поднял модель, считаю в wasm:', e?.message || e);
        return null;
      });
      if (eng) return void await build({ encoder: async () => eng.encoder(), rnnt: async () => eng.rnnt() }, new Map(), eng.threads);
    }
    const w = WIRE.genai;
    // Что уже лежит в кеше, скажем заранее: первая загрузка — это пятьсот
    // мегабайт, и молчать о них нельзя, а вторая мгновенна, и полоса на ней
    // только мешает. Судим по весам кодировщика: они и есть эти мегабайты.
    const first = !await cached(hfUrl(repo, w.data.encoder));
    post('status', { stage: first ? 'downloading' : 'loading', device });

    // По одному и по порядку: пятьсот мегабайт параллельными потоками — это
    // несколько буферов в памяти сразу и полоса, скачущая между файлами.
    // Графы .onnx не берём: своему коду нужны только веса и словарь. Веса
    // процессорного счёта не берём тоже: их rust() кладёт прямо в память
    // модуля, мимо кучи JS.
    const d = w.data;
    const direct = new Set([d.decoder, d.joint, ...(wantGpu ? [] : [d.encoder])]);
    const files = new Map();
    for (const name of weightFiles().filter(n => !n.endsWith('.onnx') && !direct.has(n))) {
      files.set(name, await weight(hfUrl(repo, name), onProgress));
    }
    await build(await rust(files, onProgress), files, cpuThreads());
  })().catch(e => {
    nemo = null;
    post('error', { error: String(e?.message || e) });
  }).finally(() => { loading = null; });
  return loading;
}

/** Поток из готового кодировщика и RNN-T (rust() или hostEngine). */
async function build(rs, files, threads) {
    post('status', { stage: 'loading', device });
    // Собираем в местную переменную, а наружу отдаём только готовое: звук идёт
    // непрерывно, и поток, объявленный готовым до сборки, начал бы push()
    // поверх недособранной модели.
    const made = new NemoStream({
      ort: { Tensor },
      // Для NemoStream это про сессии ORT, которых нет: свой кодировщик
      // приходит из makeEncoder, где бы он ни считал.
      devices: { encoder: 'wasm' },
      chunkFrames: cpuBuild.chunkFrames,
      makeEncoder: rs.encoder,
      makeRnnt: rs.rnnt,
      file: (name) => files.get(name) ?? hfUrl(repo, name)
    });
    await made.load();
    // Байты больше не нужны: модуль на Rust скопировал их к себе.
    files.clear();
    made.setLanguage(lang);
    nemo = made;
    readyAt = wallNow();
    post('ready', { model: repo, device, threads });
}

/**
 * Свой счёт на Rust (lib/nemo-rs.js): кодировщик и жадный RNN-T делят один
 * модуль и одних помощников.
 *
 * Модуль собирается внутри NemoStream.load(); байты он копирует к себе, и
 * files можно чистить сразу после. Веса процессорного счёта качаются прямо в
 * память модуля (weightsInto): копия кодировщика в куче JS — это лишние
 * 400 МБ на пике, и на телефоне WebView их не даёт.
 */
async function rust(files, onProgress) {
  const layout = JSON.parse(new TextDecoder().decode(await weight(hfUrl(repo, cpuBuild.layout))));
  const own = async (name) => files.get(name) ?? await weight(hfUrl(repo, name), onProgress);
  const d = WIRE.genai.data;
  let engine = null;
  const ready = async () => engine ??= await rustEngine({ threads: cpuThreads() });
  const into = async (...names) => {
    const e = await ready();
    return weightsInto(names.map(n => hfUrl(repo, n)), (n) => e.reserve(n), onProgress);
  };
  return {
    encoder: async () => {
      // Видеокарта не поднялась (нет WebGPU, нет int8-скалярного произведения,
      // отказ драйвера) — молча на процессор: субтитры важнее, а где считало,
      // панель покажет по device.
      if (wantGpu) {
        try {
          // Модуль — только по требованию: в приложении Android его в пакете нет
          // (ports/android/tools/pack-ext.py), там считает процессор.
          const { gpuEngine } = await import('./lib/nemo-gpu.js');
          const enc = await (await gpuEngine()).encoder({ src: await own(d.encoder), extra: await own(cpuBuild.extra), layout });
          device = 'webgpu';
          return enc;
        } catch (e) {
          console.warn('кодировщик на видеокарте не поднялся, считаю процессором:', e?.message || e);
        }
      }
      device = 'wasm';
      files.delete(d.encoder);
      return (await ready()).encoder({ src: await into(d.encoder, cpuBuild.extra), layout });
    },
    rnnt: async () => (await ready()).rnnt({ sources: [await into(d.decoder, d.joint)], layout: layout.rnnt })
  };
}

/**
 * Отдать наружу то, что наросло. Пустое не шлём: строку это только дёргает.
 *
 * Вместе с текстом уходит цена прохода: сколько звука он съел и сколько на это
 * ушло. Снаружи по ним считают, успевает ли поток за речью, — а не успевает он
 * молча, просто теряя куски из очереди.
 */
function say(text, ms, samples) {
  if (!text) return;
  post('live', { text, phrase, consumed: done, skipped, ms, seconds: +(samples / 16000).toFixed(2),
    lang: heardLang() });
}

/**
 * С какого языка переводить.
 *
 * Когда зритель назвал язык сам, ответ известен заранее. Когда стоит «авто» —
 * его знает только модель: она печатает метку <xx-XX> в поток, и nemo.js её
 * оттуда вынимает. Без этого переводчику пришлось бы называть язык наугад, и
 * до сих пор он назывался английским — то есть немецкая речь уезжала в
 * переводчик как английская.
 */
function heardLang() {
  return lang === 'auto' ? (nemo?.heard || '') : lang;
}

// Очередь на один поток.
//
// Обработчик сообщений асинхронный, а Worker их не придерживает: пока первый
// FEED ждёт кодировщик, приходит второй и заходит в ту же модель. У оконного
// воркера это невозможно (там на задание есть busy и очередь снаружи), а
// здесь состояние — кеши кодировщика и h/c предиктора — общее и меняется
// каждым куском. Два push одновременно перемешали бы их молча.
//
// Поэтому всё, что меняет поток, ложится сюда и разбирается по одному. Звук и
// отметки фраз лежат в одной очереди нарочно: отметка означает «здесь была
// тишина», и место у неё ровно между теми кусками, между которыми она пришла.
const inbox = [];
let running = false;
// Сколько пунктов очереди пройдено: по нему offscreen видит, что цикл не встал (PING).
let steps = 0;
// Сброс модели (RESET при смене языка) обнуляет кеши кодировщика и h/c
// предиктора. Если сделать это прямо в onmessage, пока drain-цикл висит внутри
// chunk() на `await encoder.run()`, возобновившийся кусок прочитает уже
// обнулённый this.cache.ch → «Cannot read properties of null (reading 'ch')».
// Поэтому при живом цикле сброс откладываем до паузы между кусками (ровно та же
// дисциплина «по одному», что держит inbox) — применяем его в run().
let pendingReset = false;
// Сброс подтверждаем номером, когда он применён: всё, что воркер прислал до
// подтверждения, offscreen выбрасывает как звук прошлого сеанса.
let resetNo = 0;
function doReset() {
  nemo?.reset();
  post('reset', { no: resetNo });
}

// Сколько звука разрешено накопить в очереди. Если машина не успевает, лучше
// потерять секунду речи, чем уехать в отставание на весь ролик: субтитры
// живут настоящим, и догонять им некуда.
const MAX_BACKLOG = 16000 * 4;
let backlog = 0;
let dropped = 0;
// Выбрасываем устаревший звук из очереди сообщений, пока он не станет свежим (см. FEED).
let stale = false;

// Первые проходы собирают модуль и стоят дороже — выброшенное в них не в счёт.
const SLOW_ARMED = 16000;
// Выброшенное после прогрева — машина не тянет, панель об этом предупредит
// (STRAIN в background.js). Прогрев сам переполняет очередь и на свободной
// машине, поэтому тоже с SLOW_ARMED. Сигнал не чаще STRAIN_EVERY_MS.
const STRAIN_EVERY_MS = 60000;
let strainAt = 0;

// Не успевает поток — сперва отдаём паузы, а не слова. В паузе слов нет, и
// пока их хватает, перегрузка стоит только длины пауз: очередь держится у
// SOFT_BACKLOG, отставание не копится до MAX_BACKLOG, и ни одно слово не
// пропадает. Пауза — три куска подряд (≥ 192 мс) на QUIET ниже громкой речи
// в очереди; выбрасываем средний. Одиночный тихий кусок бывает и внутри
// слова — смычка перед «k» или «t» — его не трогаем. Сплошная речь или музыка
// без пауз — дальше обычный выброс старого звука по MAX_BACKLOG.
const SOFT_BACKLOG = 16000;
const QUIET = 0.01;               // −20 дБ по мощности
const LOUD_RANK = 0.8;            // «громкая речь» — 80-й процентиль очереди
const SILENT = 1e-7;              // −70 дБ: цифровая тишина тиха и без сравнения
/** Сколько пауз выброшено из очереди: звук не слышан моделью, но слов в нём не было. */
let squeezed = 0;

function power(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return sum / pcm.length;
}

function squeeze() {
  const pcms = inbox.filter(x => x.pcm);
  if (pcms.length < 3) return false;
  const loud = pcms.map(x => x.power).sort((a, b) => a - b)[Math.floor((pcms.length - 1) * LOUD_RANK)];
  const quiet = x => x.power < SILENT || x.power < loud * QUIET;
  for (let i = 1; i < pcms.length - 1; i++) {
    if (!quiet(pcms[i - 1]) || !quiet(pcms[i]) || !quiet(pcms[i + 1])) continue;
    inbox.splice(inbox.indexOf(pcms[i]), 1);
    backlog -= pcms[i].pcm.length;
    squeezed += pcms[i].pcm.length;
    // В счёт отставания идёт как пропущенное: прозвучало, но модель его не
    // слышала (см. skipped).
    skipped += pcms[i].pcm.length;
    return true;
  }
  return false;
}

function queue(item) {
  if (item.pcm) {
    item.power = power(item.pcm);
    backlog += item.pcm.length;
    while (backlog > SOFT_BACKLOG && squeeze());
    // Выбрасываем разом, одним куском до SOFT_BACKLOG, а не по 64 мс. По
    // куску выходило хуже всего: при проходе чуть дороже звука (1–2×) каждый пришедший кусок выбивал самый старый, и модель
    // слышала речь с дыркой в 64 мс каждые 300–400 мс. Слова из таких обрывков
    // она не собирает, а кеши кодировщика тянут обрывки и в следующие фразы.
    // Одним выбросом теряется та же доля звука, но остальное слышно целиком.
    if (backlog > MAX_BACKLOG) {
      while (backlog > SOFT_BACKLOG) {
        const old = inbox.findIndex(x => x.pcm);
        if (old < 0) break;
        backlog -= inbox[old].pcm.length;
        dropped += inbox[old].pcm.length;
        inbox.splice(old, 1);
      }
      if (done >= SLOW_ARMED && Date.now() - strainAt > STRAIN_EVERY_MS) {
        strainAt = Date.now();
        post('strain');
      }
    }
  }
  inbox.push(item);
  run();
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (true) {
      // Между кусками — ни одного chunk() в полёте: здесь обнулять кеши
      // безопасно. Сброс делаем до проверки inbox, чтобы отложенный RESET
      // применился даже когда очередь уже пуста.
      if (pendingReset) { pendingReset = false; doReset(); }
      if (!inbox.length) break;
      const item = inbox.shift();
      if (item.pcm) { backlog -= item.pcm.length; await feed(item.pcm); }
      else await mark(item.phrase, item.cut, item.end);
      steps++;
    }
  } catch (e) {
    console.error('поток упал', e);
    post('error', { error: String(e?.message || e) });
  } finally {
    running = false;
    // Сброс мог прийти на самом выходе из цикла — не оставляем его висеть до
    // следующего FEED, модель должна встретить новый звук уже чистой.
    if (pendingReset) { pendingReset = false; doReset(); }
  }
}

async function feed(pcm) {
  const t0 = performance.now();
  pushed += pcm.length;
  const r = await nemo.push(pcm);
  // Куска не набралось — сказать нечего, и это обычное дело: звук идёт
  // порциями по 64 мс, а кусок модели — 320, 560 или 1120 на процессоре.
  if (!r.chunks) return;
  const heard = r.chunks * nemo.chunkSamples;
  done = Math.min(done + heard, pushed);
  const ms = Math.round(performance.now() - t0);
  say(r.text, ms, heard);
}

async function mark(at, cut, end) {
  const t0 = performance.now();
  // Добиваем неполный кусок тишиной только в конце звука (end): иначе
  // последнее слово сеанса так и осталось бы в буфере.
  //
  // На паузе не добиваем. Сегментатор ставит её отметку после 700 мс тишины,
  // а кусок 320: к отметке всё сказанное уже посчитано, в буфере лежит одна
  // тишина. Добивка ничего не дописывала, зато подкладывала до 340 мс
  // цифровых нулей (лог-мел таких на живом звуке не бывает) в кеши
  // кодировщика и сдвигала сетку кусков. Офлайн на ролике v9QtM6qnG50 одна
  // такая добивка за три минуты роняла F1 93.7 → 92.3: текст расходился с
  // непрерывным потоком до самого конца («flow» → «float», «let's pray» →
  // «it's looks prayer»). Без неё строки совпадают с потоком без отметок
  // слово в слово. По таймеру не добивали и раньше: там тишина разрезала бы
  // слово пополам.
  //
  // А вот строку закрываем всегда. Сначала было иначе — по таймеру менялся
  // только номер фразы, — и на плотной речи, где пауз почти нет, строка не
  // закрывалась вовсе: за три минуты ролика вышло две закрытых фразы, строка
  // доросла до 440 слов, и переводчик пережёвывал её целиком каждую секунду.
  // Слово доезжало до экрана за 13.8 с вместо секунды.
  const r = end ? await nemo.flush() : { text: '', chunks: 0 };
  const ms = Math.round(performance.now() - t0);
  // Добитый кусок — это звук плюс тишина; в счёт отставания идёт то, что
  // прозвучало на самом деле, поэтому тишину сюда не приписываем: после
  // добивки услышано ровно всё отданное (pushed).
  const heard = r.chunks * nemo.chunkSamples;
  done = Math.min(done + heard, pushed);
  say(r.text, ms, heard);
  // cut уходит наружу: по нему там решают, договорено ли последнее слово.
  // После 700 мс тишины оно дописано; таймер режет посреди речи, и хвост
  // слова досчитается уже после отметки.
  post('closed', { phrase: at, consumed: done, skipped, ms, dropped, squeezed, cut,
    seconds: +(heard / 16000).toFixed(2), lang: heardLang() });
  // Строку начинаем с чистого листа, поток — нет: clearText() кеши
  // кодировщика не трогает.
  nemo.clearText();
  phrase = at;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'NATIVE') {
    const c = calls.get(m.id);
    calls.delete(m.id);
    return void (m.ok ? c?.ok(m.value) : c?.bad(new Error(m.error || 'native call failed')));
  }
  // Пульс: ответ идёт между кусками, и воркер, вставший в Atomics.wait, молчит.
  if (m.type === 'PING') return void post('pong', { busy: running, steps });
  try {
    if (m.type === 'LOAD') {
      if (m.language) lang = m.language;
      // Сборку принимаем только до загрузки: модель уже собрана из тех файлов,
      // и менять на ходу нечего — это новый воркер, а не новое сообщение.
      if (!nemo && !loading) {
        if (m.repo) repo = m.repo;
        if (m.cpu !== undefined) cpuBuild = m.cpu;
        wantGpu = !!m.gpu;
        native = !!m.native;
      }
      await load();
      return;
    }
    if (m.type === 'LANGUAGE') {
      if (m.language) lang = m.language;
      // Новый сеанс под «авто»: метка прошлого назвала бы язык с первым же
      // словом, и перевод начался бы со старого.
      if (lang === 'auto' && nemo) nemo.heard = '';
      return void nemo?.setLanguage(lang);
    }
    if (m.type === 'RESET') {
      inbox.length = 0; backlog = 0; dropped = 0; squeezed = 0; done = 0; pushed = 0; phrase = 0; skipped = 0;
      // Живой drain-цикл может сейчас висеть внутри chunk(): обнулить кеши под
      // ним — краш (см. pendingReset выше). Откладываем до паузы между кусками;
      // на простое сбрасываем сразу.
      resetNo = m.no ?? 0;
      if (running) pendingReset = true;
      else doReset();
      return;
    }
    // Пока веса качаются, звук девать некуда: копить его бессмысленно —
    // восемьсот мегабайт едут не секунду, а субтитры живут настоящим. Тем же
    // путём идёт звук, застрявший в очереди сообщений, пока сборка сессий
    // держала поток: иначе модель начинает с отставанием в несколько секунд и
    // догоняет его ещё дольше.
    if (m.type === 'FEED' && (!nemo || m.at < readyAt)) { skipped += m.pcm.length; return; }
    // На процессоре кусок считается синхронно, весь между двумя сообщениями, и
    // inbox перегрузки не видит: она копится в очереди сообщений воркера, без
    // потолка. Отставание растёт минутами, и даже RESET нового сеанса ждёт за
    // всем старым звуком. Поэтому возраст звука смотрим здесь, как MAX_BACKLOG
    // в queue: старше него — выбрасываем разом, до SOFT_BACKLOG, не по куску.
    if (m.type === 'FEED') {
      const age = (wallNow() - m.at) * 16;
      if (age > MAX_BACKLOG) stale = true;
      else if (age <= SOFT_BACKLOG) stale = false;
      if (stale) {
        // Только в dropped: offscreen складывает skipped и dropped, и кусок
        // в обоих считался бы дважды.
        dropped += m.pcm.length;
        if (done >= SLOW_ARMED && Date.now() - strainAt > STRAIN_EVERY_MS) {
          strainAt = Date.now();
          post('strain');
        }
        return;
      }
    }
    if (!nemo) return;
    if (m.type === 'FEED') return void queue({ pcm: m.pcm });
    if (m.type === 'MARK') return void queue({ phrase: m.phrase, cut: !!m.cut, end: !!m.end });
  } catch (e) {
    console.error('поток упал на сообщении', m?.type, e);
    post('error', { error: String(e?.message || e) });
  }
};
