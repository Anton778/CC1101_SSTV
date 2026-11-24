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
  const locked = processing || Boolean(captureController);
  byId("record").disabled = locked || !navigator.serial || Boolean(window.fieldStation && !window.fieldStation.canRecord());
  if (byId("compare")) byId("compare").disabled = byId("load-bars").disabled = locked;
  byId("wav-file").disabled = processing || Boolean(captureController);
  byId("decode").disabled = processing || Boolean(captureController) || !selectedAudio;
  byId("sweep").disabled = byId("run-wav-command").disabled = processing || Boolean(captureController) || !selectedAudio;
}

if (!navigator.serial) {
  byId("record").disabled = true;
  status("record-status", "Для записи по USB откройте эту страницу в настольном Chrome или Edge. Открыть готовый WAV можно здесь.");
}
byId("record").onclick = async () => {
  const field = window.fieldStation;
  if (processing || captureController || (field && !field.session())) return;
  const seconds = byId("seconds").valueAsNumber;
  if (!byId("seconds").reportValidity() || !byId("rx-channel").reportValidity()) return;
  const rxMHz = byId("rx-channel").value === "" ? null : byId("rx-channel").valueAsNumber;
  if (field && !field.beginCapture()) return;
  captureController = new AbortController();
  byId("rx-channel").disabled = byId("seconds").disabled = byId("record").disabled = true;
  byId("cancel").hidden = false;
  const progress = byId("record-progress");
  progress.max = seconds;
  progress.value = 0;
  fileControls();
  status("record-status", "Подключение к приёмной ESP32…");
  try {
    const source = field ? field.session() : await navigator.serial.requestPort();
    const capture = field ? captureOnSession : captureFromPort;
    const audio = await capture(source, seconds, captureController.signal, elapsed => {
      progress.hidden = false;
      progress.value = elapsed;
      status("record-status", "Идёт запись: " + elapsed + " из " + seconds + " с.");
    }, rxMHz);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    setLink("save-recording", new Blob([Wav.write(audio)], {type: wavType}), "robot36-rx-" + stamp + ".wav");
    byId("cancel").hidden = true;
    status("record-status", "Принято " + seconds + " с. Декодирование началось.");
    selectedAudio = audio;
    baseName = "robot36-rx-" + stamp;
    byId("file-info").textContent = "Запись с платы · " + audio.rate + " Гц · " + seconds + " с";
    await decodeSelected();
  } catch (e) {
    let message = e.message;
    if (e.name === "NotFoundError") message = "Выбор порта отменён.";
    if (e.name === "NetworkError") message = "Не удалось открыть или прочитать порт. Закройте монитор порта и проверьте USB-кабель.";
    status("record-status", message, true);
  } finally {
    captureController = null;
    field?.endCapture();
    byId("rx-channel").disabled = byId("seconds").disabled = byId("record").disabled = false;
    byId("cancel").hidden = progress.hidden = true;
    fileControls();
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

async function decodeSelected() {
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
}

byId("decode").onclick = decodeSelected;
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

// В общем пульте контрольная запись и опыт доступны без радиоплаты.
if (byId("load-bars")) byId("load-bars").onclick = async () => {
  if (processing || captureController) return;
  selectedAudio = referenceRobot36();
  baseName = "robot36-bars";
  byId("file-info").textContent = "Контрольная запись · цветовые полосы";
  await decodeSelected();
};
if (byId("compare")) byId("compare").onclick = async () => {
  if (processing || captureController) return;
  const fields = ["low", "high", "period", "level"].map(byId);
  if (!fields.every(field => field.reportValidity())) return;
  processing = true;
  fileControls();
  const output = byId("comparison");
  output.hidden = true;
  try {
    const source = selectedAudio || referenceRobot36();
    status("sweep-status", "Декодирование исходной записи…");
    const clean = await Robot36.decode(source, () => {});
    byId("clean-frame").getContext("2d").putImageData(new ImageData(clean.pixels, clean.width, clean.height), 0, 0);
    output.hidden = false;
    byId("mixed-frame").getContext("2d").clearRect(0, 0, 320, 240);
    status("sweep-status", "Декодирование копии со свипом…");
    const mixed = await Robot36.decode(addAudioSweep(source, ...fields.map(f => f.valueAsNumber)), () => {});
    byId("mixed-frame").getContext("2d").putImageData(new ImageData(mixed.pixels, mixed.width, mixed.height), 0, 0);
    status("sweep-status", "Строк с синхронизацией из 240. Исходный кадр — " + clean.locked + ", со свипом — " + mixed.locked + ".");
  } catch (e) { status("sweep-status", e.message, true); }
  finally { processing = false; fileControls(); }
};
