"use strict";

window.fieldStation = (() => {
  const el = (id) => document.getElementById(id);
  const chat = el("chat-card"),
    chatHome = el("chat-home");
  const inChat = (id) => chat.querySelector("#" + id);
  const modes = { TX: "Передача", RX: "Приём", SCAN: "Поиск", CHAT: "Чат" };
  const boards = { ESP32: "ESP32 Dev Module", ESP32S3: "ESP32-S3" };
  let port = null,
    unsubscribe,
    info = null,
    mode = "",
    activeMHz = 0;
  let busy = false,
    recording = false,
    paused = false,
    popup = null;
  let measuring = false,
    plotted = false,
    count = 0,
    above = 0,
    top = [];
  let first = 433720,
    last = 434120,
    threshold = -75;
  const plot = new SpectrumPlot(el("spectrum"), el("scan-cursor"));
  let supportsTuning = false, tuningFailure = "";

  function show(id, message, error = false) {
    const node = el(id);
    node.hidden = !message;
    node.textContent = message;
    node.classList.toggle("error", error);
  }
  function tab(name) {
    for (const b of document.querySelectorAll("[data-view]")) {
      const selected = b.dataset.view === name;
      b.setAttribute("aria-pressed", String(selected));
      el("view-" + b.dataset.view).hidden = !selected;
    }
    if (name === "scan") drawScan();
  }
  for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => tab(b.dataset.view);
  function render() {
    const canAct = Boolean(info && !busy && !recording);
    for (const b of document.querySelectorAll("[data-radio]")) b.disabled = !canAct;
    el("board").disabled = Boolean(port);
    el("mode").textContent = mode ? mode + " · " + modes[mode] : "—";
    el("frequency").textContent = activeMHz ? activeMHz.toFixed(3) : "—";
    el("tx").setAttribute("aria-pressed", String(mode === "TX"));
    el("rx").setAttribute("aria-pressed", String(mode === "RX"));
    el("stop-tx").disabled = !canAct || mode !== "TX";
    el("record").disabled = !canAct || !info?.ready;
    el("scan-go").disabled = !canAct || measuring;
    el("scan-stop").disabled = !canAct || mode !== "SCAN";
    el("listen-peak").disabled = !canAct || !top.length || measuring;
    inChat("join").disabled = !canAct;
    const bytes = messageBytes();
    inChat("byte-count").textContent = bytes + " / 192 байт UTF-8 с позывным";
    inChat("send-chat").disabled =
      !canAct ||
      mode !== "CHAT" ||
      !info?.ready ||
      bytes > 192 ||
      !inChat("callsign").value.trim() ||
      !inChat("message").value.trim();
    const tune = canAct && info?.ready && supportsTuning && mode !== "SCAN";
    for (const id of ["tx-power", "freq-offset", "apply-tuning", "reset-tuning"]) el(id).disabled = !tune;
    window.fieldStation?.onReceiveState?.();
    if (!port) inChat("chat-state").textContent = "Плата отключена.";
  }

  function request(command, matches, timeout = 4500) {
    const session = port;
    if (!session) return Promise.reject(Error("Подключите плату."));
    return new Promise((resolve, reject) => {
      const finish = (handler, value) => {
        clearTimeout(timer);
        off();
        handler(value);
      };
      const off = session.subscribe((line) => {
        if (line === null) finish(reject, Error("Порт отключён."));
        else if (/^(FIELD ERROR|SSTV ERROR|CHAT ERROR|SSTV BUSY)/.test(line))
          finish(reject, Error("Ответ платы: " + line));
        else if (matches(line)) finish(resolve, line);
      });
      const timer = setTimeout(
        () => finish(reject, Error("Плата не подтвердила команду " + command.split(" ")[0] + ".")),
        timeout,
      );
      session.write(command).catch((error) => finish(reject, error));
    });
  }
  async function action(work, output = "operation") {
    if (!port || !info || busy || recording) return;
    const session = port;
    busy = true;
    render();
    if (output === "operation") show("operation", "");
    try {
      await work();
    } catch (error) {
      if (output === "chat-state") inChat("chat-state").textContent = error.message;
      else if (output !== "tuning-status" || !tuningFailure) show(output, error.message, true);
    } finally {
      if (port === session) {
        busy = false;
        render();
        api.onAvailable?.();
      }
    }
  }
  function setMode(next, frequency) {
    const command = next + (frequency ? " " + frequency : "");
    return request(command, (line) => line.startsWith("FIELD MODE " + next + " "));
  }
  function handle(line) {
    if (!line) return;
    let m = /^FIELD TUNING (ACTIVE|PENDING|VOLATILE) (-?\d+) (-?[\d.]+)$/.exec(line);
    if (m) {
      supportsTuning = true;
      el("tx-power").value = m[2];
      el("freq-offset").value = m[3];
      const value = m[2] + " дБм · " + m[3] + " кГц.";
      const states = {ACTIVE: "Установлено", PENDING: "Ожидает окончания операции",
                      VOLATILE: "Применено до перезапуска. Ошибка записи в память"};
      show("tuning-status", tuningFailure + states[m[1]] + " · " + value, Boolean(tuningFailure) || m[1] === "VOLATILE");
      render();
      return;
    }
    if (line.startsWith("FIELD ERROR TUNING_")) {
      const reasons = {TUNING_RANGE: "Проверьте мощность и границы частотного диапазона.",
                       TUNING_BUSY: "Остановите приём или поиск перед подстройкой.",
                       TUNING_RADIO: "CC1101 отклонил настройку."};
      tuningFailure = (reasons[line.slice(12)] || "Плата отклонила настройку.") + " ";
      show("tuning-status", tuningFailure.trim(), true);
      return;
    }
    m = /^FIELD MODE (TX|RX|SCAN|CHAT) ([\d.]+)$/.exec(line);
    if (m) {
      mode = m[1];
      activeMHz = Number(m[2]);
      if (info) info.ready = true;
      el("rssi").textContent = "—";
      if (mode !== "SCAN" && measuring) {
        measuring = false;
        show("scan-status", "Проход остановлен. Измерено точек: " + count + ".");
      }
      if (mode === "CHAT")
        inChat("chat-state").textContent = "Приём пакетов на " + activeMHz.toFixed(3) + " МГц.";
      else inChat("chat-state").textContent = "Для обмена включите чат на обоих постах.";
      render();
      api.onAvailable?.();
      return;
    }
    if (line.startsWith("FIELD ERROR RADIO") || line === "SSTV ERROR DDS") {
      if (info) info.ready = false;
      if (measuring) show("scan-status", "Ошибка радиомодуля. Получено точек: " + count + ".", true);
      mode = "";
      activeMHz = 0;
      measuring = false;
      el("rssi").textContent = "—";
      show("operation", "Ошибка CC1101 или таймера. Проверьте подключение и снова выберите режим.", true);
      render();
      return;
    }
    m = /^RSSI:\s*(-?[\d.]+)/.exec(line);
    if (m && mode === "RX") {
      el("rssi").textContent = Number(m[1]).toFixed(1);
      return;
    }
    m = /^FIELD POINT (\d+) (-?[\d.]+) ([01])$/.exec(line);
    if (m && measuring) {
      const f = Number(m[1]),
        r = Number(m[2]);
      if (f < first || f > last || !Number.isFinite(r)) return;
      ++count;
      plot.add(f, r);
      if (m[3] === "1") {
        ++above;
        top.push({ f, r });
        top.sort((a, b) => b.r - a.r || a.f - b.f);
        top.length = Math.min(top.length, 8);
      }
      activeMHz = f / 1000;
      el("frequency").textContent = activeMHz.toFixed(3);
      el("rssi").textContent = r.toFixed(1);
      if (!plotted) {
        plotted = true;
        requestAnimationFrame(() => {
          plotted = false;
          drawScan();
        });
      }
      return;
    }
    m = /^FIELD DONE (\d+) (\d+) (-?[\d.]+)$/.exec(line);
    if (m && measuring) {
      measuring = false;
      drawScan();
      show(
        "scan-status",
        "Проверено точек: " +
          count +
          ". Выше порога: " +
          m[1] +
          "." +
          (Number(m[1]) ? " Максимум " + (Number(m[2]) / 1000).toFixed(3) + " МГц, " + m[3] + " дБм." : ""),
      );
      render();
      return;
    }
    m = /^CHAT RX ([0-9a-f]{8}) [0-9a-f]{8} ([0-9a-f]{2,384})$/.exec(line);
    if (m && !(m[2].length % 2)) {
      try {
        const bytes = Uint8Array.from(m[2].match(/../g), (b) => parseInt(b, 16));
        const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const split = message.indexOf("\n");
        addMessage(split > 0 ? message.slice(0, split) : m[1], split > 0 ? message.slice(split + 1) : message);
      } catch {
        /* Радиопакет другого приложения. */
      }
    }
  }
  function drawScan() {
    plot.draw();
    if (measuring) show("scan-status", "Измерено точек: " + count + ". Выше порога: " + above + ".");
    el("hits").replaceChildren(
      ...top.map((p) => {
        const row = document.createElement("tr");
        row.insertCell().textContent = (p.f / 1000).toFixed(3);
        row.insertCell().textContent = p.r.toFixed(1);
        return row;
      }),
    );
  }

  function tune(command) {
    tuningFailure = "";
    return action(() => request(command, line => /^FIELD TUNING (ACTIVE|PENDING|VOLATILE) /.test(line)), "tuning-status");
  }
  el("tuning-form").onsubmit = event => {
    event.preventDefault();
    tune("TUNING " + el("tx-power").value + " " + el("freq-offset").valueAsNumber.toFixed(3));
  };
  el("reset-tuning").onclick = () => tune("TUNING DEFAULT");
  el("tx").onclick = () =>
    action(async () => {
      await setMode("TX");
      await request("Start_SSTV", (s) => s === "FIELD REPEAT 1");
      paused = false;
    });
  el("rx").onclick = () =>
    action(() => {
      if (!el("rx-channel").reportValidity()) return;
      return setMode("RX", el("rx-channel").value);
    });
  el("stop-tx").onclick = () =>
    action(async () => {
      await request("Stop SSTV", (s) => s === "FIELD REPEAT 0");
      paused = true;
      show("operation", "Кадр и повторы остановлены. Для продолжения нажмите «Включить TX».");
    });
  el("scan-form").onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      const a = el("scan-start").valueAsNumber,
        b = el("scan-end").valueAsNumber,
        step = el("scan-step").valueAsNumber;
      if (b < a) throw Error("Конец диапазона должен быть не ниже начала.");
      await setMode("RX");
      first = a;
      last = b;
      threshold = el("threshold").valueAsNumber;
      top = [];
      count = above = 0;
      plot.reset(first, last, threshold);
      drawScan();
      measuring = true;
      try {
        await request("SCAN " + [a, b, threshold, step].join(" "), (s) => s.startsWith("FIELD MODE SCAN "));
        if (measuring) show("scan-status", "Идёт проход по частотам.");
      } catch (error) {
        measuring = false;
        throw error;
      }
    }, "scan-status");
  };
  el("scan-stop").onclick = () => action(() => setMode("RX"), "scan-status");
  el("listen-peak").onclick = () =>
    action(async () => {
      if (!top.length) return;
      const value = (top[0].f / 1000).toFixed(3);
      await setMode("RX", value);
      el("rx-channel").value = value;
      tab("receive");
    });
  function addMessage(author, text) {
    const li = document.createElement("li"),
      name = document.createElement("strong"),
      ts = document.createElement("time");
    ts.textContent = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    name.textContent = author + " · ";
    li.append(ts, name, document.createTextNode(text));
    const log = inChat("messages");
    log.append(li);
    if (log.children.length > 200) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function messageBytes() {
    return new TextEncoder().encode(inChat("callsign").value.trim() + "\n" + inChat("message").value.trim())
      .length;
  }
  inChat("message").oninput = inChat("callsign").oninput = render;
  el("focus-chat").onclick = () => popup?.focus();
  inChat("chat-join").onsubmit = (event) => {
    event.preventDefault();
    action(() => setMode("CHAT", inChat("chat-channel").value), "chat-state");
  };
  inChat("chat-form").onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      if (mode !== "CHAT") throw Error("Включите режим чата.");
      const name = inChat("callsign").value.trim(),
        text = inChat("message").value.trim();
      if (!name || !text) throw Error("Введите позывной и сообщение.");
      const bytes = new TextEncoder().encode(name + "\n" + text);
      if (bytes.length > 192)
        throw Error("Сообщение вместе с позывным занимает " + bytes.length + " байт UTF-8. Допустимо 192.");
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      await request("MSG " + hex, (s) => /^CHAT SENT [0-9a-f]{8}$/.test(s));
      addMessage(name + " (вы)", text);
      inChat("message").value = "";
      inChat("chat-state").textContent = "Передано в эфир. Станция снова принимает.";
    }, "chat-state");
  };
  inChat("pop-chat").onclick = () => {
    if (popup && !popup.closed) {
      popup.close();
      return;
    }
    popup = window.open("", "_blank", "popup,width=720,height=520");
    if (!popup) {
      inChat("chat-state").textContent = "Разрешите отдельное окно или продолжайте чат здесь.";
      return;
    }
    const doc = popup.document;
    doc.documentElement.lang = "ru";
    doc.title = "Научная рота · Радиочат";
    const css = doc.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("style.css", location.href).href;
    doc.head.append(css);
    doc.body.className = "popup";
    doc.body.replaceChildren(chat);
    el("chat-away").hidden = false;
    inChat("pop-chat").textContent = "Вернуть в пульт";
    popup.addEventListener(
      "pagehide",
      () => {
        chatHome.append(chat);
        el("chat-away").hidden = true;
        inChat("pop-chat").textContent = "В отдельное окно ↗";
        popup = null;
      },
      { once: true },
    );
  };
  window.addEventListener("pagehide", () => popup?.close());
  const api = {
    onAvailable: null,
    onReceiveState: null,
    session: () => (info ? port : null),
    canRecord: () => Boolean(info?.ready && !busy && !recording),
    canSend: () => Boolean(info?.ready && mode === "TX" && !busy && !recording && !paused),
    canStartSend: () => Boolean(info?.ready && !busy && !recording && (mode !== "TX" || paused)),
    boardLabel: () =>
      info
        ? boards[info.board] +
          " · Flash " +
          info.flash +
          " МиБ · PSRAM " +
          info.ram +
          " МиБ" +
          (info.board === "ESP32S3" && (info.flash !== 16 || info.ram !== 8)
            ? " · проверьте параметры N16R8 в Arduino IDE."
            : "")
        : "",
    async attach(session) {
      port = session;
      unsubscribe = session.subscribe(handle);
      render();
      let line;
      try {
        line = await request("INFO", (s) => s.startsWith("FIELD INFO "), 3500);
      } catch (error) {
        throw Error(
          "Не удалось определить плату. Проверьте порт и загрузите версию прошивки для общего пульта. " +
            error.message,
        );
      }
      const m =
        /^FIELD INFO 1 (ESP32|ESP32S3) (TX|RX|CHAT|SCAN) ([\d.]+) ([\d.]+) ([\d.]+) ([01]) ([01]) (\d+) (\d+)$/.exec(
          line,
        );
      if (!m) throw Error("Неизвестная версия протокола станции.");
      const selected = el("board").value;
      if (selected !== "AUTO" && selected !== m[1])
        throw Error("Выбран другой профиль. Подключённая плата — " + boards[m[1]] + ".");
      info = { board: m[1], ready: m[6] === "1", flash: +m[8], ram: +m[9] };
      mode = m[2];
      activeMHz = mode === "TX" ? +m[3] : mode === "CHAT" ? +m[5] : mode === "RX" ? +m[4] : 0;
      el("rx-channel").value = m[4];
      inChat("chat-channel").value = m[5];
      paused = m[7] === "0";
      if (!supportsTuning) show("tuning-status", "Настройки доступны с обновлённой прошивкой SSTV_Robot36_DDS.");
      if (!info.ready)
        show(
          "operation",
          "Плата отвечает, CC1101 не инициализирован. Проверьте проводку и выберите режим.",
          true,
        );
      else show("operation", "");
      inChat("chat-state").textContent =
        mode === "CHAT" ? "Приём пакетов включён." : "Включите чат на обоих постах.";
      render();
    },
    detach(session) {
      if (port !== session) return;
      unsubscribe?.();
      port = null;
      supportsTuning = false;
      tuningFailure = "";
      el("tx-power").value = "";
      el("freq-offset").value = "";
      show("tuning-status", "Подключите плату, чтобы прочитать настройки.");
      info = null;
      mode = "";
      activeMHz = 0;
      busy = false;
      paused = false;
      if (measuring) show("scan-status", "Связь потеряна. Проход прерван.", true);
      measuring = false;
      el("rssi").textContent = "—";
      render();
    },
    beginCapture() {
      if (!info || busy || recording) return false;
      recording = true;
      render();
      return true;
    },
    endCapture() {
      recording = false;
      render();
      api.onAvailable?.();
    },
  };
  render();
  drawScan();
  return api;
})();
