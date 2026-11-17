// Плашка субтитров поверх страницы. Её ставит графит (кнопка внизу панели)
// через chrome.scripting на вкладку значка. Текст присылает фоновый скрипт
// (OVERLAY_ROWS, ovlPush в background.js), и панель для этого открытой быть не
// должна. Своих моделей и состояния тут нет.
//
// Окно Document Picture-in-Picture было бы поверх всего, но из боковой панели
// Chrome 155 его не открыть: requestWindow вешает панель целиком (e2e/overlay.mjs --raw).
// Поэтому плашка в самой странице: перетаскивается, растягивается за угол
// (больше места под строки, кегль тот же), кегль — кнопками A−/A+, переживает полноэкранный ролик (переезжает в fullscreenElement), место
// запоминает. Пишет как книга: сверху вниз, строки стоят; места не хватило —
// страница очищается, и текущая строка доезжает наверх.
//
// Вид — графит панели: пиксельный шрифт, ступенчатые углы, серые xterm.
// Движение — как в ленте: сменившееся слово проявляется на месте,
// новая строка въезжает снизу.
(() => {
  // Плашка уже стоит — ничего не делать: показывает её строками фон. Но после
  // обновления расширения прежняя остаётся на странице без связи (chrome.runtime
  // у неё мёртв): строк она не получит, и новую ставим вместо неё.
  if (globalThis.__atOverlay?.alive()) return;
  globalThis.__atOverlay?.drop();
  // Firefox держит скрипт каждой версии расширения в своей песочнице: новая
  // не видит __atOverlay прежней, а её плашка так и стоит на странице. Такие
  // находим по метке в DOM — иначе плашек на странице две. У плашек до метки
  // (0.9.76 и раньше) узнаём по шрифту в закрытом теневом дереве: заглянуть
  // в него Firefox даёт расширению через openOrClosedShadowRoot.
  const FONT = 'Audio Translator Pixel';
  for (const old of document.querySelectorAll('[data-audio-translator-overlay], div[style*="2147483647"]'))
    if (old.hasAttribute('data-audio-translator-overlay') || old.openOrClosedShadowRoot?.innerHTML.includes(FONT)) old.remove();

  // Шрифт панели. @font-face в теневом дереве не действует — только в документе.
  try {
    const face = new FontFace(FONT, `url(${chrome.runtime.getURL('font/fusion-pixel-mono.woff2')})`);
    document.fonts.add(face);
    face.load().catch(() => {});
  } catch {}

  // Кривая и длительности — те же, что у ленты (sidepanel.js).
  const EASE = 'cubic-bezier(.3, .1, .2, 1)';
  const WORD_IN = 240, MOVE = 260;
  // Ступени кегля. Было кратно 12 (шрифт нарисован в 12 px), но 24 → 36
  // прыгало из «мелко» сразу в «крупно», третьего не было. Промежуточные
  // кегли пиксель чуть неровный, но читается (как 18 у оригинала в панели);
  // шаг 10–20%.
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 84, 96];
  const FS_MIN = SIZES[0], FS_MAX = SIZES.at(-1), W_MIN = 240;
  const PX2 = 'polygon(4px 0, calc(100% - 4px) 0, calc(100% - 4px) 2px, calc(100% - 2px) 2px, calc(100% - 2px) 4px, 100% 4px,'
    + ' 100% calc(100% - 4px), calc(100% - 2px) calc(100% - 4px), calc(100% - 2px) calc(100% - 2px), calc(100% - 4px) calc(100% - 2px), calc(100% - 4px) 100%,'
    + ' 4px 100%, 4px calc(100% - 2px), 2px calc(100% - 2px), 2px calc(100% - 4px), 0 calc(100% - 4px),'
    + ' 0 4px, 2px 4px, 2px 2px, 4px 2px)';

  // Значки строками пикселей: «#» — закрашено.
  const A = ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'];
  // Знак по середине буквы и без пустого столбца справа: иначе значок
  // съезжал влево и вверх, кнопки выглядели кривыми.
  const SMALLER = A.map((r, y) => r + (y === 3 ? '.###' : '....'));
  const LARGER = A.map((r, y) => r + (y === 3 ? '.###' : y === 2 || y === 4 ? '..#.' : '....'));
  // Ступени плотности фона. Значок кнопки — буква на шахматке под слоем той же
  // плотности, что фон плашки: шахматка везде значит «прозрачность».
  const FILLS = [90, 60, 30, 0];
  const CROSS = ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'];
  const glyph = (rows, w, h) => `<svg viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}" aria-hidden="true">${
    rows.flatMap((r, y) => [...r].map((c, x) => (c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('')}</svg>`;

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0;';
  host.setAttribute('data-audio-translator-overlay', '');
  const root = host.attachShadow({ mode: 'closed' });
  // Разметка разбирается DOMParser, а не innerHTML: подставлены в неё только
  // свои константы, но проверка AMO помечает любое присваивание innerHTML.
  const html = `<style>
    :host { all: initial }
    * { box-sizing: border-box }
    .wrap { position: relative; padding-top: 32px; margin-top: -32px }
    .box { position: relative; background: rgba(8, 8, 8, var(--bga, .9)); color: #eee; clip-path: ${PX2};
      font-family: '${FONT}', ui-monospace, Menlo, Consolas, monospace; font-size: var(--fs); line-height: calc(var(--fs) * 7 / 6);
      -webkit-font-smoothing: none; font-synthesis: none; font-kerning: none; font-variant-ligatures: none;
      padding: calc(var(--fs) / 2) calc(var(--fs) / 2); cursor: grab; user-select: none; touch-action: none }
    .box.drag { cursor: grabbing }
    /* Фона нет совсем: видео под буквами, им нужна чёрная обводка. Её у
       крайних букв overflow не срезает: поле .text с боков шире пикселя. */
    .box.thin .text { text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000 }
    /* Оригинал и так на своей серой подложке: чёрная обводка слила бы чёрные буквы. */
    .box.thin .row .o { text-shadow: none }
    /* Поле с боков — под серую подложку оригинала: она выступает за край
       перевода на 0.25em (.row .o), и overflow срезал её вместе с отступом,
       первая буква вставала на тёмный фон. */
    .text { height: var(--h); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-start;
      padding: 0 calc(var(--ofs) / 4); margin: 0 calc(var(--ofs) / -4) }
    /* Одна строка длиннее плашки: показываем её конец, где говорят сейчас. */
    .text.tail { justify-content: flex-end }
    .rows { flex: none }
    /* Зазор — от базовой линии до верха заглавной следующей строки (заглавная
       у шрифта 2/3 кегля), x = половина кегля перевода: внутри фразы x,
       оригинал к своему переводу 1.25x, между фразами 2x. Чем ближе по
       смыслу, тем ближе по высоте. Отступы выведены из этого же. */
    .row + .row { margin-top: calc(var(--fs) / 2) }
    .row { color: #a8a8a8; white-space: pre-wrap; overflow-wrap: anywhere; transition: color .3s ease-out, opacity .22s ease-out }
    .row:last-child { color: #eee }
    .row .o { display: block; color: #080808; font-size: var(--ofs); line-height: calc(var(--ofs) * 2 / 3 + var(--fs) / 2);
      margin: 0 0 calc(var(--fs) / 8) -0.25em; white-space: normal }
    /* Чёрный на сером, как в ленте: фон под каждой строкой оригинала. */
    .row .ot { padding: 0.05em 0.25em; background: #444; transition: background-color .3s ease-out;
      -webkit-box-decoration-break: clone; box-decoration-break: clone }
    .row:last-child .ot { background: #808080 }
    .row .o[hidden] { display: none }
    /* Пусто — курсор-блок в ячейку шрифта, как в ленте: звук ждём. */
    .cur { display: none; width: .5em; height: 1em; margin: calc(1em / 12) 0; background: #eee;
      animation: blink 1.1s ease-in-out infinite }
    .text.empty .cur { display: block }
    @keyframes blink { 0%, 35% { opacity: 1 } 55%, 85% { opacity: 0 } }
    /* Ручки видны только под мышью: кегль и закрыть сверху справа, растянуть — угол.
       Значки — пиксель в 2 px, как в панели. */
    .bar { position: absolute; right: 0; top: 0; display: flex; gap: 4px; opacity: 0; transition: opacity .15s ease-out }
    .bar button { width: 28px; height: 28px; border: 0; padding: 0; background: #1c1c1c; cursor: pointer;
      clip-path: ${PX2}; display: grid; place-items: center; transition: background .15s }
    .bar button:hover { background: #303030 }
    .bar button:disabled { cursor: default; opacity: .4; background: #1c1c1c }
    .bar svg { fill: #eee; shape-rendering: crispEdges }
    /* Кнопка фона: буква на шахматке, слой поверх по плотности плашки, но
       на 0.7 от неё: и у самой плотной ступени шахматка видна. */
    .sw { position: relative; width: 20px; height: 20px; display: grid; place-items: center;
      background: repeating-conic-gradient(#9a9a9a 0 25%, #e0e0e0 0 50%) 0 0 / 8px 8px;
      box-shadow: 0 0 0 1px #9a9a9a }
    .sw::before { content: ''; position: absolute; inset: 0; background: rgba(8, 8, 8, calc(var(--bga, .9) * .7)) }
    .sw svg { position: relative; filter: drop-shadow(1px 0 #000) drop-shadow(-1px 0 #000) drop-shadow(0 1px #000) drop-shadow(0 -1px #000) }
    .grip { position: absolute; right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize;
      opacity: 0; transition: opacity .15s ease-out; touch-action: none }
    .grip svg { position: absolute; right: 4px; bottom: 4px; width: 10px; height: 10px; shape-rendering: crispEdges }
    .wrap:hover .bar, .wrap:hover .grip, .wrap.busy .grip, .bar:focus-within { opacity: 1 }
  </style>
  <div class="wrap">
    <div class="bar">
      <button class="sm" type="button" aria-label="Smaller text" title="Smaller text">${glyph(SMALLER, 9, 7)}</button>
      <button class="lg" type="button" aria-label="Larger text" title="Larger text">${glyph(LARGER, 9, 7)}</button>
      <button class="bg" type="button"><i class="sw">${glyph(A, 5, 7)}</i></button>
      <button class="x" type="button" aria-label="Hide overlay" title="Hide">${glyph(CROSS, 7, 7)}</button>
    </div>
    <div class="box" role="region" aria-live="polite" aria-label="Subtitles">
      <div class="text empty"><i class="cur"></i><div class="rows"></div></div>
      <div class="grip" aria-hidden="true">
        <svg viewBox="0 0 5 5" fill="#808080"><rect x="4" y="0" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/>
        <rect x="4" y="2" width="1" height="1"/><rect x="0" y="4" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/>
        <rect x="4" y="4" width="1" height="1"/></svg>
      </div>
    </div>
  </div>`;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  root.append(...parsed.head.childNodes, ...parsed.body.childNodes);
  const wrap = root.querySelector('.wrap'), box = root.querySelector('.box');
  const text = root.querySelector('.text'), rowsEl = root.querySelector('.rows');
  const grip = root.querySelector('.grip');
  const smaller = root.querySelector('.sm'), larger = root.querySelector('.lg');
  const shadeBtn = root.querySelector('.bg');

  // Место — левый верхний угол долями окна (окно и полный экран разного
  // размера), ширина, высота текста и кегль — в пикселях. h не задана —
  // две строки.
  const KEY = 'overlayPlace';
  let place = { x: null, y: null, w: 760, h: null, fs: 24 };
  let dual = false;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  /** Ближайшая ступень. */
  const near = (fs) => SIZES.reduce((a, b) => (Math.abs(b - fs) < Math.abs(a - fs) ? b : a));
  const snap = (fs) => near(clamp(fs, FS_MIN, FS_MAX));
  /** Оригинал — ступень не крупнее 0.6 перевода (у 24 это 12), но не мельче 12. */
  const ofs = () => Math.max(FS_MIN, ...SIZES.filter((s) => s <= place.fs * 0.6));
  /** Одна строка перевода и, если показан оригинал, одна его: меньше нельзя. */
  const line = () => place.fs * 7 / 6 + place.fs / 2 + (dual ? ofs() * 2 / 3 + place.fs / 2 + place.fs / 8 : 0);
  /** Высота текста: растянутая рукой или две строки. */
  const height = () => Math.round(Math.max(line(), place.h ?? line() * 2));
  function apply() {
    smaller.disabled = place.fs <= FS_MIN;
    larger.disabled = place.fs >= FS_MAX;
    const w = clamp(place.w, W_MIN, innerWidth - 16);
    box.style.setProperty('--fs', `${place.fs}px`);
    box.style.setProperty('--ofs', `${ofs()}px`);
    box.style.setProperty('--h', `${height()}px`);
    host.style.width = `${w}px`;
    const h = host.offsetHeight;
    // Без сохранённого места — по центру, над нижней кромкой, как субтитры.
    const x = place.x == null ? (innerWidth - w) / 2 : place.x * innerWidth;
    const y = place.y == null ? innerHeight * 0.92 - h : place.y * innerHeight;
    host.style.left = `${clamp(x, 0, Math.max(0, innerWidth - w))}px`;
    host.style.top = `${clamp(y, 0, Math.max(0, innerHeight - h))}px`;
    clip();
  }
  /**
   * Верх текста режет по строке, а не посреди букв: строку, у которой верх
   * ушёл бы за кромку, гасим целиком, как clipTop в ленте. Нижнюю — никогда.
   */
  function clip() {
    const top = text.getBoundingClientRect().top;
    // Сперва все чтения, потом записи: чтение после записи на каждой строке
    // пересчитывало раскладку страницы заново.
    const kids = [...rowsEl.children];
    const tops = kids.map((k) => k.getBoundingClientRect().top);
    kids.forEach((k, i) => {
      const o = i === kids.length - 1 || tops[i] >= top - 0.5 ? '' : '0';
      if (k.style.opacity !== o) k.style.opacity = o;
    });
  }
  chrome.storage.local.get(KEY).then((r) => {
    const p = r[KEY];
    // Прежняя плашка хранила середину, а не угол, и без ширины: её место не берём.
    if (p && p.w) place = { ...place, ...p, fs: snap(p.fs || 24) };
    apply();
  }, () => {});
  const save = () => chrome.storage.local.set({ [KEY]: place }).catch(() => {});
  // Плотность фона в процентах (ovlBg), по умолчанию 90. Кнопка идёт по
  // ступеням FILLS по кругу; плашки на других вкладках и панель подхватывают.
  // Плотность ставится на обёртку: её берут и плашка, и значок кнопки.
  let bgNow = 90;
  const bg = (v) => {
    // Значение не на ступени — к ближайшей ступени.
    const n = Number.isFinite(v) ? v : 90;
    bgNow = FILLS.reduce((a, f) => (Math.abs(f - n) < Math.abs(a - n) ? f : a), 90);
    wrap.style.setProperty('--bga', String(bgNow / 100));
    box.classList.toggle('thin', bgNow === 0);
    shadeBtn.title = `Background ${bgNow}%`;
    shadeBtn.setAttribute('aria-label', shadeBtn.title);
  };
  bg(bgNow);
  chrome.storage.local.get('ovlBg').then((r) => bg(r.ovlBg), () => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.ovlBg) bg(ch.ovlBg.newValue); });
  addEventListener('resize', () => { if (host.isConnected) apply(); });

  /** Тянуть за указателем; fn получает сдвиг от точки нажатия. */
  function track(e, el, fn) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => fn(ev.clientX - x0, ev.clientY - y0);
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', move);
      box.classList.remove('drag');
      wrap.classList.remove('busy');
      save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
    // Указатель отобрал рабочий стол (жест, Alt+Tab с зажатой кнопкой) — без
    // этого плашка осталась бы «тянущейся» и держала мышь всего окна.
    el.addEventListener('lostpointercapture', up, { once: true });
  }
  // Перетаскивание за саму плашку.
  box.addEventListener('pointerdown', (e) => {
    const r = host.getBoundingClientRect();
    if (e.button === 0) box.classList.add('drag');
    track(e, box, (dx, dy) => {
      place = { ...place, x: clamp(r.left + dx, 0, innerWidth - r.width) / innerWidth,
        y: clamp(r.top + dy, 0, innerHeight - r.height) / innerHeight };
      apply();
    });
  });
  // Растяжение за угол: больше места под строки, кегль тот же — его меняют
  // кнопки. Левый верхний угол стоит на месте.
  grip.addEventListener('pointerdown', (e) => {
    const r = host.getBoundingClientRect();
    const h0 = text.offsetHeight, room = innerHeight - r.top - (box.offsetHeight - h0);
    if (e.button === 0) wrap.classList.add('busy');
    track(e, grip, (dx, dy) => {
      place = { ...place, x: r.left / innerWidth, y: r.top / innerHeight,
        w: clamp(r.width + dx, W_MIN, innerWidth - r.left), h: clamp(h0 + dy, line(), Math.max(line(), room)) };
      apply();
    });
  });
  // Кегль на ступень SIZES. Высота текста — в строках: сколько их влезало,
  // столько влезет и после.
  const zoom = (d) => {
    const fs = SIZES[clamp(SIZES.indexOf(snap(place.fs)) + d, 0, SIZES.length - 1)];
    if (fs === place.fs) return;
    const n = place.h == null ? null : place.h / line();
    place = { ...place, fs };
    if (n != null) place.h = n * line();
    apply();
    save();
  };
  smaller.addEventListener('click', () => zoom(-1));
  larger.addEventListener('click', () => zoom(1));
  shadeBtn.addEventListener('click', () => {
    const next = FILLS[(FILLS.indexOf(bgNow) + 1) % FILLS.length];
    bg(next);
    chrome.storage.local.set({ ovlBg: next }).catch(() => {});
  });
  root.querySelector('.x').addEventListener('click', () => {
    hide();
    chrome.runtime.sendMessage({ type: 'OVERLAY_CLOSED' }).catch(() => {});
  });

  // Полный экран показывает только свой элемент: плашка переезжает в него.
  const mount = () => {
    const fs = document.fullscreenElement;
    const parent = fs && !(fs instanceof HTMLVideoElement) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
  };
  document.addEventListener('fullscreenchange', () => { if (host.isConnected) { mount(); apply(); } });

  /**
   * Строку — по словам, как ленту (wordsInto и marksFor в sidepanel.js).
   * Показанный текст не гаснет: оставшиеся слова стоят, заменённое встаёт
   * на место сразу, из нуля проявляется только дописанное. Прежде заменённое
   * гасло до 0.35 на каждом снимке, 3–5 раз в секунду, и строка мерцала.
   * Сверка — по общей подпоследовательности, а не по месту: вставка слова в
   * середину не делает переписанным весь хвост.
   */
  function words(el, said, quiet = false) {
    if (!el.dataset.w) { el.textContent = ''; el.dataset.w = '1'; }
    const was = [...el.children].map((n) => n.textContent);
    const added = grown(was, said);
    while (el.children.length > said.length) {
      const last = el.lastElementChild;
      if (last.previousSibling?.nodeType === 3) last.previousSibling.remove();
      last.remove();
    }
    while (el.children.length < said.length) {
      if (el.children.length) el.append(document.createTextNode(' '));
      el.append(Object.assign(document.createElement('span'), { className: 'w' }));
    }
    const nodes = [...el.children];
    said.forEach((w, i) => {
      if (nodes[i].textContent === w) return;
      for (const a of nodes[i].getAnimations()) if (a.id === 'w-in') a.cancel();
      nodes[i].textContent = w;
      if (added[i] && !quiet) nodes[i].animate([{ opacity: 0 }, { opacity: 1 }], { id: 'w-in', duration: WORD_IN, easing: EASE });
    });
  }
  /**
   * Какие слова next дописаны: за последним оставшимся словом дальше, чем шёл
   * за ним прошлый показ (первые слова после него заменяют прежний хвост).
   */
  function grown(prev, next) {
    const a = prev.map(BARE), b = next.map(BARE), n = a.length, m = b.length;
    const out = next.map(() => false);
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let lastI = -1, lastJ = -1;
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) { lastI = i++; lastJ = j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    for (let j = lastJ + 1 + (n - 1 - lastI); j < m; j++) out[j] = true;
    return out;
  }
  const split = (s) => (s || '').split(/\s+/).filter(Boolean);
  const BARE = (w) => w.toLowerCase().replace(/[.,!?;:—–…"'«»()]/g, '');

  // С какой строки (id реплики) начинается страница. null — с первой пришедшей.
  // Фон шлёт хвост из нескольких строк, а на странице их бывает больше:
  // строки страницы, ушедшие из хвоста, плашка помнит сама (book), иначе
  // верх страницы пропадал раньше, чем она заполнится.
  let first = null, book = [];
  const over = () => rowsEl.offsetHeight > text.clientHeight + 0.5;

  /**
   * Книга: строки страницы пишутся сверху вниз и стоят. Не влезла новая —
   * страница очищается, на ней остаётся одна текущая строка и доезжает наверх.
   */
  function render(rows) {
    const d = rows.some((r) => r.orig);
    if (d !== dual) { dual = d; apply(); }
    // Номера реплик начались заново — новый сеанс, страница тоже.
    if (first != null && !(rows.at(-1)?.id >= first)) { first = null; book = []; }
    // Ушедшие из хвоста — как были; хвост — как пришёл (в нём строки могли
    // смениться, слиться или пропасть).
    if (rows.length) book = [...book.filter((r) => r.id < rows[0].id).slice(-200), ...rows];
    else book = [];
    rows = book;
    // Опора — строка, что стояла ниже всех и осталась: где она была на глазах
    // и где встала. Разница — насколько она уехала вверх при перевороте; доезжает.
    const ids = new Set(rows.map((r) => String(r.id)));
    const keep = [...rowsEl.children].filter((el) => ids.has(el.dataset.id));
    const anchor = keep.at(-1);
    const was = anchor?.getBoundingClientRect().top;
    put(rows.filter((r) => first == null || r.id >= first), anchor);
    let full = over();
    if (full && rowsEl.children.length > 1) {
      first = rows.at(-1).id;
      put(rows.filter((r) => r.id >= first), anchor);
      full = over();
    }
    if (first != null) book = book.filter((r) => r.id >= first);
    text.classList.toggle('tail', full);
    text.classList.toggle('empty', !rows.some((r) => r.text));
    for (const a of rowsEl.getAnimations()) a.cancel();
    clip();
    if (anchor?.isConnected) {
      const dy = was - anchor.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) {
        rowsEl.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MOVE, easing: EASE });
      }
    }
  }

  /** Написать на странице ровно эти строки; новые проявляются. */
  function put(rows, anchor) {
    const ids = new Set(rows.map((r) => String(r.id)));
    for (const el of [...rowsEl.children]) if (!ids.has(el.dataset.id)) el.remove();
    rows.forEach((r, i) => {
      let el = rowsEl.children[i];
      // Новая строка проявляется целиком: её слова по отдельности не проявляем,
      // два проявления разной скорости разом — рябь.
      let fresh = false;
      if (!el || el.dataset.id !== String(r.id)) {
        el = Object.assign(document.createElement('div'), { className: 'row' });
        el.dataset.id = String(r.id);
        const o = Object.assign(document.createElement('span'), { className: 'o' });
        o.append(Object.assign(document.createElement('span'), { className: 'ot' }));
        el.append(o, document.createElement('span'));
        rowsEl.insertBefore(el, rowsEl.children[i] ?? null);
        if (anchor) { fresh = true; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: EASE }); }
      }
      const [o, t] = el.children;
      o.hidden = !r.orig;
      const os = split(r.orig), ts = split(r.text);
      words(o.firstElementChild, os, fresh);
      words(t, ts, fresh);
    });
  }

  let leaving = null;
  // Соединение с фоном — только ради его обрыва. Расширение удалили или
  // выключили — Chrome рвёт его сам, и плашка уходит вместе с ним: раньше она
  // висела поверх страницы до перезагрузки («hovering tab blocking view. even
  // after uninstalling», отзыв 05.11). Обрыв при живом расширении — это уснул
  // фоновый скрипт: тогда новое соединение заводит следующая порция строк.
  let port = null;
  function link() {
    // В Android-прослойке connect нет: там плашку снимает сама обёртка.
    if (port || !chrome.runtime?.connect) return;
    try { port = chrome.runtime.connect({ name: 'overlay' }); } catch {
      if (!chrome.runtime?.id) host.remove();
      return;
    }
    port.onDisconnect.addListener(() => {
      port = null;
      if (!chrome.runtime?.id) host.remove();
    });
  }

  function show() {
    link();
    if (leaving) { leaving.cancel(); leaving = null; }
    if (host.isConnected) return;
    mount();
    apply();
    box.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: EASE });
  }
  function hide() {
    if (!host.isConnected || leaving) return;
    leaving = wrap.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 160, easing: 'ease-in' });
    leaving.onfinish = () => { leaving = null; host.remove(); };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'OVERLAY_ROWS') { show(); render(msg.rows || []); }
    else if (msg?.type === 'OVERLAY_OFF') hide();
    else return;
    // Ответ обязателен: без него промис sendMessage у фонового скрипта
    // падает, и он счёл бы, что плашки на вкладке больше нет.
    reply(true);
  });

  // Сама себя не показывает: встаёт по первой порции строк от фона (ovlPush
  // в background.js), а он шлёт их только при идущем сеансе. Показанная сразу,
  // без сеанса, плашка висела пустой: строк и OVERLAY_OFF никто не пришлёт,
  // фон засыпает и об удалении расширения ей не скажет.
  globalThis.__atOverlay = { alive: () => !!chrome.runtime?.id, drop: () => host.remove() };
})();
