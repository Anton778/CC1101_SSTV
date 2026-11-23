(() => {
  const el = id => document.getElementById(id);
  const items = [];
  let link = null, online = false, running = false, changingPort = false;
  const stages = {
    preparing: "Подготовка картинки…", waiting: "Ожидает передачи", begin: "Запрос к плате…",
    usb: "Загрузка по USB", saving: "Плата проверяет и сохраняет кадр…",
    air: "В эфире · Robot 36", sent: "Передано · 240 строк", failed: "Передача прервана"
  };
  function connection(connected, title, hint) {
    online = connected;
    el("led").classList.toggle("online", connected);
    el("connection").textContent = title;
    el("hint").textContent = hint;
    el("connect").textContent = connected ? "Отключить" : "Подключить передатчик";
  }
  function remove(item) {
    items.splice(items.indexOf(item), 1);
    if (item.image) URL.revokeObjectURL(item.image.preview);
    item.row.remove();
    refresh();
    drain();
  }
  function refresh() {
    el("empty").hidden = Boolean(items.length);
    el("clear").hidden = !items.some(item => item.stage === "sent");
  }
  function setStage(item, stage, message, fraction) {
    item.stage = stage;
    item.row.classList.toggle("failed", stage === "failed");
    item.row.classList.toggle("done", stage === "sent");
    item.status.textContent = message || stages[stage];
    if (stage === "usb") item.status.textContent += " · " + Math.round(fraction * 100) + " %";
    item.progress.hidden = stage !== "usb";
    item.progress.value = fraction || 0;
    item.retry.hidden = !(stage === "failed" && item.image);
    item.discard.hidden = !["waiting", "sent", "failed"].includes(stage);
    refresh();
  }
  function row(file) {
    const node = document.createElement("li");
    node.innerHTML = '<div class="thumb"></div><div><strong class="filename"></strong><span class="row-state"></span><progress max="1" hidden aria-label="Загрузка по USB"></progress></div><div class="actions"><button class="text retry" hidden>Повторить</button><button class="text discard" hidden>Убрать</button></div>';
    node.querySelector(".filename").textContent = file.name;
    const item = {row: node, status: node.querySelector(".row-state"), progress: node.querySelector("progress"),
      retry: node.querySelector(".retry"), discard: node.querySelector(".discard")};
    item.retry.onclick = () => { setStage(item, "waiting"); drain(); };
    item.discard.onclick = () => remove(item);
    items.push(item);
    el("queue").append(node);
    setStage(item, "preparing");
    return item;
  }
  async function add(files) {
    // Места резервируются до декодирования: большие файлы сохраняют порядок.
    const batch = Array.from(files, file => ({file, item: row(file)}));
    for (const {file, item} of batch) {
      try {
        item.image = await prepareImage(file);
        const thumb = document.createElement("img");
        thumb.alt = "";
        thumb.src = item.image.preview;
        item.row.querySelector(".thumb").append(thumb);
        setStage(item, "waiting");
      } catch (error) {
        setStage(item, "failed", error.message);
      }
      drain();
    }
  }
  async function drain() {
    if (running || !online) return;
    running = true;
    try {
      while (online) {
        const item = items.find(candidate => candidate.stage !== "sent");
        if (!item || item.stage !== "waiting") break;
        setStage(item, "begin");
        try {
          await ImageTransfer.send(link, item.image.bytes, (stage, fraction) => setStage(item, stage, null, fraction));
          el("notice").textContent = "Передано: " + item.row.querySelector(".filename").textContent;
        } catch (error) {
          setStage(item, "failed", error.message + " Очередь приостановлена.");
          break;
        }
      }
    } finally { running = false; }
  }
  async function disconnect(session, reason) {
    if (session !== link) return;
    link = null;
    connection(false, "Плата отключена", reason);
    try { await session.close(); } catch {}
  }
  el("connect").onclick = async () => {
    if (changingPort) return;
    changingPort = el("connect").disabled = true;
    let session, port;
    try {
      if (link) {
        await disconnect(link, "Подключите передатчик, чтобы продолжить работу с очередью.");
        return;
      }
      port = await navigator.serial.requestPort();
      await port.open({baudRate: 115200, bufferSize: 8192, flowControl: "none"});
      session = new ImageTransfer.Link(port, () => disconnect(session, "USB-соединение потеряно. Подключите плату снова."));
      link = session;
      connection(false, "Проверяем прошивку…", "Ожидаем ответ ESP32 через выбранный порт.");
      await session.hello();
      connection(true, "Передатчик подключён", "Можно добавлять изображения в очередь.");
      drain();
    } catch (error) {
      if (session) await disconnect(session, error.message);
      else if (error.name !== "NotFoundError") connection(false, "Порт недоступен", "Закройте монитор Arduino IDE и другие окна, использующие этот порт. " + error.message);
    } finally { changingPort = el("connect").disabled = false; }
  };
  const drop = el("drop");
  drop.onclick = () => el("files").click();
  el("files").onchange = event => { add(event.target.files); event.target.value = ""; };
  for (const type of ["dragover", "drop"]) window.addEventListener(type, event => event.preventDefault());
  drop.ondragover = event => { event.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = event => { event.preventDefault(); drop.classList.remove("over"); add(event.dataTransfer.files); };
  el("clear").onclick = () => { for (const item of items.slice()) if (item.stage === "sent") remove(item); };
  if (!navigator.serial) {
    connection(false, "USB недоступен в этом браузере", "Откройте локальный index.html в настольном Chrome или Edge.");
    el("connect").disabled = true;
  }
})();
