// nemotron на процессоре — свой, на Rust (native/nemo-enc), без ORT:
// кодировщик и жадный RNN-T (предиктор и joint) в одном модуле.
//
// ORT на wasm считал процессорный граф int8-весами, которые воркер собирал из
// int4 пакета: 775 мс на кусок 1120 мс в четыре потока, 95-й процентиль 1001.
// Свой кодировщик берёт int4 как есть (relaxed-simd: точка i8×i7 в i32, на
// Chrome с AVX-VNNI это vpdpbusd), и на том же процессоре кусок 320 мс стоит
// 28–33 мс в четыре потока и 53–64 в один в чистом Chrome (i5-13500H, Chrome 155,
// 22.10; натив ORT 45 и 65), в расширении на живом звуке 31 в четыре. Отсюда и
// кусок как на видеокарте: 1120 мс держались только ради цены прохода.
//
// Точность: против того же графа на int4-весах без квантования входа (ORT,
// accuracy_level 0) косинус выхода 0.996–0.999 на потоке кусков; процессорный
// граф ORT давал против него же 0.93–0.98 — у int8-весов масштаб на столбец.
//
// RNN-T через ORT — это десятки run() на кусок, каждый со своей ценой входа;
// здесь кусок — один вызов, веса fp32 те же, выбор тот же (src/rnnt.rs).
//
// Потоки — экземпляры одного модуля на общей памяти, по воркеру на каждый
// (nemo-rs-helper.js). Задание раздаётся кусками через атомарный счётчик,
// спят помощники в Atomics.wait. Ждать на главном потоке страницы нельзя,
// поэтому движок живёт только в воркере (live-worker.js). Кодировщик и RNN-T
// зовутся по очереди и делят одних и тех же помощников.

const DIM = 1024;

/**
 * Модуль, память и помощники; из него — кодировщик и RNN-T для NemoStream.
 *
 * @param {object} o
 * @param {number} o.threads сколько потоков считает, вместе с этим
 * @param {WebAssembly.Module=} o.module готовый модуль (node: fetch не берёт file:)
 */
export async function rustEngine({ threads, module }) {
  const mod = module ?? await WebAssembly.compileStreaming(fetch(new URL('../vendor/nemo/nemo_enc.wasm', import.meta.url)));
  // 512 страниц на старт, потолок 1.5 ГБ: кодировщик 435 МБ и разложенные ~90,
  // предиктор с joint — 97. Общая память резервирует потолок целиком сразу, и
  // 32-битный Chrome на Windows 1.5 ГБ адресов часто не находит: тогда потолок
  // ниже, модели хватает и 768 МБ.
  let memory, fail;
  for (const maximum of [24576, 16384, 12288]) {
    try { memory = new WebAssembly.Memory({ initial: 512, maximum, shared: true }); break; }
    catch (err) { fail = err; }
  }
  if (!memory) throw new Error(`Not enough memory for the speech model (${fail?.message || fail})`);
  const e = (await WebAssembly.instantiate(mod, { env: envFor(memory) })).exports;
  // alloc() при нехватке памяти отдаёт 0: писать туда — портить сам модуль.
  const alloc = (n) => {
    const p = e.alloc(n);
    if (!p) throw new Error(`Not enough memory for the speech model (${Math.round(n / 1048576)} MB more)`);
    return p;
  };
  const f32 = (p, n) => new Float32Array(memory.buffer, p, n);

  // Блоки, выданные reserve(): веса уже в памяти модуля, копировать некуда.
  const placed = new WeakSet();

  /** Склеить байты в один блок памяти модуля, таблицу — рядом; init(блок, таблица). */
  const load = (init, parts, table) => {
    const bs = parts.filter(Boolean).map(bytes);
    let blob;
    if (bs.length === 1 && placed.has(bs[0])) blob = bs[0].byteOffset;
    else {
      let at = blob = alloc(bs.reduce((n, b) => n + b.length, 0));
      for (const b of bs) { new Uint8Array(memory.buffer, at, b.length).set(b); at += b.length; }
    }
    const tp = alloc(table.length * 4);
    new Uint32Array(memory.buffer, tp, table.length).set(table);
    return init(blob, tp, table.length);
  };

  // Помощникам — свой стек по 256 КБ из той же памяти.
  // Помощник, не поднявшийся за 20 с или упавший, гасим (в цикл он ещё не
  // входил: туда пускает только {go}): par() раздаёт работу
  // тем, кто уже в цикле, и считать можно на меньшем числе потоков. Ждать
  // e.helpers() до числа воркеров без срока — вечное «загружаю».
  const started = await Promise.all(Array.from({ length: Math.max(0, threads - 1) }, () => {
    const top = alloc(1 << 18) + (1 << 18);
    return new Promise(res => {
      const w = new Worker(new URL('./nemo-rs-helper.js', import.meta.url));
      let done = false;
      const end = (ok) => {
        if (done) return;
        done = true; clearTimeout(t);
        if (!ok) w.terminate();
        res(ok ? w : null);
      };
      const t = setTimeout(() => end(false), 20000);
      w.onmessage = ({ data }) => {
        if (data?.error) console.warn('помощник кодировщика:', data.error);
        // Принят — только теперь пускаем в цикл (см. nemo-rs-helper.js).
        if (!done && !data?.error) w.postMessage({ go: true });
        end(!data?.error);
      };
      w.onerror = (ev) => { ev.preventDefault?.(); console.warn('помощник кодировщика:', ev.message); end(false); };
      w.postMessage({ mod, memory, top });
    });
  }));
  const helpers = started.filter(Boolean);
  // Принятый помощник входит в цикл сразу по {go}: дойдёт быстро.
  for (let i = 0; e.helpers() < helpers.length; i++) {
    if (i > 2000) { helpers.forEach(w => w.terminate()); throw new Error('speech model threads did not start'); }
    await new Promise(r => setTimeout(r, 5));
  }
  if (e.helpers() !== helpers.length) { helpers.forEach(w => w.terminate()); throw new Error('speech model threads miscounted'); }

  return {
    threads: helpers.length + 1,

    /**
     * Место под n байт весов прямо в памяти модуля (lib/weights.js
     * weightsInto). Отданный блок encoder() и rnnt() берут без копии. Память
     * общая и при росте не переезжает, так что вид остаётся верным.
     */
    reserve(n) {
      // Сначала alloc: он растит память, и memory.buffer до него короче.
      const p = alloc(n);
      const v = new Uint8Array(memory.buffer, p, n);
      placed.add(v);
      return v;
    },

    /**
     * Кодировщик под видом сессии ORT: run() с теми же входами и выходами.
     * Кеши лежат внутри модуля; наружу вместо них уходит метка, и если на вход
     * пришла не наша последняя метка (новый поток, reset()), модуль обнуляет
     * свои кеши.
     *
     * @param {ArrayBuffer|Uint8Array} src encoder.onnx.data — int4-веса пакета
     *   (или блок reserve() с ними и encoder-cpu.extra следом)
     * @param {ArrayBuffer|Uint8Array=} extra encoder-cpu.extra; нет — он уже в src
     * @param {{table: number[]}} layout encoder-rs.json (native/nemo-enc/tools/layout.py)
     */
    encoder({ src, extra, layout }) {
      const rc = load(e.init, [src, extra], layout.table);
      if (rc) throw new Error(`CPU encoder: bad weights (${rc})`);
      // Ядро выбираем на живых проходах: первые WARM ждут TurboFan, потом TRIES
      // проходов через раз на каждом ядре, и остаётся то, что в сумме быстрее.
      // Проход от звука не зависит — только от T, так что сравнение честное.
      const WARM = 4, TRIES = 12;
      const spent = [0, 0];
      let calls = 0;
      let mark = null;
      return {
        inputNames: ['audio_signal', 'cache_last_channel', 'cache_last_time', 'lang_onehot'],
        async run(feeds) {
          if (feeds.cache_last_channel !== mark) e.reset();
          const T = feeds.lang_onehot.dims[1];
          f32(e.sig(), (9 + 8 * T) * 128).set(feeds.audio_signal.data);
          f32(e.onehot(), T * 128).set(feeds.lang_onehot.data);
          const k = calls - WARM, trial = k >= 0 && k < TRIES;
          if (trial) e.kernel(k & 1);
          const t0 = performance.now();
          const out = f32(e.encode(T), T * DIM).slice();
          if (trial) spent[k & 1] += performance.now() - t0;
          if (++calls === WARM + TRIES) {
            e.kernel(spent[1] <= spent[0] ? 1 : 0);
            console.log(`кодировщик на процессоре: ядро i32 ${(spent[1] / TRIES * 2).toFixed(1)} мс, i16 ${(spent[0] / TRIES * 2).toFixed(1)} мс`);
          }
          mark = { dispose() {} };
          return {
            outputs: { dims: [1, T, DIM], getData: async () => out },
            cache_last_channel_next: mark,
            cache_last_time_next: mark
          };
        }
      };
    },

    /**
     * Жадный RNN-T: предиктор и joint из пакета, fp32.
     *
     * @param {(ArrayBuffer|Uint8Array)[]} sources decoder.onnx.data, joint.onnx.data
     *   (или один блок reserve() с обоими)
     * @param {{table: number[]}} layout ключ rnnt в encoder-rs.json
     */
    rnnt({ sources, layout }) {
      const rc = load(e.rnnt_init, sources, layout.table);
      if (rc) throw new Error(`CPU decoder: bad weights (${rc})`);
      return {
        /** Предиктор с нуля. */
        reset: () => e.rnnt_reset(),
        /** Концы фраз и запятые — номера символов, которым положена прибавка. */
        marks(ends, commas) {
          const m = new Uint16Array(memory.buffer, e.marks(), 64);
          m.set(ends.slice(0, 32));
          m.set(commas.slice(0, 32), 32);
          this.counts = [ends.length, commas.length];
        },
        counts: [0, 0],
        /** Кадры [T][1024] → символы; прибавки — как у NemoStream. */
        run(enc, T, blank, end, comma) {
          f32(e.frames(), T * DIM).set(enc.subarray(0, T * DIM));
          e.rnnt_bias(blank, end, comma, ...this.counts);
          return Array.from(new Uint32Array(memory.buffer, e.tokens(), e.greedy(T)));
        }
      };
    }
  };
}

/** Сон и будильник для модуля: атомики Rust на wasm пока нестабильны, зовём JS. */
export function envFor(memory) {
  // Буфер общей памяти при росте не переезжает, но объект его новый: берём
  // свежий вид на каждом вызове, иначе адреса за старой длиной не видны.
  const i32 = () => new Int32Array(memory.buffer);
  return {
    memory,
    sleep: (p, v) => Atomics.wait(i32(), p >> 2, v),
    wake: (p, n) => Atomics.notify(i32(), p >> 2, n)
  };
}

const bytes = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
