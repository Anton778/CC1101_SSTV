"use strict";

const byId = id => document.getElementById(id);
const wavType = "audio/wav";
let selectedAudio, baseName, captureController, processing = false;

function status(id, text, error = false) {
  const node = byId(id);
  node.textContent = text;
  node.classList.toggle("error", error);
}

function setLink(id, blob, filename) {
  const link = byId(id);
  if (link.hasAttribute("href")) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.hidden = false;
}

function downloadWav(audio, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([Wav.write(audio)], {type: wavType}));
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function fileControls() {
  byId("wav-file").disabled = processing;
  byId("decode").disabled = processing || !selectedAudio;
  byId("sweep").disabled = byId("run-wav-command").disabled = processing || !selectedAudio;
}

if (!navigator.serial) {
  byId("record").disabled = true;
  status("record-status", "Для записи по USB откройте эту страницу в настольном Chrome или Edge. Открыть готовый WAV можно здесь.");
}
byId("record").onclick = async () => {
  const seconds = byId("seconds").valueAsNumber;
  if (!byId("seconds").reportValidity() || !byId("rx-channel").reportValidity()) return;
  const rxMHz = byId("rx-channel").value === "" ? null : byId("rx-channel").valueAsNumber;
  captureController = new AbortController();
  byId("rx-channel").disabled = byId("seconds").disabled = byId("record").disabled = true;
  byId("cancel").hidden = false;
  const progress = byId("record-progress");
  progress.max = seconds;
  progress.value = 0;
  status("record-status", "Выберите USB-порт приёмной ESP32.");
  try {
    const port = await navigator.serial.requestPort();
    status("record-status", "Подключение к приёмной ESP32…");
    const audio = await captureFromPort(port, seconds, captureController.signal, elapsed => {
      progress.hidden = false;
      progress.value = elapsed;
      status("record-status", "Идёт запись: " + elapsed + " из " + seconds + " с.");
    }, rxMHz);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    setLink("save-recording", new Blob([Wav.write(audio)], {type: wavType}), "robot36-rx-" + stamp + ".wav");
    status("record-status", "Принято " + seconds + " с. Сохраните WAV и выберите его в разделе декодирования.");
  } catch (e) {
    let message = e.message;
    if (e.name === "NotFoundError") message = "Выбор порта отменён.";
    if (e.name === "NetworkError") message = "Не удалось открыть или прочитать порт. Закройте монитор порта и проверьте USB-кабель.";
    status("record-status", message, true);
  } finally {
    captureController = null;
    byId("rx-channel").disabled = byId("seconds").disabled = byId("record").disabled = false;
    byId("cancel").hidden = progress.hidden = true;
  }
};
byId("cancel").onclick = () => captureController?.abort();

byId("wav-file").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  processing = true;
  selectedAudio = null;
  byId("result").hidden = byId("save-picture").hidden = true;
  status("decode-status", "");
  status("sweep-status", "");
  fileControls();
  try {
    if (file.size > 140 * 1024 * 1024) throw Error("WAV превышает 140 МиБ. Оставьте фрагмент с одним полным кадром.");
    selectedAudio = Wav.read(await file.arrayBuffer());
    baseName = file.name.replace(/\.wav$/i, "");
    byId("file-info").textContent = file.name + " · " + selectedAudio.rate + " Гц · " +
      (selectedAudio.samples.length / selectedAudio.rate).toFixed(1) + " с";
  } catch (e) {
    byId("file-info").textContent = file.name;
    status("decode-status", e.message, true);
  } finally {
    processing = false;
    fileControls();
  }
};

byId("decode").onclick = async () => {
  processing = true;
  fileControls();
  byId("result").hidden = byId("save-picture").hidden = true;
  try {
    const frame = await Robot36.decode(selectedAudio, fraction => {
      status("decode-status", "Обработка сигнала: " + Math.round(100 * fraction) + " %");
    });
    const canvas = byId("picture");
    canvas.getContext("2d").putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!png) throw Error("Браузер не смог создать PNG.");
    setLink("save-picture", png, baseName + ".png");
    byId("caption").textContent = "Начало заголовка на " + frame.headerTime.toFixed(2) +
      " с. Строк с синхронизацией: " + frame.locked + " из 240.";
    byId("result").hidden = false;
    status("decode-status", "Принят кадр Robot 36, VIS = 8.");
  } catch (e) {
    status("decode-status", e.message, true);
  } finally {
    processing = false;
    fileControls();
  }
};

byId("example").onclick = () => downloadWav(referenceRobot36(), "robot36-bars.wav");
function saveSweep(createAudio) {
  if (!selectedAudio) return;
  try {
    const audio = createAudio();
    downloadWav(audio, baseName + "-sweep.wav");
    status("sweep-status", "Копия подготовлена. Выберите WAV со свипом в разделе декодирования.");
  } catch (e) {
    status("sweep-status", e.message, true);
  }
}
byId("sweep").onclick = () => {
  const fields = ["low", "high", "period", "level"].map(byId);
  if (fields.every(field => field.reportValidity())) {
    saveSweep(() => addAudioSweep(selectedAudio, ...fields.map(field => field.valueAsNumber)));
  }
};
byId("wav-command-form").onsubmit = event => {
  event.preventDefault();
  saveSweep(() => sweepFromCommand(selectedAudio, byId("wav-command").value));
};
