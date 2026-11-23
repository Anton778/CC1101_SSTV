// Протокол отправителя. Для каждого кадра ждём отдельные подтверждения USB и эфира.
const ImageTransfer = (() => {
  const maxBytes = 65536;
  const blockSize = 768;
  const errors = {
    BUSY: "Плата занята записью или передачей заказанного кадра. Дождитесь окончания и повторите.",
    RADIO: "ESP32 сообщила об ошибке CC1101. Проверьте подключение радиомодуля.",
    PARTITION: "Плате нужен пустой раздел spiffs или раздел с LittleFS. Проверьте разметку памяти в Arduino IDE.",
    STORAGE: "Плата не смогла сохранить кадр. Проверьте свободное место в LittleFS.",
    MEMORY: "ESP32 не хватило оперативной памяти для картинки.",
    JPEG: "Плата не смогла декодировать JPEG размером 320 × 240.",
    READ: "Плата прервала передачу при чтении картинки из памяти.",
    INTERRUPTED: "Передача прервана командой станции.",
    CRC: "Контрольная сумма или длина загрузки не совпала.",
    BLOCK: "Плата обнаружила повреждённый блок.",
    OFFSET: "Нарушен порядок блоков при загрузке.",
    TIMEOUT: "Плата прервала незавершённую загрузку по тайм-ауту."
  };
  function crcHex(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return ((~crc) >>> 0).toString(16).padStart(8, "0");
  }

  class Deadline extends Error {}
  class Link {
    constructor(port, onLoss) {
      this.port = port;
      this.onLoss = onLoss;
      this.lines = [];
      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.pump = this.read();
    }
    async read() {
      const decoder = new TextDecoder();
      let rest = "";
      try {
        while (true) {
          const {done, value} = await this.reader.read();
          if (done) break;
          const lines = (rest + decoder.decode(value, {stream: true})).split("\n");
          rest = lines.pop();
          if (rest.length > 4096) throw Error("Нарушены границы сообщений USB.");
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("IMG ")) continue;
            if (this.waiter) this.waiter.resolve(line);
            else {
              this.lines.push(line);
              if (this.lines.length > 32) this.lines.shift();
            }
          }
        }
      } catch (error) { this.failure = error; }
      finally {
        this.failure ||= Error("Соединение с платой закрыто.");
        this.waiter?.reject(this.failure);
        if (!this.closing) this.onLoss(this.failure);
      }
    }
    async write(line) {
      if (this.failure) throw this.failure;
      await this.writer.write(new TextEncoder().encode(line + "\n"));
    }
    next(ms) {
      if (this.failure) return Promise.reject(this.failure);
      if (this.lines.length) return Promise.resolve(this.lines.shift());
      return new Promise((resolve, reject) => {
        const clear = () => { clearTimeout(timer); this.waiter = null; };
        const timer = setTimeout(() => {
          clear();
          reject(new Deadline("Плата не прислала подтверждение вовремя."));
        }, ms);
        this.waiter = {
          resolve: line => { clear(); resolve(line); },
          reject: error => { clear(); reject(error); }
        };
      });
    }
    async hello() {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        await this.write("IMG HELLO");
        try { if (await this.next(700) === "IMG READY 1") return; }
        catch (error) { if (!(error instanceof Deadline)) throw error; }
      }
      throw Error("Плата не ответила на запрос отправителя. Проверьте порт и один раз загрузите актуальную прошивку.");
    }
    async expect(expected, ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const line = await this.next(Math.max(1, end - Date.now()));
        if (line === expected) return;
        if (line === "IMG READY 1" || line === "IMG CANCELED") continue;
        if (line.startsWith("IMG ERROR ")) {
          const code = line.slice(10);
          throw Error(errors[code] || "Ошибка платы (" + code + ").");
        }
        throw Error("Неожиданное подтверждение платы: " + line);
      }
      throw new Deadline("Время ожидания подтверждения истекло.");
    }
    async close() {
      if (this.closing) return this.closing;
      this.closing = (async () => {
        try { await this.reader.cancel(); } catch {}
        await this.pump;
        this.reader.releaseLock();
        this.writer.releaseLock();
        await this.port.close();
      })();
      return this.closing;
    }
  }

  async function send(link, bytes, update) {
    if (!bytes.length || bytes.length > maxBytes) throw Error("Кадр превышает размер буфера ESP32.");
    const id = crcHex(bytes);
    let uploading = false;
    try {
      await link.write("IMG BEGIN " + bytes.length + " " + id);
      await link.expect("IMG ACCEPT " + id + " " + blockSize, 6000);
      uploading = true;
      update("usb", 0);
      for (let offset = 0; offset < bytes.length; offset += blockSize) {
        const block = bytes.subarray(offset, offset + blockSize);
        await link.write("IMG DATA " + offset + " " + btoa(String.fromCharCode(...block)));
        const end = offset + block.length;
        await link.expect("IMG ACK " + end, 6000);
        update("usb", end / bytes.length);
      }
      update("saving");
      await link.write("IMG END " + id);
      await link.expect("IMG STORED " + id, 25000);
      uploading = false;
      await link.expect("IMG AIR " + id, 6000);
      update("air");
      await link.expect("IMG SENT " + id, 55000);
      update("sent");
    } catch (error) {
      if (uploading) {
        try { await link.write("IMG CANCEL"); } catch {}
      }
      throw error;
    }
  }
  return {Link, send, crcHex, maxBytes};
})();
if (typeof module !== "undefined") module.exports = ImageTransfer;
