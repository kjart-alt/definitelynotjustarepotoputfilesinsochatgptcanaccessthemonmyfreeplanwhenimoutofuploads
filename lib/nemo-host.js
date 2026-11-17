// nemotron в процессе приложения Android (ports/android Nemo.kt): то же ядро
// на Rust (native/nemo-enc), собранное под arm64.
//
// WebView на телефоне бывает 32-битным даже на 64-битном Android, и тогда
// память wasm не растёт дальше пары сотен мегабайт: 620 МБ модели туда не
// помещаются («Invalid typed array length» на reserve()). Процесс приложения
// 64-битный, веса он читает сам из APK; сюда ходят только мел куска и
// выбранные символы.
//
// Воркеру до натива дороги нет (AtNative есть только у страниц): вызовы идут
// через offscreen.js (relayNative). Порядок вызовов натив держит: у него одна
// очередь на всё.

const DIM = 1024;

/** Float32Array → base64 его байт. */
function b64(f32) {
  const u = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Модель в нативе; из неё — кодировщик и RNN-T для NemoStream, как у
 * rustEngine (lib/nemo-rs.js).
 *
 * @param {(op: string, args?: object) => Promise<any>} call вызов натива
 */
export async function hostEngine(call) {
  // gen — номер этой загрузки: вызовы прошлого воркера, что ещё в очереди
  // натива, кеши нового уже не тронут.
  const { threads, gen } = await call('nemo.load');
  return {
    threads,

    /** Кодировщик под видом сессии ORT; кеши и его выход остаются в нативе. */
    encoder() {
      let mark = null;
      return {
        inputNames: ['audio_signal', 'cache_last_channel', 'cache_last_time', 'lang_onehot'],
        async run(feeds) {
          const T = feeds.lang_onehot.dims[1];
          await call('nemo.encode', {
            gen, t: T, fresh: feeds.cache_last_channel !== mark,
            sig: b64(feeds.audio_signal.data), hint: b64(feeds.lang_onehot.data)
          });
          mark = { dispose() {} };
          return {
            // Кадры кодировщика натив сразу кладёт под RNN-T: возить их сюда незачем.
            outputs: { dims: [1, T, DIM], getData: async () => null },
            cache_last_channel_next: mark,
            cache_last_time_next: mark
          };
        }
      };
    },

    /** Жадный RNN-T по кадрам последнего encode. */
    rnnt() {
      return {
        reset: () => void call('nemo.reset', { gen }).catch(() => {}),
        marks: (ends, commas) => void call('nemo.marks', { gen, ends: ends.slice(0, 32), commas: commas.slice(0, 32) })
          .catch((e) => console.warn('натив не принял концы фраз:', e?.message || e)),
        run: (enc, T, blank, end, comma) => call('nemo.greedy', { gen, t: T, blank, end, comma })
      };
    }
  };
}
