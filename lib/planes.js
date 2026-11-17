/**
 * fp32-веса в пакете лежат «плоскостями»: сначала первые байты всех чисел
 * тензора, потом вторые, третьи, четвёртые. Без потерь, бит в бит.
 *
 * Зачем. Старший байт fp32 (знак и порядок) у весов почти один и тот же, но
 * вперемешку с тремя шумными байтами deflate этого не видит. Собранный в одну
 * полосу, он сжимается почти в ноль: пакет магазина на те же байты меньше на
 * ~22 МБ (texts/размер-пакета.2026-10-19.txt). int4-ядро не трогаем: оно и так
 * у предела энтропии.
 *
 * Плоскостями пакет собирает ui/pack.sh (tools/planes.mjs), он же пишет
 * planes.json рядом с весами: файл → [[смещение, длина], …] fp32-тензоров. В
 * ext/ (стенд, разработка) planes.json пустой, и веса читаются как есть.
 */

/** Числа тензора — в плоскости (в пакет). */
export function toPlanes(buf, ranges) {
  for (const [at, len] of ranges) {
    const src = buf.slice(at, at + len), n = len >> 2;
    for (let i = 0; i < n; i++) {
      const j = i << 2;
      buf[at + i] = src[j];
      buf[at + n + i] = src[j + 1];
      buf[at + 2 * n + i] = src[j + 2];
      buf[at + 3 * n + i] = src[j + 3];
    }
  }
  return buf;
}

/** Плоскости — обратно в числа (при загрузке), на месте. */
export function fromPlanes(buf, ranges) {
  for (const [at, len] of ranges) {
    const n = len >> 2;
    const p0 = buf.slice(at, at + len);
    for (let i = 0; i < n; i++) {
      const j = at + (i << 2);
      buf[j] = p0[i];
      buf[j + 1] = p0[n + i];
      buf[j + 2] = p0[2 * n + i];
      buf[j + 3] = p0[3 * n + i];
    }
  }
  return buf;
}
