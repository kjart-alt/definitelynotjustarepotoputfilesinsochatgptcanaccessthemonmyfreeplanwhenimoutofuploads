// Кодировщик nemotron на видеокарте — свой, на WebGPU, без ORT: тот же счёт,
// что native/nemo-enc (Rust), в своих шейдерах WGSL.
//
// Веса — int4 пакета как есть (encoder.onnx.data, MatMulNBits): на столбец n и
// блок из 32 k — 16 байт, байт j держит k = 2j в младшем полубайте и 2j + 1 в
// старшем. Слово u32 блока i — это k = 8i..8i+7: маска 0x0F0F0F0F даёт чётные
// k четырьмя байтами, сдвиг на 4 и та же маска — нечётные. Активации квантуются
// по блоку из 32 в int8 (как у Rust) и пакуются в том же порядке: слово чётных
// и слово нечётных. Тогда блок на строку — восемь dot4I8Packed, без распаковки
// в регистры; поправка на нуль весов целочисленная: Σq·(w − z) = Σq·w − z·Σq.
//
// Все веса — один буфер (адреса — в таблице параметров), все промежуточные
// массивы и кеши — второй. Кеши — кольца по абсолютному номеру кадра, как в
// Rust: слот = кадр & (ёмкость − 1); они живут на видеокарте между кусками,
// наружу уходит только выход [T][1024]. Параметры всех проходов записаны один
// раз при загрузке, по 256 байт на проход, и выбираются динамическим смещением
// одной группы привязок; на кусок меняются только T и номер кадра.
//
// Кусок — один проход вычислений и одна отправка: ~510 запусков ядер.

const D = 1024, H = 8, DH = 128, MEL = 128, CTX = 56, PW = 139, MAXT = 14;
const KV = 128, TC = 32, LAYERS = 24, PRE = 256 * 17;
/** Шаг записей параметров: minUniformBufferOffsetAlignment. */
const REC = 256;

const WGSL = /* wgsl */ `
requires packed_4x8_integer_dot_product;

// Поля по ядрам:
//   gemm  k, n; w0 полубайты, w1 шкалы (слова), w2 нули (байт), w3 смещение; a0 выход, ld его шаг
//   quant k; ka — граница склейки: до неё a0 (шаг ld), после — a1 (шаг k − ka)
//   lnq   w0 γ, w1 β; a0 вход, a1 выход
//   attn  w0 позиции, w1 u, w2 v; a0 q, a1 выход, a2 ключи, a3 значения
//   glu   w0 свёртка [c][9]; a0 вход 2D, a1 выход, a2 кольцо
//   dwc, pwc, gw — w0 веса, w1 смещения, a0 вход, a1 выход, k — стадия подвыборки
struct P {
  k: u32, n: u32, ld: u32, ka: u32,
  w0: u32, w1: u32, w2: u32, w3: u32,
  a0: u32, a1: u32, a2: u32, a3: u32,
}
// На кусок: число кадров и номер первого.
struct C { t: u32, n0: u32 }

@group(0) @binding(0) var<storage, read> W4: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> W: array<u32>;
@group(0) @binding(2) var<storage, read_write> A: array<f32>;
@group(0) @binding(3) var<storage, read_write> Q: array<vec4<u32>>;
@group(0) @binding(4) var<uniform> p: P;
@group(0) @binding(5) var<uniform> c: C;

// Q: строка r — 256 векторов пакованных int8, блок b — векторы 2b и 2b + 1
// (чётные и нечётные k вперемежку: e0 d0 e1 d1, e2 d2 e3 d3); дальше на блок
// строки вектор (шкала, Σq) [16][128].
const QM = 4096u;

fn wf(i: u32) -> f32 { return bitcast<f32>(W[i]); }
fn swish(x: f32) -> f32 { return x / (1.0 + exp(-x)); }

// Блок из 32 значений строки r → int8 со шкалой amax/127, чётные и нечётные k порознь.
fn qblock(r: u32, b: u32, v: ptr<function, array<f32, 32>>) {
  var m = 0.0;
  for (var i = 0u; i < 32u; i++) { m = max(m, abs((*v)[i])); }
  let inv = select(0.0, 127.0 / m, m > 0.0);
  var s = vec4<i32>(0);
  var w: array<u32, 8>;
  for (var g = 0u; g < 4u; g++) {
    let e = vec4<i32>(round(vec4((*v)[8u * g], (*v)[8u * g + 2u], (*v)[8u * g + 4u], (*v)[8u * g + 6u]) * inv));
    let d = vec4<i32>(round(vec4((*v)[8u * g + 1u], (*v)[8u * g + 3u], (*v)[8u * g + 5u], (*v)[8u * g + 7u]) * inv));
    s += e + d;
    w[2u * g] = pack4xI8(e);
    w[2u * g + 1u] = pack4xI8(d);
  }
  Q[r * 256u + 2u * b] = vec4(w[0], w[1], w[2], w[3]);
  Q[r * 256u + 2u * b + 1u] = vec4(w[4], w[5], w[6], w[7]);
  Q[QM + r * 128u + b] = vec4(bitcast<u32>(m / 127.0), bitcast<u32>(s.x + s.y + s.z + s.w), 0u, 0u);
}

// Строка r, по блоку на нить; хвост одной строки может приходить из второго массива.
@compute @workgroup_size(128)
fn quant(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) b: u32) {
  let r = wid.x;
  if (b >= p.k >> 5u) { return; }
  var v: array<f32, 32>;
  let k0 = b * 32u;
  if (k0 < p.ka) {
    let o = p.a0 + r * p.ld + k0;
    for (var i = 0u; i < 32u; i++) { v[i] = A[o + i]; }
  } else {
    let o = p.a1 + r * (p.k - p.ka) + k0 - p.ka;
    for (var i = 0u; i < 32u; i++) { v[i] = A[o + i]; }
  }
  qblock(r, b, &v);
}

// ---- LayerNorm (+ swish) → квант и/или f32 ----
override SWISH = false;
override STORE = false;
override QUANT = true;
var<workgroup> red: array<f32, 256>;
var<workgroup> ys: array<f32, 1024>;

fn wsum(v: f32, l: u32) -> f32 {
  red[l] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (l < s) { red[l] += red[l + s]; }
    workgroupBarrier();
  }
  let t = red[0];
  workgroupBarrier();
  return t;
}

@compute @workgroup_size(256)
fn lnq(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  let r = wid.x;
  let src = p.a0 + r * 1024u;
  let x = vec4(A[src + l], A[src + l + 256u], A[src + l + 512u], A[src + l + 768u]);
  let d = x - vec4(wsum(x.x + x.y + x.z + x.w, l) / 1024.0);
  let inv = inverseSqrt(wsum(dot(d, d), l) / 1024.0 + 1e-5);
  for (var i = 0u; i < 4u; i++) {
    let k = l + 256u * i;
    var y = d[i] * inv * wf(p.w0 + k) + wf(p.w1 + k);
    if (SWISH) { y = swish(y); }
    if (STORE) { A[p.a1 + r * 1024u + k] = y; }
    ys[k] = y;
  }
  if (QUANT) {
    workgroupBarrier();
    if (l < 32u) {
      var v: array<f32, 32>;
      for (var i = 0u; i < 32u; i++) { v[i] = ys[32u * l + i]; }
      qblock(r, l, &v);
    }
  }
}

// ---- int4 × int8 ----
// Нить ведёт CPT столбцов по одному блоку k за шаг, KL нитей делят k столбца.
// Строк — всегда четвёрка (плитка по y): лишние строки Q считаются вхолостую
// и не пишутся, зато все индексы постоянные и активации блока — три вектора
// на строку, общие для всех столбцов нити.
// MODE — что делать с суммой: 0 запись, 1 swish, 2 x += v/2, 3 x += v,
// 4 кольцо ключей/значений, 5 ReLU(v + b), 6 v + b.
override MODE = 0u;
override CPT = 1u;
override KL = 8u;
override WG = 64u;
var<workgroup> part: array<vec4<f32>, 256>;

// Блок одной строки на блок весов: восемь точек int8×int8 по четыре.
fn dot8(a: vec4<u32>, b: vec4<u32>, lo: vec4<u32>, hi: vec4<u32>) -> i32 {
  return dot4I8Packed(a.x, lo.x) + dot4I8Packed(a.y, hi.x) + dot4I8Packed(a.z, lo.y) + dot4I8Packed(a.w, hi.y)
       + dot4I8Packed(b.x, lo.z) + dot4I8Packed(b.y, hi.z) + dot4I8Packed(b.z, lo.w) + dot4I8Packed(b.w, hi.w);
}

@compute @workgroup_size(WG)
fn gemm(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  let lane = l & (KL - 1u);
  let cg = l / KL;
  let col0 = (wid.x * (WG / KL) + cg) * CPT;
  let r0 = wid.y * 4u;
  let nb = p.k >> 5u;
  let zrow = (nb + 1u) >> 1u;
  let m4 = vec4(0x0F0F0F0Fu);
  var acc: array<vec4<f32>, 4>;
  for (var b = lane; b < nb; b += KL) {
    let xo = r0 * 256u + 2u * b;
    let x0 = Q[xo]; let x1 = Q[xo + 1u];
    let x2 = Q[xo + 256u]; let x3 = Q[xo + 257u];
    let x4 = Q[xo + 512u]; let x5 = Q[xo + 513u];
    let x6 = Q[xo + 768u]; let x7 = Q[xo + 769u];
    let mo = QM + r0 * 128u + b;
    let m0 = Q[mo]; let m1 = Q[mo + 128u]; let m2 = Q[mo + 256u]; let m3 = Q[mo + 384u];
    let xs = bitcast<vec4<f32>>(vec4(m0.x, m1.x, m2.x, m3.x));
    let xn = bitcast<vec4<i32>>(vec4(m0.y, m1.y, m2.y, m3.y));
    for (var j = 0u; j < CPT; j++) {
      let col = col0 + j;
      let w = W4[(p.w0 >> 2u) + col * nb + b];
      let lo = w & m4;
      let hi = (w >> vec4(4u)) & m4;
      let s = wf(p.w1 + col * nb + b);
      let zi = p.w2 + col * zrow + (b >> 1u);
      let z = i32((W[zi >> 2u] >> (((zi & 3u) << 3u) | ((b & 1u) << 2u))) & 15u);
      let ia = vec4(dot8(x0, x1, lo, hi), dot8(x2, x3, lo, hi), dot8(x4, x5, lo, hi), dot8(x6, x7, lo, hi));
      acc[j] += s * xs * vec4<f32>(ia - z * xn);
    }
  }
  for (var j = 0u; j < CPT; j++) { part[l * CPT + j] = acc[j]; }
  workgroupBarrier();
  for (var s = KL >> 1u; s > 0u; s >>= 1u) {
    if (lane < s) {
      for (var j = 0u; j < CPT; j++) { part[l * CPT + j] += part[(l + s) * CPT + j]; }
    }
    workgroupBarrier();
  }
  // CPT × 4 сумм полосы — нитям полосы, по одной.
  for (var o = lane; o < CPT * 4u; o += KL) {
    let r = r0 + (o & 3u);
    if (r >= c.t) { continue; }
    let col = col0 + (o >> 2u);
    let v = part[(l - lane) * CPT + (o >> 2u)][o & 3u];
    let i = p.a0 + r * p.ld + col;
    if (MODE == 0u) { A[i] = v; }
    else if (MODE == 1u) { A[i] = swish(v); }
    else if (MODE == 2u) { A[i] += 0.5 * v; }
    else if (MODE == 3u) { A[i] += v; }
    else if (MODE == 4u) { A[p.a0 + ((c.n0 + r) & ${KV - 1}u) * 1024u + col] = v; }
    else if (MODE == 5u) { A[i] = max(v + wf(p.w3 + col), 0.0); }
    else { A[i] = v + wf(p.w3 + col); }
  }
}

// ---- внимание с относительными позициями: группа на (голова, запрос) ----
// счёт_j = ((q + u)·k_j + (q + v)·P[h][·][13 − i + j]) / √128, ключи — 56 + T
// кадров из кольца, начиная с n0 − 56.
var<workgroup> qu: array<f32, 128>;
var<workgroup> qv: array<f32, 128>;
var<workgroup> sc: array<f32, 128>;
var<workgroup> sp: array<f32, 256>;

@compute @workgroup_size(256)
fn attn(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  let h = wid.x;
  let i = wid.y;
  let lk = ${CTX}u + c.t;
  let a0 = c.n0 - ${CTX}u;
  let d = l & 127u;
  if (l < 128u) {
    let q = A[p.a0 + i * 1024u + h * 128u + d];
    qu[d] = q + wf(p.w1 + h * 128u + d);
    qv[d] = q + wf(p.w2 + h * 128u + d);
  }
  workgroupBarrier();
  // Счёт ключа j — четвёрке соседних нитей: нить берёт e ≡ l (mod 4), так
  // четвёрка читает строку ключа подряд, а суммы сходятся через sp.
  let e0 = l & 3u;
  for (var jb = 0u; jb < lk; jb += 64u) {
    let j = jb + (l >> 2u);
    var s = 0.0;
    if (j < lk) {
      let kp = p.a2 + ((a0 + j) & ${KV - 1}u) * 1024u + h * 128u;
      let pp = p.w0 + h * ${DH * PW}u + 13u - i + j;
      for (var e = e0; e < 128u; e += 4u) { s += qu[e] * A[kp + e] + qv[e] * wf(pp + e * ${PW}u); }
    }
    sp[l] = s;
    workgroupBarrier();
    if (e0 == 0u && j < lk) { sc[j] = (sp[l] + sp[l + 1u] + sp[l + 2u] + sp[l + 3u]) * ${1 / Math.sqrt(DH)}; }
    workgroupBarrier();
  }
  let j = l;
  workgroupBarrier();
  var mx = sc[0];
  for (var k = 1u; k < lk; k++) { mx = max(mx, sc[k]); }
  workgroupBarrier();
  if (j < lk) { sc[j] = exp(sc[j] - mx); }
  workgroupBarrier();
  if (l >= 128u) { return; }
  var sum = 0.0;
  var o = 0.0;
  for (var k = 0u; k < lk; k++) {
    sum += sc[k];
    o += sc[k] * A[p.a3 + ((a0 + k) & ${KV - 1}u) * 1024u + h * 128u + d];
  }
  A[p.a1 + i * 1024u + h * 128u + d] = o / sum;
}

// ---- GLU → кольцо по времени → глубинная свёртка k = 9: нить на канал ----
@compute @workgroup_size(256)
fn glu(@builtin(global_invocation_id) g: vec3<u32>) {
  let ch = g.x;
  for (var r = 0u; r < c.t; r++) {
    let a = A[p.a0 + r * 2048u + ch];
    let b = A[p.a0 + r * 2048u + 1024u + ch];
    A[p.a2 + ((c.n0 + r) & ${TC - 1}u) * 1024u + ch] = a / (1.0 + exp(-b));
  }
  for (var r = 0u; r < c.t; r++) {
    var s = 0.0;
    for (var k = 0u; k < 9u; k++) {
      s += wf(p.w0 + ch * 9u + k) * A[p.a2 + ((c.n0 + r + k - 8u) & ${TC - 1}u) * 1024u + ch];
    }
    A[p.a1 + r * 1024u + ch] = s;
  }
}

// ---- подвыборка ×8 ----
// Размер плоскости после s свёрток с шагом 2: (9 + 8T) × 128 → h/2 + 1 × w/2 + 1.
fn dims(s: u32) -> vec2<u32> {
  var v = vec2(9u + 8u * c.t, 128u);
  for (var i = 0u; i < s; i++) { v = v / 2u + 1u; }
  return v;
}

// Глубинная 3×3 с шагом 2, поля 2 сверху/слева и 1 снизу/справа; стадия 0 —
// один вход на все 256 каналов и ReLU.
@compute @workgroup_size(64)
fn dwc(@builtin(global_invocation_id) g: vec3<u32>) {
  let hw = dims(p.k);
  let o = hw / 2u + 1u;
  let i = g.x + g.y * 65535u * 64u;
  if (i >= 256u * o.x * o.y) { return; }
  let ch = i / (o.x * o.y);
  let t = (i / o.y) % o.x;
  let f = i % o.y;
  let src = p.a0 + select(ch * hw.x * hw.y, 0u, p.k == 0u);
  var a = wf(p.w1 + ch);
  for (var dy = 0u; dy < 3u; dy++) {
    let y = 2u * t + dy - 2u;
    if (y >= hw.x) { continue; }
    for (var dx = 0u; dx < 3u; dx++) {
      let x = 2u * f + dx - 2u;
      if (x < hw.y) { a += wf(p.w0 + ch * 9u + dy * 3u + dx) * A[src + y * hw.y + x]; }
    }
  }
  if (p.k == 0u) { a = max(a, 0.0); }
  A[p.a1 + i] = a;
}

// 1×1 256 → 256 + смещение + ReLU по плоскостям [256][h·w] стадии k.
@compute @workgroup_size(64)
fn pwc(@builtin(global_invocation_id) g: vec3<u32>) {
  // Нить: восемь выходных каналов в одной точке — чтение входа на восемь умножений.
  let hw = dims(p.k);
  let np = hw.x * hw.y;
  let i = g.x;
  if (i >= 32u * np) { return; }
  let c0 = (i / np) * 8u;
  let pp = i % np;
  var a0 = bitcast<vec4<f32>>(W4[(p.w1 + c0) >> 2u]);
  var a1 = bitcast<vec4<f32>>(W4[(p.w1 + c0 + 4u) >> 2u]);
  for (var ci = 0u; ci < 256u; ci++) {
    let x = A[p.a0 + ci * np + pp];
    let w = p.w0 + c0 * 256u + ci;
    a0 += x * vec4(wf(w), wf(w + 256u), wf(w + 512u), wf(w + 768u));
    a1 += x * vec4(wf(w + 1024u), wf(w + 1280u), wf(w + 1536u), wf(w + 1792u));
  }
  a0 = max(a0, vec4(0.0));
  a1 = max(a1, vec4(0.0));
  let o = p.a1 + c0 * np + pp;
  A[o] = a0.x; A[o + np] = a0.y; A[o + 2u * np] = a0.z; A[o + 3u * np] = a0.w;
  A[o + 4u * np] = a1.x; A[o + 5u * np] = a1.y; A[o + 6u * np] = a1.z; A[o + 7u * np] = a1.w;
}

// [256][h3][17] → кадры tt + 2 (первые два граф отрезает) → 4352 → 1024 в f32.
// 32 столбца на группу, 8 полос по каналам, сумма полос через общую память.
@compute @workgroup_size(256)
fn gw(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  // Нить: четыре соседних столбца (один vec4 весов) × четыре строки плитки;
  // 32 доли каналов складываются деревом в part.
  let col = wid.x * 32u + (l & 7u) * 4u;
  let sl = l >> 3u;
  let r0 = wid.y * 4u;
  let h3 = dims(3u).x;
  var acc: array<vec4<f32>, 4>;
  for (var ch = sl; ch < 256u; ch += 32u) {
    let base = p.a0 + (ch * h3 + 2u + r0) * 17u;
    for (var f = 0u; f < 17u; f++) {
      let w = bitcast<vec4<f32>>(W4[(p.w0 + (ch * 17u + f) * 1024u + col) >> 2u]);
      acc[0] += w * A[base + f];
      acc[1] += w * A[base + 17u + f];
      acc[2] += w * A[base + 34u + f];
      acc[3] += w * A[base + 51u + f];
    }
  }
  for (var r = 0u; r < 4u; r++) {
    part[l] = acc[r];
    workgroupBarrier();
    for (var s = 128u; s >= 8u; s >>= 1u) {
      if (l < s) { part[l] += part[l + s]; }
      workgroupBarrier();
    }
    if (l < 8u && r0 + r < c.t) {
      let o = p.a1 + (r0 + r) * 1024u + col;
      let v = part[l] + bitcast<vec4<f32>>(W4[(p.w1 + col) >> 2u]);
      A[o] = v.x; A[o + 1u] = v.y; A[o + 2u] = v.z; A[o + 3u] = v.w;
    }
    workgroupBarrier();
  }
}
`;

/**
 * Видеокарта и модуль шейдеров; из них — кодировщик под видом сессии ORT.
 *
 * @param {object=} o
 * @param {GPUDevice=} o.device готовое устройство (иначе своё, с лимитами адаптера)
 * @param {Function=} o.tune (k, MODE) → {CPT, KL, WG} умножения, для подбора на стенде
 */
export async function gpuEngine({ device, tune } = {}) {
  if (!device) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('GPU encoder: no WebGPU adapter');
    if (!navigator.gpu.wgslLanguageFeatures.has('packed_4x8_integer_dot_product')) throw new Error('GPU encoder: no packed int8 dot product');
    const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
    // Метки времени — только для profile(); без них ядро то же.
    // Метки времени — только для profile(); без них ядро то же.
    const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    device = await adapter.requestDevice({ requiredFeatures, requiredLimits: { maxBufferSize, maxStorageBufferBindingSize } });
  }
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === 'error');
  if (errs.length) throw new Error('GPU encoder: ' + errs.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));

  const S = GPUBufferUsage.STORAGE, U = GPUBufferUsage.UNIFORM, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
  const layout = device.createBindGroupLayout({
    entries: [
      ...[0, 1].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } })),
      ...[2, 3].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } })),
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (entryPoint, constants) =>
    device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint, constants } });

  return {
    device,

    /**
     * Кодировщик: run() с входами и выходами графа. Кеши на видеокарте; наружу
     * вместо них — метка, и если на вход пришла не наша последняя метка (новый
     * поток), кольца обнуляются.
     *
     * @param {ArrayBuffer|Uint8Array} src encoder.onnx.data — int4-веса пакета
     * @param {ArrayBuffer|Uint8Array} extra encoder-cpu.extra
     * @param {{table: number[]}} layout encoder-rs.json (native/nemo-enc/tools/layout.py)
     */
    async encoder({ src, extra, layout: { table } }) {
      const bytes = (b) => b instanceof Uint8Array ? b : new Uint8Array(b);
      const [s8, e8] = [bytes(src), bytes(extra)];
      // Веса: по таблице в порядке Rust (init), каждый тензор — по границе 256 байт.
      const parts = [];
      let wAt = 0;
      const put = (at, n) => {
        const o = wAt;
        parts.push([at, n, o]);
        wAt = (o + n + 255) & ~255;
        return o;
      };
      let ti = 0;
      const u = () => {
        if (ti >= table.length) throw new Error('GPU encoder: table too short');
        return table[ti++];
      };
      const f = (n) => {
        const at = u();
        if (u() !== n) throw new Error('GPU encoder: bad weights');
        return put(at, n * 4) >> 2;
      };
      const ln = () => [f(D), f(D)];
      const q = (k, n) => {
        const [qa, sa, za] = [u(), u(), u()];
        if (u() !== k || u() !== n) throw new Error('GPU encoder: bad weights');
        const nb = k >> 5;
        return { q: put(qa, n * nb * 16) >> 2, s: put(sa, n * nb * 4) >> 2, z: put(za, n * ((nb + 1) >> 1)), k, n };
      };
      if (u() !== 0x4E454D4F || u() !== 1) throw new Error('GPU encoder: bad weights table');
      const cw = [], cb = [];
      for (const cin of [1, 1, 256, 1, 256]) {
        cw.push(f(256 * cin * (cin === 1 ? 9 : 1)));
        cb.push(f(256));
      }
      const gwW = f(PRE * D), gbW = f(D);
      const p1 = q(D + MEL, 2048), b1 = f(2048), p2 = q(2048, D), b2 = f(D);
      const L = [];
      for (let i = 0; i < LAYERS; i++) {
        L.push({
          ff1n: ln(), ff1a: q(D, 4096), ff1b: q(4096, D),
          attn: ln(), wq: q(D, D), wk: q(D, D), wv: q(D, D), wo: q(D, D), pu: f(D), pv: f(D), pos: f(H * DH * PW),
          convn: ln(), pw1: q(D, 2 * D), dw: f(D * 9), bnn: ln(), pw2: q(D, D),
          ff2n: ln(), ff2a: q(D, 4096), ff2b: q(4096, D), outn: ln()
        });
      }
      if (ti !== table.length) throw new Error('GPU encoder: bad weights table');

      const wbuf = device.createBuffer({ size: wAt, usage: S, mappedAtCreation: true });
      {
        const m = new Uint8Array(wbuf.getMappedRange());
        for (const [at, n, o] of parts) {
          const [b, a] = at < s8.length ? [s8, at] : [e8, at - s8.length];
          m.set(b.subarray(a, a + n), o);
        }
        wbuf.unmap();
      }

      // Рабочие массивы, f32: вход, слои, плоскости подвыборки, кольца.
      let aAt = 0;
      const take = (n) => { const o = aAt; aAt += (n + 63) & ~63; return o; };
      const SIG = take((9 + 8 * MAXT) * MEL), OH = take(MAXT * MEL);
      const X = take(MAXT * D), Hb = take(MAXT * D), QB = take(MAXT * D), ATT = take(MAXT * D);
      const BIG = take(MAXT * 4096), OUT = take(MAXT * D);
      const PA = take(256 * 61 * 65), PB = take(256 * 31 * 33);
      const RING = aAt;
      const rings = L.map(() => ({ kr: take(KV * D), vr: take(KV * D), tr: take(TC * D) }));
      const abuf = device.createBuffer({ size: aAt * 4, usage: S | CD | CS });
      const qbuf = device.createBuffer({ size: (4096 + 2048) * 16, usage: S });
      const cbuf = device.createBuffer({ size: 16, usage: U | CD });
      const rbuf = device.createBuffer({ size: MAXT * D * 4, usage: GPUBufferUsage.MAP_READ | CD });

      // Ядра и план прохода: запись параметров на запуск, сетка — от T.
      const P = {
        quant: pipe('quant'), attn: pipe('attn'), glu: pipe('glu'), dwc: pipe('dwc'), pwc: pipe('pwc'), gw: pipe('gw'),
        lnq: pipe('lnq'), lnqs: pipe('lnq', { SWISH: 1 }), lns: pipe('lnq', { STORE: 1, QUANT: 0 })
      };
      for (const k in P) P[k] = await P[k];
      // Умножения — по ядру на (MODE, CPT, KL); на Iris Xe лучше всех 1 × 8.
      const GEMM = new Map();
      const gpipe = async (MODE, k) => {
        const o = { MODE, CPT: 1, KL: 8, WG: 64, ...tune?.(k, MODE) };
        const key = JSON.stringify(o);
        if (!GEMM.has(key)) GEMM.set(key, await pipe('gemm', o));
        return [GEMM.get(key), o];
      };

      const plan = [];
      const recs = [];
      let tag = '';
      const kind = new Map(Object.entries(P).map(([k, v]) => [v, k]));
      const run = (pl, grid, f, name = kind.get(pl)) => {
        const r = new Uint32Array(REC >> 2);
        for (const k in f) r[FIELDS[k]] = f[k];
        plan.push({ pl, grid, off: recs.length * REC, tag, name });
        recs.push(r);
      };
      const rowsOf = (t) => [t];
      const gemm = async (w, mode, a0, ld, w3 = 0) => {
        const [pl, { CPT, KL, WG }] = await gpipe(mode, w.k);
        run(pl, (t) => [w.n / (WG / KL * CPT), (t + 3) >> 2], { k: w.k, n: w.n, w0: w.q, w1: w.s, w2: w.z, w3, a0, ld }, `gemm${w.k}x${w.n}`);
      };
      const quant = (a0, k, ld = k, a1 = 0, ka = k) => run(P.quant, rowsOf, { k, ka, a0, a1, ld });
      const lnq = (pl, [g, b], a0, a1 = 0) => run(pl, rowsOf, { w0: g, w1: b, a0, a1 });
      const dims = (t, s) => { let h = 9 + 8 * t, w = 128; while (s--) { h = (h >> 1) + 1; w = (w >> 1) + 1; } return [h, w]; };
      const cells = (t, s, ch = 256) => { const [h, w] = dims(t, s); return Math.ceil(ch * h * w / 64); };

      tag = 'pre';
      // Подвыборка: мел → [256][h1][65] → [256][h2][33] → 1×1 → [256][h3][17] → 1×1 → 4352 → 1024.
      run(P.dwc, (t) => [cells(t, 1)], { k: 0, w0: cw[0], w1: cb[0], a0: SIG, a1: PA });
      run(P.dwc, (t) => [cells(t, 2)], { k: 1, w0: cw[1], w1: cb[1], a0: PA, a1: PB });
      run(P.pwc, (t) => [cells(t, 2, 32)], { k: 2, w0: cw[2], w1: cb[2], a0: PB, a1: PA });
      run(P.dwc, (t) => [cells(t, 3)], { k: 2, w0: cw[3], w1: cb[3], a0: PA, a1: PB });
      run(P.pwc, (t) => [cells(t, 3, 32)], { k: 3, w0: cw[4], w1: cb[4], a0: PB, a1: PA });
      run(P.gw, (t) => [D / 32, (t + 3) >> 2], { w0: gwW, w1: gbW, a0: PA, a1: X });
      for (let i = 0; i < LAYERS; i++) {
        const l = L[i], r = rings[i];
        // FF1, полшага
        tag = 'ff';
        lnq(P.lnq, l.ff1n, X);
        await gemm(l.ff1a, 1, BIG, 4096);
        quant(BIG, 4096);
        await gemm(l.ff1b, 2, X, D);
        // Внимание: новые ключи и значения — сразу в кольца.
        tag = 'qkv';
        lnq(P.lnq, l.attn, X);
        await gemm(l.wq, 0, QB, D);
        await gemm(l.wk, 4, r.kr, D);
        await gemm(l.wv, 4, r.vr, D);
        tag = 'attn';
        run(P.attn, (t) => [H, t], { w0: l.pos, w1: l.pu, w2: l.pv, a0: QB, a1: ATT, a2: r.kr, a3: r.vr });
        tag = 'wo';
        quant(ATT, D);
        await gemm(l.wo, 3, X, D);
        // Свёртка: GLU → кольцо → глубинная k = 9 → LN → swish → 1×1.
        tag = 'conv';
        lnq(P.lnq, l.convn, X);
        await gemm(l.pw1, 0, BIG, 2 * D);
        run(P.glu, () => [D / 256], { w0: l.dw, a0: BIG, a1: Hb, a2: r.tr });
        lnq(P.lnqs, l.bnn, Hb);
        await gemm(l.pw2, 3, X, D);
        // FF2, полшага
        tag = 'ff';
        lnq(P.lnq, l.ff2n, X);
        await gemm(l.ff2a, 1, BIG, 4096);
        quant(BIG, 4096);
        await gemm(l.ff2b, 2, X, D);
        lnq(P.lns, l.outn, X, X);
      }
      // Хвост: [x ‖ язык] → 2048 → ReLU → 1024.
      tag = 'tail';
      quant(X, D + MEL, D, OH, D);
      await gemm(p1, 5, BIG, 2048, b1);
      quant(BIG, 2048);
      await gemm(p2, 6, OUT, D, b2);

      const pbuf = device.createBuffer({ size: recs.length * REC, usage: U | CD });
      const all = new Uint32Array(recs.length * (REC >> 2));
      recs.forEach((r, i) => all.set(r, i * (REC >> 2)));
      device.queue.writeBuffer(pbuf, 0, all);
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: wbuf } }, { binding: 1, resource: { buffer: wbuf } },
          { binding: 2, resource: { buffer: abuf } }, { binding: 3, resource: { buffer: qbuf } },
          { binding: 4, resource: { buffer: pbuf, size: 48 } }, { binding: 5, resource: { buffer: cbuf } }
        ]
      });

      let mark = null;
      let frame = 0;
      return {
        inputNames: ['audio_signal', 'cache_last_channel', 'cache_last_time', 'lang_onehot'],
        /** Запусков ядер на кусок. */
        dispatches: plan.length,
        async run(feeds, prof) {
          const T = feeds.lang_onehot.dims[1];
          if (T < 1 || T > MAXT) throw new Error(`GPU encoder: T=${T}`);
          const t0 = performance.now();
          const enc = device.createCommandEncoder();
          const qs = prof && device.createQuerySet({ type: 'timestamp', count: 2 * plan.length });
          if (feeds.cache_last_channel !== mark) {
            enc.clearBuffer(abuf, RING * 4, (aAt - RING) * 4);
            frame = 0;
          }
          const qu = device.queue;
          qu.writeBuffer(cbuf, 0, new Uint32Array([T, frame, 0, 0]));
          qu.writeBuffer(abuf, SIG * 4, feeds.audio_signal.data, 0, (9 + 8 * T) * MEL);
          qu.writeBuffer(abuf, OH * 4, feeds.lang_onehot.data, 0, T * MEL);
          let pass = !qs && enc.beginComputePass();
          for (const [i, { pl, grid, off }] of plan.entries()) {
            if (qs) pass = enc.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } });
            pass.setPipeline(pl);
            pass.setBindGroup(0, group, [off]);
            const [x, y = 1] = grid(T);
            if (x > 65535) pass.dispatchWorkgroups(65535, Math.ceil(x / 65535));
            else pass.dispatchWorkgroups(x, y);
            if (qs) pass.end();
          }
          if (!qs) pass.end();
          enc.copyBufferToBuffer(abuf, OUT * 4, rbuf, 0, T * D * 4);
          let tb;
          if (qs) {
            const n = 16 * plan.length;
            const rs = device.createBuffer({ size: n, usage: GPUBufferUsage.QUERY_RESOLVE | CS });
            tb = device.createBuffer({ size: n, usage: GPUBufferUsage.MAP_READ | CD });
            enc.resolveQuerySet(qs, 0, 2 * plan.length, rs, 0);
            enc.copyBufferToBuffer(rs, 0, tb, 0, n);
          }
          qu.submit([enc.finish()]);
          if (prof) prof.cpu = performance.now() - t0;
          if (tb) {
            // Профиль: мкс по меткам проходов, суммой по группам ядер.
            await tb.mapAsync(GPUMapMode.READ);
            const ts = new BigInt64Array(tb.getMappedRange());
            prof.by = {};
            prof.kind = {};
            plan.forEach(({ tag, name }, i) => {
              const us = Number(ts[2 * i + 1] - ts[2 * i]) / 1e3;
              prof.by[tag] = (prof.by[tag] ?? 0) + us;
              prof.kind[name] = (prof.kind[name] ?? 0) + us;
            });
            tb.unmap();
          }
          frame = (frame + T) >>> 0;
          await rbuf.mapAsync(GPUMapMode.READ, 0, T * D * 4);
          const out = new Float32Array(rbuf.getMappedRange(0, T * D * 4)).slice();
          rbuf.unmap();
          mark = { dispose() {} };
          return {
            outputs: { dims: [1, T, D], getData: async () => out },
            cache_last_channel_next: mark,
            cache_last_time_next: mark
          };
        }
      };
    }
  };
}

/** Номера полей записи P (порядок — как в struct P шейдера). */
const FIELDS = Object.fromEntries(['k', 'n', 'ld', 'ka', 'w0', 'w1', 'w2', 'w3', 'a0', 'a1', 'a2', 'a3'].map((k, i) => [k, i]));
