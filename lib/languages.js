// Языки, которые расширение предлагает зрителю.
//
// Списка два, и это не придирка: ограничения здесь разные. Речь понимает
// распознавание — у nemotron 35 языков со слотом подсказки и своим тегом в
// словаре (lib/nemo-langs.js). Переводит встроенный в Chrome движок, и у него
// свой список — 39 кодов. Показывать в «языке звука» то, что мы не распознаём,
// или в «языке перевода» то, чего нет у Chrome, значит обещать зрителю пустую
// строку вместо субтитров.
//
// Списки не сочинены, а измерены: node e2e/nmt-langs.mjs спрашивает у Chrome
// Translator.availability() по каждой паре. На Chrome 150 из 35 языков речи
// переводчик не берёт четыре — эстонский и латышский не берёт вовсе (их здесь
// нет), а норвежский он знает одним кодом `no` вместо букмола и нюнорска
// (см. MT_CODE ниже). Ответ зависит от сборки браузера, так что при обновлении
// Chrome стенд стоит прогнать заново.
import { NEMO_LANGS } from './nemo-langs.js';

/** Название языка по коду. Один словарь на оба списка: коды не пересекаются. */
const NAMES = {
  ru: 'Russian', en: 'English', ar: 'Arabic', bg: 'Bulgarian',
  bn: 'Bengali', cs: 'Czech', da: 'Danish', de: 'German',
  el: 'Greek', es: 'Spanish', et: 'Estonian', fi: 'Finnish',
  fr: 'French', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian',
  hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese',
  kn: 'Kannada', ko: 'Korean', lt: 'Lithuanian', lv: 'Latvian',
  mr: 'Marathi', nb: 'Norwegian (Bokmål)', nl: 'Dutch',
  nn: 'Norwegian (Nynorsk)', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', sk: 'Slovak', sl: 'Slovenian',
  sv: 'Swedish', ta: 'Tamil', te: 'Telugu', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
  zh: 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)'
};

/**
 * Чем наш код языка называется у переводчика Chrome.
 *
 * Распознавание различает две письменные нормы норвежского — у них разные
 * слоты и разные теги, — а переводчик знает один `no`. Без этой строки
 * норвежская речь распознавалась бы верно и не переводилась вовсе.
 */
export const MT_CODE = { nb: 'no', nn: 'no' };

/** Код для запроса к переводчику: наш, если Chrome его знает, иначе его. */
export const mtCode = (code) => MT_CODE[code] || code;

/**
 * Языки перевода: всё, что берёт встроенный движок Chrome 150.
 * Распознавания среди них нет у восьми (bn, id, kn, mr, no, ta, te, zh-Hant) —
 * для языка перевода оно и не нужно.
 */
export const TARGET_CODES = [
  'ru', 'en', 'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr',
  'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl',
  'no', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk',
  'vi', 'zh', 'zh-Hant'
];

/**
 * Языки звука: те, что распознавание умеет печатать И с которых Chrome
 * переводит. Вычитаются эстонский и латышский — их nemotron слышит, но
 * переводить их Chrome отказывается, и толку от такой пары нет.
 */
export const SOURCE_CODES = NEMO_LANGS.filter(
  code => TARGET_CODES.includes(mtCode(code)));

const list = (codes) => codes.map(code => ({ code, name: NAMES[code] || code }));
// Английский и русский первыми, дальше по алфавиту названия: список длинный,
// и искать в нём глазами надо по названию языка, а не по коду.
const ordered = (codes) => {
  const head = ['en', 'ru'].filter(c => codes.includes(c));
  const rest = codes.filter(c => !head.includes(c))
    .sort((a, b) => (NAMES[a] || a).localeCompare(NAMES[b] || b, 'en'));
  return list([...head, ...rest]);
};

/** Для выпадающего списка «язык звука». */
export const SOURCES = ordered(SOURCE_CODES);
/**
 * Для выпадающего списка «язык перевода»: всё, что есть в «языке звука», тоже
 * здесь. Норвежский — двумя пунктами, как у распознавания (букмол и нюнорск),
 * хоть Chrome и переводит одним `no`: нюнорскую речь в нюнорск показываем как
 * есть, без перевода. Движку цель уходит через mtCode.
 */
export const TARGET_PICKS = TARGET_CODES.flatMap(c => c === 'no' ? ['nb', 'nn'] : [c]);
export const TARGETS = ordered(TARGET_PICKS);

export const langName = (code) => NAMES[code] || code;
