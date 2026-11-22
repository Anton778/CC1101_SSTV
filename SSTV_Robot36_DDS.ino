#include "src/SstvRadio.h"

constexpr SstvMode RADIO_MODE = SSTV_TX;      // SSTV_TX — передача, SSTV_RX — запись, SSTV_SCAN — поиск.
constexpr double CARRIER_FREQ_MHZ = 433.920;  // Канал для передачи или записи, МГц.
constexpr int8_t TX_POWER_DBM = 0;            // Мощность, дБм: -30, -20, -15, -10, 0, 5, 7 или 10.
constexpr double FREQ_OFFSET_KHZ = 0.0;       // Поправка своего модуля, кГц (+ выше, − ниже).
constexpr uint16_t FRAME_PAUSE_S = 10;        // Пауза после передачи картинки, с.

constexpr int SCAN_START_KHZ = 433720;        // Нижняя граница поиска, кГц.
constexpr int SCAN_END_KHZ   = 434120;        // Верхняя граница поиска, кГц.
constexpr uint16_t SCAN_STEP_KHZ{25};            // Шаг перестройки приёмника, кГц.
static_assert(SCAN_STEP_KHZ > 0 && SCAN_START_KHZ <= SCAN_END_KHZ && SCAN_END_KHZ <= 928000,
              "Проверьте границы и шаг поиска");

void setup() {
  double initialMHz = CARRIER_FREQ_MHZ;
  if (RADIO_MODE == SSTV_SCAN) initialMHz = SCAN_START_KHZ / 1000.0;
  beginStation(RADIO_MODE, initialMHz, FREQ_OFFSET_KHZ, TX_POWER_DBM);
}

void loop() {
  if (RADIO_MODE == SSTV_TX) {
    transmitPicture(FRAME_PAUSE_S);
  } else if (RADIO_MODE == SSTV_RX) {
    listenForPicture();
  } else {
    float strongest = -200;
    float weakest = 0;
    int bestKHz = SCAN_START_KHZ;
    for (int f = SCAN_START_KHZ; f <= SCAN_END_KHZ; f += SCAN_STEP_KHZ) {
      float rssi = measureReceiveRssi(f);     // Перестроить приёмник и измерить уровень, дБм.
      Serial.printf("%d кГц  %.1f дБм\n", f, rssi);
      if (rssi > strongest) {
        strongest = rssi;
        bestKHz = f;
      }
      if (rssi < weakest) weakest = rssi;
    }
    if (strongest - weakest >= 6) {           // Максимум заметно выше минимума прохода.
      Serial.printf("Кандидат: %d кГц (%.1f дБм)\n", bestKHz, strongest);
    } else {
      Serial.println("Выраженного пика нет.");
    }
    delay(1000);
  }
}
