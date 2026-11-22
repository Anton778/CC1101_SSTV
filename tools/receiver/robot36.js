// Декодер режима Robot 36 для формы сигнала штатного передатчика.
const Robot36 = (() => {
  const RATE = 8000;  // Частота отсчётов мгновенной частоты после полосовой фильтрации.
  const WIDTH = 320, HEIGHT = 240;
  const T = ms => Math.round(ms * RATE / 1000);

  // Квадратурный полосовой КИХ-фильтр выделяет основной тон даже у меандра GDO0.
  // Разность фаз двух соседних комплексных отсчётов даёт его частоту в герцах.
  async function demodulate({samples, rate}, progress) {
    const half = Math.ceil(rate * 0.0025), taps = 2 * half + 1;
    const real = new Float64Array(taps), imag = new Float64Array(taps);
    const cutoff = 950 / rate, center = 2 * Math.PI * 1700 / rate;
    for (let j = 0; j < taps; ++j) {
      const k = j - half;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * k / half) + 0.08 * Math.cos(2 * Math.PI * k / half);
      const h = window * (k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k));
      real[j] = h * Math.cos(center * k);
      imag[j] = -h * Math.sin(center * k);
    }
    const count = Math.floor(samples.length * RATE / rate);
    const sum = new Float64Array(count + 1);
    let lastRe = 0, lastIm = 0, lastCenter = 0;
    for (let n = 0; n < count; ++n) {
      const mid = Math.round(n * rate / RATE);
      const start = mid - half;
      let re = 0, im = 0;
      const lo = Math.max(0, -start), hi = Math.min(taps, samples.length - start);
      for (let j = lo; j < hi; ++j) {
        const v = samples[start + j];
        re += real[j] * v;
        im += imag[j] * v;
      }
      let hz = 0;
      if (n && re * re + im * im > 1e-10) {
        const angle = Math.atan2(lastRe * im - lastIm * re, lastRe * re + lastIm * im);
        hz = Math.max(0, angle * rate / (2 * Math.PI * (mid - lastCenter)));
      }
      sum[n + 1] = sum[n] + hz;
      lastRe = re; lastIm = im; lastCenter = mid;
      if (n % 24000 === 0) {
        progress(n / count);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    return sum;  // Префиксная сумма позволяет усреднять частоту на любом интервале.
  }

  function mean(sum, start, end) {
    const a = Math.max(0, Math.min(sum.length - 1, Math.round(start)));
    const b = Math.max(0, Math.min(sum.length - 1, Math.round(end)));
    return b > a ? (sum[b] - sum[a]) / (b - a) : 0;
  }

  // Ищем переход второго тона 1900 Гц в стартовый тон VIS, затем читаем
  // 7 бит младшим вперёд, бит чётности и стоповый тон. У Robot 36 код равен 8.
  function* headers(sum) {
    for (let t = T(550); t + T(300) < sum.length; t += T(2)) {
      const before = mean(sum, t - T(5), t - T(2));
      const after = mean(sum, t + T(2), t + T(5));
      if (before - after < 550) continue;
      const offset = mean(sum, t - T(260), t - T(15)) - 1900;
      if (Math.abs(offset) > 110) continue;
      const at = (ms, halfWidth) => mean(sum, t + T(ms - halfWidth), t + T(ms + halfWidth)) - offset;
      if (Math.abs(at(-450, 20) - 1900) > 65 || Math.abs(at(-305, 2) - 1200) > 100 ||
          Math.abs(at(15, 8) - 1200) > 50 || Math.abs(at(285, 8) - 1200) > 50) continue;
      let vis = 0, parity = 0, valid = true;
      for (let i = 0; i < 8; ++i) {
        const hz = at(45 + 30 * i, 8);
        const bit = hz < 1200 ? 1 : 0;
        if (Math.abs(hz - (bit ? 1100 : 1300)) > 55) valid = false;
        if (i < 7) vis |= bit << i;
        parity ^= bit;
      }
      if (valid && vis === 8 && parity === 0) {
        yield {lineStart: t + T(300), offset};
        t += T(290);
      }
    }
  }

  function readFrame(sum, header) {
    const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const luminance = new Float32Array(2 * WIDTH);
    const chroma = new Float32Array(2 * WIDTH);
    const limit = sum.length - 1;
    let next = header.lineStart, locked = 0;
    function component(begin, length, position, halfWindow) {
      // Фазовая разность относится к середине интервала между двумя отсчётами.
      // Цветность усредняем дольше яркости, чтобы подавить дрожание фронтов GDO0.
      const index = begin + Math.max(halfWindow, Math.min(length - halfWindow, position * length + 1));
      const hz = mean(sum, index - halfWindow, index + halfWindow) - header.offset;
      return Math.max(0, Math.min(255, (hz - 1500) * 255 / 800));
    }
    for (let y = 0; y < HEIGHT; ++y) {
      if (next + T(150) > limit + T(2)) return null;
      // Конец низкого синхроимпульса привязывает каждую строку к своему началу.
      const expected = Math.round(next + T(9));
      let start = next, distance = Infinity;
      for (let j = expected - T(5); j <= expected + T(5); ++j) {
        const previous = mean(sum, j - 2, j) - header.offset;
        const current = mean(sum, j, j + 2) - header.offset;
        if (previous > 1350 || current < 1350) continue;
        if (Math.abs(mean(sum, j - T(5), j - T(1)) - header.offset - 1200) > 100 ||
            mean(sum, j + T(1), j + T(2)) - header.offset < 1360) continue;
        if (Math.abs(expected - j) < distance) {
          distance = Math.abs(expected - j);
          start = j - T(9);
        }
      }
      if (Number.isFinite(distance)) ++locked;
      next = start + T(150);
      const row = y % 2;
      for (let x = 0; x < WIDTH; ++x) {
        const position = (x + 0.5) / WIDTH;
        luminance[row * WIDTH + x] = component(start + T(12), T(88), position, 4);
        chroma[row * WIDTH + x] = component(start + T(106), T(44), position, 7) - 128;
      }
      if (row === 1) {
        for (let k = 0; k < 2 * WIDTH; ++k) {
          const x = k % WIDTH;
          const yy = luminance[k], cr = chroma[x], cb = chroma[WIDTH + x];
          const i = 4 * ((y - 1) * WIDTH + k);
          pixels[i] = yy + 1.402 * cr;
          pixels[i + 1] = yy - 0.344136 * cb - 0.714136 * cr;
          pixels[i + 2] = yy + 1.772 * cb;
          pixels[i + 3] = 255;
        }
      }
    }
    return {pixels, width: WIDTH, height: HEIGHT, locked,
            headerTime: Math.max(0, (header.lineStart - T(910)) / RATE)};
  }

  async function decode(audio, progress = () => {}) {
    const sum = await demodulate(audio, progress);
    let seen = false, incomplete = false;
    for (const header of headers(sum)) {
      seen = true;
      const frame = readFrame(sum, header);
      if (!frame) incomplete = true;
      else if (frame.locked >= 180) return frame;
    }
    if (incomplete) throw Error("Заголовок Robot 36 найден, но запись закончилась до конца кадра. Запишите следующий кадр целиком.");
    if (seen) throw Error("VIS = 8 принят, но слишком мало строчных синхроимпульсов. Проверьте чистую запись.");
    throw Error("Заголовок Robot 36 (VIS = 8) не найден. Начните запись до начала кадра и проверьте канал.");
  }
  return {decode};
})();
