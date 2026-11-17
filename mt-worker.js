// Движок перевода моделями Firefox (bergamot в wasm) — для lib/firefox-mt.js.
//
// Обычный воркер, не модуль: связку wasm Firefox отдаёт скриптом с
// глобальной функцией loadBergamot, и взять её можно только importScripts.
// Файлы пар страница уже скачала в Cache API (или они в пакете) — воркер
// читает их оттуда сам, чтобы мегабайты весов не ездили сообщениями.
//
// Перевод синхронный и по одному: очередь — цепочка обещаний, иначе загрузка
// пары (она ждёт кеш) перемешалась бы с переводом строки.

importScripts('vendor/bergamot/bergamot-translator.js');

const CACHE = 'translator-mt-v1';
// Пар в памяти: перевод через английский держит две, плюс прежний язык речи
// при «определить сам». Пара — от 15 до 60 МБ кучи wasm.
const KEEP = 4;
const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
const CONFIG = {
  'beam-size': '1',
  normalize: '1.0',
  'word-penalty': '0',
  'max-length-break': '128',
  'mini-batch-words': '1024',
  workspace: '128',
  'max-length-factor': '2.0',
  'skip-cost': 'true',
  'cpu-threads': '0',
  quiet: 'true',
  'quiet-translation': 'true'
};

let bergamot = null;
function boot() {
  return bergamot ??= fetch('vendor/bergamot/bergamot.wasm')
    .then(r => { if (!r.ok) throw new Error(`bergamot.wasm: ${r.status}`); return r.arrayBuffer(); })
    .then(wasmBinary => new Promise((resolve, reject) => {
      const B = loadBergamot({
        INITIAL_MEMORY: 41943040,
        wasmBinary,
        print: () => {},
        printErr: () => {},
        onAbort: (e) => reject(new Error('bergamot aborted: ' + e)),
        onRuntimeInitialized: () => resolve(B)
      });
    }))
    .catch(e => { bergamot = null; throw e; });
}

let service = null;
/** Загруженные пары, последняя тронутая — в конце. */
const models = new Map();

async function model(B, { pair, files }) {
  const have = models.get(pair);
  if (have) {
    models.delete(pair);
    models.set(pair, have);
    return have;
  }
  const store = await caches.open(CACHE);
  const mem = {};
  try {
    for (const f of files) {
      // Пара в пакете — .gz рядом с mt.json: распаковать по пути, кеш не нужен.
      const hit = (f.pack && await fetch(f.pack).then(r => r.ok ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))) : null, () => null))
        || await store.match(f.key);
      if (!hit) throw new Error(`${f.name}: not downloaded`);
      const buf = new Uint8Array(await hit.arrayBuffer());
      const m = new B.AlignedMemory(buf.length, ALIGN[f.type] || 64);
      m.getByteArrayView().set(buf);
      mem[f.type] = m;
    }
    const vocabs = new B.AlignedMemoryList();
    if (mem.vocab) vocabs.push_back(mem.vocab);
    else if (mem.srcvocab && mem.trgvocab) { vocabs.push_back(mem.srcvocab); vocabs.push_back(mem.trgvocab); }
    else throw new Error(`${pair}: no vocabulary`);
    const name = files.find(f => f.type === 'model')?.name || '';
    const config = '\n' + Object.entries({
      ...CONFIG,
      'gemm-precision': name.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll'
    }).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
    const [s, d] = pair.split(/-(?=[a-z]{2}(?:-[A-Z][a-z]+)?$)/);
    // Без шортлиста: см. files() в lib/firefox-mt.js.
    const tm = new B.TranslationModel(s, d, config, mem.model, null, vocabs, null);
    models.set(pair, tm);
    while (models.size > KEEP) {
      const [old, m] = models.entries().next().value;
      models.delete(old);
      try { m.delete(); } catch {}
    }
    return tm;
  } catch (e) {
    // Память под веса забирает модель; не собралась — отдаём сами.
    for (const m of Object.values(mem)) { try { m.delete(); } catch {} }
    throw e;
  }
}

async function run({ models: need, text }) {
  const B = await boot();
  service ??= new B.BlockingService({ cacheSize: 0 });
  const tms = [];
  for (const m of need) tms.push(await model(B, m));
  const messages = new B.VectorString();
  const options = new B.VectorResponseOptions();
  let res = null;
  try {
    messages.push_back(text);
    options.push_back({ qualityScores: false, alignment: false, html: false });
    res = tms.length === 1
      ? service.translate(tms[0], messages, options)
      : service.translateViaPivoting(tms[0], tms[1], messages, options);
    return res.get(0).getTranslatedText();
  } finally {
    messages.delete();
    options.delete();
    res?.delete();
  }
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.op === 'load') {
        // Прогрев: движок и пары в память до первой строки (см. create()).
        const B = await boot();
        for (const m of data.models) await model(B, m);
        return postMessage({ id: data.id, text: '' });
      }
      if (data.op === 'drop') {
        // Пары больше не нужны (переводит словарь Chrome): веса — из памяти.
        for (const p of data.pairs) {
          const m = models.get(p);
          models.delete(p);
          try { m?.delete(); } catch {}
        }
        // Сколько пар осталось в памяти: 0 — воркер можно закрыть.
        return postMessage({ id: data.id, text: String(models.size) });
      }
      if (data.op !== 'run') throw new Error(`unknown op ${data.op}`);
      postMessage({ id: data.id, text: await run(data) });
    } catch (e) {
      // Упавший внутри wasm (abort, нехватка памяти) модуль дальше не
      // работает: следующую строку переводит новый, с чистой кучей.
      if (e instanceof WebAssembly.RuntimeError || /abort/i.test(e?.message)) {
        bergamot = null; service = null; models.clear();
      }
      postMessage({ id: data.id, error: String(e?.message || e) });
    }
  });
};
