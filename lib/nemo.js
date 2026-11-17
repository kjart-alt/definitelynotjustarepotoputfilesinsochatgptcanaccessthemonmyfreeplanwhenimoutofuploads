// Потоковое распознавание: nvidia nemotron-3.5-asr-streaming-0.6b.
//
// Зачем оно вместо окна. Вся задержка живой строки — это ожидание куска звука:
// whisper добивает вход до тридцати секунд и не отвечает быстрее 3.7 с, сколько
// бы ему ни дали, moonshine пола не имеет, но берёт окно целиком и считает его
// заново на каждый снимок. Отсюда «слово на экране через 2.6 с».
//
// Cache-aware streaming устроен иначе: кодировщик держит контекст в кеш-
// тензорах и на каждом шаге считает только новый кусок. Пересчитывать нечего,
// конца фразы ждать не надо — задержка равна длине куска плюс проход. Замер в
// браузере (e2e/nemo-probe.mjs): кусок 560 мс считается за 248 мс своей сборкой
// и за 361 рабочей, слово на экране через 0.76 с от начала произнесения — но
// 0.24 из них длится само слово, см. e2e/word-end.mjs и texts/кусок/ИТОГ.txt.
//
// Модель не из transformers.js: три отдельных графа в формате
// onnxruntime-genai и свой протокол, поэтому здесь голый InferenceSession.
// Имена графов, входов и выходов — в таблице WIRE ниже.
//
// Два знания, каждое оплаченное днём отладки, живут в соседних файлах:
//   * признаки — lib/nemo-mel.js, там же сверка с эталонным процессором;
//   * кодировщик на видеокарте требует ПЕРЕПИСАННОГО графа: в исходном есть
//     Concat на 24 входа, а WebGPU даёт шейдеру не больше восьми буферов —
//     конвейер не собирается, и весь кусок выходит нулями, молча. Правленый
//     граф (пирамида из парных Concat) лежит рядом с весами под именем
//     encoder-split.onnx; веса у него те же, меняется только граф.

import { MelStream } from './nemo-mel.js';
// Слоты языка живут отдельным файлом: ту же таблицу читает каталог моделей, а
// тянуть ради неё весь потоковый движок ему незачем.
import { LANG_ID } from './nemo-langs.js';
import { Level } from './level.js';

// Длина куска: 56 мел-кадров по 10 мс. Это chunk_samples из genai_config.json.
//
// Она же — пол задержки: слово ждёт закрытия куска, в среднем полкуска, и
// никакой скоростью это не отыграть. Поэтому длина вынесена в настройку
// экземпляра (o.chunkFrames): cache-aware модели NVIDIA учат на нескольких
// задержках сразу, и короткий кусок граф может принять — кеш слоёв от него не
// зависит (left_context живёт в cache_last_channel и равен 56 кадрам
// кодировщика независимо от того, сколько новых кадров пришло).
//
// Кратность восьми обязательна: subsampling_factor = 8, и остаток кодировщик
// не увидит. Чем это оборачивается по точности — меряет e2e/nemo-probe.mjs
// --chunk=N; таблица в шапке этого файла.
export const CHUNK_FRAMES = 56;
export const CHUNK_SAMPLES = CHUNK_FRAMES * 160;   // 8960, ровно 560 мс
// Длина куска приходит из карточки модели (lib/models.js): она свойство не
// породы, а экспорта. Константы выше — значение по умолчанию, то есть сборка
// onnx-community.
// Сколько кадров прошлого кодировщик хочет видеть перед новыми:
// pre_encode_cache_size. Это не кеш слоёв, а перекрытие свёрток на входе.
const PRE_FRAMES = 9;
// Потолок символов на один кадр кодировщика: max_symbols_per_step. Без него
// RNN-T на тишине уходит в петлю и печатает один токен бесконечно.
const MAX_SYMBOLS = 10;
// Прибавка к логитам концов предложений там, где победила пустышка.
//
// На длинной сплошной речи модель почти перестаёт ставить точки: на трёх
// минутах английского 9 концов против 53 у ютуба. Сбросом и прогревом
// предиктора их не вернуть (теряются слова), а отдельная модель пунктуации
// портит русский. Но точка в логитах есть — она лишь проигрывает пустышке, и
// +2 её возвращает: 53 конца, F1 93.3 → 93.6. Вместе с точками возвращаются
// запятые, заглавные и слова, которые предиктор терял в слитной фразе.
// Переводчик Chrome режет текст по предложениям, и без точек он получал одну
// простыню: en→ru 90.0 → 90.7, es 87.6 → 89.7, fr 88.1 → 88.8, pt 87.3 → 89.2,
// ar 87.4 → 88.8, hi 85.5 → 86.9; ja→en 53.1 → 54.3 (texts/пунктуация-прибавка).
//
// Только на пустышке — чтобы точка не вытесняла настоящее слово. Там, где
// модель и так ставит точки сама, прибавка почти ничего не меняет: на
// русском 18 → 29 концов при 32 у человека, F1 тот же. Проверка —
// e2e/nemo-node.mjs --endbias=N.
const END_BIAS = 2;
const END_TOKEN = /^▁?(\.|\?|!|\.\.\.|。|？|！)$/;
// То же для запятой. С прибавкой к точкам запятых всё равно мало: 21 на 627
// слов английского против 39 у ютуба и 32 у человека, а переводчику Chrome они
// размечают придаточные. +1 на пустышке (и только если запятая обходит и
// пустышку, и точку с её прибавкой): запятых 27, F1 тот же (en 93.6, ru
// 88.8 → 89.1, fr 79.8, ja 89.6 → 89.8). Перевод: en→X chrF 68.3 → 68.9,
// смысловой в шуме (89.2 → 89.1); ru→en смысловой 80.4 → 82.0, fr→en 83.4 →
// 84.2, ja→en 54.6 → 55.6. +2 даёт en→X ещё +0.2 chrF, но в русском запятые
// начинают вытеснять точки (концов 29 → 22, ru→en chrF −0.6).
// Проверка — e2e/nemo-node.mjs --commabias=N (0 — без неё).
const COMMA_BIAS = 1;
const COMMA_TOKEN = /^▁?(,|、|，)$/;
// Штраф пустышке. Пение под музыкой (автотюн, припев) модель слышит, но
// слово там проигрывает пустышке, и на Drake «Solar Eclipse» живая строка
// стояла по 30 с при словах в песне (whisper: «She from Texas», «ain't here
// for now»). −1 логиту пустышки часть их возвращает, а речи не вредит:
// F1 en 93.6 → 93.7, fr 79.8 → 80.6, de 95.2 → 96.4, ru 89.1 → 89.1, на
// заставке без голоса выдумок нет. −1.5 уже роняет ru (88.6), −2 и en (93.0),
// −3 на пении сыплет «s s s s». Задержку штраф не двигает
// (memory/blank-bias-is-a-dead-end). Проверка — e2e/nemo-node.mjs --blankbias=N.
const BLANK_BIAS = 1;
const LAYERS = 24, DIM = 1024, TIME_CTX = 8, PRED = 640;

/**
 * Провод модели: как называются графы, файлы весов, входы и выходы, в каком
 * порядке оси. Ключ — формат экспорта; он один, onnxruntime-genai, и под этим
 * именем таблицу зовут и стенды (e2e/fixtures/nemo-live.html).
 */
export const WIRE = {
  genai: {
    // Кодировщик правленый: исходный Concat на 24 входа WebGPU не собирает.
    encoder: 'encoder-split.onnx',
    graphs: { decoder: 'decoder.onnx', joint: 'joint.onnx' },
    // Имена файлов с весами — ровно те, что записаны внутри .onnx.
    data: { encoder: 'encoder.onnx.data', decoder: 'decoder.onnx.data', joint: 'joint.onnx.data' },
    vocab: 'vocab.txt',
    words: (t) => t.split('\n'),
    blank: 13087,
    chCtx: 56,
    lang: true,
    chFirst: false,
    steps: (e) => e.outputs.dims[1],
    frame: (enc, t) => enc.slice(t * DIM, (t + 1) * DIM),
    caches: (e) => [e.cache_last_channel_next, e.cache_last_time_next, e.cache_last_channel_len_next],
    decIn: (T, last, h, c) => ({
      targets: new T('int64', BigInt64Array.from([BigInt(last)]), [1, 1]), h_in: h, c_in: c }),
    decOut: (d) => [d.decoder_output, d.h_out, d.c_out],
    jointIn: (T, frame, dout) => ({
      encoder_output: frame, decoder_output: new T('float32', dout, [1, 1, PRED]) }),
    jointOut: (j) => j.joint_output
  }
};

/**
 * Файлы весов сборки: веса кодировщика, предиктор с joiner и словарь. Сам
 * граф кодировщика сюда не входит — его путь называет карточка модели.
 *
 * @param {string} dialect строка таблицы WIRE
 * @returns {string[]} имена файлов в репозитории сборки
 */
export const weightFiles = (dialect = 'genai') => {
  const w = WIRE[dialect];
  return [w.data.encoder, w.graphs.decoder, w.data.decoder, w.graphs.joint, w.data.joint, w.vocab]
    .filter(Boolean);
};

const zeros = n => new Float32Array(n);

/**
 * Одна дорожка распознавания: звук внутрь кусками, текст наружу по мере речи.
 *
 * Состояние — кеши кодировщика и h/c предиктора — живёт между вызовами push,
 * поэтому на один поток звука нужен один экземпляр. reset() начинает заново.
 */
export class NemoStream {
  /**
   * @param {object} o
   * @param {object} o.ort модуль onnxruntime-web
   * @param {(name: string) => (string|ArrayBuffer|Promise<string|ArrayBuffer>)} o.file
   *   откуда взять файл модели по имени («encoder-split.onnx», «vocab.txt»…)
   * @param {{encoder: string, decoder: string, joint: string}=} o.devices
   *   бэкенд на каждый граф. По умолчанию кодировщик на видеокарте, а RNN-T на
   *   процессоре: предиктор и joint зовутся сотнями раз за фразу и стоят не
   *   арифметикой, а запуском — на видеокарте шаг 32 мс, на процессоре 6 мс.
   * @param {string=} o.encoder имя файла кодировщика
   * @param {'genai'=} o.dialect как устроен провод модели, см. WIRE
   * @param {() => Promise<object>=} o.makeEncoder свой кодировщик вместо сессии
   *   ORT, с тем же run() (на процессоре — nemo-rs.js)
   * @param {() => Promise<object>=} o.makeRnnt свой жадный RNN-T вместо сессий
   *   decoder и joint: reset(), marks(), run(кадры, T, прибавки) (nemo-rs.js).
   *   Языковую модель (lm) он не знает. Не поднялся — берём сессии ORT.
   */
  constructor({ ort, file, devices, dialect = 'genai', encoder, chunkFrames = CHUNK_FRAMES, makeEncoder = null, makeRnnt = null }) {
    this.ort = ort;
    this.file = file;
    const wire = WIRE[dialect];
    if (!wire) throw new Error(`неизвестный диалект модели: ${dialect}`);
    this.wire = wire;
    this.dialect = dialect;
    this.blank = wire.blank;
    this.encoderFile = encoder || wire.encoder;
    this.makeEncoder = makeEncoder;
    this.makeRnnt = makeRnnt;
    this.rnnt = null;
    if (chunkFrames % 8) throw new Error(`кусок ${chunkFrames} кадров не кратен восьми — остаток кодировщик не увидит`);
    this.chunkFrames = chunkFrames;
    // Отсчётов в куске — по ним снаружи считают, сколько звука уже обработано.
    // Считать это модульной константой нельзя: граф и его длина куска теперь
    // выбираются вместе (см. e2e/export-nemo.py), и у двух потоков в одном
    // воркере они могут быть разными.
    this.chunkSamples = chunkFrames * 160;
    this.devices = { encoder: 'webgpu', decoder: 'wasm', joint: 'wasm', ...devices };
    this.sessions = null;
    this.vocab = null;
    // Слот 101 в prompt_dictionary чекпойнта — настоящий «auto», а не
    // отсутствие подсказки: модель сама называет услышанный язык меткой
    // <xx-XX> в тексте. Поэтому по умолчанию не английский.
    this.lang = 'auto';
    this.endBias = END_BIAS;
    this.commaBias = COMMA_BIAS;
    this.blankBias = BLANK_BIAS;
    this.ends = [];
    // Языковая модель поверх жадного выбора (NGPU-LM): пустышку решает
    // акустика, среди непустых символов — акустика + α·LM. По умолчанию нет.
    // Объект с pick(lg, best, blank), advance(k), reset(), skip(k).
    this.lm = null;
    this.reset();
  }

  /** Забыть услышанное: новая дорожка, новый говорящий, перемотка. */
  reset() {
    this.mel = new MelStream();
    this.level = new Level();             // громкость входа, см. level.js
    this.pending = new Float32Array(0);   // кадры, не набравшие на кусок
    this.pendingFrames = 0;
    this.tail = new Float32Array(128 * PRE_FRAMES);  // хвост прошлого куска
    this.tailFrames = 0;
    this.cache?.ch?.dispose?.();
    this.cache?.ti?.dispose?.();
    this.cache = null;
    this.state = null;
    this.last = this.blank;
    this.pred = null;
    this.lm?.reset();
    this.text = '';
    this.heard = '';
  }

  async load() {
    if (this.sessions) return;
    const w = this.wire;
    const opts = (graph) => ({
      // Команды видеокарте ORT отправляет пачками по maxNumPendingDispatches
      // (по умолчанию 16), то есть кодировщик — это сотня отправок за проход.
      // Пока страница играет видео, каждая отправка ждёт в очереди GPU-процесса
      // за кадрами: на Apple Music (обложка-видео 1080×1080) проход куска 320 мс
      // дорожал со 120 мс до 600–700, поток уходил на процессор посреди песни.
      // Пачки по 1024 — две отправки за проход: те же 120 мс без видео и 260 с
      // ним (64 → 450, 256 → 290, 4096 → 320; стенд, 18.10). Ключ ORT из JS сам
      // не передаёт — правка в vendor/ort/ort.mjs, её стережёт test/vendor-ort.
      executionProviders: [this.devices[graph] === 'webgpu'
        ? { name: 'webgpu', maxNumPendingDispatches: 1024 }
        : this.devices[graph]],
      // Веса лежат рядом с графом отдельным файлом; ORT сам их не ищет — путь
      // надо назвать ровно так, как он записан внутри .onnx. У правленого
      // кодировщика имя внутри осталось исходным. Там, где весь граф в одном
      // файле, ключа быть не должно вовсе.
      ...(w.data[graph] ? { externalData: [{ path: w.data[graph], data: this.file(w.data[graph]) }] } : {}),
      // Кеши кодировщика — шесть мегабайт, и они идут по кругу: выход этого
      // куска становится входом следующего, а нам самим они не нужны ни разу.
      // По умолчанию ORT снимает их с видеокарты в память и заливает обратно,
      // то есть двенадцать мегабайт через шину на каждые 560 мс звука.
      // preferredOutputLocation оставляет их лежать на месте.
      //
      // Замер на трёх минутах ролика (e2e/nemo-probe.mjs --keepcache=0|1):
      // кодировщик 166 мс против 144, весь проход 224 против 209, худший
      // кусок 636 против 544, доля реального времени 0.40 → 0.37. Текст
      // побитово тот же.
      ...(graph === 'encoder' && this.devices[graph] === 'webgpu' ? {
        preferredOutputLocation: {
          cache_last_channel_next: 'gpu-buffer',
          cache_last_time_next: 'gpu-buffer'
        }
      } : {})
    });
    const names = { encoder: this.encoderFile, decoder: w.graphs.decoder, joint: w.graphs.joint };
    // Строго по очереди: параллельная сборка сессий на разных бэкендах роняет
    // ORT — «multiple calls to initWasm()», гонка за общий рантайм.
    const made = {};
    this.rnnt = this.makeRnnt && await this.makeRnnt().catch((e) => {
      // Без ORT (расширение, где считает только свой код) подменить нечем.
      if (!this.ort.InferenceSession) throw e;
      console.warn('свой RNN-T не поднялся, беру ORT:', e?.message || e);
      return null;
    });
    for (const graph of this.rnnt ? ['encoder'] : ['encoder', 'decoder', 'joint']) {
      made[graph] = graph === 'encoder' && this.makeEncoder ? await this.makeEncoder()
        : await this.ort.InferenceSession.create(await this.file(names[graph]), opts(graph));
    }
    // Что именно просит кодировщик, спрашиваем у него самого, а не у карточки
    // модели. Статизированная сборка (e2e/freeze-lens.py) держит длины внутри
    // константами, а подсказку языка принимает готовым вектором вместо номера
    // (e2e/lang-onehot.py) — входов с прежними именами у неё нет, и ORT на
    // лишнее имя отвечает ошибкой. Сборок в ходу несколько, разбирать их по
    // именам файлов значит держать таблицу, которая разойдётся с файлами.
    this.needsLens = made.encoder.inputNames.includes('length');
    this.langVec = made.encoder.inputNames.includes('lang_onehot');
    const vocab = await this.file(w.vocab);
    this.vocab = w.words(typeof vocab === 'string' ? await (await fetch(vocab)).text()
      : new TextDecoder().decode(vocab));
    this.ends = this.vocab.flatMap((v, k) => END_TOKEN.test(v ?? '') ? [k] : []);
    this.commas = this.vocab.flatMap((v, k) => COMMA_TOKEN.test(v ?? '') ? [k] : []);
    this.rnnt?.marks(this.ends, this.commas);
    this.sessions = made;
  }

  /**
   * Начать строку заново, не трогая услышанное.
   *
   * Это не reset(): кеши кодировщика и состояние предиктора остаются на месте.
   * Пауза в речи для модели — такой же звук, как всякий другой, и забывать
   * из-за неё контекст значит начинать следующую фразу глухой.
   */
  clearText() { this.text = ''; }

  /** Какой язык звучит. Меняет только подсказку кодировщику, не сбрасывает поток. */
  setLanguage(lang) { this.lang = lang in LANG_ID ? lang : 'auto'; }

  /**
   * Подсказка языка кодировщику — номером слота или готовым вектором.
   *
   * Исходный граф строил вектор сам: из номера делал нулевой тензор на всю
   * длину куска и писал в него единицу (ConstantOfShape + ScatterElements).
   * Этих двух узлов WebGPU не знает, и из-за них проход на каждом куске
   * спускался на процессор и возвращался. Собрать четыре единицы в JS стоит
   * ничего, поэтому у статизированной сборки вектор приходит снаружи.
   */
  hint(T) {
    const id = LANG_ID[this.lang];
    if (!this.langVec) return { lang_id: new T('int64', BigInt64Array.from([BigInt(id)]), [1]) };
    // Кодировщик сжимает время в восемь раз: на кусок приходится ровно
    // chunkFrames / 8 шагов, и подсказка повторяется на каждом из них.
    const steps = this.chunkFrames / 8;
    const v = new Float32Array(steps * 128);
    for (let t = 0; t < steps; t++) v[t * 128 + id] = 1;
    return { lang_onehot: new T('float32', v, [1, steps, 128]) };
  }

  /**
   * @param {Float32Array} pcm новые отсчёты 16 кГц
   * @returns {Promise<{text: string, tokens: number[], full: string, chunks: number}>}
   *   text — что добавилось этим вызовом, full — вся дорожка с последнего
   *   reset, chunks — сколько кусков модель успела посчитать (обычно 0 или 1)
   */
  async push(pcm) {
    await this.load();
    const { mel, frames } = this.mel.push(this.level.apply(pcm));
    // Копим кадры до полного куска.
    if (frames) {
      const total = this.pendingFrames + frames;
      const merged = new Float32Array(128 * total);
      for (let m = 0; m < 128; m++) {
        for (let t = 0; t < this.pendingFrames; t++) merged[m * total + t] = this.pending[m * this.pendingFrames + t];
        for (let t = 0; t < frames; t++) merged[m * total + this.pendingFrames + t] = mel[m * frames + t];
      }
      this.pending = merged; this.pendingFrames = total;
    }

    const out = [];
    let chunks = 0;
    while (this.pendingFrames >= this.chunkFrames) {
      out.push(...await this.chunk());
      chunks++;
      // Отрезаем посчитанное; хвост в PRE_FRAMES кадров уже сохранён в chunk().
      const left = this.pendingFrames - this.chunkFrames;
      const rest = new Float32Array(128 * left);
      for (let m = 0; m < 128; m++)
        for (let t = 0; t < left; t++) rest[m * left + t] = this.pending[m * this.pendingFrames + this.chunkFrames + t];
      this.pending = rest; this.pendingFrames = left;
    }

    const text = this.decode(out);
    this.text += text;
    return { text, tokens: out, full: this.text, chunks, heard: this.heard };
  }

  /**
   * Договорить последний неполный кусок.
   *
   * Модель считает целыми кусками, и если речь кончилась посередине куска, её
   * хвост так и останется в буфере: на экране это оборванное слово, которое
   * никогда не допишется. Поэтому по концу дорожки — и по паузе, когда её
   * замечает тот, кто кормит поток, — добиваем буфер тишиной до полного куска.
   * Отсчёты тишины настоящие: кодировщику нужен не признак конца, а вход.
   */
  async flush() {
    if (!this.pendingFrames && !this.mel.started) return { text: '', tokens: [], full: this.text, chunks: 0, heard: this.heard };
    const need = (this.chunkFrames - this.pendingFrames % this.chunkFrames) % this.chunkFrames;
    return this.push(new Float32Array((need + 2) * 160));
  }

  /** Один кусок: кодировщик, потом жадный RNN-T по его выходу. */
  async chunk() {
    const T = this.ort.Tensor;
    const w = this.wire;
    const { encoder, decoder, joint } = this.sessions;
    const width = PRE_FRAMES + this.chunkFrames;

    // Вход кодировщика — девять кадров прошлого и chunkFrames новых, оси
    // [1, время, банк] (chFirst в таблице WIRE — если экспорт ждёт наоборот).
    const sig = new Float32Array(width * 128);
    const ix = w.chFirst ? (t, m) => m * width + t : (t, m) => t * 128 + m;
    for (let t = 0; t < PRE_FRAMES; t++) {
      const src = t - (PRE_FRAMES - this.tailFrames);
      if (src < 0) continue;   // самое начало дорожки: прошлого ещё нет
      for (let m = 0; m < 128; m++) sig[ix(t, m)] = this.tail[m * PRE_FRAMES + src];
    }
    for (let t = 0; t < this.chunkFrames; t++)
      for (let m = 0; m < 128; m++) sig[ix(PRE_FRAMES + t, m)] = this.pending[m * this.pendingFrames + t];
    // Хвост для следующего куска — последние девять кадров этого.
    for (let m = 0; m < 128; m++)
      for (let t = 0; t < PRE_FRAMES; t++)
        this.tail[m * PRE_FRAMES + t] = this.pending[m * this.pendingFrames + this.chunkFrames - PRE_FRAMES + t];
    this.tailFrames = PRE_FRAMES;

    this.cache ??= {
      ch: new T('float32', zeros(LAYERS * w.chCtx * DIM), [1, LAYERS, w.chCtx, DIM]),
      ti: new T('float32', zeros(LAYERS * DIM * TIME_CTX), [1, LAYERS, DIM, TIME_CTX]),
      len: new T('int64', BigInt64Array.from([0n]), [1])
    };
    const e = await encoder.run({
      audio_signal: new T('float32', sig, w.chFirst ? [1, 128, width] : [1, width, 128]),
      cache_last_channel: this.cache.ch,
      cache_last_time: this.cache.ti,
      ...(this.needsLens ? {
        length: new T('int64', BigInt64Array.from([BigInt(width)]), [1]),
        cache_last_channel_len: this.cache.len
      } : {}),
      ...(w.lang ? this.hint(T) : {})
    });
    const [ch, ti, len] = w.caches(e);
    // Прошлые кеши больше не нужны, а лежат они на видеокарте — ORT их сам не
    // соберёт, буфер держится живым, пока тензор не выброшен.
    if (ch !== this.cache.ch) { this.cache.ch.dispose?.(); this.cache.ti.dispose?.(); }
    this.cache = { ch, ti, len };
    // Сколько кадров кодировщик выдал — спрашиваем ДО getData: тот забирает
    // данные себе, и лезть в тензор после него незачем.
    const steps = w.steps(e);
    const enc = await e.outputs.getData(true);

    // Свой RNN-T держит состояние предиктора у себя; пустое state здесь —
    // знак его обнулить (reset() и сброс предиктора у стенда).
    if (this.rnnt) {
      if (!this.state) { this.rnnt.reset(); this.state = {}; }
      return this.rnnt.run(enc, steps, this.blankBias, this.endBias, this.commaBias);
    }

    this.state ??= {
      h: new T('float32', zeros(2 * PRED), [2, 1, PRED]),
      c: new T('float32', zeros(2 * PRED), [2, 1, PRED])
    };
    const out = [];
    for (let t = 0; t < steps; t++) {
      const frame = new T('float32', w.frame(enc, t, steps), w.chFirst ? [1, DIM, 1] : [1, 1, DIM]);
      for (let s = 0; s < MAX_SYMBOLS; s++) {
        // Предиктор считаем только тогда, когда его вход изменился, то есть
        // после непустого символа. На пустышке он повторил бы сам себя: вход
        // у него — последний символ и состояние, а кадр кодировщика он не
        // видит вовсе, кадр входит только в joint.
        //
        // Речь редкая: на кусок в 560 мс приходится 11–12 обращений к RNN-T
        // и лишь 4–5 напечатанных символов, остальное — пустышки. Замер на
        // трёх минутах ролика (e2e/nemo-probe.mjs --predcache=0|1): запусков
        // предиктора 3715 против 1462, счёт на кусок 33.8 мс против 13.2,
        // весь проход 249 мс против 224, доля реального времени 0.44 → 0.40.
        // Текст при этом побитово тот же — кешируется ответ, а не решение.
        if (!this.pred) {
          const d = await decoder.run(w.decIn(T, this.last, this.state.h, this.state.c));
          const [doutT, h, c] = w.decOut(d);
          this.pred = { dout: await doutT.getData(true), h, c };
        }
        const j = await joint.run(w.jointIn(T, frame, this.pred.dout));
        const lg = await w.jointOut(j).getData(true);
        lg[this.blank] -= this.blankBias;   // см. BLANK_BIAS
        let best = 0;
        for (let k = 1; k < lg.length; k++) if (lg[k] > lg[best]) best = k;
        // Точка вместо пустышки, если ей не хватило меньше endBias, см. END_BIAS.
        if (best === this.blank) {
          let end = -1;
          for (const k of this.ends) if (end < 0 || lg[k] > lg[end]) end = k;
          if (end >= 0 && lg[end] + this.endBias > lg[best]) best = end;
          if (this.commaBias > 0) {
            let com = -1;
            for (const k of this.commas) if (com < 0 || lg[k] > lg[com]) com = k;
            const over = best === this.blank ? lg[best] : lg[best] + this.endBias;
            if (com >= 0 && lg[com] + this.commaBias > over) best = com;
          }
        } else if (this.lm && !this.lm.skip(best)) best = this.lm.pick(lg, best, this.blank);
        if (best === this.blank) break;
        out.push(best);
        this.lm?.advance(best);
        this.last = best;
        // Состояние предиктора двигается только на непустом символе — в этом
        // вся разница между RNN-T и обычным декодером.
        this.state = { h: this.pred.h, c: this.pred.c };
        this.pred = null;
      }
    }
    return out;
  }

  /**
   * Номера в текст.
   *
   * Языковые метки вида <ru-RU> модель печатает сама — под подсказкой «auto»
   * это единственный способ узнать, что за язык она услышала. В тексте метке
   * не место (её увидит зритель и переводчик), но выбросить её молча значит
   * потерять ответ на вопрос «с какого переводим». Поэтому запоминаем.
   */
  decode(ids) {
    let out = '';
    for (const i of ids) {
      const s = this.vocab[i] ?? '';
      const tag = /^<([a-z]{2})-[A-Z]{2}>$/.exec(s);
      if (tag) { this.heard = tag[1]; continue; }
      // <unk> — знак, которого в словаре модели нет: ни «ёлочек», ни „лапок“,
      // ни тире, ни двоеточия, ни скобок (дефис и прямые " ' есть, и внутри
      // слова модель пишет их сама: «что-то», «aujourd'hui»). Расшифровки, на
      // которых её учили, такие знаки местами содержат, и на их месте она
      // печатает <unk>: «<unk> слово<unk>» доходил до переводчика и до экрана.
      // Какой знак стоял, по нему не узнать — выбрасываем, слово остаётся.
      if (s === '<unk>') continue;
      out += s;
    }
    // Выброшенный знак мог стоять отдельно («слово — слово»): одинокий ▁ перед
    // ним и ▁ следующего слова дали бы двойной пробел.
    return out.replace(/▁+/g, ' ');
  }
}
