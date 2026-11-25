"use strict";

const byId = id => document.getElementById(id);
const canvas = byId("picture"), picture = canvas.getContext("2d");
let captureController, processing = false, audioContext, playAt = 0;
let part, pngVersion = 0;

function status(id, message, error = false) {
  const node = byId(id);
  node.textContent = message;
  node.classList.toggle("error", error);
}
function setControls() {
  const locked = processing || Boolean(captureController);
  byId("record").disabled = locked || !navigator.serial || Boolean(window.fieldStation && !window.fieldStation.canRecord());
  byId("wav-file").disabled = byId("rx-channel").disabled = locked;
}
function download(blob, name) {
  const link = document.createElement("a");
  link.download = name;
  link.href = URL.createObjectURL(blob);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
function wavBlob(audio) {
  return new Blob([Wav.write(audio)], {type: "audio/wav"});
}
function savePart(clip) {
  if (!clip?.used) return;
  const audio = Wav.unpack(clip.bytes.subarray(0, clip.used), 32000);
  download(wavBlob(audio), clip.name + ".wav");
}
function archivePart() {
  if (!part?.used) return;
  const clip = part;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = clip.label + " · " + (clip.used / 4000).toFixed(2) + " с · WAV";
  button.onclick = () => savePart(clip);
  const item = document.createElement("li");
  item.append(button);
  byId("recordings").prepend(item);
}
byId("save-recording").onclick = () => savePart(part);

function enableMonitor() {
  if (!captureController || !byId("monitor").checked || audioContext) return;
  try {
    audioContext = new AudioContext();
    audioContext.resume().catch(() => {});
    playAt = 0;
  } catch {
    byId("monitor").checked = false;
  }
}
function closeMonitor() {
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
}
byId("monitor").onchange = () => byId("monitor").checked ? enableMonitor() : closeMonitor();
function playBlock({samples, rate}) {
  if (audioContext?.state !== "running") return;
  const now = audioContext.currentTime;
  if (playAt < now || playAt > now + 0.3) playAt = now + 0.05;
  const buffer = audioContext.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start(playAt);
  playAt += buffer.duration;
}
function saveComplete(frame, name) {
  const version = ++pngVersion;
  canvas.toBlob(blob => {
    if (version !== pngVersion || !blob) return;
    const link = byId("save-picture");
    if (link.hasAttribute("href")) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.download = name + ".png";
    link.hidden = false;
  }, "image/png");
  byId("caption").textContent = "Принято 240 строк. Строчная синхронизация в " + frame.locked + " из 240.";
}
function livePicture(name) {
  let number = 0;
  return Robot36.stream(32000, {
    onHeader() {
      ++number;
      picture.clearRect(0, 0, canvas.width, canvas.height);
      byId("result").hidden = false;
      byId("caption").textContent = "Ожидание первой пары строк.";
      status("decode-status", "Принят заголовок Robot 36 (VIS = 8). Кадр " + number + ".");
    },
    onRows(frame, first) {
      const stride = 4 * frame.width;
      const pair = frame.pixels.subarray(first * stride, (first + 2) * stride);
      picture.putImageData(new ImageData(pair, frame.width, 2), 0, first);
      byId("caption").textContent = "Принято " + frame.rows + " из 240 строк.";
    },
    onFrame(frame) {
      saveComplete(frame, name + "-кадр-" + number);
      status("decode-status", "Кадр " + number + " принят. Ожидание следующего заголовка.");
    },
    onLost(frame) {
      const message = frame.rows < 240 ? "Приём кадра прерван." : "Недостаточно строчных синхроимпульсов.";
      status("decode-status", message + " Получено " + frame.rows + " из 240 строк.");
    }
  });
}
byId("record").onclick = async () => {
  const field = window.fieldStation;
  if (processing || captureController || !byId("rx-channel").reportValidity() || (field && !field.beginCapture())) return;
  const input = byId("rx-channel");
  const rxMHz = input.value === "" ? null : input.valueAsNumber;
  const started = new Date();
  const name = "robot36-" + started.toISOString().replace(/[:.]/g, "-");
  const decoder = livePicture(name);
  let partNumber = 0;
  captureController = new AbortController();
  setControls();
  byId("cancel").hidden = false;
  byId("cancel").disabled = false;
  status("record-status", "Подключение к приёмной плате…");
  enableMonitor();
  try {
    const source = field ? field.session() : await navigator.serial.requestPort();
    const capture = field ? captureOnSession : captureFromPort;
    const result = await capture(source, null, captureController.signal, seconds => {
      status("record-status", "Идёт запись · " + seconds + " с");
      if (seconds === 0) status("decode-status", "Ожидание заголовка Robot 36 (VIS = 8).");
    }, rxMHz, (bytes, rate) => {
      if (!partNumber || !part || part.used === part.bytes.length) {
        archivePart();
        // Двухминутные части можно снова открыть во встроенном WAV-декодере.
        ++partNumber;
        part = {bytes: new Uint8Array(120 * 4000), used: 0, name: name + "-часть-" + partNumber,
                label: started.toLocaleTimeString("ru-RU") + " · часть " + partNumber};
      }
      part.bytes.set(bytes, part.used);
      part.used += bytes.length;
      byId("save-recording").disabled = false;
      const audio = Wav.unpack(bytes, rate);
      playBlock(audio);
      decoder.push(audio.samples);
    });
    status("record-status", "Приём остановлен. Записано " + result.seconds.toFixed(2) + " с.");
  } catch (e) {
    let message = e.message;
    if (e.name === "NotFoundError") message = "Выбор порта отменён.";
    if (e.name === "NetworkError") message = "Пропала связь по USB. Проверьте кабель и монитор порта Arduino IDE.";
    if (partNumber) message += " Принятый звук доступен по кнопке «Сохранить WAV».";
    status("record-status", message, true);
  } finally {
    decoder.finish();
    captureController = null;
    closeMonitor();
    byId("cancel").hidden = true;
    field?.endCapture();
    setControls();
  }
};
byId("cancel").onclick = () => {
  byId("cancel").disabled = true;
  captureController?.abort();
};

byId("wav-file").onchange = async event => {
  const file = event.target.files[0];
  if (!file || processing || captureController) return;
  processing = true;
  setControls();
  try {
    if (file.size > 140 * 1024 * 1024) throw Error("WAV превышает 140 МиБ. Выберите фрагмент с полным кадром.");
    const audio = Wav.read(await file.arrayBuffer());
    byId("file-info").textContent = file.name + " · " + audio.rate + " Гц · " + (audio.samples.length / audio.rate).toFixed(2) + " с";
    const frame = await Robot36.decode(audio, f => status("decode-status", "Декодирование WAV · " + Math.round(f * 100) + "%"));
    picture.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
    byId("result").hidden = false;
    saveComplete(frame, file.name.replace(/\.wav$/i, ""));
    status("decode-status", "Кадр Robot 36 из WAV. Начало заголовка на " + frame.headerTime.toFixed(2) + " с.");
  } catch (e) {
    status("decode-status", e.message, true);
  } finally {
    processing = false;
    event.target.value = "";
    setControls();
  }
};
byId("example").onclick = () => download(wavBlob(referenceRobot36()), "robot36-bars.wav");
if (!navigator.serial) status("record-status", "Для приёма по USB откройте страницу в настольном Chrome или Edge.");
if (window.fieldStation) window.fieldStation.onReceiveState = setControls;
setControls();
