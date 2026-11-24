const {test} = require("node:test");
const assert = require("node:assert/strict");
const {Link, send, crcHex} = require("../tools/sender/transfer.js");

function portFor(respond) {
  let input;
  const history = [];
  const push = line => input.enqueue(new TextEncoder().encode(line + "\n"));
  const port = {
    readable: new ReadableStream({start(controller) { input = controller; }}),
    writable: new WritableStream({write(bytes) {
      const line = new TextDecoder().decode(bytes).trim();
      history.push(line);
      respond(line, push);
    }}),
    async close() {}
  };
  return {link: new Link(port, () => {}), history, push, unplug: () => input.close()};
}

test("CRC32 совпадает с контрольным вектором IEEE", () => {
  assert.equal(crcHex(new TextEncoder().encode("123456789")), "cbf43926");
});

test("отправка учитывает ACK каждого блока и ждёт окончания кадра", async () => {
  const bytes = Uint8Array.from({length: 1573}, (_, i) => (71 * i) & 255);
  const id = crcHex(bytes);
  let packed = [], inAir;
  const started = new Promise(resolve => { inAir = resolve; });
  const stages = [];
  const {link, push, history} = portFor((line, reply) => {
    if (line === "IMG HELLO") return reply("SSTV READY 1\nIMG READY 1");
    if (line === "IMG BEGIN 1573 " + id) return reply("IMG ACCEPT " + id + " 768");
    if (line.startsWith("IMG DATA ")) {
      const [, , offset, b64] = line.split(" ");
      assert.equal(+offset, packed.length);
      packed.push(...Buffer.from(b64, "base64"));
      reply("IMG ACK " + packed.length);
    }
    if (line === "IMG END " + id) reply("IMG STORED " + id + "\nIMG AIR " + id);
  });
  try {
    await link.hello();
    const pending = send(link, bytes, (stage, fraction) => {
      stages.push([stage, fraction]);
      if (stage === "air") inAir();
    });
    await started;
    assert.deepEqual(Buffer.from(packed), Buffer.from(bytes));
    assert.deepEqual(stages.filter(([s]) => s === "usb").map(([, f]) => f * bytes.length), [0, 768, 1536, 1573]);
    assert.equal(stages.at(-1)[0], "air");
    push("IMG SENT " + id);
    await pending;
    assert.equal(stages.at(-1)[0], "sent");
    assert.equal(history.filter(line => line.startsWith("IMG DATA ")).length, 3);
  } finally { await link.close(); }
});

test("неверное смещение отменяет загрузку до записи во флеш", async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const {link, history} = portFor((line, reply) => {
    if (line.startsWith("IMG BEGIN ")) reply("IMG ACCEPT " + crcHex(bytes) + " 768");
    if (line.startsWith("IMG DATA ")) reply("IMG ACK 3");
  });
  try {
    await assert.rejects(send(link, bytes, () => {}), /подтверждение/);
    assert.equal(history.at(-1), "IMG CANCEL");
    assert.ok(!history.some(line => line.startsWith("IMG END")));
  } finally { await link.close(); }
});

test("пропавшее соединение или подтверждение чужого кадра не дают статуса Передано", async () => {
  for (const failure of ["disconnect", "id", "crc"]) {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), id = crcHex(bytes), stages = [];
    const {link, history, unplug} = portFor((line, reply) => {
      if (line.startsWith("IMG BEGIN ")) reply("IMG ACCEPT " + id + " 768");
      if (line.startsWith("IMG DATA ")) reply("IMG ACK 4");
      if (line.startsWith("IMG END ")) {
        if (failure === "crc") return reply("IMG ERROR CRC");
        reply("IMG STORED " + id + "\nIMG AIR " + id);
        if (failure === "id") reply("IMG SENT 00000000");
        else setImmediate(unplug);
      }
    });
    try {
      await assert.rejects(send(link, bytes, stage => stages.push(stage)));
      assert.ok(!stages.includes("sent"));
      if (failure === "crc") assert.equal(history.at(-1), "IMG CANCEL");
    } finally { await link.close(); }
  }
});

test("очередь завершает кадр из ОЗУ и различает подтверждения следующих картинок", async () => {
  const first = Uint8Array.of(10, 15), second = Uint8Array.of(11, 16);
  const ramId = crcHex(first);
  let id;
  const {link} = portFor((line, reply) => {
    if (line.startsWith("IMG BEGIN ")) {
      id = line.split(" ").at(-1);
      reply("IMG ACCEPT " + id + " 768");
    }
    if (line.startsWith("IMG DATA ")) reply("IMG ACK 2");
    if (line.startsWith("IMG END ")) {
      // У старой прошивки нет FIELD IMAGE. Запоздалое сообщение про другой кадр допустимо.
      reply("FIELD IMAGE " + ramId + " RAM\nIMG STORED " + id + "\nIMG AIR " + id + "\nIMG SENT " + id);
    }
  });
  try {
    for (const [bytes, location] of [[first, "RAM"], [second, "FLASH"]]) {
      const reports = [];
      await send(link, bytes, (stage, _, storage) => {
        if (stage === "air" || stage === "sent") reports.push([stage, storage]);
      });
      assert.deepEqual(reports, [["air", location], ["sent", location]]);
      assert.equal(link.subscribers.size, 0);
    }
  } finally { await link.close(); }
});
