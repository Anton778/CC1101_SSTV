const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dir = path.join(__dirname, "..", "tools", "receiver");
const code = ["wav.js", "reference.js", "robot36.js", "serial.js"]
  .map(file => fs.readFileSync(path.join(dir, file), "utf8")).join("\n");
const {captureOnSession, referenceRobot36, Robot36} = vm.runInNewContext(
  code + "\n;({captureOnSession, referenceRobot36, Robot36})",
  {ReadableStream, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval}
);

function session(onWrite) {
  const listeners = new Set(), commands = [];
  const emit = line => { for (const callback of listeners) callback(line); };
  return {listeners, commands, emit,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async write(cmd) { commands.push(cmd); onWrite(cmd, emit); }
  };
}

function streamBars(emit) {
  const {samples} = referenceRobot36();
  const blocks = 800;
  let index = 0, crc = 2166136261;
  emit("SSTV BEGIN 32000 200 " + blocks);
  for (let k = 0; k < blocks; ++k) {
    const data = Buffer.alloc(200);
    for (let j = 0; j < data.length; ++j) {
      for (let bit = 0; bit < 8; ++bit, ++index) {
        data[j] = (data[j] << 1) | (samples[Math.floor(index / 2)] > 0 ? 1 : 0);
      }
      crc = Math.imul(crc ^ data[j], 16777619) >>> 0;
    }
    emit("SSTV DATA " + k + " " + data.toString("hex"));
  }
  emit("SSTV END " + blocks + " " + crc.toString(16).padStart(8, "0"));
}

test("общий порт из режима чата принимает биты GDO0 и декодирует кадр без промежуточного файла", async () => {
  const link = session((cmd, emit) => {
    if (cmd === "PING") emit("SSTV MODE CHAT");
    if (cmd === "RX 433.925") { emit("FIELD MODE RX 433.925000"); emit("SSTV RX 433.925000"); }
    if (cmd === "REC 40") streamBars(emit);
  });
  const pcm = await captureOnSession(link, 40, new AbortController().signal, () => {}, 433.925);
  assert.deepEqual(link.commands, ["PING", "RX 433.925", "REC 40"]);
  assert.equal(link.listeners.size, 0);
  const frame = await Robot36.decode(pcm);
  assert.equal(frame.locked, 240);
  assert.equal(frame.pixels.length, 320 * 240 * 4);
  const pixel = (x, y) => Array.from(frame.pixels.slice(4*(y*320+x), 4*(y*320+x)+3));
  assert.ok(pixel(20, 60).every(v => v > 220));
  assert.ok(pixel(20, 180).every(v => v < 40));
});

test("общий порт освобождает подписку после отмены, обрыва или неверного номера блока", async () => {
  for (const failure of ["cancel", "unplug", "sequence"]) {
    const controller = new AbortController();
    const link = session((cmd, emit) => {
      if (cmd === "PING") emit("SSTV READY 1");
      if (cmd !== "REC 40") return;
      emit("SSTV BEGIN 32000 200 800");
      if (failure === "cancel") controller.abort();
      if (failure === "unplug") emit(null);
      if (failure === "sequence") emit("SSTV DATA 1 " + "00".repeat(200));
    });
    await assert.rejects(captureOnSession(link, 40, controller.signal, () => {}, null));
    assert.equal(link.listeners.size, 0);
    assert.equal(link.commands.at(-1), "STOP");
  }
});
