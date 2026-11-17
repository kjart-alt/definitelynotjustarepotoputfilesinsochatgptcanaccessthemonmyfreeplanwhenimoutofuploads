// Автосохранение: фоновый скрипт сам пишет расшифровку сеанса в «Загрузки».
//
// Раньше писала панель в файл, выбранный зрителем. Право на такой файл Chrome
// отбирает, стоит панели закрыться или переехать за значком, и возвращает
// только под щелчком в ней: смотришь с плашкой, панель закрыта — запись стоит.
// Загрузки права не теряют, и писать их может сам фон, без панели. Платим тем,
// что загрузка не дописывает, а перезаписывает файл целиком, — поэтому файл на
// сеанс: журнал после перезапуска браузера пуст, и общий файл за день стёрся бы.
//
// Файл — Загрузки/audio-translator/<начало сеанса>.txt, переписывается не чаще
// раза в секунду и только когда в журнале прибавилось. Где он и когда записан —
// session.afile, его рисует панель.
import { journalSlice } from './journal.js';

const DIR = 'audio-translator';
// Знаков в одном файле. Текст уходит data:-ссылкой, а длиннее 2 МБ Chrome её
// не примет: 256 тыс. знаков даже по три байта в base64 — около мегабайта.
// Дальше сеанс продолжается во втором файле, третьем и т. д.
const PART = 1 << 18;
// Не чаще секунды на мегабайт файла: каждый раз он пишется целиком.
const every = (n) => Math.max(1000, n / 1000);
// Разрешения просит переключатель в панели (optional_permissions).
export const AUTOSAVE_PERMISSIONS = ['downloads', 'downloads.ui'];

const two = (n) => String(n).padStart(2, '0');
// dup — номер сеанса, начатого в ту же секунду, что прошлый (Stop и сразу Start).
const nameOf = (t, part, dup = 1) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`
    + (dup > 1 ? ` (${dup})` : '') + (part > 1 ? ` part ${part}` : '') + '.txt';
};
const base64 = (s) => {
  const b = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
};

/** Дождаться конца загрузки: true — файл записан. */
const finished = (id) => new Promise((done) => {
  const check = (d) => {
    const s = d?.state?.current ?? d?.state;
    if (s !== 'complete' && s !== 'interrupted') return false;
    chrome.downloads.onChanged.removeListener(on);
    done(s === 'complete');
    return true;
  };
  const on = (d) => { if (d.id === id) check(d); };
  chrome.downloads.onChanged.addListener(on);
  chrome.downloads.search({ id }).then(([d]) => check(d), () => {});
});

export function autosave() {
  let timer = 0, chain = Promise.resolve();

  const wanted = async () => (await chrome.storage.local.get('autosave')).autosave === true
    && !!chrome.downloads && await chrome.permissions.contains({ permissions: AUTOSAVE_PERMISSIONS });

  /** Переписать файл f текстом text; false — Chrome его не записал. */
  async function save(f, text) {
    // Окошко загрузок мигало бы каждую секунду: на время записи его гасим.
    await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    try {
      // Имя уникально само (время начала сеанса и dup): uniquify Chrome на
      // стенде молча переписывал файл прошлого сеанса той же секунды.
      const id = await chrome.downloads.download({
        url: `data:text/plain;charset=utf-8;base64,${base64(text)}`,
        filename: `${DIR}/${f.name}`, conflictAction: 'overwrite', saveAs: false
      });
      const ok = await finished(id);
      // В списке загрузок держим одну строку на файл — последнюю: по ней панель
      // и показывает файл в папке.
      if (f.id && f.id !== id) chrome.downloads.erase({ id: f.id }).catch(() => {});
      f.id = id;
      return ok;
    } finally {
      await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
    }
  }

  /** Дописать в файл f журнал до смещения end и за ним хвост (строки на экране). */
  async function put(f, end, tail = '') {
    let { text } = await journalSlice(f.from);
    text = text.slice(0, end - f.from) + tail;
    try {
      while (text.length > PART) {
        const cut = text.lastIndexOf('\n', PART) + 1 || PART;
        if (!await save(f, text.slice(0, cut))) throw new Error('interrupted');
        Object.assign(f, { from: f.from + cut, part: f.part + 1, name: nameOf(f.started, f.part + 1, f.dup), id: 0 });
        text = text.slice(cut);
      }
      if (!await save(f, text)) throw new Error('interrupted');
      Object.assign(f, { len: end, tail, savedAt: Date.now(), note: '' });
    } catch (e) {
      console.warn('автосохранение:', e);
      f.note = `Can't write ${f.name}`;
    }
  }

  async function write() {
    if (!await wanted()) return;
    // Журнал и хвост — одним чтением: строка переходит из хвоста в журнал, и
    // порознь её можно не застать ни там, ни там.
    const { jmeta: m, jtail } = await chrome.storage.session.get(['jmeta', 'jtail']);
    if (!m?.started) return;
    // Хвост — только идущего сеанса: у кончившегося он весь ушёл в журнал.
    const tail = m.t0 && jtail?.started === m.started ? jtail.text : '';
    let { afile: f } = await chrome.storage.session.get('afile');
    if (f?.started !== m.started) {
      // Сеанс сменился раньше, чем дописан прошлый файл (Stop и сразу снова
      // перевод): его хвост — всё до начала нового сеанса.
      if (f && f.len < m.sessionAt) await put(f, m.sessionAt);
      // Новый сеанс — новый файл, с заголовка сеанса.
      const dup = f && Math.floor(f.started / 1000) === Math.floor(m.started / 1000) ? (f.dup || 1) + 1 : 1;
      f = { started: m.started, dup, from: m.sessionAt, part: 1, name: nameOf(m.started, 1, dup), id: 0, len: m.sessionAt, tail: '', savedAt: 0, note: '' };
    }
    if (m.len > f.len || tail !== f.tail) await put(f, m.len, tail);
    await chrome.storage.session.set({ afile: f });
  }

  function later() {
    if (timer) return;
    chrome.storage.session.get('afile').then(({ afile }) => {
      if (!timer) timer = setTimeout(run, every(afile?.len ?? 0));
    });
  }
  function run() {
    clearTimeout(timer);
    timer = 0;
    return (chain = chain.then(write).catch((e) => console.warn('автосохранение:', e)));
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'session' && (ch.jmeta || ch.jtail)) later();
    // Включили — пишем сразу, с начала текущего сеанса.
    if (area === 'local' && ch.autosave?.newValue) run();
  });
  // Разрешение сняли в настройках Chrome — переключатель гаснет.
  chrome.permissions.onRemoved.addListener((p) => {
    if (p.permissions?.some((x) => AUTOSAVE_PERMISSIONS.includes(x))) chrome.storage.local.set({ autosave: false });
  });

  return { run };
}
