// RIFF/WAVE PCM и IEEE float. Внутри программы сигнал хранится в моно, от −1 до +1.
const Wav = (() => {
  function read(buffer) {
    const view = new DataView(buffer);
    const tag = i => String.fromCharCode(...new Uint8Array(buffer, i, 4));
    const u16 = i => view.getUint16(i, true);
    const u32 = i => view.getUint32(i, true);
    if (view.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
      throw Error("Ожидается звуковой файл WAV (RIFF/WAVE).");
    }
    const limit = 8 + u32(4);
    if (limit > buffer.byteLength) throw Error("Файл WAV оборван.");
    let fmt, data;
    for (let i = 12; i + 8 <= limit;) {
      const name = tag(i);
      const length = u32(i + 4);
      const start = i + 8;
      if (start + length > limit) throw Error("Повреждён блок WAV.");
      if (name === "fmt " && length >= 16) fmt = start;
      if (name === "data" && !data) data = {start, length};
      i = start + length + (length % 2);
    }
    if (!fmt || !data) throw Error("В WAV отсутствуют параметры или звуковые отсчёты.");
    const format = u16(fmt), channels = u16(fmt + 2), rate = u32(fmt + 4);
    const stride = u16(fmt + 12), bits = u16(fmt + 14);
    const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
    if (!(pcm || (format === 3 && bits === 32)) || ![1, 2].includes(channels) ||
        rate < 8000 || rate > 96000 || stride !== channels * bits / 8) {
      throw Error("Используйте WAV PCM (8/16/24/32 бит) или float32, моно или стерео, 8–96 кГц.");
    }
    const count = data.length / stride;
    if (!Number.isInteger(count) || count === 0 || count > 180 * rate) {
      throw Error("Длительность WAV должна быть больше нуля и не превышать 180 с.");
    }
    function sample(i) {
      if (format === 3) {
        const value = view.getFloat32(i, true);
        return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      }
      if (bits === 8) return (view.getUint8(i) - 128) / 128;
      if (bits === 16) return view.getInt16(i, true) / 32768;
      if (bits === 24) return ((u16(i) << 8) | (view.getInt8(i + 2) << 24)) / 2147483648;
      return view.getInt32(i, true) / 2147483648;
    }
    const samples = new Float32Array(count);
    for (let n = 0, i = data.start; n < count; ++n, i += stride) {
      samples[n] = channels === 1 ? sample(i) : (sample(i) + sample(i + bits / 8)) / 2;
    }
    return {samples, rate};
  }

  function write({samples, rate}) {
    const buffer = new ArrayBuffer(44 + 2 * samples.length);
    const view = new DataView(buffer);
    function tag(i, text) {
      for (let j = 0; j < text.length; ++j) view.setUint8(i + j, text.charCodeAt(j));
    }
    tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
    tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, buffer.byteLength - 44, true);
    for (let i = 0; i < samples.length; ++i) {
      const value = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)));
      view.setInt16(44 + i * 2, value, true);
    }
    return buffer;
  }

  function unpack(bytes, rate) {
    const samples = new Float32Array(bytes.length * 8);
    for (let i = 0; i < samples.length; ++i) {
      samples[i] = (bytes[i >> 3] & (128 >> (i % 8))) ? 0.6 : -0.6;
    }
    return {samples, rate};
  }
  return {read, write, unpack};
})();
