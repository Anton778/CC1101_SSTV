// Строковый протокол USB. Проверяем номера блоков, их длину и контрольную сумму.
async function captureFromPort(port, seconds, signal, onProgress, rxMHz = null) {
  await port.open({baudRate: 115200, bufferSize: 32768, flowControl: "none"});
  const reader = port.readable.getReader(), writer = port.writable.getWriter();
  const encoder = new TextEncoder();
  try {
    return await captureRobot36(reader, line => writer.write(encoder.encode(line + "\n")), seconds, signal, onProgress, rxMHz);
  } finally {
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}

// Один владелец USB-порта на весь пульт. Запись подписывается только на ответы SSTV.
function captureOnSession(session, seconds, signal, onProgress, rxMHz) {
  let unlisten;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      unlisten = session.subscribe(line => {
        if (line === null) { unlisten(); controller.error(Error("Потеряна связь с платой.")); }
        else if (line.startsWith("SSTV ")) controller.enqueue(encoder.encode(line + "\n"));
      });
    },
    cancel() { unlisten(); }
  });
  return captureRobot36(stream.getReader(), line => session.write(line), seconds, signal, onProgress, rxMHz);
}

async function captureRobot36(reader, send, seconds, signal, onProgress, rxMHz) {
  const decoder = new TextDecoder();
  let phase = "ready", deadline = Date.now() + 12000, nextPing = Date.now() + 700;
  let failure, pending = "", bytes, blocks = 0, blockSize = 0, received = 0;
  let rate = 0, hash = 2166136261;
  function requestRecording() {
    phase = "begin";
    deadline = Date.now() + 6000;
    return send("REC " + seconds);
  }
  function interrupt(error) {
    if (!failure) {
      failure = error;
      reader.cancel().catch(() => {});
    }
  }
  const abort = () => interrupt(Error("Запись отменена."));
  signal.addEventListener("abort", abort);
  const watchdog = setInterval(() => {
    if (Date.now() > deadline) {
      interrupt(Error(phase === "ready"
        ? "Плата не ответила. Проверьте USB-порт и закройте монитор Arduino IDE."
        : (phase === "tune" ? "Прошивка не подтвердила переход в RX. Загрузите версию с командами порта."
                            : "Поток с платы прервался. Повторите запись.")));
    } else if (phase === "ready" && Date.now() >= nextPing) {
      nextPing = Date.now() + 700;
      send("PING").catch(interrupt);
    }
  }, 200);

  try {
    if (signal.aborted) throw Error("Запись отменена.");
    await send("PING");
    while (true) {
      const {value, done} = await reader.read();
      if (failure) throw failure;
      if (done) throw Error("USB-порт закрылся до окончания записи.");
      pending += decoder.decode(value, {stream: true});
      const lines = pending.split("\n");
      pending = lines.pop();
      if (pending.length > 1024) throw Error("Повреждены границы блоков записи.");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("SSTV ")) continue;
        if (line.startsWith("SSTV ERROR")) {
          throw Error("Плата прервала запись (" + line.slice(11) + "). Запустите её ещё раз.");
        }
        if (phase === "ready") {
          if (line === "SSTV BUSY") await send("STOP");
          if (/^SSTV MODE (TX|SCAN|CHAT)$/.test(line) || (line === "SSTV READY 1" && rxMHz !== null)) {
            phase = "tune";
            deadline = Date.now() + 6000;
            await send(rxMHz === null ? "RX" : "RX " + rxMHz);
          } else if (line === "SSTV READY 1") {
            await requestRecording();
          }
        } else if (phase === "tune") {
          const ack = /^SSTV RX (\d+(?:\.\d+)?)$/.exec(line);
          if (!ack) continue;
          if (rxMHz !== null && Math.abs(Number(ack[1]) - rxMHz) > 0.000001) {
            throw Error("Плата подтвердила другую частоту приёма.");
          }
          await requestRecording();
        } else if (phase === "begin") {
          if (!line.startsWith("SSTV BEGIN ")) continue;
          const match = /^SSTV BEGIN (\d+) (\d+) (\d+)$/.exec(line);
          if (!match) throw Error("Неверные параметры записи.");
          [rate, blockSize, blocks] = match.slice(1).map(Number);
          if (rate !== 32000 || blockSize !== 200 || blocks !== seconds * 20) {
            throw Error("Параметры потока не совпали с запросом.");
          }
          bytes = new Uint8Array(blockSize * blocks);
          phase = "data";
          onProgress(0);
        } else if (line.startsWith("SSTV DATA ")) {
          const match = /^SSTV DATA (\d+) ([0-9a-f]+)$/.exec(line);
          if (!match || Number(match[1]) !== received || received >= blocks || match[2].length !== 2 * blockSize) {
            throw Error("Нарушена последовательность блоков. Повторите запись целиком.");
          }
          const hex = match[2];
          for (let i = 0; i < blockSize; ++i) {
            const byte = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
            bytes[received * blockSize + i] = byte;
            hash = Math.imul(hash ^ byte, 16777619) >>> 0;
          }
          ++received;
          if (received % 20 === 0) onProgress(received / 20);
          deadline = Date.now() + 6000;
        } else if (line.startsWith("SSTV END ")) {
          const match = /^SSTV END (\d+) ([0-9a-f]{8})$/.exec(line);
          if (!match || received !== blocks || Number(match[1]) !== blocks || parseInt(match[2], 16) !== hash) {
            throw Error("Проверка целостности записи не пройдена. Повторите приём.");
          }
          phase = "done";
          return Wav.unpack(bytes, rate);
        } else if (line === "SSTV STOP") {
          throw Error("Плата остановила запись.");
        }
      }
    }
  } finally {
    clearInterval(watchdog);
    signal.removeEventListener("abort", abort);
    if (phase !== "done") await send("STOP").catch(() => {});
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
