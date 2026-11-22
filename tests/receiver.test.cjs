// Запуск из корня проекта: node --test tests/receiver.test.cjs
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "tools", "receiver");
const scripts = ["wav.js", "robot36.js", "reference.js", "sweep.js"];
const code = scripts.map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
const {Wav, Robot36, referenceRobot36, addAudioSweep, sweepFromCommand} = vm.runInNewContext(
  code + "\n;({Wav, Robot36, referenceRobot36, addAudioSweep, sweepFromCommand})", {setTimeout}
);

test("WAV → VIS 8 → 240 строк, порядок цветов в обеих половинах", async () => {
  const frame = await Robot36.decode(Wav.read(Wav.write(referenceRobot36())));
  assert.equal(frame.locked, 240);
  assert.ok(Math.abs(frame.headerTime - 0.5) < 0.005);
  const bars = [[255,255,255], [255,255,0], [0,255,255], [0,255,0],
                [255,0,255], [255,0,0], [0,0,255], [0,0,0]];
  for (const y of [30, 31, 210, 211]) {
    for (let x = 0; x < 8; ++x) {
      const expected = bars[y < 120 ? x : 7 - x];
      const i = 4 * (320 * y + 40 * x + 20);
      for (let c = 0; c < 3; ++c) assert.ok(Math.abs(frame.pixels[i + c] - expected[c]) <= 4);
    }
  }
});

test("оборванный кадр и испорченный бит чётности не дают готовую картинку", async () => {
  const audio = referenceRobot36();
  const short = {rate: audio.rate, samples: audio.samples.subarray(0, 20 * audio.rate)};
  await assert.rejects(Robot36.decode(short), /до конца кадра/);
  // Заголовок начинается на 0,5 с. Вместо контрольной единицы VIS передаём ноль.
  const first = Math.round(1.350 * audio.rate), last = Math.round(1.380 * audio.rate);
  for (let n = first; n < last; ++n) audio.samples[n] = 0.6 * Math.sin(2 * Math.PI * 1300 * n / audio.rate);
  await assert.rejects(Robot36.decode(audio), /VIS = 8.*не найден/);
});

test("USB-биты идут старшим вперёд и переживают преобразование в PCM16", () => {
  const audio = Wav.read(Wav.write(Wav.unpack(Uint8Array.of(0xa1), 32000)));
  assert.equal(audio.rate, 32000);
  assert.deepEqual(Array.from(audio.samples, value => Math.sign(value)), [1,-1,1,-1,-1,-1,-1,1]);
});

test("частота звукового свипа поднимается и опускается; исходный WAV сохранён", () => {
  const rate = 16000;
  const original = {rate, samples: new Float32Array(2 * rate).fill(0.5)};
  const mixed = addAudioSweep(original, 1000, 2000, 1, 100);
  function frequencyAt(time) {
    let crossings = 0;
    const first = Math.round((time - 0.02) * rate), count = Math.round(0.04 * rate);
    for (let i = first; i < first + count; ++i) {
      if (mixed.samples[i] <= 0.5 && mixed.samples[i + 1] > 0.5) ++crossings;
    }
    return crossings / 0.04;
  }
  for (const [time, hz] of [[0.10,1200], [0.45,1900], [0.75,1500], [1.10,1200]]) {
    assert.ok(Math.abs(frequencyAt(time) - hz) <= 35);
  }
  assert.ok(original.samples.every(v => v === 0.5));
  const clean = referenceRobot36();
  assert.deepEqual(addAudioSweep(clean, 1100, 2300, 2, 0).samples, clean.samples);
});

test("команда свипа задаёт отношение мощностей в дБ и сохраняет исходные отсчёты", () => {
  const audio = {rate: 16000, samples: new Float32Array(32000).fill(0.2)};
  const mix = sweepFromCommand(audio, "wav_sweep 1100 2300 -6");
  let tonePower = 0, signalPower = 0;
  for (let i = 0; i < audio.samples.length; ++i) {
    tonePower += (mix.samples[i] - audio.samples[i]) ** 2;
    signalPower += audio.samples[i] ** 2;
  }
  assert.ok(Math.abs(10 * Math.log10(tonePower / signalPower) + 6) < 0.02);
  assert.ok(audio.samples.every(v => v === Math.fround(0.2)));
  assert.throws(() => sweepFromCommand(audio, "WAV_SWEEP 1100 2300"), /Формат/);
  assert.throws(() => sweepFromCommand(audio, "WAV_SWEEP 2300 1100 -6"), /частоты/);
});
