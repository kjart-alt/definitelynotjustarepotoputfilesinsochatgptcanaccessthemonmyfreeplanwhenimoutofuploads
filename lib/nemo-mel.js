// Лог-мел для nemotron-3.5-asr-streaming: preemph 0.97 → STFT(512/160/400,
// hann) → |·|² → 128 мел-банков librosa(slaney, 0–8000 Гц) → log(x + 5.96e-08),
// без нормализации.
//
// Каждая мелочь здесь сверена с эталоном — штатным процессором ORT-GenAI,
// который отдаёт свои признаки наружу (`sp.process(chunk)['audio_features']`).
// Сверять пришлось потому, что модель на неверном входе не падает и не шумит:
// она уверенно молчит, выдавая один пустой символ за другим, и отличить
// «плохой мел» от «неверного протокола» по выходу невозможно.
//
// Что дала сверка (среднее |Δ| по 65×128 признакам одного чанка):
//
//   порог логарифма 1e-10 вместо 5.96e-08        1.06
//   паддинг n_fft/2 (256) вместо win_length/2    0.44
//   мел-шкала HTK вместо slaney                  1.40
//   как ниже                                     0.007
//
// Последняя строка — это уже численный шум float32. Из неочевидного: паддинг
// именно половина ОКНА, а не половина FFT, то есть кадр t приходится ровно на
// отсчёт t*160 и берёт [t*160−200, t*160+200).

// EPS — это log_eps из genai_config.json, ровно 2⁻²⁴.
export const SR = 16000, HOP = 160;
const NFFT = 512, WIN = 400, NMEL = 128, EPS = 5.96046448e-08, PREEMPH = 0.97;
const PAD = WIN >> 1;  // 200: полокна слева от первого кадра

const hzToMel = f => f < 1000 ? f / (200 / 3)
  : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27);
const melToHz = m => m < 15 ? m * (200 / 3)
  : 1000 * Math.exp((m - 15) * (Math.log(6.4) / 27));

/** Треугольные фильтры librosa: [NMEL][NFFT/2+1], нормировка slaney. */
function melBank() {
  const bins = NFFT / 2 + 1;
  const fft = Array.from({ length: bins }, (_, i) => i * SR / NFFT);
  const lo = hzToMel(0), hi = hzToMel(8000);
  const pts = Array.from({ length: NMEL + 2 }, (_, i) => melToHz(lo + (hi - lo) * i / (NMEL + 1)));
  const w = Array.from({ length: NMEL }, () => new Float32Array(bins));
  for (let m = 0; m < NMEL; m++) {
    const [a, b, c] = [pts[m], pts[m + 1], pts[m + 2]];
    const enorm = 2 / (c - a);
    for (let k = 0; k < bins; k++) {
      const up = (fft[k] - a) / (b - a), dn = (c - fft[k]) / (c - b);
      const v = Math.min(up, dn);
      if (v > 0) w[m][k] = v * enorm;
    }
  }
  return w;
}

const BANK = melBank();
const HANN = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN));

/** Обычное radix-2 на месте: 512 точек, комплексный вход. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Поток мел-кадров: звук приходит кусками, кадры выходят по мере готовности.
 *
 * Считать мел на весь файл разом, как делал стенд, для живой дорожки нельзя по
 * двум причинам. Звука целиком нет — он идёт из захвата по 20 мс. И паддинг:
 * обе кромки отражаются, то есть «конец» сигнала меняет последние кадры, а в
 * потоке конца нет. Поэтому левая кромка отражается один раз на старте, правой
 * не бывает вовсе, и кадр выдаётся ровно тогда, когда пришли все его отсчёты.
 */
export class MelStream {
  constructor() { this.reset(); }

  reset() {
    // Всё, что ещё может понадобиться кадрам: абсолютный номер первого отсчёта
    // в buf и сколько отсчётов уже пришло.
    this.buf = new Float32Array(0);
    this.base = -PAD;   // buf[0] — это отсчёт с номером base (левый паддинг)
    this.have = -PAD;   // до какого номера включительно buf заполнен (не вкл.)
    this.frame = 0;
    this.prev = 0;      // последний сырой отсчёт: preemph смотрит на соседа
    this.started = false;
    this.head = [];     // первые PAD+1 отсчётов, пока не набрались на отражение
  }

  /**
   * @param {Float32Array} pcm новые отсчёты 16 кГц
   * @returns {{mel: Float32Array, frames: number}} mel[банк * frames + кадр]
   */
  push(pcm) {
    // preemph по всему потоку без швов: помним предыдущий сырой отсчёт.
    const x = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) { x[i] = pcm[i] - PREEMPH * this.prev; this.prev = pcm[i]; }
    // Самый первый отсчёт берётся как есть — так делает librosa.
    if (!this.started && pcm.length) x[0] = pcm[0];

    if (!this.started) {
      // Левая кромка: p[PAD-1-i] = x[i+1], то есть отражение без повтора
      // нулевого отсчёта. Нужны первые PAD+1 отсчётов.
      this.head.push(x);
      const n = this.head.reduce((s, a) => s + a.length, 0);
      if (n < PAD + 1) return { mel: new Float32Array(0), frames: 0 };
      const all = new Float32Array(n);
      let o = 0; for (const a of this.head) { all.set(a, o); o += a.length; }
      this.head = null;
      const pad = new Float32Array(PAD);
      for (let i = 0; i < PAD; i++) pad[PAD - 1 - i] = all[i + 1];
      this.buf = new Float32Array(PAD + n);
      this.buf.set(pad, 0); this.buf.set(all, PAD);
      this.have = n;
      this.started = true;
    } else {
      const next = new Float32Array(this.buf.length + x.length);
      next.set(this.buf, 0); next.set(x, this.buf.length);
      this.buf = next;
      this.have += x.length;
    }

    // Кадр t берёт [t*HOP-PAD, t*HOP+PAD) — готов, когда пришёл отсчёт t*HOP+PAD.
    const ready = Math.max(0, Math.floor((this.have - PAD) / HOP) + 1 - this.frame);
    const mel = new Float32Array(NMEL * ready);
    const bins = NFFT / 2 + 1;
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT), pw = new Float32Array(bins);
    const off = (NFFT - WIN) >> 1;  // окно 400 внутри 512 по центру — как torch.stft
    for (let f = 0; f < ready; f++) {
      const s = (this.frame + f) * HOP - PAD - this.base;
      re.fill(0); im.fill(0);
      for (let i = 0; i < WIN; i++) re[off + i] = this.buf[s + i] * HANN[i];
      fft(re, im);
      for (let k = 0; k < bins; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
      for (let m = 0; m < NMEL; m++) {
        const w = BANK[m];
        let acc = 0;
        for (let k = 0; k < bins; k++) acc += w[k] * pw[k];
        mel[m * ready + f] = Math.log(acc + EPS);
      }
    }
    this.frame += ready;

    // Отрезаем прошлое: следующему кадру нужен буфер начиная с его левого края.
    const keep = this.frame * HOP - PAD;
    if (keep - this.base > 4 * WIN) {
      this.buf = this.buf.slice(keep - this.base);
      this.base = keep;
    }
    return { mel, frames: ready };
  }
}

/**
 * Мел на готовый кусок целиком — как его считает librosa: обе кромки отражены.
 * Для стенда и сверок; живая дорожка ходит через MelStream.
 *
 * @param {Float32Array} pcm звук 16 кГц
 * @returns {{mel: Float32Array, frames: number}} mel[банк * frames + кадр]
 */
export function logMel(pcm) {
  const s = new MelStream();
  // Правая кромка: отражение хвоста, чтобы последние кадры совпали с librosa.
  const tail = new Float32Array(PAD);
  for (let i = 0; i < PAD; i++) tail[i] = pcm[pcm.length - 2 - i];
  const want = Math.floor(pcm.length / HOP) + 1;
  const { mel, frames } = s.push(Float32Array.from([...pcm, ...tail]));
  if (frames === want) return { mel, frames };
  // push отдаёт столько кадров, сколько набралось; лишние с отражённого хвоста
  // выбрасываем — они за пределами сигнала.
  const cut = new Float32Array(NMEL * want);
  for (let m = 0; m < NMEL; m++) for (let t = 0; t < want; t++) cut[m * want + t] = mel[m * frames + t];
  return { mel: cut, frames: want };
}
