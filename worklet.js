// Снимает моно-поток с захваченного звука кусками по 1024 отсчёта (64 мс при 16 кГц)
// и отдаёт их в offscreen-документ. Downmix до моно делает сам граф —
// на узле выставлены channelCount:1 и channelCountMode:'explicit'.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;                 // источник ещё не подключён — ждём
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
