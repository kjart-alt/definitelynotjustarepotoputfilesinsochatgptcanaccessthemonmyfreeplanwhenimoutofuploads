// Распознавание Chrome на устройстве (SODA) под видом потокового воркера.
//
// Только для стенда (--draft=soda в e2e/subtitles.mjs): тот же конвейер,
// перевод и экран, что у nemotron, меняется лишь распознавание, и задержку до
// экрана меряем одной меркой. Отдаёт те же сообщения, что live-worker.js:
// reset, ready, live (прибавка текста, только дописывается) и closed.
//
// SODA переписывает промежуточные результаты, а лента принимает только
// прибавку. Поэтому слово уходит, когда два промежуточных подряд согласны с ним
// (LocalAgreement-2), или когда результат окончательный.

const TAGS = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', ru: 'ru-RU', ja: 'ja-JP', es: 'es-ES',
  pt: 'pt-BR', it: 'it-IT', ko: 'ko-KR', zh: 'zh-CN', hi: 'hi-IN', tr: 'tr-TR', pl: 'pl-PL' };
const tagFor = (lang) => (lang && lang.includes('-') ? lang : TAGS[lang] || 'en-US');
const toks = (t) => t.trim().split(/\s+/).filter(Boolean);

/**
 * @param {MediaStreamTrack} track звук вкладки
 * @param {(m: object) => void} emit куда отдавать сообщения воркера
 */
export function sodaStreamer(track, emit) {
  const R = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let lang = 'en', rec = null, stopped = false, base = 0, samples = 0;
  // По результату: сколько слов отдано и прошлая версия промежуточного.
  const res = new Map();

  const out = (words) => {
    if (!words.length) return;
    emit({ type: 'live', text: ' ' + words.join(' '), phrase: 0, consumed: samples, skipped: 0,
      ms: 0, seconds: +(samples / 16000).toFixed(2), lang });
  };

  const onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i], key = base + i, now = toks(r[0].transcript);
      const st = res.get(key) || { sent: 0, prev: [] };
      let upto = now.length;
      if (!r.isFinal) {
        upto = 0;
        while (upto < now.length && upto < st.prev.length && now[upto] === st.prev[upto]) upto++;
      }
      if (upto > st.sent) { out(now.slice(st.sent, upto)); st.sent = upto; }
      st.prev = now;
      res.set(key, st);
    }
  };

  const begin = () => {
    rec = new R();
    rec.lang = tagFor(lang);
    rec.processLocally = true;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = onresult;
    // После ошибки (язык ещё не поставлен: install() стенд зовёт уже после
    // клика) onend приходит не всегда, поэтому перезапуск по таймеру.
    rec.onerror = (e) => {
      console.warn('soda:', e.error);
      const was = rec;
      setTimeout(() => { if (!stopped && rec === was) { rec.onend = null; base += 1000; begin(); } }, 1000);
    };
    // ready на каждом старте, а не раз: SODA готова мгновенно, раньше, чем
    // стенд стирает статус прошлого прогона, и после install() её поднимает
    // уже перезапуск.
    rec.onstart = () => emit({ type: 'ready', model: 'soda', device: 'soda', threads: 0 });
    rec.onend = () => { base += 1000; if (!stopped) begin(); };
    rec.start(track);
  };

  const w = {
    postMessage(m) {
      if (m.type === 'RESET') {
        res.clear();
        samples = 0;
        emit({ type: 'reset', no: m.no });
      } else if (m.type === 'LANGUAGE') {
        if (m.language && m.language !== 'auto') lang = m.language;
        if (rec) { rec.onend = null; rec.abort(); }
        stopped = false;
        begin();
      } else if (m.type === 'FEED') {
        samples += m.pcm?.length || 0;
      } else if (m.type === 'MARK') {
        emit({ type: 'closed', phrase: m.phrase, consumed: samples, skipped: 0, ms: 0, dropped: 0,
          squeezed: 0, cut: !!m.cut, seconds: +(samples / 16000).toFixed(2), lang });
      }
    },
    terminate() {
      stopped = true;
      if (rec) { rec.onend = null; rec.abort(); }
      rec = null;
    }
  };
  return w;
}
