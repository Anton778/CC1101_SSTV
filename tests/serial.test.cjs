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
