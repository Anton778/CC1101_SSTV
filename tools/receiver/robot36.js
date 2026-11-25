// Robot 36. Один декодер обрабатывает поток USB и звуковые файлы.
const Robot36 = (() => {
  const RATE = 8000;
  const WIDTH = 320, HEIGHT = 240;
  const T = ms => Math.round(ms * RATE / 1000);

  function headerAt(mean, t) {
    const before = mean(t - T(5), t - T(2));
    const after = mean(t + T(2), t + T(5));
    if (before - after < 550) return null;
    const offset = mean(t - T(260), t - T(15)) - 1900;
    if (Math.abs(offset) > 110) return null;
    const at = (ms, halfWidth) => mean(t + T(ms - halfWidth), t + T(ms + halfWidth)) - offset;
    if (Math.abs(at(-450, 20) - 1900) > 65 || Math.abs(at(-305, 2) - 1200) > 100 ||
        Math.abs(at(15, 8) - 1200) > 50 || Math.abs(at(285, 8) - 1200) > 50) return null;
    let vis = 0, parity = 0, valid = true;
    for (let i = 0; i < 8; ++i) {
      const hz = at(45 + 30 * i, 8);
      const bit = hz < 1200 ? 1 : 0;
      if (Math.abs(hz - (bit ? 1100 : 1300)) > 55) valid = false;
      if (i < 7) vis |= bit << i;
      parity ^= bit;
    }
    return valid && vis === 8 && parity === 0 ? {lineStart: t + T(300), offset} : null;
  }

  function frameReader(mean, header, handlers) {
    const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const frame = {width: WIDTH, height: HEIGHT, pixels, rows: 0, locked: 0,
                   headerTime: Math.max(0, (header.lineStart - T(910)) / RATE)};
    const luminance = new Float32Array(2 * WIDTH), chroma = new Float32Array(2 * WIDTH);
    let next = header.lineStart;
    handlers.onHeader?.(frame);
    function component(begin, length, position, halfWindow) {
      // Фазовая разность относится к середине интервала между двумя отсчётами.
      // Цветность усредняем дольше яркости, чтобы подавить дрожание фронтов GDO0.
      const index = begin + Math.max(halfWindow, Math.min(length - halfWindow, position * length + 1));
      const hz = mean(index - halfWindow, index + halfWindow) - header.offset;
      return Math.max(0, Math.min(255, (hz - 1500) * 255 / 800));
    }
    function readLine() {
      const y = frame.rows;
      // Конец низкого синхроимпульса привязывает каждую строку к своему началу.
      const expected = Math.round(next + T(9));
      let start = next, distance = Infinity;
      for (let j = expected - T(5); j <= expected + T(5); ++j) {
        const previous = mean(j - 2, j) - header.offset;
        const current = mean(j, j + 2) - header.offset;
        if (previous > 1350 || current < 1350) continue;
        if (Math.abs(mean(j - T(5), j - T(1)) - header.offset - 1200) > 100 ||
            mean(j + T(1), j + T(2)) - header.offset < 1360) continue;
        if (Math.abs(expected - j) < distance) {
          distance = Math.abs(expected - j);
          start = j - T(9);
        }
      }
      if (Number.isFinite(distance)) ++frame.locked;
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
      ++frame.rows;
      if (row === 1) handlers.onRows?.(frame, y - 1);
    }
    return {
      frame,
      advance(end, final) {
        while (frame.rows < HEIGHT && next + T(final ? 148 : 155) <= end) readLine();
        return frame.rows === HEIGHT;
      }
    };
  }

  function stream(rate, handlers = {}) {
    if (!(rate >= 8000 && rate <= 96000)) throw Error("Частота дискретизации должна быть от 8 до 96 кГц.");
    // Квадратурный полосовой КИХ-фильтр выделяет основной тон даже у меандра GDO0.
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
    const samples = new Float32Array(2 * taps);
    // Скользящая префиксная сумма. Двух секунд достаточно для VIS и одной строки.
    const sums = new Float64Array(16384), mask = sums.length - 1;
    let end = 0, total = 0, cursor = T(550), current = null;
    let input = 0, write = 0, mid = 0, lastMid = 0, lastRe = 0, lastIm = 0;
    let ended = false;
    function mean(start, stop) {
      const oldest = Math.max(0, end - mask);
      const a = Math.max(oldest, Math.min(end, Math.round(start)));
      const b = Math.max(oldest, Math.min(end, Math.round(stop)));
      return b > a ? (sums[b & mask] - sums[a & mask]) / (b - a) : 0;
    }
    function advance(final = false) {
      while (cursor + T(300) <= end) {
        const header = headerAt(mean, cursor);
        cursor += T(2);
        if (header) {
          if (current) handlers.onLost?.(current.frame);
          current = frameReader(mean, header, handlers);
          cursor += T(290);
        }
      }
      if (current && current.advance(end, final)) {
        if (current.frame.locked >= 180) handlers.onFrame?.(current.frame);
        else handlers.onLost?.(current.frame);
        current = null;
      }
    }
    function sample(value) {
      samples[write] = samples[write + taps] = value;
      if (++write === taps) write = 0;
      if (input++ !== mid + half) return;
      let re = 0, im = 0;
      for (let j = 0; j < taps; ++j) {
        const v = samples[write + j];
        re += real[j] * v;
        im += imag[j] * v;
      }
      if (end && re * re + im * im > 1e-10) {
        const angle = Math.atan2(lastRe * im - lastIm * re, lastRe * re + lastIm * im);
        total += Math.max(0, angle * rate / (2 * Math.PI * (mid - lastMid)));
      }
      sums[++end & mask] = total;
      lastRe = re;
      lastIm = im;
      lastMid = mid;
      mid = Math.round(end * rate / RATE);
      if (end % 400 === 0) advance();
    }
    return {
      push(chunk) {
        if (ended) throw Error("Приём завершён.");
        for (const value of chunk) sample(value);
        advance();
      },
      finish() {
        if (ended) return;
        ended = true;
        const target = Math.floor(input * RATE / rate);
        while (end < target) sample(0);
        advance(true);
        if (current) handlers.onLost?.(current.frame);
      }
    };
  }

  async function decode({samples, rate}, progress = () => {}) {
    let result, seen = false, partial = false;
    const decoder = stream(rate, {
      onHeader() { seen = true; },
      onFrame(frame) { result ??= frame; },
      onLost(frame) { if (frame.rows < HEIGHT) partial = true; }
    });
    for (let index = 0; index < samples.length && !result; index += rate) {
      decoder.push(samples.subarray(index, index + rate));
      progress(Math.min(1, (index + rate) / samples.length));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    decoder.finish();
    if (result) return result;
    if (partial) throw Error("Заголовок Robot 36 найден, но запись закончилась до конца кадра.");
    if (seen) throw Error("VIS = 8 принят, но слишком мало строчных синхроимпульсов.");
    throw Error("Заголовок Robot 36 (VIS = 8) не найден. Включите приём перед началом кадра.");
  }
  return {decode, stream};
})();
