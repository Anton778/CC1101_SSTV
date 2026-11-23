#include "SstvRadio.h"
#include "Robot36Tx.h"
#include "ImageStore.h"
#include "RxCapture.h"
#include "StationCommands.h"
#include <SPI.h>
#include <RadioLib.h>
#include <cmath>

namespace {
constexpr uint8_t PIN_SCK = 18, PIN_MISO = 19, PIN_MOSI = 23;
constexpr uint8_t PIN_CS = 21, PIN_GDO0 = 4, PIN_GDO2 = 27;
CC1101 radio = new Module(PIN_CS, PIN_GDO0, RADIOLIB_NC, PIN_GDO2);

SstvMode mode = SSTV_RX;
ScanRange defaultScan{}, scan{};
double txMHz, rxMHz, offsetKHz;
int8_t txPowerDbm;
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

uint32_t correctedHz(double nominalHz) {
  const double hz = nominalHz + offsetKHz * 1000;
  if (!(hz >= 1 && hz <= UINT32_MAX)) return 0;
  return static_cast<uint32_t>(hz + 0.5);
}

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
  return mode == SSTV_TX ? "TX" : (mode == SSTV_SCAN ? "SCAN" : "RX");
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
  Serial.printf("SSTV ERROR RADIO %s %d\n", operation, code);
  return false;
}
void cancelRecording() {
  stopRxRecording();
  Serial.println("SSTV STOP");
}
bool selectMode(SstvMode requested, double channelMHz) {
  if (ready && requested == mode && requested != SSTV_SCAN &&
      (mode != SSTV_RX || channelMHz == rxMHz)) return true;
  const uint32_t hz = correctedHz(channelMHz * 1e6);
  if (!band(hz)) { Serial.println("SSTV ERROR CHANNEL"); return false; }
  if (rxRecording()) cancelRecording();
  const bool interrupted = Robot36Tx::active();
  if (requested != SSTV_TX) interruptFrame("INTERRUPTED");
  releaseOutput();
  if (!ready) {
    ConfigFSK_t config;
    config.frequency = hz;
    config.power = txPowerDbm;
    if (!radioOK("radio.begin", radio.begin(config))) return false;
    Serial.println("radio.begin = 0");
    if (!radioOK("setFrequencyDeviation", radio.setFrequencyDeviation(2000))) return false;
    Serial.println("setFrequencyDeviation = 0");
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
    nextFrameMs = millis();
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
  Serial.printf("Режим %s, канал %.6f МГц, поправка %+.3f кГц, задано CC1101 %.6f МГц\n",
                modeName(), channelMHz, offsetKHz, hz / 1e6);
  return true;
}
void printHelp() {
  Serial.println("TX | RX [канал_МГц] | Start_SSTV | Stop SSTV | STATUS | HELP");
  Serial.println("В RX: SCAN или SCAN начало_кГц конец_кГц порог_дБм [шаг_кГц]");
  Serial.println("Пример: SCAN 433720 434120 -75 25");
}
void command(const StationCommand& cmd) {
  if (ImageStore::busy() && (cmd.kind == Command::Rx || cmd.kind == Command::Tx ||
      cmd.kind == Command::StartImage || cmd.kind == Command::StopImage)) abortUpload("INTERRUPTED");
  switch (cmd.kind) {
    case Command::ImageHello:
      Serial.println("IMG READY 1");
      break;
    case Command::ImageBegin: {
      if (rxRecording() || awaitingFrame || ImageStore::busy()) { imageError("BUSY"); break; }
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
    case Command::Tx:
      if (selectMode(SSTV_TX, txMHz)) Serial.println(repeatImages ? "TX: повторы включены." : "TX: кадры остановлены. Для запуска — Start_SSTV.");
      break;
    case Command::Rx: {
      const double channel = cmd.rxMHz ? cmd.rxMHz : rxMHz;
      if (!band(correctedHz(channel * 1e6))) { Serial.println("SSTV ERROR CHANNEL"); break; }
      if (rxRecording() && channel != rxMHz) { Serial.println("SSTV BUSY"); break; }
      if (selectMode(SSTV_RX, channel)) Serial.printf("SSTV RX %.6f\n", rxMHz);
      break;
    }
    case Command::StartImage:
      if (mode != SSTV_TX || !ready) { Serial.println("Для передачи сначала введите TX."); break; }
      repeatImages = true;
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
      Serial.println("Передача SSTV остановлена.");
      break;
    case Command::Scan:
      if (!ready || mode != SSTV_RX) { Serial.println("Для нового прохода сначала введите RX."); break; }
      if (rxRecording() || ImageStore::busy()) { Serial.println("SSTV BUSY"); break; }
      if (!validRange(cmd.scan)) { Serial.println("Ошибка границ, шага или порога сканирования."); break; }
      scan = cmd.scan;
      repeatScan = false;
      selectMode(SSTV_SCAN, scan.startKHz / 1000.0);
      break;
    case Command::Status:
      Serial.printf("Режим %s, радио %s, TX %.6f МГц, RX %.6f МГц, кадры %s, повторы %s\n",
                    modeName(), ready ? "готово" : "ошибка", txMHz, rxMHz,
                    Robot36Tx::active() ? "в эфире" : "в ожидании", repeatImages ? "вкл" : "выкл");
      Serial.println(ImageStore::hasImage() ? "Картинка из USB-загрузки." : "Встроенная картинка.");
      break;
    case Command::Ping:
      if (!ready) Serial.println("SSTV ERROR RADIO");
      else if (mode != SSTV_RX) Serial.printf("SSTV MODE %s\n", modeName());
      else Serial.println((rxRecording() || ImageStore::busy()) ? "SSTV BUSY" : "SSTV READY 1");
      break;
    case Command::Record:
      if (!ready || mode != SSTV_RX) Serial.println("SSTV ERROR RX");
      else if (rxRecording() || ImageStore::busy()) Serial.println("SSTV BUSY");
      else if (!cmd.seconds) Serial.println("SSTV ERROR DURATION");
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
                  const ScanRange& defaults) {
  Serial.setRxBufferSize(2048);
  Serial.setTxBufferSize(2048);
  Serial.begin(115200);
  delay(1500);
  Serial.println("=== SSTV ROBOT 36 / DDS / ESP32 + CC1101 ===");
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);
  txMHz = rxMHz = channelMHz;
  offsetKHz = correctionKHz;
  txPowerDbm = powerDbm;
  defaultScan = scan = defaults;
  repeatScan = initial == SSTV_SCAN;
  if (repeatScan && !validRange(scan)) {
    Serial.println("Ошибка настроек поиска. Переход в RX.");
    initial = SSTV_RX;
  }
  const double firstMHz = initial == SSTV_SCAN ? scan.startKHz / 1000.0 : channelMHz;
  ImageStore::load();
  printHelp();
  selectMode(initial, firstMHz);
}
SstvMode pollStation() {
  if (ImageStore::expired(millis())) abortUpload("TIMEOUT");
  StationCommand cmd;
  if (readStationCommand(defaultScan, cmd)) command(cmd);
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
void finishScan() {
  if (repeatScan) nextScanMs = millis() + 1000;
  else selectMode(SSTV_RX, rxMHz);
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
