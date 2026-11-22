#pragma once

#include <stdint.h>

enum SstvMode { SSTV_TX, SSTV_RX };

// Эти настройки задаются в основном скетче. Arduino вызывает setup() и loop() из SstvRadio.cpp.
extern const SstvMode RADIO_MODE;
extern const double CARRIER_FREQ_MHZ;
extern const int8_t TX_POWER_DBM;
extern const double FREQ_OFFSET_KHZ;
extern const uint16_t FRAME_PAUSE_S;
