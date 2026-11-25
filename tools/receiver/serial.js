// Строковый протокол USB. Проверяем номера блоков, их длину и контрольную сумму.
async function captureFromPort(port, seconds, signal, onProgress, rxMHz = null, onBlock) {
  await port.open({baudRate: 115200, bufferSize: 32768, flowControl: "none"});
  const reader = port.readable.getReader(), writer = port.writable.getWriter();
  const encoder = new TextEncoder();
  try {
    return await captureRobot36(reader, line => writer.write(encoder.encode(line + "\n")), seconds, signal, onProgress, rxMHz, onBlock);
  } finally {
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}

// Один владелец USB-порта на весь пульт. Запись подписывается только на ответы SSTV.
function captureOnSession(session, seconds, signal, onProgress, rxMHz, onBlock) {
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
  return captureRobot36(stream.getReader(), line => session.write(line), seconds, signal, onProgress, rxMHz, onBlock);
}

async function captureRobot36(reader, send, seconds, signal, onProgress, rxMHz, onBlock) {
  const decoder = new TextDecoder();
  const live = seconds === null;
  let stopping = false;
  let phase = "ready", deadline = Date.now() + 12000, nextPing = Date.now() + 700;
  let failure, pending = "", bytes, blocks = 0, blockSize = 0, received = 0;
  let rate = 0, hash = 2166136261;
  function requestRecording() {
    phase = "begin";
    deadline = Date.now() + 6000;
    return send(live ? "REC LIVE" : "REC " + seconds);
  }
  function interrupt(error) {
    if (!failure) {
      failure = error;
      reader.cancel().catch(() => {});
    }
  }
  const abort = () => {
    if (stopping) return;
    if (!live || phase !== "data") return interrupt(Error("Запись остановлена."));
    stopping = true;
    deadline = Date.now() + 4000;
    send("STOP").catch(interrupt);
  };
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
          if (live && phase === "begin" && line === "SSTV ERROR DURATION") {
            throw Error("Для потокового приёма загрузите обновлённый скетч SSTV_Robot36_DDS.");
          }
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
          if (!line.startsWith(live ? "SSTV LIVE " : "SSTV BEGIN ")) continue;
          const match = (live ? /^SSTV LIVE (\d+) (\d+)$/ : /^SSTV BEGIN (\d+) (\d+) (\d+)$/).exec(line);
          if (!match) throw Error("Неверные параметры записи.");
          [rate, blockSize, blocks] = match.slice(1).map(Number);
          if (rate !== 32000 || blockSize !== 200 || (!live && blocks !== seconds * 20)) {
            throw Error("Параметры потока не совпали с запросом.");
          }
          if (!live) bytes = new Uint8Array(blockSize * blocks);
          phase = "data";
          onProgress(0);
        } else if (line.startsWith("SSTV DATA ")) {
          const pattern = live ? /^SSTV DATA (\d+) ([0-9a-f]+) ([0-9a-f]{8})$/ : /^SSTV DATA (\d+) ([0-9a-f]+)$/;
          const match = pattern.exec(line);
          if (!match || Number(match[1]) !== received || (!live && received >= blocks) || match[2].length !== 2 * blockSize) {
            throw Error("Нарушена последовательность блоков USB.");
          }
          const hex = match[2];
          const block = live ? new Uint8Array(blockSize) : bytes.subarray(received * blockSize, (received + 1) * blockSize);
          for (let i = 0; i < blockSize; ++i) {
            const byte = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
            block[i] = byte;
            hash = Math.imul(hash ^ byte, 16777619) >>> 0;
          }
          if (live && parseInt(match[3], 16) !== hash) throw Error("Ошибка контрольной суммы блока USB.");
          ++received;
          if (live) onBlock?.(block, rate);
          if (received % 20 === 0) onProgress(received / 20);
          if (!stopping) deadline = Date.now() + 6000;
        } else if (line.startsWith("SSTV END ")) {
          const match = /^SSTV END (\d+) ([0-9a-f]{8})$/.exec(line);
          if (!match || (!live && received !== blocks) || Number(match[1]) !== received || parseInt(match[2], 16) !== hash) {
            throw Error("Проверка целостности записи не пройдена. Повторите приём.");
          }
          phase = "done";
          return live ? {rate, seconds: received / 20} : Wav.unpack(bytes, rate);
        } else if (line === "SSTV STOP") {
          throw Error("Плата остановила запись.");
        }
      }
    }
  } finally {
    clearInterval(watchdog);
    signal.removeEventListener("abort", abort);
    if (phase !== "done" && !stopping) await send("STOP").catch(() => {});
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
