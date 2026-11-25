const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "tools", "receiver");
const source = ["wav.js", "serial.js"].map(file => fs.readFileSync(path.join(directory, file), "utf8")).join("\n");
const capture = vm.runInNewContext(source + "\n;captureFromPort", {TextEncoder, TextDecoder, setInterval, clearInterval});

function modelPort(onCommand) {
  const history = [];
  let input;
  return {
    history,
    async open() {
      this.readable = new ReadableStream({start(controller) { input = controller; }});
      this.writable = new WritableStream({write(bytes) {
        const cmd = new TextDecoder().decode(bytes).trim();
        history.push(cmd);
        const answer = onCommand(cmd);
        if (answer) input.enqueue(new TextEncoder().encode(answer + "\n"));
      }});
    },
    async close() {}
  };
}

test("из автономного TX конвертер устанавливает канал RX перед записью", async () => {
  const blocks = 800, block = "00".repeat(200);
  const data = ["SSTV BEGIN 32000 200 800"];
  let checksum = 2166136261;
  for (let i = 0; i < blocks; ++i) {
    data.push("SSTV DATA " + i + " " + block);
    for (let j = 0; j < 200; ++j) checksum = Math.imul(checksum, 16777619) >>> 0;
  }
  data.push("SSTV END 800 " + checksum.toString(16).padStart(8, "0"));
  const port = modelPort(cmd => {
    if (cmd === "PING") return "SSTV MODE TX";
    if (cmd === "RX 433.945") return "SSTV RX 433.945000";
    if (cmd === "REC 40") return data.join("\n");
  });
  const audio = await capture(port, 40, new AbortController().signal, () => {}, 433.945);
  assert.deepEqual(port.history, ["PING", "RX 433.945", "REC 40"]);
  assert.equal(audio.rate, 32000);
  assert.equal(audio.samples.length, 40 * audio.rate);
});

test("конвертер отклоняет подтверждение другого канала до начала записи", async () => {
  const port = modelPort(cmd => {
    if (cmd === "PING") return "SSTV READY 1";
    if (cmd === "RX 433.945") return "SSTV RX 433.920000";
  });
  await assert.rejects(capture(port, 40, new AbortController().signal, () => {}, 433.945), /другую частоту/);
  assert.deepEqual(port.history, ["PING", "RX 433.945", "STOP"]);
});

test("REC LIVE выдаёт проверенный звук до STOP и подтверждает неполную секунду", async () => {
  const controller = new AbortController();
  const hex = "a5".repeat(200);
  let hash = 2166136261;
  for (let i = 0; i < 200; ++i) hash = Math.imul(hash ^ 0xa5, 16777619) >>> 0;
  const sum = hash.toString(16).padStart(8, "0");
  const port = modelPort(cmd => {
    if (cmd === "PING") return "SSTV READY 1";
    if (cmd === "REC LIVE") return "SSTV LIVE 32000 200\nSSTV DATA 0 " + hex + " " + sum;
    if (cmd === "STOP") return "SSTV END 1 " + sum + "\nSSTV STOP";
  });
  let calls = 0;
  const result = await capture(port, null, controller.signal, () => {}, null, (block, rate) => {
    assert.equal(rate, 32000);
    assert.equal(block.length, 200);
    assert.ok(block.every(b => b === 0xa5));
    assert.deepEqual(port.history, ["PING", "REC LIVE"]);
    ++calls;
    controller.abort();
  });
  assert.equal(calls, 1);
  assert.equal(result.seconds, 0.05);
  assert.deepEqual(port.history, ["PING", "REC LIVE", "STOP"]);
});

test("повреждённый блок LIVE не попадает в WAV, предыдущий блок доступен", async () => {
  let hash = 2166136261;
  for (let i = 0; i < 200; ++i) hash = Math.imul(hash, 16777619) >>> 0;
  const hex = "00".repeat(200);
  const port = modelPort(cmd => {
    if (cmd === "PING") return "SSTV READY 1";
    if (cmd === "REC LIVE") return ["SSTV LIVE 32000 200", "SSTV DATA 0 " + hex + " " + hash.toString(16).padStart(8, "0"),
                                      "SSTV DATA 1 " + hex + " 00000000"].join("\n");
  });
  let kept = 0;
  await assert.rejects(capture(port, null, new AbortController().signal, () => {}, null,
      block => { kept += block.length; }), /контрольной суммы блока/);
  assert.equal(kept, 200);
  assert.equal(port.history.at(-1), "STOP");
});
