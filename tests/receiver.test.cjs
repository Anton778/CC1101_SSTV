// Запуск из корня проекта: node --test tests/receiver.test.cjs
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "tools", "receiver");
const scripts = ["wav.js", "robot36.js", "reference.js"];
const code = scripts.map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
const {Wav, Robot36, referenceRobot36} = vm.runInNewContext(
  code + "\n;({Wav, Robot36, referenceRobot36})", {setTimeout}
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

test("пары строк приходят до окончания кадра, следующий VIS восстанавливает синхронизацию", () => {
  const {rate, samples} = referenceRobot36();
  const finished = [], lost = [], rows = [];
  const decoder = Robot36.stream(rate, {
    onRows(frame, first) { assert.equal(frame.rows, first + 2); rows.push(frame.rows); },
    onFrame(frame) { finished.push(frame); },
    onLost(frame) { lost.push(frame.rows); }
  });
  function feed(data) {
    for (let i = 0; i < data.length; i += 997) decoder.push(data.subarray(i, i + 997));
  }
  feed(samples.subarray(0, 2 * rate));
  assert.ok(rows.length >= 1 && rows.at(-1) < 10);
  assert.equal(finished.length, 0);
  feed(samples);
  feed(samples);
  decoder.finish();
  assert.equal(finished.length, 2);
  assert.ok(lost.some(n => n > 0 && n < 240));
  assert.deepEqual(finished.map(f => f.locked), [240, 240]);
  assert.deepEqual(Array.from(finished[0].pixels), Array.from(finished[1].pixels));
});
