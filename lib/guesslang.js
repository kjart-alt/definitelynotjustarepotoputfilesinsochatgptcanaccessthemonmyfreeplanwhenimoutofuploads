// Запасной определитель языка ПО РАСПОЗНАННОМУ ТЕКСТУ.
//
// Зачем. Под слотом «авто» переводить не с чего, пока язык не назван. На речи его
// называет сама модель (метка <xx-XX> → liveLang). На пении модель молчит про
// язык, и язык для перевода берёт детектор Chrome (detLang). Но встроенного
// LanguageDetector в профиле может не быть, а включать его флагом нельзя
// (memory/no-chrome-flags) — и тогда auto на пении оставался бы без перевода.
// Этот модуль определяет язык сам, из текста, который модель уже напечатала:
// без сети, без компонента, без флагов. Возвращает КОД ПЕРЕВОДЧИКА Chrome
// (как mtCode) из набора поддерживаемых пар — или '' , и тогда молчим.
//
// Это не классификатор на все 35 языков распознавания, а два уверенных шага.
// Чего он не распознаёт уверенно — отдаёт '' (как было и с одним детектором):
// перевода не будет, но и неверного языка тоже.
import { TARGET_CODES } from './languages.js';

// 1) По письменности. Для перевода нам нужен код, а не точный язык: кириллицу
//    по умолчанию считаем русским (украинский выдают свои буквы), арабицу —
//    арабским, и т.д. Диапазоны Unicode однозначнее любых служебных слов.
const SCRIPTS = [
  ['he', /[֐-׿]/],              // иврит
  ['ar', /[؀-ۿݐ-ݿ]/], // арабский
  ['el', /[Ͱ-Ͽ]/],              // греческий
  ['hi', /[ऀ-ॿ]/],              // деванагари (хинди/маратхи → хинди)
  ['bn', /[ঀ-৿]/],              // бенгальский
  ['ta', /[஀-௿]/],              // тамильский
  ['te', /[ఀ-౿]/],              // телугу
  ['kn', /[ಀ-೿]/],              // каннада
  ['th', /[฀-๿]/],              // тайский
  ['ko', /[가-힣ᄀ-ᇿ]/], // хангыль
  ['ja', /[぀-ヿ]/],              // кана → японский
  ['zh', /[一-鿿]/],              // хань без каны → китайский
];

// Служебные слова самых «поющих» латинских языков. Счёт попаданий на язык,
// побеждает набравший больше (с запасом). Пересечения вроде «la»/«de» гасятся
// объёмом: к концу фразы слов хватает.
const STOP = {
  en: new Set('the and you to of in is it that my me your we i a for on with this be are not all so just like dont cant im youre what have was'.split(' ')),
  es: new Set('que de la el y en los las un una no mi te me se por con para lo es su yo tu como más pero'.split(' ')),
  fr: new Set('le la les de et un une je tu ne pas que qui est dans pour mon ma te vous nous sur ce se il elle'.split(' ')),
  de: new Set('der die das und ich du nicht ist ein eine mit den dem zu auf für war mein dein wir sie es so auch'.split(' ')),
  it: new Set('che di la il e non un una mi ti per con sono ho ma se questo come più io tu ci mio mia perché gli della però anche cosa quando tutto'.split(' ')),
  pt: new Set('que de não e o a os as um uma eu te me por com para meu minha você se do da é mas como'.split(' ')),
};

const CYR = /[Ѐ-ӿ]/;
const UK = /[іїєґ]/i;          // буквы, которых нет в русском
// Болгарский: ъ — гласная и стоит перед согласной («България», «държава»), в
// русском он только знак перед е, ё, ю, я («объект»). Букв ы, э, ё в
// болгарском нет.
const BG = /ъ[бвгджзйклмнпрстфхцчшщ]/i;
const RU = /[ыэё]/i;
const LAT = /[a-z]/i;

/**
 * Угадать язык по тексту. Возвращает код переводчика из TARGET_CODES или ''.
 * @param {string} text распознанная строка (чем длиннее, тем вернее)
 */
export function guessLang(text) {
  const s = String(text || '');
  if (!s.trim()) return '';

  // Письменность: какой диапазон набрал больше символов, тот и язык.
  let best = '', bestN = 0;
  for (const [code, re] of SCRIPTS) {
    const g = new RegExp(re.source, 'g');
    const n = (s.match(g) || []).length;
    if (n > bestN) { bestN = n; best = code; }
  }
  // Японский пишет кандзи вперемешку с каной, и кандзи бывает больше:
  // «東京都知事選挙の結果» — восемь хань на одну кану. Хань без каны — китайский,
  // с каной — японский: в китайском тексте каны не бывает.
  if (best === 'zh' && /[぀-ヿ]/.test(s)) best = 'ja';
  const cyr = (s.match(new RegExp(CYR.source, 'g')) || []).length;
  if (cyr > bestN) { bestN = cyr; best = UK.test(s) ? 'uk' : BG.test(s) && !RU.test(s) ? 'bg' : 'ru'; }
  const lat = (s.match(/[a-z]/gi) || []).length;
  // Нелатинская письменность уверенно победила латиницу — отдаём её.
  if (best && bestN >= lat && bestN >= 3) {
    return TARGET_CODES.includes(best) ? best : '';
  }

  // Латиница: по служебным словам. Нужны и объём, и перевес.
  const low = s.toLowerCase().replace(/[’`]/g, "'");
  const words = low.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 8 || !LAT.test(s)) return '';
  // Слово с апострофом, которое есть в списке слитно («don't» — «dont»),
  // считаем слитным, иначе по частям («c'est» — это «est»). Но не так и так
  // сразу: «I'm» дало бы английскому два очка.
  const stop = (w) => Object.values(STOP).some((set) => set.has(w));
  const toks = low.replace(/[^\p{L}\s']/gu, ' ').split(/\s+/)
    .flatMap((t) => (t.includes("'") && !stop(t.replace(/'/g, '')) ? t.split("'") : [t.replace(/'/g, '')]))
    .filter(Boolean);
  const score = { en: 0, es: 0, fr: 0, de: 0, it: 0, pt: 0 };
  for (const w of toks) for (const [lang, set] of Object.entries(STOP)) if (set.has(w)) score[lang]++;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, topN] = ranked[0];
  const runnerN = ranked[1][1];
  // Хотя бы 3 попадания и перевес над вторым — иначе молчим: лучше без перевода,
  // чем не с того языка (на пении метка модели его уже не исправит).
  if (topN >= 3 && topN - runnerN >= 2) return TARGET_CODES.includes(top) ? top : '';
  return '';
}

// Письменность, какой её ждут от метки языка модели. Чего здесь нет — латиница.
const LABEL_SCRIPT = {
  ru: 'cyr', uk: 'cyr', bg: 'cyr', el: 'el', he: 'he', ar: 'ar', hi: 'hi',
  ja: 'cjk', zh: 'cjk', ko: 'ko', th: 'th',
};

// Слова, которые бывают только английскими. Короткие служебные (a, i, to, is,
// in, on, we, be, me, was, of) сюда не берём: в польском, чешском, венгерском,
// немецком, голландском это самые частые слова, и 04.11 по ним польская речь
// под меткой pl считалась английской. По той же причине нет her (tr, da),
// had и want (nl), more (sl), have (da), also (de), has (es), are (ro), like
// (nb), make (sv), some (pt), these (de).
const ENGLISH_ONLY = new Set(('the and that you this with what they there their '
  + 'but your about know would which been from were not it could should '
  + "it's i'm don't can't that's you're we're they're didn't doesn't isn't "
  + 'going gonna really because think people something when where who how '
  + 'very here now get got did does she him his them our those '
  + 'into than then only after before much other right well said').split(' '));

/**
 * Годится ли метка языка модели к тексту, который она же напечатала.
 *
 * Под «авто» nemotron изредка метит речь чужим языком: на английском ролике
 * 04.11 метки el и et скачали два словаря, кольцо загрузки всплывало раз за
 * разом, а английский текст шёл в переводчик как греческий. Ложную метку
 * выдаёт сам текст: греческая на латинице, или явный английский под
 * латинской меткой другого языка.
 * @param {string} lang код метки (en, ru, el…)
 * @param {string} text текст, распознанный с появления метки
 * @returns {'no'|'yes'|''} противоречит, подтверждает, или текста мало
 */
export function labelFits(lang, text) {
  const s = String(text || '');
  const count = (re) => (s.match(new RegExp(re.source, 'g')) || []).length;
  const n = {
    latin: count(/[a-zA-Z]/), cyr: count(CYR),
    cjk: count(/[぀-ヿ一-鿿]/),
  };
  for (const [code, re] of SCRIPTS) if (!['ja', 'zh'].includes(code)) n[code] = count(re);
  let top = '', topN = 0, all = 0;
  for (const [k, v] of Object.entries(n)) { all += v; if (v > topN) { top = k; topN = v; } }
  // Письменность должна быть явной: хотя бы 8 букв и четыре пятых всех.
  if (topN < 8 || topN < all * 0.8) return '';
  const want = LABEL_SCRIPT[lang] || 'latin';
  if (want !== top) return 'no';
  if (want !== 'latin' || lang === 'en') return 'yes';
  // Латиница: чужая латинская метка ложная на явном английском — два слова
  // из ENGLISH_ONLY и десятая часть текста. Подтверждает её текст без них, но
  // от 12 слов: в шести словах английской речи ни одного из них нет в каждом
  // девятом окне, и ложная et проходила (третье ревью 04.11).
  const ws = s.toLowerCase().replace(/[’`]/g, "'").split(/[^a-z'\u00c0-\u024f\u1e00-\u1eff]+/)
    .filter((w) => /[^']/.test(w));
  const eng = ws.filter((w) => ENGLISH_ONLY.has(w)).length;
  if (eng >= 2 && eng >= ws.length * 0.1) return 'no';
  return ws.length >= 12 && eng <= ws.length * 0.05 ? 'yes' : '';
}
