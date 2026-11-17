// Междометия раздумья: «euh», «uh», «äh», «э». Модель пишет их дословно —
// у неё в словаре есть целые «▁uh», «äh», «э», «呃», — а человек в субтитрах
// их не ставит никогда: в ручных дорожках роликов стенда «euh» ни одного, у
// нашей живой строки на трёх минутах французского их семь. Каждое — лишнее
// слово на экране и мусор для переводчика.
//
// Списки по языкам, а не общий, и в них только то, что словом не бывает:
// португальское «um» — это «один», немецкое «um» — предлог, испанское «eh» —
// переспрос, китайское «嗯» — ещё и «да». Такие остаются.

const SPACED = {
  en: 'uh um umm uhm erm hmm',
  de: 'äh ähm öhm ehm hmm',
  nl: 'eh ehm uh uhm hmm',
  sv: 'öh öhm eh ehm hmm',
  da: 'øh øhm hmm',
  nb: 'eh øh øhm ehm hmm',
  nn: 'eh øh øhm ehm hmm',
  fr: 'euh heu hum',
  es: 'ehm emm mmm',
  pt: 'ãh hã hum',
  it: 'uh ehm uhm mmm',
  ro: 'ăă ăăă ee eee hmm',
  ru: 'э ээ эээ эм эмм мм ммм хм',
  uk: 'ее еее ем мм ммм хм',
  bg: 'ъъ ъъъ ъм мм ммм хм',
  pl: 'yy yyy eee emm hmm',
  cs: 'ehm eee hmm',
  sk: 'ehm eee hmm',
  hr: 'eee hmm',
  sl: 'eee hmm',
  lt: 'eee hmm',
  el: 'εε εεε εμ χμ',
  tr: 'ıı ııı eee hmm',
  hu: 'öö ööö hmm',
  fi: 'öö ööö hmm',
  he: 'אמ אממ אהה',
  ar: 'امم اممم ااا',
  hi: 'अ अं उम्म हम्म',
  vi: 'ừm ờm ưm',
  ko: '어 음 으음 어어',
};

// Без пробелов междометие режется подстрокой, поэтому только длинные формы,
// которых внутри слова не бывает: японское «あの» без долготы — «тот».
const UNSPACED = {
  ja: ['えーっと', 'えーと', 'えっと', 'あのー', 'えー', 'うーん'],
  zh: ['呃'],
  th: ['เอ่อ', 'อืม'],
};

const lower = (w, lang) => (lang === 'tr' ? w.toLocaleLowerCase('tr') : w.toLowerCase());
const sets = {};

function setFor(lang) {
  if (!(lang in sets)) sets[lang] = SPACED[lang] ? new Set(SPACED[lang].split(' ')) : null;
  return sets[lang];
}

/** Убирает междометия раздумья, не трогая остальное. */
export function unfill(text, lang) {
  if (!text || !lang) return text;
  const code = String(lang).toLowerCase().split(/[-_]/)[0];
  if (UNSPACED[code]) {
    let s = text;
    for (const f of UNSPACED[code]) s = s.split(f).join('');
    // «えー、» оставило бы висячую запятую в начале фразы.
    return s.replace(/(^|[。！？\s])[、，]+/gu, '$1').replace(/\s{2,}/g, ' ').trim();
  }
  const set = setFor(code);
  if (!set) return text;

  const raw = text.split(/\s+/).filter(Boolean);
  const out = [];
  let cap = false;
  for (const w of raw) {
    const m = /^([\p{P}]*)(.*?)([\p{P}]*)$/u.exec(w);
    if (!m[2] || !set.has(lower(m[2], code))) {
      // Фраза начиналась с междометия — заглавную берёт следующее слово.
      out.push(cap ? w.replace(/\p{L}/u, c => c.toLocaleUpperCase(code)) : w);
      cap = false;
      continue;
    }
    // Конец фразы на междометии отдаём предыдущему слову, запятую — нет.
    const end = m[3].match(/[.!?…。]+/u);
    if (end && out.length && !/[.!?…]$/u.test(out[out.length - 1])) {
      out[out.length - 1] = out[out.length - 1].replace(/[,;:]+$/u, '') + end[0];
    }
    if (/^\p{Lu}/u.test(m[2]) && (!out.length || /[.!?…]$/u.test(out[out.length - 1]))) cap = true;
  }
  return out.join(' ');
}

/** Языки, для которых есть список. */
export const FILLER_LANGS = [...Object.keys(SPACED), ...Object.keys(UNSPACED)];
