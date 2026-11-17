// Что приложить к отзыву, чтобы жалобу «не переводит» можно было разобрать:
// последнюю ошибку, пару языков, сколько фраз показано и сколько переведено,
// на чём считала модель и грубо железо. Это diag в storage.local, его ведёт
// noteDiag в background.js. Ни сайтов, ни текста: только счётчики и короткая
// строка ошибки.
//
// Одни и те же поля едут в адрес страницы удаления и страницы отзыва на 1–3
// звезды. Страница (ports/android/store/site/assets/feedback.js) берёт их из
// адреса и шлёт вместе с формой, а страница удаления ещё и сразу при открытии.

/**
 * Адрес страницы отзыва: версия и поля diag.
 *
 * @param {object} [diag] запись diag из storage.local
 * @param {string} v версия расширения
 * @returns {URLSearchParams}
 */
export function diagQuery(diag = {}, v) {
  const q = new URLSearchParams({ v });
  const put = (k, val, max = 40) => { if (val !== undefined && val !== '') q.set(k, String(val).slice(0, max)); };
  put('e', diag.e, 160);
  put('pair', diag.pair);
  put('n', diag.n);
  put('t', diag.t);
  put('dev', diag.dev);
  for (const [k, val] of Object.entries(diag.hw || {})) put(k, val);
  return q;
}
