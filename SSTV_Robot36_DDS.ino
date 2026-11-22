#include "src/SstvRadio.h"

// Robot 36 — настройки станции
constexpr SstvMode RADIO_MODE = SSTV_TX;      // SSTV_TX — передача, SSTV_RX — приём.
constexpr double CARRIER_FREQ_MHZ = 433.920;  // Частота канала на рации, МГц.
constexpr int8_t TX_POWER_DBM = 0;            // Мощность, дБм. Выберите -30, -20, -15, -10, 0, 5, 7 или 10.
constexpr double FREQ_OFFSET_KHZ = 0.0;       // Поправка, кГц. Плюс повышает частоту, минус понижает.
constexpr uint16_t FRAME_PAUSE_S = 10;        // Пауза между передачами картинки, с.
