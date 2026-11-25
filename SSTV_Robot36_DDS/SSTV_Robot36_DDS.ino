#include "src/SstvRadio.h"

constexpr SstvMode RADIO_MODE = SSTV_TX;      // Режим при включении. Затем вводите TX или RX в монитор порта.
constexpr double CARRIER_FREQ_MHZ = 433.920;  // Номинальная частота канала, МГц.
constexpr double CHAT_FREQ_MHZ = 433.500;     // Отдельный канал текста, одинаковый у двух постов.
constexpr int8_t TX_POWER_DBM = 0;            // Мощность SSTV, дБм: -30, -20, -15, -10, 0, 5, 7 или 10.
constexpr double FREQ_OFFSET_KHZ = 0.0;       // Поправка своего CC1101, кГц (+ выше, − ниже).
constexpr uint16_t FRAME_PAUSE_S = 10;        // Пауза после полной картинки, с.

constexpr int SCAN_START_KHZ = 433720;        // Нижняя граница поиска, кГц.
constexpr int SCAN_END_KHZ = 434120;          // Верхняя граница поиска, кГц.
constexpr int SCAN_STEP_KHZ = 25;             // Шаг приёмника, кГц.
constexpr float SCAN_THRESHOLD_DBM = -75;     // Отмечать сигналы с RSSI выше этого уровня.

void setup() {
  beginStation(RADIO_MODE, CARRIER_FREQ_MHZ, FREQ_OFFSET_KHZ, TX_POWER_DBM,
               {SCAN_START_KHZ, SCAN_END_KHZ, SCAN_STEP_KHZ, SCAN_THRESHOLD_DBM}, CHAT_FREQ_MHZ);
}

void loop() {
  SstvMode mode = pollStation();              // Прочитать команду из монитора порта.
  if (mode == SSTV_TX) {
    transmitPicture(FRAME_PAUSE_S);
  } else if (mode == SSTV_RX) {
    listenForPicture();
  } else if (mode == SSTV_CHAT) {
    listenForChat();
  } else if (scanDue()) {
    ScanRange scan = scanSettings();
    int signals = 0;
    float strongest = -200;
    int bestKHz = scan.startKHz;
    for (int f = scan.startKHz; f <= scan.endKHz; f += scan.stepKHz) {
      if (pollStation() != SSTV_SCAN) return; // Команда RX или TX прерывает проход.
      float rssi = measureReceiveRssi(f);
      if (!isfinite(rssi)) return;
      bool above = rssi > scan.thresholdDbm;
      reportScanPoint(f, rssi, above);
      if (above) {
        ++signals;
        if (rssi > strongest) {
          strongest = rssi;
          bestKHz = f;
        }
      }
    }
    if (signals > 0) {
      Serial.printf("Точек выше порога: %d. Максимум: %d кГц, %.1f дБм\n", signals, bestKHz, strongest);
    } else {
      Serial.println("Сигналов выше порога нет.");
    }
    finishScan(signals, bestKHz, strongest);
  }
}
