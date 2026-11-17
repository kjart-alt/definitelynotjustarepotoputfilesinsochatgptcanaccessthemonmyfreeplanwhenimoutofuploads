// Графитовая панель поверх sidepanel.js.
//
// sidepanel.js остаётся как есть: он ведёт ленту, держит захват выбранного
// источника и говорит с фоновым скриптом. Его кнопки и поля живут в разметке
// спрятанными (.legacy), а здесь — только то, что видно: три управления в
// шапке, список языков и строка «что мешает работать». Выключатель нажимает
// старую #go, список пишет в старые
// select, а состояние читается обратно с них же — второго источника правды
// о сеансе панель не заводит.
//
// Грузится раньше sidepanel.js: тот вызывает applyConfig только после ответа
// GET_STATE, и к этому времени перехват value на select уже стоит.

import { SOURCES, TARGETS } from './lib/languages.js';
import { t, localize, uiLang, setUiLang, onUiLang, UI_LANGS } from './lib/i18n.js';
import { diagQuery } from './lib/diag.js';

const $ = (id) => document.getElementById(id);

// --- Движение ------------------------------------------------------------------
//
// Ничего не возникает и не пропадает щелчком. Настройку «меньше движения» не
// спрашиваем: у пользователя она стоит от рабочего стола (KDE), а плавность
// он просил именно здесь.

// Что сейчас уходит: hidden ставится, когда уход доиграл.
const going = new WeakMap();

/**
 * Показать или спрятать прозрачностью; позвали обратно на полпути — разворот
 * с того места, где элемент сейчас, а не с нуля.
 * @param {HTMLElement} el
 * @param {boolean} show
 * @param {number} [lift] на сколько пикселей уходит вверх, исчезая
 */
function reveal(el, show, lift = 0) {
  const out = going.get(el);
  if (show ? !el.hidden && !out : el.hidden || out) return;
  const now = el.hidden ? 0 : +getComputedStyle(el).opacity;
  const at = (o) => ({ opacity: o, transform: `translateY(${((1 - o) * -lift).toFixed(1)}px)` });
  if (out) { out.cancel(); going.delete(el); el.style.pointerEvents = ''; }
  if (show) {
    el.hidden = false;
    el.animate([at(now), at(1)], { duration: 160 * (1 - now), easing: 'ease-out' });
    return;
  }
  const a = el.animate([at(now), at(0)], { duration: 120 * now, easing: 'ease-in', fill: 'forwards' });
  going.set(el, a);
  el.style.pointerEvents = 'none';
  a.onfinish = () => { el.hidden = true; el.style.pointerEvents = ''; going.delete(el); a.cancel(); };
}

/** Спрятать сразу, оборвав уход: следующее появление пойдёт с нуля. */
function hush(el) {
  going.get(el)?.cancel();
  going.delete(el);
  el.style.pointerEvents = '';
  el.hidden = true;
}

/**
 * Кнопка языка сменила код и с ним ширину — доехать до новой, а не прыгнуть:
 * за ней едут стрелка и вторая кнопка.
 * @param {HTMLElement} b кнопка
 * @param {number} from ширина до смены
 */
function grow(b, from) {
  const to = b.offsetWidth;
  b.querySelector('.code').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  if (!from || from === to) return;
  // Носик подсказки встаёт по ширине, а пока кнопка едет, она не та.
  b.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 180, easing: 'ease-out' })
    .onfinish = paint;
}
const go = $('go'), pack = $('pack'), packno = $('packno');
const head = document.querySelector('.head');
const stage = document.querySelector('.stage');
const sel = { src: $('source'), dst: $('target') };
const btn = { src: $('src'), dst: $('dst'), ui: $('ui') };
const sw = $('sw');
const swTip = $('bsw').querySelector('.tip > span');
const note = $('note'), say = note.querySelector('.say'), bang = note.querySelector('.bang');
const dlWrap = $('bdl'), dl = $('dl'), bno = $('bno'), no = $('no');
const noTipEl = bno.querySelector('.tip span');
const ring = $('ring'), fill = $('bar').firstElementChild;
const wait = $('wait'), rowsBox = document.querySelector('.rows'), view = document.querySelector('.view');
let strainOn = false;
const menu = $('menu'), list = menu.firstElementChild, sb = menu.querySelector('.sb');

/** Свой ползунок списка: высота по видимой доле, место по прокрутке. */
function placeThumb() {
  const h = list.clientHeight, all = list.scrollHeight;
  sb.hidden = all <= h + 1;
  if (sb.hidden) return;
  const len = Math.max(16, Math.round(h * h / all));
  sb.style.height = `${len}px`;
  sb.style.top = `${list.offsetTop + list.clientTop + Math.round((h - len) * list.scrollTop / (all - h))}px`;
}
list.addEventListener('scroll', placeThumb, { passive: true });
// Ползунок тянется мышью и пальцем, как системный.
sb.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sb.setPointerCapture(e.pointerId);
  sb.classList.add('drag');
  const y0 = e.clientY, top0 = list.scrollTop;
  const k = (list.scrollHeight - list.clientHeight) / (list.clientHeight - sb.offsetHeight);
  const move = (m) => { list.scrollTop = top0 + (m.clientY - y0) * k; };
  const up = () => { sb.classList.remove('drag'); sb.removeEventListener('pointermove', move); };
  sb.addEventListener('pointermove', move);
  sb.addEventListener('lostpointercapture', up, { once: true });
});

// --- Языки ---------------------------------------------------------------------

/** Код на кнопке: две буквы, а «определить сам» — AUTO. */
const label = (code) =>
  code === 'auto' ? 'AUTO' : code === 'zh-Hant' ? 'ZH-T' : code.toUpperCase();

/**
 * Самоназвание: каждый находит свой язык, не читая по-английски. Intl отдаёт
 * его со строчной буквы («français», «русский») — поднимаем первую.
 */
/** Самоназвания, которых нет в данных Intl у Chrome: nn он отдаёт по-английски. */
const OWN = { nn: 'Norsk nynorsk' };
function endonym(code) {
  if (code === 'auto') return t('auto');
  if (OWN[code]) return OWN[code];
  try {
    const n = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (n && n !== code) return n[0].toLocaleUpperCase(code) + n.slice(1);
  } catch { /* неизвестный Intl код — покажем как есть */ }
  return code;
}

// Порядок по коду: список длинный, и глаз ищет в нём две буквы, а не слово
// на чужом алфавите. «Определить сам» — первым.
const byCode = (langs) => langs.map((l) => l.code).sort();
const CODES = { src: ['auto', ...byCode(SOURCES)], dst: byCode(TARGETS), ui: UI_LANGS };

// --- Состояние -----------------------------------------------------------------

const running = () => go.dataset.on === '1';
// Включили, а сеанс ещё поднимается. Индикатора загрузки нет — всё локально и
// ждать почти нечего, — поэтому выключатель встаёт сразу, а откатывается,
// только если запуск не вышел.
let pending = false;
/** Перерисовать всё видимое по состоянию старой разметки. */
function paint() {
  for (const k of ['src', 'dst']) {
    const code = sel[k].value || (k === 'src' ? 'auto' : 'ru');
    // Пишем только перемену: paint зовут на каждой строке ленты, и запись
    // того же текста всё равно пересобирала узел и стиль кнопки.
    const c = btn[k].querySelector('.code'), lab = label(code);
    if (c.textContent !== lab) c.textContent = lab;
    const aria = `${t(k === 'src' ? 'audioLang' : 'translateInto')}: ${endonym(code)}`;
    if (btn[k].getAttribute('aria-label') !== aria) btn[k].setAttribute('aria-label', aria);
  }

  const bad = head.classList.contains('bad');
  if (bad) pending = false;
  const on = running() || pending;
  sw.classList.toggle('on', on);
  if (sw.getAttribute('aria-checked') !== String(on)) sw.setAttribute('aria-checked', String(on));
  const tip = t(on ? 'turnOff' : 'turnOn');
  if (sw.getAttribute('aria-label') !== tip) sw.setAttribute('aria-label', tip);
  if (swTip.textContent !== tip) swTip.textContent = tip;

  // Строка «что мешает». Текст ошибок — от фонового скрипта. Окна выбора
  // источника больше нет: звук всего браузера берётся всегда.
  const packOn = !pack.hidden && !!pack.dataset.from;
  let text = '';
  // Пара перевода не скачалась (sidepanel.js, paintFailed): на экране оригинал.
  // Стрелка — «повторить», крестик — закрыть.
  const failed = packOn && !!pack.dataset.fail;
  if (bad) text = stage.textContent.trim();
  // Любой сбой (и нет сети, и слишком медленно) — одна надпись и стрелка.
  else if (failed) text = t('mtFail');
  // Подсказка «что сделать» (sidepanel.js, класс hint): язык не определился,
  // или звук играет на вкладке, которую не слышим. Прежде графит показывал
  // только ошибки, и обе подсказки до зрителя не доходили — пустая лента без
  // единого слова, почему.
  else if (head.classList.contains('hint')) text = stage.textContent.trim();
  // Машина не успевает (sidepanel.js, data-strain): висит до крестика.
  strainOn = !text && !packOn && document.body.hasAttribute('data-strain');
  if (strainOn) text = t('slow');
  // Пара качается: кольцо загрузки вместо кнопок. Загрузка кончилась, а
  // кольцо ещё догоняет 100% — дорисовать, потом закрыть (walk): в чистом
  // профиле Chrome шлёт 0 и 100% в одну мс, и баннер пропадал с пустым кольцом.
  const filling = !packOn && !ring.hidden && want === dots.length && lit < want;
  const loading = (packOn && !failed) || filling;
  if (loading) text = t('getPack', { a: label(pack.dataset.from), b: label(pack.dataset.to) });
  // Кольцо открылось или сменило пару: с того, что на полосе сейчас. Новую
  // загрузку showPack начинает с 0%, вернувшаяся сеть держит достигнутое.
  const ringKey = pack.dataset.from + '>' + pack.dataset.to;
  const opening = loading && (ring.hidden || ringKey !== ringPair);
  ring.hidden = !loading;
  if (opening) {
    ringPair = ringKey;
    clearTimeout(walking);
    lit = want = Math.round(Math.min(100, parseFloat(fill.style.width) || 0) / 100 * dots.length);
    walk();
  }
  if (bang.textContent !== '!') bang.textContent = '!';
  dlWrap.hidden = !failed;
  bno.hidden = loading || (!failed && !strainOn);
  const noTip = t('close');
  if (noTipEl.textContent !== noTip) {
    noTipEl.textContent = noTip;
    no.setAttribute('aria-label', noTip);
  }
  if (say.textContent !== text) {
    say.textContent = text;
    if (!note.hidden) say.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }
  reveal(note, !!text || packOn);
  // Включено, а строк нет: крупно «ждём речь». Ленту стирают перед каждым
  // запуском (clearCues), так что надпись встаёт и при перезапуске.
  // Три экрана ленты не накладываются: загрузка (.loading.on из sidepanel.js),
  // «ждём речь» и сами строки. Поэтому гасим надпись сразу, без затухания.
  // Речь уже слышна (data-heard из sidepanel.js), а строк нет — это не «ждём
  // речь»: про язык и музыку тогда говорит шапка (04.11 надпись вставала под
  // играющим роликом).
  const waitOn = on && !bad && !rowsBox.firstElementChild && !document.body.dataset.heard
    && !view.querySelector(':scope > .loading.on');
  if (waitOn) reveal(wait, true);
  else { going.get(wait)?.cancel(); going.delete(wait); wait.hidden = true; }

  // Носик подсказки — под серединой своей кнопки. Ширины читаем все разом,
  // пишем потом и только перемену: чтение после записи на каждой кнопке
  // стоило полного пересчёта раскладки, и так на каждой строке ленты.
  const bs = [...document.querySelectorAll('.b')];
  const ws = bs.map((b) => b.firstElementChild.offsetWidth);
  bs.forEach((b, i) => {
    const half = `${ws[i] / 2}px`;
    if (ws[i] && b.style.getPropertyValue('--half') !== half) b.style.setProperty('--half', half);
  });
}

// --- Кольцо загрузки словаря ---------------------------------------------------

// Клетки кольца на сетке 11×11 (клетка 2 px, как весь пиксельный рисунок):
// толщиной в две клетки, от 3.6 до 5.6 от центра — 60 клеток, симметрично по
// обеим осям. По часовой от верхней середины: atan2(x, −y) там ноль.
const dots = [];
for (let i = 0; i < 121; i++) {
  const x = i % 11 - 5, y = (i / 11 | 0) - 5, d = Math.hypot(x, y);
  if (d > 3.6 && d <= 5.6) dots.push([(Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI), x + 5, y + 5]);
}
dots.sort((p, q) => p[0] - q[0]);
const ringSvg = ring.firstElementChild;
for (let i = 0; i < dots.length; i++) {
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('x', dots[i][1]); r.setAttribute('y', dots[i][2]);
  r.setAttribute('width', 1); r.setAttribute('height', 1);
  dots[i] = ringSvg.appendChild(r);
}
// Горит lit клеток, нужно want. Прогресс Chrome шлёт рывками (бывает 0 и сразу
// 100%), поэтому к цели идём по клетке за кадр, а не скачком.
let lit = 0, want = 0, walking = 0, ringPair = '';
function walk() {
  lit += Math.sign(want - lit);
  dots.forEach((r, i) => r.setAttribute('class', i < lit ? 'on' : i === lit ? 'next' : ''));
  walking = lit === want ? 0 : setTimeout(walk, 16);
  // Дозаполнили кольцо уже кончившейся загрузки: миг полным — и закрыть. Не
  // дошли (полосу перехватила загрузка модели) — закрыть всё равно.
  if (!walking && pack.hidden && !ring.hidden) setTimeout(paint, 300);
}
// Кольцо — только настоящий ход Chrome. Хода нет (просыпается до 10 с, первый
// запуск в чистом профиле шлёт сразу 100%) — стоит пустым, без бегущего
// отрезка: он ни о чём не говорил.
new MutationObserver(() => {
  if (ring.hidden) return;
  const p = Math.min(100, parseFloat(fill.style.width) || 0);
  ring.setAttribute('aria-valuenow', String(Math.round(p)));
  const w = Math.round(p / 100 * dots.length);
  // Загрузка кончилась, кольцо дорисовывается: полосу уже пишет модель речи,
  // её меньшая доля кольцо назад не тянет.
  if (pack.hidden && w < want) return;
  want = w;
  if (!walking) walk();
}).observe(fill, { attributes: true, attributeFilter: ['style'] });

// sidepanel.js пишет язык в select присваиванием value (applyConfig) — событий
// на это нет, поэтому перехватываем само присваивание.
const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
for (const s of Object.values(sel)) {
  Object.defineProperty(s, 'value', {
    configurable: true,
    get() { return VALUE.get.call(this); },
    set(v) { VALUE.set.call(this, v); paint(); }
  });
}

// Всё остальное sidepanel.js показывает разметкой: data-on у #go, классы шапки,
// hidden и data-* у #pack.
const watch = (el, opts) => new MutationObserver(paint).observe(el, opts);
new MutationObserver(() => { pending = false; paint(); })
  .observe(go, { attributes: true, attributeFilter: ['data-on'] });
watch(head, { attributes: true, attributeFilter: ['class'] });
watch(stage, { childList: true, characterData: true, subtree: true });
// От ленты paint нужно одно: есть ли в ней строки («ждём речь»). Строки же
// меняются на каждой реплике, и полный paint на каждую был лишним.
let rowsEmpty = !rowsBox.firstElementChild;
new MutationObserver(() => {
  const e = !rowsBox.firstElementChild;
  if (e !== rowsEmpty) { rowsEmpty = e; paint(); }
}).observe(rowsBox, { childList: true });
// Значок загрузки sidepanel.js кладёт в ленту лениво: ловим его появление,
// дальше следим за классом «on».
new MutationObserver((_, ob) => {
  const l = view.querySelector(':scope > .loading');
  if (!l) return;
  ob.disconnect(); watch(l, { attributes: true, attributeFilter: ['class'] }); paint();
}).observe(view, { childList: true });
watch(pack, { attributes: true, attributeFilter: ['hidden', 'disabled', 'data-from', 'data-to', 'data-fail'] });
watch(document.body, { attributes: true, attributeFilter: ['data-strain', 'data-heard'] });

// --- Выключатель ---------------------------------------------------------------

sw.addEventListener('click', () => {
  if (running()) return go.click();
  // Сначала клик: до первого await он успевает сменить шапку на «готовлюсь»,
  // и прошлая ошибка в ней не сбросит pending тут же.
  go.click();
  pending = true;
  paint();
});

dl.addEventListener('click', () => pack.click());
// Крестик закрывает плашку «не успевает» или ошибку загрузки пары.
no.addEventListener('click', () => strainOn
  ? chrome.storage.local.set({ strainShut: Date.now() }).catch(() => {})
  : packno.click());

// --- Список языков -------------------------------------------------------------

let openFor = null;

function openMenu(k) {
  closeMenu();
  // Список другой кнопки приходит своим движением, а не дорисовывается в
  // уходящий.
  hush(menu);
  openFor = k;
  const current = k === 'ui' ? uiLang() : sel[k].value;
  list.replaceChildren(...CODES[k].map((code) => {
    const it = document.createElement('div');
    it.className = code === current ? 'it sel' : 'it';
    it.setAttribute('role', 'option');
    it.setAttribute('aria-selected', String(code === current));
    it.tabIndex = -1;
    it.dataset.code = code;
    if (code !== 'auto') it.lang = code;
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = label(code);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = endonym(code);
    it.append(c, n);
    return it;
  }));
  // Язык интерфейса раскрывается в своей плитке на место остальных: поверх
  // настроек ничего не ложится.
  // Верх листа до раскрытия: выше него список не растёт.
  const top0 = sheet.getBoundingClientRect().top;
  if (k === 'ui') { btn.ui.closest('.tile').append(menu); sheet.classList.add('picking'); }
  reveal(menu, true, 4);
  document.body.classList.add('menu-open');
  btn[k].classList.add('open');
  btn[k].setAttribute('aria-expanded', 'true');
  const frame = menu.offsetHeight - list.offsetHeight;
  // Высота списка — целое число строк: последняя видна целиком или не видна вовсе.
  // Поле — рамкой, не padding: padding прокручивался бы и показывал край соседней строки.
  const cs = getComputedStyle(list), pad = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const row = list.firstElementChild.offsetHeight;
  const rows = (h) => pad + Math.max(3, Math.floor((h - pad) / row)) * row;
  if (k === 'ui') {
    // Лист прижат к низу и растёт вверх: список в высоту настроек, не выше их верха.
    menu.style.left = menu.style.top = '';
    list.style.maxHeight = '0px';
    const ceil = Math.max(top0, document.querySelector('.hd').getBoundingClientRect().bottom + 8);
    list.style.maxHeight = `${rows(pad + sheet.getBoundingClientRect().top - ceil)}px`;
  } else {
    // Под своей кнопкой с зазором, но не за правым краем: панель уже списка.
    const b = btn[k].parentElement, r = b.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(b.offsetLeft - 4, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 6 - (menu.offsetParent?.getBoundingClientRect().top ?? 0)}px`;
    // Низ — над нижней строкой (настройки, звёзды): раскрытый не заслоняет кнопок.
    const ft = document.querySelector('.ft');
    const floor = Math.min(innerHeight, ft?.offsetParent ? ft.getBoundingClientRect().top : innerHeight) - 8;
    list.style.maxHeight = `${rows(floor - r.bottom - 6 - frame)}px`;
  }
  // Прокрутка на целую строку: выбранная посередине, края без обрезков.
  const on = list.querySelector('.sel') || list.firstElementChild;
  const fit = Math.round(list.clientHeight / row);
  const first = [...list.children].indexOf(on) - (fit >> 1);
  list.scrollTop = Math.max(0, Math.min(first, list.children.length - fit)) * row;
  placeThumb();
  on.focus({ preventScroll: true });
}

function closeMenu(refocus = false) {
  if (!openFor) return;
  const k = openFor;
  openFor = null;
  if (k === 'ui') {
    // Из плитки — сразу на место; спрятанные плитки проявляются.
    hush(menu);
    document.querySelector('.hd').after(menu);
    sheet.classList.remove('picking');
    for (const t of tiles) if (!t.contains(btn.ui)) t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
  } else {
    reveal(menu, false, 4);
  }
  document.body.classList.remove('menu-open');
  btn[k].classList.remove('open');
  btn[k].setAttribute('aria-expanded', 'false');
  if (refocus) btn[k].focus();
}

for (const k of ['src', 'dst', 'ui']) {
  btn[k].addEventListener('click', () => (openFor === k ? closeMenu() : openMenu(k)));
}

list.addEventListener('click', (e) => {
  const it = e.target.closest('.it');
  if (it) choose(openFor, it.dataset.code);
});

// Клавиатура: стрелки, Enter, Esc и первая буква кода.
list.addEventListener('keydown', (e) => {
  const items = [...list.children];
  const i = items.indexOf(document.activeElement);
  const to = (j) => { e.preventDefault(); items[(j + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') return to(i + 1);
  if (e.key === 'ArrowUp') return to(i - 1);
  if (e.key === 'Home') return to(0);
  if (e.key === 'End') return to(items.length - 1);
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return choose(openFor, items[i]?.dataset.code); }
  // Escape закрывает только список: дойди он до window, закрыл бы и лист настроек.
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return closeMenu(true); }
  if (/^[a-z]$/i.test(e.key)) {
    const k = e.key.toLowerCase();
    for (let s = 1; s <= items.length; s++) {
      const j = (i + s) % items.length;
      if (items[j].dataset.code.startsWith(k)) return to(j);
    }
  }
});

document.addEventListener('pointerdown', (e) => {
  if (openFor && !menu.contains(e.target) && !btn[openFor].contains(e.target)) closeMenu();
});
addEventListener('blur', () => closeMenu());

/**
 * Выбрали язык. Пишем его в старый select (оттуда конфиг читает и
 * sidepanel.js), сохраняем и, если субтитры идут, перезапускаем сеанс с новой
 * парой: offscreen при этом оставляет звук вкладки и загруженные модели.
 */
function choose(k, code) {
  closeMenu(true);
  // Язык интерфейса сеанс не трогает: только надписи.
  if (k === 'ui') return code && setUiLang(code);
  if (!k || !code || sel[k].value === code) return;
  const from = btn[k].offsetWidth;
  sel[k].value = code;
  grow(btn[k], from);
  const config = { source: sel.src.value, target: sel.dst.value, orig: $('showOriginal').checked };
  const live = running();
  // Без сеанса — только пары: отказ прошлой пары снимается, новая качается
  // заранее (жеста модели Firefox не просят).
  if (live) warm(config);
  else self.__mt?.warm(config);
  // Перезапуск посреди сеанса ленту сам не чистит: строки прошлой пары иначе
  // висят вперемешку с новыми — на экране каша из двух языков (та самая, что на
  // скрине). Стираем до старта, тем же clearCues, что и при обычном включении.
  if (live) window.__captions?.clear?.();
  // Сменился только язык перевода — звук и распознавание не трогаем
  // (RETARGET): полный перезапуск держал ленту пустой секунд шесть, пока поток
  // заново набирал слова. Не вышло (сеанс уже кончился) — по-старому, START.
  chrome.runtime.sendMessage({ type: 'SET_CONFIG', config })
    .then(async () => {
      if (!live) return;
      if (k === 'dst') {
        const r = await chrome.runtime.sendMessage({ type: 'RETARGET', target: code }).catch(() => null);
        if (r?.ok) return;
      }
      await restart();
    })
    .catch(() => {});
}

/**
 * Перезапуск сеанса из графита: с окном панели, как у кнопки sidepanel.js
 * (иначе фон берёт активную вкладку не того окна), и отказ — в статус.
 */
async function restart() {
  const windowId = await chrome.windows?.getCurrent().then((w) => w.id, () => null);
  const res = await chrome.runtime.sendMessage({ type: 'START', windowId })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (res && !res.ok && !res.quiet) window.__captions?.showError?.(res.error || 'could not start capture');
}

/** Тот же прогрев, что у sidepanel.js при запуске: пара перевода и определитель языка. */
async function warm(config) {
  // Пары качает панель (warmPairs): там же ход загрузки и отказ.
  self.__mt?.warm(config);
  try {
    // Определитель Chrome качает только под жестом — он сейчас и есть.
    if (config.source === 'auto' && self.LanguageDetector && await LanguageDetector.availability() !== 'available') {
      (await LanguageDetector.create()).destroy?.();
    }
  } catch { /* не скачался — язык скажет модель, только позже */ }
}

// --- Низ: настройки ---------------------------------------------------------------
//
// Шестерёнка открывает лист над низом: оригинал над переводом и запись в файл.
// Закрывается вторым щелчком, щелчком мимо и Escape.

const set = $('set'), sheet = $('sheet');
const tiles = [...sheet.querySelectorAll('.tile')];
function openSheet(on) {
  const shut = sheet.hidden;
  reveal(sheet, on, on ? 0 : -6);
  document.body.classList.toggle('sheet-open', on);
  // Плитки встают снизу вверх по очереди, ближняя к шестерёнке первой.
  if (on && shut) {
    tiles.forEach((t, i) => t.animate(
      [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, delay: (tiles.length - 1 - i) * 45, easing: 'cubic-bezier(.2, .8, .3, 1)', fill: 'backwards' }));
  }
  set.setAttribute('aria-expanded', String(on));
}
const sheetOpen = () => set.getAttribute('aria-expanded') === 'true';
set.addEventListener('click', () => openSheet(!sheetOpen()));
addEventListener('pointerdown', (e) => {
  if (sheetOpen() && !sheet.contains(e.target) && !set.contains(e.target) && !menu.contains(e.target)) openSheet(false);
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Фокус ушёл из списка (клик по рамке): Escape закрывает сперва список.
  if (openFor) closeMenu(true);
  else if (sheetOpen()) { openSheet(false); set.focus(); }
});
// Строка целиком — тот же переключатель: попасть в него пальцем не нужно.
for (const tg of sheet.querySelectorAll('.opt .tg')) {
  const opt = tg.closest('.opt');
  opt.addEventListener('click', (e) => { if (!e.target.closest('.tg')) tg.click(); });
}

// Оригинал: переключатель повторяет старую галку, настройка — она.
const og = $('og'), showOriginal = $('showOriginal');
og.addEventListener('click', () => {
  showOriginal.checked = !showOriginal.checked;
  // Событие слушает sidepanel.js: показ (body[data-orig]) и запись настройки.
  showOriginal.dispatchEvent(new Event('change'));
});
// applyConfig ставит галку присваиванием, а следом — data-orig на body.
const paintOg = () => og.setAttribute('aria-checked', String(showOriginal.checked));
new MutationObserver(paintOg).observe(document.body, { attributes: true, attributeFilter: ['data-orig'] });
paintOg();

// Автосохранение: файл сеанса в «Загрузках» пишет фоновый скрипт
// (lib/autosave.js), здесь только переключатель и где лежит файл.
const as = $('as'), asSay = $('asSay'), asMore = $('asMore');
const AS_PERMS = { permissions: ['downloads', 'downloads.ui'] };
let asOn = false, asFile = null;
function paintAs() {
  as.setAttribute('aria-checked', String(asOn));
  asMore.hidden = !asOn || !asFile?.id;
  const f = asFile;
  asSay.textContent = !asOn ? t('asSay')
    : f?.note || (f?.savedAt ? `Downloads/audio-translator/${f.name}`
      : t('asFile'));
}
Promise.all([chrome.storage.local.get('autosave'), chrome.storage.session.get('afile')]).then(([l, s]) => {
  asOn = l.autosave === true;
  asFile = s.afile || null;
  paintAs();
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.autosave) asOn = ch.autosave.newValue === true;
  else if (area === 'session' && ch.afile) asFile = ch.afile.newValue || null;
  else return;
  paintAs();
});
as.addEventListener('click', () => {
  if (asOn) return chrome.storage.local.set({ autosave: false });
  // Разрешение спрашиваем прямо под щелчком: без жеста Chrome окно не покажет.
  chrome.permissions.request(AS_PERMS).then((ok) => ok && chrome.storage.local.set({ autosave: true }), () => {});
});
$('asShow').addEventListener('click', () => {
  if (asFile?.id) chrome.downloads.show(asFile.id);
});

// Где считает модель: процессор (по умолчанию) или видеокарта. Устройство
// выбирается при сборке модели, поэтому посреди сеанса — перезапуск, как при
// смене языка. Не поднялась видеокарта — offscreen считает процессором, а
// здесь об этом говорит строка под выбором.
const devs = [...sheet.querySelectorAll('.seg [data-dev]')], devSay = $('devSay');
let dev = 'cpu', ranOn = '';
function paintDev() {
  if (!devSay) return; // приложение Android: плитки нет, считает процессор
  for (const b of devs) {
    b.setAttribute('aria-checked', String(b.dataset.dev === dev));
    b.tabIndex = b.dataset.dev === dev ? 0 : -1;
  }
  devSay.textContent = t(!ranOn ? 'devSay'
    : ranOn === 'webgpu' ? 'devGpu'
      : dev === 'gpu' ? 'devGpuNo' : 'devCpu');
}
function pickDev(d) {
  if (d === dev) return;
  dev = d;
  paintDev();
  const live = running();
  if (live) window.__captions?.clear?.();
  chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: { device: d } })
    .then(() => live && restart())
    .catch(() => {});
}
for (const b of devs) {
  b.addEventListener('click', () => pickDev(b.dataset.dev));
  b.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = devs[(devs.indexOf(b) + 1) % devs.length];
    pickDev(next.dataset.dev);
    next.focus();
  });
}
/** Устройство готовой модели — из статуса сеанса; без сеанса строка молчит. */
const readDev = (s) => { ranOn = s?.stage === 'ready' ? s.draftDevice || '' : ''; paintDev(); };
chrome.storage.local.get(['config', 'status']).then(({ config, status }) => {
  dev = config?.device === 'gpu' ? 'gpu' : 'cpu';
  readDev(status);
}).catch(() => paintDev());
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.status) readDev(ch.status.newValue);
  // Устройство сменили в панели другой вкладки: настройка одна на все.
  if (ch.config) { dev = ch.config.newValue?.device === 'gpu' ? 'gpu' : 'cpu'; paintDev(); }
});

// --- Низ: копия расшифровки -------------------------------------------------------
//
// Журнал фонового скрипта с запуска браузера (lib/journal.js, до 4 млн знаков)
// и строки, что ещё не устоялись, — в буфер обмена.

const copyWrap = $('bcopy'), copyTip = copyWrap.querySelector('.tip > span');
let copyTimer = 0;
/** Подсказка на экране одна: сказанное (say-it) живёт, пока не заговорила
 *  другая и пока не навели или не перешли фокусом на другую кнопку; тогда оно
 *  снято насовсем, а не спрятано до ухода мыши. */
const hushers = new Map();
function soleTip(keep) {
  for (const [b, stop] of hushers) if (b !== keep && b.classList.contains('say-it')) stop();
}
for (const ev of ['pointerover', 'focusin']) {
  // Только вход в кнопку: переходы между её частями (svg выключателя, звёзды)
  // гасили просьбу оценить, показанную, пока мышь ещё стоит на выключателе.
  document.addEventListener(ev, (e) => {
    const b = e.target.closest?.('.b');
    if (b && !b.contains(e.relatedTarget)) soleTip(b);
  });
}
/** Облако посередине над кнопкой, но не левее поля низа (у .ft слева 12 px). */
function seatCopy() {
  const tip = copyTip.parentElement, shown = tip.offsetWidth > 0;
  // important: при открытом списке подсказки спрятаны через !important.
  if (!shown) { tip.style.visibility = 'hidden'; tip.style.setProperty('display', 'flex', 'important'); }
  const w = copyTip.offsetWidth;
  if (!shown) tip.style.visibility = tip.style.display = '';
  const shift = Math.min((w - copyWrap.offsetWidth) / 2, copyWrap.offsetLeft - 12);
  copyWrap.style.setProperty('--shift', `${Math.max(0, shift)}px`);
}
for (const ev of ['pointerenter', 'focusin']) copyWrap.addEventListener(ev, seatCopy);
function hushCopy() {
  clearTimeout(copyTimer);
  copyWrap.classList.remove('say-it');
  copyTip.textContent = t('copy');
  seatCopy();
}
hushers.set(copyWrap, hushCopy);
function sayCopy(text) {
  copyTip.textContent = text;
  seatCopy();
  soleTip(copyWrap);
  copyWrap.classList.add('say-it');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(hushCopy, 2000);
}
$('copy').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'JOURNAL_TEXT' }).catch(() => null);
  const text = r?.text || '';
  if (!text) return sayCopy(t('copyNone'));
  const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
  sayCopy(t(ok ? 'copied' : 'copyFail'));
});

// --- Низ: субтитры поверх страницы ------------------------------------------------
//
// Плашка (overlay.js) ставится на вкладку значка, текст ей шлёт фоновый скрипт
// (ovlPush в background.js): закрыли панель — субтитры поверх страницы идут
// дальше. Кнопка только ставит и снимает желание — session.overlay = { tab }.
//
// Ошибок зритель не видит. Право ставить скрипт даёт грант значка. Его нет
// (сменился сайт) или сюда скриптам нельзя вовсе (новая вкладка, страницы
// Chrome) — кнопка один раз просит у Chrome доступ к сайтам
// (optional_host_permissions, patch.py), и плашка встанет сама, как только
// вкладка дойдёт до обычной страницы. Отказали в доступе — кнопка качнётся.

const ovl = $('ovl'), ovlWrap = $('bovl'), ovlTip = ovlWrap.querySelector('.tip > span');
const SITES = { origins: ['https://*/*', 'http://*/*'] };
let ovlTab = 0;
function paintOvl() {
  ovl.setAttribute('aria-pressed', String(!!ovlTab));
  ovlTip.textContent = t(ovlTab ? 'ovlHide' : 'ovl');
}
chrome.storage.session.get('overlay').then((r) => { ovlTab = r.overlay?.tab || 0; paintOvl(); }, () => {});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'session' && ch.overlay) { ovlTab = ch.overlay.newValue?.tab || 0; paintOvl(); }
});
/** Поставить плашку; false — скрипту сюда нельзя или гранта нет. */
const inject = (tab) => chrome.scripting.executeScript({ target: { tabId: tab }, files: ['overlay.js'] })
  .then(() => true, () => false);
/** Вкладка этой панели: последняя в panelTabs (background.js), иначе активная. */
async function panelTab() {
  const { panelTabs = [] } = await chrome.storage.session.get('panelTabs').catch(() => ({}));
  if (panelTabs.length) return panelTabs.at(-1);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id || 0;
}
/** Не вышло: кнопка качается, без слов. */
function nope(el = ovl) {
  el.animate([{ transform: 'none' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
    { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 280, easing: 'steps(1, end)' });
}
ovl.addEventListener('click', async () => {
  if (ovlTab) {
    ovlTab = 0;
    paintOvl();
    return chrome.storage.session.remove('overlay');
  }
  const tab = await panelTab();
  if (!tab) return nope();
  // Гранта значка нет — просим доступ к сайтам. Клик ещё свежий: Chrome
  // считает его жестом несколько секунд, окно разрешения откроется.
  const ok = await inject(tab) || await chrome.permissions.contains(SITES)
    || await chrome.permissions.request(SITES).catch(() => false);
  if (!ok) return nope();
  ovlTab = tab;
  paintOvl();
  chrome.storage.session.set({ overlay: { tab } });
});
paintOvl();

// --- Слушаем другую вкладку ----------------------------------------------------
//
// Панель видна на вкладке, которую не слушаем, — браузер её не закрыл. Opera
// держит панель вкладки до крестика зрителя, что бы ни сказал ей код, а у
// Firefox боковая панель одна на все вкладки окна. Чужая лента здесь путает,
// какую вкладку слушаем: вместо всей панели — надпись «субтитры на другой
// вкладке», имя той вкладки и кнопка перенести их сюда (graphite.css,
// body[data-away]).
//
// Вкладка панели — активная в её окне: видна панель только поверх активной,
// поэтому все панели окна решают одинаково, и права та, что на виду.
const away = $('away'), awayTab = $('awayTab'), awayName = awayTab.lastElementChild, awayGo = $('awayGo'), awayWhy = $('awayWhy');
/**
 * Активная вкладка окна панели или null. Окно спрашиваем каждый раз: вкладку
 * с панелью могут перетащить в другое окно.
 */
const hereTab = async () => {
  try {
    const win = await chrome.windows.getCurrent();
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab || null;
  } catch { return null; }
};
// Вкладка, куда «Listen here» не пустил Chrome: подсказка под кнопкой у неё.
let awayFailed = null;
// Чтения перекрываются (вкладку сменили, пока читали сеанс): рисует последнее.
let awaySeq = 0;
async function paintAway() {
  const seq = ++awaySeq;
  const [here, { session, pending } = {}] = await Promise.all([hereTab(),
    chrome.storage.session.get(['session', 'pending']).catch(() => ({}))]);
  // Запуск и подъём (смена языка, revive) ещё без сеанса: вкладку несёт pending.
  const heard = session?.tabId ?? pending?.tabId ?? null;
  const on = !!here && heard != null && here.id !== heard;
  // Звук дошёл сюда (значком): прежний отказ «Listen here» устарел.
  if (here && heard === here.id) awayFailed = null;
  // Имя вкладки видно, пока у нас грант её клика или доступ к сайту.
  const tab = on ? await chrome.tabs.get(heard).catch(() => null) : null;
  if (seq !== awaySeq) return;
  // Меню языков и лист настроек — не про эту вкладку: закрыть. Открытый лист
  // ещё и гасит ленту (sheet-open), а с ней и надпись с кнопкой.
  if (on) { closeMenu(); if (sheetOpen()) openSheet(false); }
  awayName.textContent = tab?.title || '';
  awayTab.hidden = !tab?.title;
  awayWhy.hidden = !on || awayFailed !== here.id;
  // Сразу, без проявления: панель под ним гаснет тем же атрибутом мгновенно, а
  // анимация в Опере на смене вкладки стояла секунды — чёрный экран без кнопки.
  document.body.toggleAttribute('data-away', on);
  away.hidden = !on;
}
chrome.tabs.onActivated.addListener(paintAway);
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && (ch.session || ch.pending)) paintAway(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title && document.body.hasAttribute('data-away')) paintAway(); });
paintAway();
// Сюда звук переезжает так же, как по значку на этой вкладке (listen в
// background.js). Ключа звука Chrome без клика по значку здесь не даёт (грант
// прежнего клика ушёл с переходом страницы) — тогда просим этот клик.
awayGo.addEventListener('click', async () => {
  awayGo.disabled = true;
  const here = await hereTab();
  const r = here && await chrome.runtime.sendMessage({ type: 'LISTEN_HERE', tabId: here.id }).catch(() => null);
  awayGo.disabled = false;
  awayFailed = r?.ok ? null : here?.id ?? null;
  if (!r?.ok) nope(awayGo);
  paintAway();
});

// --- Оценка --------------------------------------------------------------------
//
// Пять звёзд внизу: 4–5 — на отзывы в магазине, 1–3 — на нашу страницу «что
// не так», чтобы недовольный сказал это нам, а не вслепую в отзыве. Спрашивает
// подсказка над звёздами после выключения, когда расширением попользовались:
// десять минут субтитров, не чаще раза в три дня, дважды без ответа — больше
// никогда, после оценки — тоже. Оценку не показываем: открыл панель — звёзды
// пустые. Уходит она со второго клика по той же звезде, чтобы промах мышью не
// уводил на страницу отзывов.

const REVIEWS = 'https://chromewebstore.google.com/detail/phnegjcmilllfibjapkpolnfiifcjhcb/reviews';
const FEEDBACK = 'https://audio-translator.pages.dev/feedback/';
const ASK_AFTER = 10 * 60e3, ASK_GAP = 3 * 864e5, ASK_SKIPS = 2;
const rateWrap = $('brate'), stars = rateWrap.querySelector('.stars'), rateTip = rateWrap.querySelector('.tip > span');
let rated = { used: 0, asked: 0, skips: 0, stars: 0 };
// Наслушанное считает фон (heardMs, background.js); used — счёт прежних версий.
let heard = 0;
chrome.storage?.local?.get(['rated', 'heardMs']).then((o) => {
  rated = { ...rated, ...o?.rated };
  heard = o?.heardMs || 0;
}).catch(() => {});
const keep = (patch) => {
  rated = { ...rated, ...patch };
  chrome.storage?.local?.set({ rated }).catch(() => {});
};

/** Подсказка над звёздами говорит сама, на время. */
let rateTimer = 0;
function hushRate() {
  clearTimeout(rateTimer);
  rateWrap.classList.remove('say-it');
  rateTip.textContent = t('rateLabel');
}
// Сняли «Click again» — снят и выбор звезды: второй клик снова первый.
hushers.set(rateWrap, () => { hushRate(); unpick(); });
function sayRate(text, ms) {
  rateTip.textContent = text;
  soleTip(rateWrap);
  rateWrap.classList.add('say-it');
  clearTimeout(rateTimer);
  rateTimer = setTimeout(hushRate, ms);
}

/** Звёзды до n-й горят; без наведения — выбранные, но ещё не отправленные. */
function light(n) {
  if (n) stars.dataset.on = n;
  else delete stars.dataset.on;
}
const CONFIRM_MS = 5000;
let pick = 0, pickTimer = 0;
function unpick() {
  pick = 0;
  clearTimeout(pickTimer);
  light(0);
}
stars.addEventListener('pointerover', (e) => { const st = e.target.closest('.st'); if (st) light(st.dataset.n); });
stars.addEventListener('focusin', (e) => light(e.target.closest('.st')?.dataset.n));
for (const ev of ['pointerleave', 'focusout']) stars.addEventListener(ev, () => light(pick));
stars.addEventListener('click', async (e) => {
  const st = e.target.closest('.st');
  if (!st) return;
  const n = +st.dataset.n;
  // Первый клик только выбирает, второй по той же звезде отправляет.
  if (pick !== n) {
    pick = n;
    light(n);
    sayRate(t('rateAgain'), CONFIRM_MS);
    clearTimeout(pickTimer);
    pickTimer = setTimeout(unpick, CONFIRM_MS);
    return;
  }
  unpick();
  keep({ stars: n });
  sayRate(t('rateThanks'), 1600);
  // К жалобе то же, что к удалению (lib/diag.js): без ошибки и железа её не разобрать.
  let url = REVIEWS;
  if (n < 4) {
    const { diag } = await chrome.storage.local.get('diag').catch(() => ({}));
    url = `${FEEDBACK}?stars=${n}&${diagQuery(diag, chrome.runtime.getManifest().version)}`;
  }
  chrome.tabs.create({ url }).catch(() => open(url, '_blank'));
});

// Сеанс кончился — момент спросить: ленту больше не читают. Наслушанное
// прибавляет фон на конце сеанса (background.js), отсюда и сигнал: вырос
// heardMs, а субтитры не идут (переезд на другую вкладку тоже закрывает отрезок).
// Кнопка гаснет и до записи фона, и после — спрашиваем по тому, что придёт
// вторым; asked не даёт спросить дважды.
function askRate() {
  if (!running() && !rated.stars && rated.skips < ASK_SKIPS && rated.used + heard >= ASK_AFTER
      && Date.now() - rated.asked > ASK_GAP && note.hidden) {
    keep({ asked: Date.now(), skips: rated.skips + 1 });
    sayRate(t('rateAsk'), 8000);
  }
}
chrome.storage?.onChanged?.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.rated) rated = { ...rated, ...ch.rated.newValue };
  if (ch.heardMs) {
    heard = ch.heardMs.newValue || 0;
    askRate();
  }
});
let wasOn = running();
new MutationObserver(() => {
  if (wasOn && !running()) askRate();
  wasOn = running();
}).observe(go, { attributes: true, attributeFilter: ['data-on'] });

addEventListener('resize', () => { closeMenu(); paint(); });
// Пиксельный шрифт догружается после первой отрисовки, и ширины кнопок
// языка (--half у подсказок) меняются вместе с ним.
document.fonts?.addEventListener('loadingdone', paint);

// --- Язык интерфейса -------------------------------------------------------------
//
// Надписи разметки — по data-i18n, остальное перерисовывают свои paint*.
// Сменили язык (здесь или в другой странице) — всё заново, без перезапуска.

function paintUi() {
  localize();
  const code = uiLang();
  btn.ui.querySelector('.code').textContent = label(code);
  $('uiSay').textContent = endonym(code);
  if (!copyWrap.classList.contains('say-it')) { copyTip.textContent = t('copy'); seatCopy(); }
  if (!rateWrap.classList.contains('say-it')) rateTip.textContent = t('rateLabel');
  paintAs();
  paintDev();
  paintOvl();
  paint();
}
onUiLang(() => { closeMenu(); paintUi(); });
paintUi();
