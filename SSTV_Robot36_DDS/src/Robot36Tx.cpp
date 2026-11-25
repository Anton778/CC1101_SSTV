#include "Robot36Tx.h"
#include "ImageStore.h"
#include <Arduino.h>
#include "soc/soc.h"
#include "soc/gpio_reg.h"
#include "../image_data.h"

namespace {
constexpr uint16_t IMAGE_WIDTH  = 320;
constexpr uint16_t IMAGE_HEIGHT = 256;
constexpr uint16_t SSTV_WIDTH   = 320;
constexpr uint16_t SSTV_HEIGHT  = 240;
static_assert(sizeof(image_map) / sizeof(image_map[0]) ==
              (size_t)IMAGE_WIDTH * IMAGE_HEIGHT,
              "image_data.h должен содержать 320x256 пикселей RGB565");

// === СИНТЕЗ ЗВУКОВОГО ТОНА С НЕПРЕРЫВНОЙ ФАЗОЙ (DDS) ===
// В отличие от ledcChangeFrequency(), изменение частоты не сбрасывает фазу.
// GPIO4 работает как цифровой вход асинхронной 2-FSK CC1101.
// Arduino-ESP32 3.x, ESP32 и ESP32-S3.
constexpr uint32_t AUDIO_TICK_HZ = 80000; // 12,5 мкс между отсчётами
uint32_t dataMask = 0;
hw_timer_t* audioTimer = nullptr;
volatile uint32_t phaseAcc = 0;
volatile uint32_t phaseStep = 0;
volatile bool audioActive = false;

void IRAM_ATTR audioISR() {
  if (!audioActive) {
    return;
  }
  phaseAcc += phaseStep;
  // Прямой доступ к регистрам GPIO (быстро, без digitalWrite в ISR).
  if (phaseAcc & 0x80000000UL) {
    REG_WRITE(GPIO_OUT_W1TS_REG, dataMask);
  } else {
    REG_WRITE(GPIO_OUT_W1TC_REG, dataMask);
  }
}

inline uint32_t frequencyToStep(uint16_t hz) {
  return (uint32_t)(((uint64_t)hz << 32) / AUDIO_TICK_HZ);
}

// Единая временная сетка для VIS и всех 240 строк.
uint32_t toneDeadlineUs = 0;
uint32_t lateTones = 0;
uint32_t worstLateUs = 0;

inline void startTone(uint16_t frequencyHz, uint32_t durationUs) {
  // Меняем только приращение фазы; сам аккумулятор не обнуляем.
  phaseStep = frequencyToStep(frequencyHz);
  toneDeadlineUs += durationUs;
}
inline void waitTone() {
  while ((int32_t)(micros() - toneDeadlineUs) < 0) {
    // Ждём заданную границу сегмента, не накапливая задержки вычисления.
  }
  const int32_t late = (int32_t)(micros() - toneDeadlineUs);
  if (late > 50) {
    ++lateTones;
  }
  if (late > 0 && (uint32_t)late > worstLateUs) {
    worstLateUs = late;
  }
}

inline void playTone(uint16_t hz, uint32_t durationUs) {
  startTone(hz, durationUs);
  waitTone();
}

// VIS = 8, семь бит младшим вперёд, бит чётности и стоповый тон.
struct VisTone { uint16_t hz, ms; };
constexpr VisTone VIS[] = {
  {1900,300}, {1200,10}, {1900,300}, {1200,30},
  {1300,30}, {1300,30}, {1300,30}, {1100,30}, {1300,30}, {1300,30}, {1300,30},
  {1100,30}, {1200,30}
};
unsigned visIndex = 0;
uint16_t lineIndex = 0;
uint32_t frameStartUs = 0, elapsedMs = 0;

bool storedFrame = false, readError = false;
uint16_t rowPixels[SSTV_WIDTH];
static_assert(SSTV_WIDTH == ImageStore::Width && SSTV_HEIGHT == ImageStore::Height, "Robot 36 geometry");

inline void unpack565(uint16_t c, uint8_t& r, uint8_t& g, uint8_t& b) {
  r = ((c >> 11) & 0x1F) * 255 / 31;
  g = ((c >> 5)  & 0x3F) * 255 / 63;
  b = (c & 0x1F) * 255 / 31;
}

void sendRobot36Line(uint16_t y) {
  startTone(1200, 9000);  // Читаем строку во время синхроимпульса.
  const uint16_t* row = rowPixels;
  if (storedFrame) {
    if (!ImageStore::readRow(rowPixels)) { readError = true; return; }
  } else {
    const uint16_t srcY = (uint32_t(2 * y + 1) * IMAGE_HEIGHT) / (2 * SSTV_HEIGHT);
    row = &image_map[uint32_t(srcY) * IMAGE_WIDTH];
  }
  waitTone();
  playTone(1500, 3000);  // Площадка 3 мс

  // Y: 320 * 275 мкс = 88 мс.
  for (uint16_t x = 0; x < SSTV_WIDTH; ++x) {
    uint8_t r, g, b;
    unpack565(pgm_read_word(row + x), r, g, b);
    const uint8_t Y = (uint8_t)(0.299f * r + 0.587f * g + 0.114f * b);
    const uint16_t frequencyY = 1500 + (uint32_t)Y * 800 / 255;
    playTone(frequencyY, 275);
  }

  const bool even = ((y & 1U) == 0);
  playTone(even ? 1500 : 2300, 4500); // R-Y / B-Y
  playTone(1900, 1500);

  // Цветность: 320 * 137,5 мкс = 44 мс.
  for (uint16_t x = 0; x < SSTV_WIDTH; ++x) {
    uint8_t r, g, b;
    unpack565(pgm_read_word(row + x), r, g, b);
    int16_t chroma = even
      ? (128 + (int16_t)(0.500f * r - 0.419f * g - 0.081f * b))
      : (128 + (int16_t)(-0.169f * r - 0.331f * g + 0.500f * b));
    if (chroma < 0) chroma = 0;
    if (chroma > 255) chroma = 255;
    const uint16_t frequencyC = 1500 + (uint32_t)chroma * 800 / 255;
    // 137+138 мкс = 275 мкс за каждые два пикселя.
    playTone(frequencyC, (x & 1U) ? 138 : 137);
  }
}

}  // namespace

namespace Robot36Tx {
bool prepare(uint8_t pin) {
  if (audioTimer) return true;
  dataMask = 1UL << pin;
  audioTimer = timerBegin(AUDIO_TICK_HZ);
  if (!audioTimer) return false;
  timerStop(audioTimer);
  if (timerGetFrequency(audioTimer) != AUDIO_TICK_HZ) {
    timerEnd(audioTimer);
    audioTimer = nullptr;
    return false;
  }
  timerAttachInterrupt(audioTimer, &audioISR);
  timerAlarm(audioTimer, 1, true, 0);
  Serial.println("DDS tick: 80000 Гц");
  return true;
}

bool start() {
  storedFrame = ImageStore::hasImage();
  readError = !ImageStore::openFrame();
  if (readError) return false;
  phaseAcc = lateTones = worstLateUs = 0;
  visIndex = lineIndex = 0;
  phaseStep = frequencyToStep(VIS[0].hz);
  audioActive = true;
  timerRestart(audioTimer);
  timerStart(audioTimer);
  frameStartUs = toneDeadlineUs = micros();
  return true;
}

bool advance() {
  // Таймер продолжает воспроизводить заголовок, пока основной цикл читает порт.
  if (lineIndex == 0) {
    int32_t remaining = static_cast<int32_t>(toneDeadlineUs - micros());
    if (remaining > 0) {
      if (remaining > 2500) delay(1);
      return false;
    }
    if (visIndex < sizeof(VIS) / sizeof(VIS[0])) {
      const VisTone tone = VIS[visIndex++];
      phaseStep = frequencyToStep(tone.hz);
      toneDeadlineUs += tone.ms * 1000U;
      return false;
    }
  }
  sendRobot36Line(lineIndex++);
  return readError || lineIndex == SSTV_HEIGHT;
}

bool active() { return audioActive; }
bool readFailed() { return readError; }

void stop() {
  if (!audioActive) return;
  elapsedMs = (micros() - frameStartUs) / 1000;
  audioActive = false;
  timerStop(audioTimer);
  ImageStore::closeFrame();
}

void printTiming() {
  Serial.printf("Длительность = %lu мс. Опозданий >50 мкс: %lu, максимум = %lu мкс\n",
                (unsigned long)elapsedMs, (unsigned long)lateTones, (unsigned long)worstLateUs);
}
}  // namespace Robot36Tx
