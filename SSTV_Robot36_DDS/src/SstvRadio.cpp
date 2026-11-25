#include "SstvRadio.h"
#include "Robot36Tx.h"
#include "ImageStore.h"
#include "RxCapture.h"
#include "BoardProfile.h"
#include "PacketChat.h"
#include "StationCommands.h"
#include <SPI.h>
#include <esp_psram.h>
#include <RadioLib.h>
#include <cmath>

namespace {
using namespace BoardProfile;
CC1101 radio = new Module(PIN_CS, PIN_GDO0, RADIOLIB_NC, PIN_GDO2, SPI);

SstvMode mode = SSTV_RX;
ScanRange defaultScan{}, scan{};
double txMHz, rxMHz, chatMHz, offsetKHz;
int8_t txPowerDbm;
RadioTuning sketchTuning{}, requestedTuning{};
bool tuningPending = false, restoreTuning = false, persisted = true;
bool ready = false, repeatImages = true, repeatScan = false;
uint32_t nextFrameMs = 0, nextScanMs = 0;
bool awaitingFrame = false;
uint32_t frameId = 0;
void imageError(const char* why) { Serial.printf("IMG ERROR %s\n", why); }
void abortUpload(const char* why) {
  ImageStore::cancel();
  imageError(why);
}
void interruptFrame(const char* why) {
  if (awaitingFrame) { awaitingFrame = false; imageError(why); }
}

uint32_t applyOffset(double nominalHz, double correctionKHz) {
  const double hz = nominalHz + correctionKHz * 1000;
  if (!(hz >= 1 && hz <= UINT32_MAX)) return 0;
  return static_cast<uint32_t>(hz + 0.5);
}

uint32_t correctedHz(double nominalHz) { return applyOffset(nominalHz, offsetKHz); }

// Интервалы синтезатора CC1101. Весь проход должен лежать в одном интервале.
int band(uint32_t hz) {
  if (hz >= 300000000 && hz <= 348000000) return 1;
  if (hz >= 387000000 && hz <= 464000000) return 2;
  if (hz >= 779000000 && hz <= 928000000) return 3;
  return 0;
}
bool validRange(const ScanRange& r) {
  int firstBand = band(correctedHz(r.startKHz * 1000.0));
  return r.startKHz > 0 && r.startKHz <= r.endKHz && r.stepKHz > 0 &&
         r.endKHz <= INT32_MAX - r.stepKHz && std::isfinite(r.thresholdDbm) &&
         firstBand && firstBand == band(correctedHz(r.endKHz * 1000.0));
}
const char* modeName() {
  switch (mode) {
    case SSTV_TX: return "TX";
    case SSTV_SCAN: return "SCAN";
    case SSTV_CHAT: return "CHAT";
    default: return "RX";
  }
}
void releaseOutput() {
  if (Robot36Tx::active()) {
    Robot36Tx::stop();
    digitalWrite(PIN_GDO0, LOW);
  }
  pinMode(PIN_GDO0, INPUT);
}
bool radioOK(const char* operation, int16_t code) {
  if (code == RADIOLIB_ERR_NONE) return true;
  releaseOutput();
  radio.standby();
  interruptFrame("RADIO");
  ready = false;
  mode = SSTV_RX;
  Serial.println("FIELD ERROR RADIO");
  Serial.printf("SSTV ERROR RADIO %s %d\n", operation, code);
  return false;
}
void cancelRecording() {
  stopRxRecording(true);
  Serial.println("SSTV STOP");
}
bool selectMode(SstvMode requested, double channelMHz, bool retune = false) {
  if (!retune && ready && requested == mode && requested != SSTV_SCAN &&
      (mode != SSTV_TX || channelMHz == txMHz) && (mode != SSTV_RX || channelMHz == rxMHz) &&
      (mode != SSTV_CHAT || channelMHz == chatMHz)) {
    Serial.printf("FIELD MODE %s %.6f\n", modeName(), channelMHz);
    return true;
  }
  const uint32_t hz = correctedHz(channelMHz * 1e6);
  if (!band(hz)) { Serial.println("SSTV ERROR CHANNEL"); return false; }
  if (rxRecording()) cancelRecording();
  const bool interrupted = Robot36Tx::active();
  if (requested != SSTV_TX) interruptFrame("INTERRUPTED");
  releaseOutput();
  if (retune || !ready || ((mode == SSTV_CHAT) != (requested == SSTV_CHAT))) {
    ConfigFSK_t config;
    if (requested == SSTV_CHAT) {
      config.bitRate = 9600;
      config.receiverBandwidth = 58000;
    }
    config.frequency = hz;
    config.power = txPowerDbm;
    if (!radioOK("radio.begin", radio.begin(config))) return false;
    Serial.println("radio.begin = 0");
    if (requested != SSTV_CHAT) {
      if (!radioOK("setFrequencyDeviation", radio.setFrequencyDeviation(2000))) return false;
      Serial.println("setFrequencyDeviation = 0");
    }
  }
  if (!radioOK("standby", radio.standby())) return false;
  if (interrupted) Serial.println("Текущий кадр прерван.");
  if (!radioOK("setFrequency", radio.setFrequency(hz))) return false;
  if (requested == SSTV_TX) {
    if (!Robot36Tx::prepare(PIN_GDO0)) {
      ready = false;
      mode = SSTV_RX;
      Serial.println("SSTV ERROR DDS");
      return false;
    }
    txMHz = channelMHz;
    nextFrameMs = millis();
  } else if (requested == SSTV_CHAT) {
    if (!radioOK("packet RX", PacketChat::configure(radio))) return false;
    chatMHz = channelMHz;
  } else {
    const uint32_t bandwidth = requested == SSTV_SCAN ? 58000 : ConfigFSK_t{}.receiverBandwidth;
    if (!radioOK("setRxBandwidth", radio.setRxBandwidth(bandwidth)) ||
        !radioOK("receiveDirectAsync", radio.receiveDirectAsync())) return false;
    Serial.println("receiveDirectAsync = 0");
    if (requested == SSTV_RX) rxMHz = channelMHz;
    else nextScanMs = millis();
  }
  mode = requested;
  ready = true;
  Serial.printf("FIELD MODE %s %.6f\n", modeName(), channelMHz);
  Serial.printf("Режим %s, канал %.6f МГц, поправка %+.3f кГц, задано CC1101 %.6f МГц\n",
                modeName(), channelMHz, offsetKHz, hz / 1e6);
  return true;
}
bool fitsChannels(const RadioTuning& tuning) {
  const double offset = tuning.offsetHz / 1000.0;
  return band(applyOffset(txMHz * 1e6, offset)) && band(applyOffset(rxMHz * 1e6, offset)) &&
         band(applyOffset(chatMHz * 1e6, offset));
}
void printTuning() {
  if (tuningPending) {
    Serial.printf("FIELD TUNING PENDING %d %.3f\n", int(requestedTuning.powerDbm), requestedTuning.offsetHz / 1000.0);
  } else {
    Serial.printf("FIELD TUNING %s %d %.3f\n", persisted ? "ACTIVE" : "VOLATILE", int(txPowerDbm), offsetKHz);
  }
}
void applyPendingTuning() {
  if (!tuningPending || ImageStore::busy() || awaitingFrame || Robot36Tx::active() ||
      rxRecording() || mode == SSTV_SCAN) return;
  tuningPending = false;
  if (!fitsChannels(requestedTuning)) { Serial.println("FIELD ERROR TUNING_RANGE"); printTuning(); return; }
  const auto previousPower = txPowerDbm;
  const auto previousOffset = offsetKHz;
  const auto previousMode = mode;
  const auto nextTx = nextFrameMs;
  const double channel = mode == SSTV_TX ? txMHz : (mode == SSTV_CHAT ? chatMHz : rxMHz);
  const double offset = requestedTuning.offsetHz / 1000.0;
  if (!ready || txPowerDbm != requestedTuning.powerDbm || offsetKHz != offset) {
    txPowerDbm = requestedTuning.powerDbm;
    offsetKHz = offset;
    if (!selectMode(previousMode, channel, true)) {
      txPowerDbm = previousPower;
      offsetKHz = previousOffset;
      selectMode(previousMode, channel, true);
      nextFrameMs = nextTx;
      Serial.println("FIELD ERROR TUNING_RADIO");
      printTuning();
      return;
    }
    nextFrameMs = nextTx; // Не сокращаем штатную паузу между кадрами.
  }
  persisted = storeTuning(requestedTuning, restoreTuning);
  printTuning();
}
void printHelp() {
  Serial.println("TX [канал_МГц] | RX [канал_МГц] | Start_SSTV | Stop SSTV | STATUS | HELP");
  Serial.println("В RX: SCAN или SCAN начало_кГц конец_кГц порог_дБм [шаг_кГц]");
  Serial.println("CHAT [канал_МГц] | INFO | REC LIVE | STOP");
  Serial.println("TUNING [мощность_дБм поправка_кГц] | TUNING DEFAULT");
  Serial.println("Пример: SCAN 433720 434120 -75 25");
}
void command(const StationCommand& cmd) {
  if (ImageStore::busy() && (cmd.kind == Command::Rx || cmd.kind == Command::Chat ||
      cmd.kind == Command::StartImage || cmd.kind == Command::StopImage)) abortUpload("INTERRUPTED");
  switch (cmd.kind) {
    case Command::Info:
      Serial.printf("FIELD INFO 1 %s %s %.6f %.6f %.6f %d %d %u %u\n", BoardProfile::NAME, modeName(),
                    txMHz, rxMHz, chatMHz, ready, repeatImages,
                    unsigned(ESP.getFlashChipSize() >> 20), unsigned(esp_psram_get_size() >> 20));
      // Отдельная строка сохраняет совместимость INFO с прежним пультом.
      printTuning();
      Serial.println("FIELD CAP TX_CHANNEL");
      break;
    case Command::TuningGet:
      printTuning();
      break;
    case Command::TuningInvalid:
      Serial.println("FIELD ERROR TUNING_RANGE");
      break;
    case Command::TuningSet:
    case Command::TuningDefault: {
      if (rxRecording() || mode == SSTV_SCAN) { Serial.println("FIELD ERROR TUNING_BUSY"); break; }
      const bool reset = cmd.kind == Command::TuningDefault;
      const RadioTuning candidate = reset ? sketchTuning : cmd.tuning;
      if (!fitsChannels(candidate)) { Serial.println("FIELD ERROR TUNING_RANGE"); break; }
      restoreTuning = reset;
      requestedTuning = candidate;
      tuningPending = true;
      if (Robot36Tx::active() || ImageStore::busy() || awaitingFrame) printTuning();
      break;
    }
    case Command::Chat:
      if (rxRecording()) { Serial.println("FIELD ERROR BUSY"); break; }
      selectMode(SSTV_CHAT, cmd.channelMHz ? cmd.channelMHz : chatMHz);
      break;
    case Command::ChatMessage:
      if (!ready || mode != SSTV_CHAT) Serial.println("CHAT ERROR MODE");
      else radioOK("chat RX", PacketChat::send(radio, cmd.payload));
      break;
    case Command::ImageHello:
      Serial.println("IMG READY 1");
      break;
    case Command::ImageBegin: {
      if (rxRecording() || mode == SSTV_CHAT || awaitingFrame || ImageStore::busy()) { imageError("BUSY"); break; }
      if (!ready) { imageError("RADIO"); break; }
      const char* error = ImageStore::begin(cmd.imageSizeOrOffset, cmd.imageCrc);
      if (error) { imageError(error); break; }
      // Освобождаем эфир на время USB-загрузки. При обрыве возобновится прежний кадр.
      if (mode == SSTV_TX && Robot36Tx::active()) {
        releaseOutput();
        if (!radioOK("standby", radio.standby())) { abortUpload("RADIO"); break; }
      }
      Serial.printf("IMG ACCEPT %08lx %u\n", (unsigned long)cmd.imageCrc, (unsigned)ImageStore::BlockSize);
      break;
    }
    case Command::ImageBlock: {
      const char* error = ImageStore::append(cmd.imageSizeOrOffset, cmd.payload);
      if (error) abortUpload(error);
      else Serial.printf("IMG ACK %u\n", (unsigned)ImageStore::received());
      break;
    }
    case Command::ImageEnd: {
      const char* error = ImageStore::commit(cmd.imageCrc);
      ImageStore::cancel();
      if (error) { imageError(error); break; }
      frameId = cmd.imageCrc;
      Serial.printf("FIELD IMAGE %08lx %s\n", (unsigned long)frameId, ImageStore::inRam() ? "RAM" : "FLASH");
      Serial.printf("IMG STORED %08lx\n", (unsigned long)frameId);
      if (!selectMode(SSTV_TX, txMHz)) { imageError("RADIO"); break; }
      repeatImages = awaitingFrame = true;
      nextFrameMs = millis();
      break;
    }
    case Command::ImageCancel:
      ImageStore::cancel();
      Serial.println("IMG CANCELED");
      break;
    case Command::ImageInvalid:
      abortUpload("COMMAND");
      break;
    case Command::TxInvalid:
      Serial.println("FIELD ERROR TX_CHANNEL");
      break;
    case Command::Tx: {
      const double channel = cmd.channelMHz ? cmd.channelMHz : txMHz;
      if (cmd.channelMHz) {
        if (!band(correctedHz(channel * 1e6))) { Serial.println("FIELD ERROR TX_CHANNEL"); break; }
        if (channel != txMHz && (Robot36Tx::active() || awaitingFrame)) {
          Serial.println("FIELD ERROR TX_FRAME");
          break;
        }
        if (rxRecording() || ImageStore::busy()) { Serial.println("FIELD ERROR BUSY"); break; }
      } else if (ImageStore::busy()) {
        abortUpload("INTERRUPTED");
      }
      if (selectMode(SSTV_TX, channel)) {
        Serial.println(repeatImages ? "TX: повторы включены." : "TX: кадры остановлены. Для запуска — Start_SSTV.");
      }
      break;
    }
    case Command::Rx: {
      const double channel = cmd.channelMHz ? cmd.channelMHz : rxMHz;
      if (!band(correctedHz(channel * 1e6))) { Serial.println("SSTV ERROR CHANNEL"); break; }
      if (rxRecording() && channel != rxMHz) { Serial.println("SSTV BUSY"); break; }
      if (selectMode(SSTV_RX, channel)) Serial.printf("SSTV RX %.6f\n", rxMHz);
      break;
    }
    case Command::StartImage:
      if (mode != SSTV_TX || !ready) { Serial.println("Для передачи сначала введите TX."); break; }
      repeatImages = true;
      Serial.println("FIELD REPEAT 1");
      nextFrameMs = millis();
      Serial.println(Robot36Tx::active() ? "Кадр уже передаётся." : "Передача SSTV запущена.");
      break;
    case Command::StopImage:
      interruptFrame("INTERRUPTED");
      repeatImages = false;
      if (mode == SSTV_TX) {
        releaseOutput();
        if (!radioOK("standby", radio.standby())) break;
      }
      Serial.println("FIELD REPEAT 0");
      Serial.println("Передача SSTV остановлена.");
      break;
    case Command::Scan:
      if (!ready || mode != SSTV_RX) { Serial.println("Для нового прохода сначала введите RX."); break; }
      if (rxRecording() || ImageStore::busy()) { Serial.println("SSTV BUSY"); break; }
      if (!validRange(cmd.scan)) { Serial.println("FIELD ERROR RANGE"); Serial.println("Ошибка границ, шага или порога сканирования."); break; }
      scan = cmd.scan;
      repeatScan = false;
      selectMode(SSTV_SCAN, scan.startKHz / 1000.0);
      break;
    case Command::Status:
      Serial.printf("Режим %s, радио %s, TX %.6f МГц, RX %.6f МГц, кадры %s, повторы %s\n",
                    modeName(), ready ? "готово" : "ошибка", txMHz, rxMHz,
                    Robot36Tx::active() ? "в эфире" : "в ожидании", repeatImages ? "вкл" : "выкл");
      if (ImageStore::inRam()) Serial.println("Картинка из USB-загрузки в ОЗУ до перезапуска.");
      else Serial.println(ImageStore::hasImage() ? "Картинка из USB-загрузки во флеш." : "Встроенная картинка.");
      break;
    case Command::Ping:
      if (!ready) Serial.println("SSTV ERROR RADIO");
      else if (mode != SSTV_RX) Serial.printf("SSTV MODE %s\n", modeName());
      else Serial.println((rxRecording() || ImageStore::busy()) ? "SSTV BUSY" : "SSTV READY 1");
      break;
    case Command::RecordLive:
    case Command::Record:
      if (!ready || mode != SSTV_RX) Serial.println("SSTV ERROR RX");
      else if (rxRecording() || ImageStore::busy()) Serial.println("SSTV BUSY");
      else if (cmd.kind != Command::RecordLive && !cmd.seconds) Serial.println("SSTV ERROR DURATION");
      else startRxRecording(cmd.seconds, PIN_GDO0);
      break;
    case Command::StopRecording:
      cancelRecording();
      break;
    case Command::Help:
      printHelp();
      break;
    default:
      Serial.println("Команда или её параметры не распознаны. Список команд: HELP");
  }
}
}  // namespace

void beginStation(SstvMode initial, double channelMHz, double correctionKHz, int8_t powerDbm,
                  const ScanRange& defaults, double defaultChatMHz) {
  Serial.setRxBufferSize(2048);
#if !ARDUINO_USB_CDC_ON_BOOT || ARDUINO_USB_MODE
  Serial.setTxBufferSize(2048);
#endif
  Serial.begin(115200);
  delay(1500);
  Serial.println("=== SSTV ROBOT 36 / DDS / ESP32 + CC1101 ===");
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);
  txMHz = rxMHz = channelMHz;
  chatMHz = defaultChatMHz;
  offsetKHz = correctionKHz;
  txPowerDbm = powerDbm;
  sketchTuning = {powerDbm, static_cast<int32_t>(std::lround(correctionKHz * 1000.0))};
  RadioTuning saved{};
  if (readTuning(saved) && fitsChannels(saved)) {
    txPowerDbm = saved.powerDbm;
    offsetKHz = saved.offsetHz / 1000.0;
  }
  defaultScan = scan = defaults;
  repeatScan = initial == SSTV_SCAN;
  if (repeatScan && !validRange(scan)) {
    Serial.println("Ошибка настроек поиска. Переход в RX.");
    initial = SSTV_RX;
  }
  const double firstMHz = initial == SSTV_SCAN ? scan.startKHz / 1000.0 : (initial == SSTV_CHAT ? chatMHz : channelMHz);
  ImageStore::load();
  printHelp();
  selectMode(initial, firstMHz);
}
SstvMode pollStation() {
  if (ImageStore::expired(millis())) abortUpload("TIMEOUT");
  StationCommand cmd;
  if (readStationCommand(defaultScan, cmd)) command(cmd);
  applyPendingTuning();
  return mode;
}
const ScanRange& scanSettings() { return scan; }
bool scanDue() {
  if (static_cast<int32_t>(millis() - nextScanMs) >= 0) return true;
  delay(1);
  return false;
}
float measureReceiveRssi(int frequencyKHz) {
  if (!radioOK("scan frequency", radio.setFrequency(correctedHz(frequencyKHz * 1000.0))) ||
      !radioOK("scan RX", radio.receiveDirectAsync())) return NAN;
  delay(12);
  float sum = 0;
  for (int i = 0; i < 4; ++i) {
    sum += radio.getRSSI();
    delay(2);
  }
  return sum / 4;
}
void reportScanPoint(int frequencyKHz, float rssi, bool above) {
  Serial.printf("%d кГц  %.1f дБм  %s\n", frequencyKHz, rssi, above ? "СИГНАЛ" : "");
  Serial.printf("FIELD POINT %d %.2f %d\n", frequencyKHz, rssi, above);
}
void finishScan(int hits, int peakKHz, float peakDbm) {
  Serial.printf("FIELD DONE %d %d %.2f\n", hits, peakKHz, peakDbm);
  if (repeatScan) nextScanMs = millis() + 1000;
  else selectMode(SSTV_RX, rxMHz);
}
void listenForChat() {
  if (ready && digitalRead(BoardProfile::PIN_GDO0)) radioOK("chat RX", PacketChat::receive(radio));
  delay(1);
}
void listenForPicture() {
  static uint32_t previousReport = 0;
  if (ready && !serviceRxCapture() && millis() - previousReport >= 250) {
    Serial.printf("RSSI: %.1f дБм\n", radio.getRSSI());
    previousReport = millis();
  }
  delay(1);
}
void transmitPicture(uint16_t pauseSeconds) {
  if (!ready || !repeatImages || ImageStore::busy()) { delay(1); return; }
  if (!Robot36Tx::active()) {
    if (static_cast<int32_t>(millis() - nextFrameMs) < 0) { delay(1); return; }
    Serial.println("TX START: VIS + 240 строк");
    if (!radioOK("transmitDirectAsync", radio.transmitDirectAsync())) return;
    Serial.println("transmitDirectAsync = 0");
    pinMode(PIN_GDO0, OUTPUT);
    digitalWrite(PIN_GDO0, LOW);
    if (!Robot36Tx::start()) {
      releaseOutput();
      radioOK("standby", radio.standby());
      repeatImages = false;
      interruptFrame("READ");
      Serial.println("SSTV ERROR IMAGE READ");
      return;
    }
    if (awaitingFrame) Serial.printf("IMG AIR %08lx\n", (unsigned long)frameId);
  }
  if (Robot36Tx::advance()) {
    releaseOutput();
    if (!radioOK("standby", radio.standby())) return;
    if (Robot36Tx::readFailed()) {
      repeatImages = false;
      interruptFrame("READ");
      Serial.println("SSTV ERROR IMAGE READ");
      return;
    }
    if (awaitingFrame) {
      Serial.printf("IMG SENT %08lx\n", (unsigned long)frameId);
      awaitingFrame = false;
    }
    nextFrameMs = millis() + uint32_t(pauseSeconds) * 1000;
    Serial.println("TX STOP: кадр передан.");
    Robot36Tx::printTiming();
    Serial.printf("Пауза %u с.\n", static_cast<unsigned>(pauseSeconds));
  }
}
