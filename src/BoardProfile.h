#pragma once
#include <Arduino.h>

namespace BoardProfile {
constexpr uint8_t PIN_CS = 21, PIN_GDO0 = 4;
#if CONFIG_IDF_TARGET_ESP32S3
constexpr char NAME[] = "ESP32S3";
constexpr uint8_t PIN_SCK = 12, PIN_MISO = 13, PIN_MOSI = 11, PIN_GDO2 = 5;
#elif CONFIG_IDF_TARGET_ESP32
constexpr char NAME[] = "ESP32";
constexpr uint8_t PIN_SCK = 18, PIN_MISO = 19, PIN_MOSI = 23, PIN_GDO2 = 27;
#else
#error "Select ESP32 Dev Module or ESP32S3 Dev Module (N16R8)"
#endif
static_assert(PIN_GDO0 < 32, "DDS and RX use GPIO bank 0");
}
