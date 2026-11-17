// Помощник кодировщика (nemo-rs.js): тот же модуль на общей памяти, свой стек,
// вечный helper() — спит, пока главный не раздаст работу.
//
// В цикл входит только по второму сообщению {go}: главный шлёт его, лишь приняв
// помощника. Опоздавший (главный уже снял его по сроку) в счёт HELPERS не
// попадает, иначе par() ждал бы мёртвого вечно.
let e = null;
onmessage = async ({ data }) => {
  if (data.go) {
    if (e) e.helper();
    return;
  }
  const { mod, memory, top } = data;
  const i32 = () => new Int32Array(memory.buffer);
  const env = {
    memory,
    sleep: (p, v) => Atomics.wait(i32(), p >> 2, v),
    wake: (p, n) => Atomics.notify(i32(), p >> 2, n)
  };
  try {
    ({ exports: e } = await WebAssembly.instantiate(mod, { env }));
    e.__stack_pointer.value = top;
  } catch (err) {
    e = null;
    postMessage({ error: String(err?.message || err) });
    return;
  }
  postMessage({ ok: true });
};
