#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include "soc/gpio_struct.h"
#include "image_data.h"

// SSTV Robot 36, ESP32-WROOM-32 + CC1101.
// Подключения не изменены: CSN=21, GDO0=4, GDO2=27,
// SCK=18, MISO=19, MOSI=23. Питание CC1101: только 3,3 В.
constexpr uint8_t PIN_SCK  = 18;
constexpr uint8_t PIN_MISO = 19;
constexpr uint8_t PIN_MOSI = 23;
constexpr uint8_t PIN_CS   = 21;
constexpr uint8_t PIN_GDO0 = 4;
constexpr uint8_t PIN_GDO2 = 27;

constexpr double CARRIER_FREQ_MHZ = 433.920; // Частота канала на рации, МГц.
constexpr double TX_FREQ_OFFSET_KHZ = 0.0;   // Поправка CC1101 в кГц. Знак + повышает частоту, знак − понижает.
constexpr int8_t TX_POWER_DBM = 0; // Вблизи SDR; первоначально было +10 dBm.

constexpr uint16_t IMAGE_WIDTH  = 320;
constexpr uint16_t IMAGE_HEIGHT = 256;
constexpr uint16_t SSTV_WIDTH   = 320;
constexpr uint16_t SSTV_HEIGHT  = 240;
static_assert(sizeof(image_map) / sizeof(image_map[0]) ==
              (size_t)IMAGE_WIDTH * IMAGE_HEIGHT,
              "image_data.h должен содержать 320x256 пикселей RGB565");

CC1101 radio = new Module(PIN_CS, PIN_GDO0, RADIOLIB_NC, PIN_GDO2);

// === СИНТЕЗ ЗВУКОВОГО ТОНА С НЕПРЕРЫВНОЙ ФАЗОЙ (DDS) ===
// В отличие от ledcChangeFrequency(), изменение частоты не сбрасывает фазу.
// GPIO4 работает как цифровой вход асинхронной 2-FSK CC1101.
// Arduino-ESP32 3.x, только классический ESP32/ESP32-WROOM-32.
constexpr uint32_t AUDIO_TICK_HZ = 80000; // 12,5 мкс между отсчётами
constexpr uint32_t GDO0_MASK = (1UL << PIN_GDO0);
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
    GPIO.out_w1ts = GDO0_MASK;
  } else {
    GPIO.out_w1tc = GDO0_MASK;
  }
}

inline uint32_t frequencyToStep(uint16_t hz) {
  return (uint32_t)(((uint64_t)hz << 32) / AUDIO_TICK_HZ);
}

// Единая временная сетка для VIS и всех 240 строк.
uint32_t toneDeadlineUs = 0;
uint32_t lateTones = 0;
uint32_t worstLateUs = 0;

inline void playTone(uint16_t frequencyHz, uint32_t durationUs) {
  // Меняем только приращение фазы; сам аккумулятор не обнуляем.
  phaseStep = frequencyToStep(frequencyHz);
  toneDeadlineUs += durationUs;
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

void sendVISHeader() {
  // Robot 36, VIS = 8, контроль чётности, LSB first.
  playTone(1900, 300000);
  playTone(1200, 10000);
  playTone(1900, 300000);
  playTone(1200, 30000);

  const uint8_t vis = 0x08;
  uint8_t parity = 0;
  for (uint8_t i = 0; i < 7; ++i) {
    const uint8_t bit = (vis >> i) & 1U;
    parity ^= bit;
    playTone(bit ? 1100 : 1300, 30000);
  }
  playTone(parity ? 1100 : 1300, 30000);
  playTone(1200, 30000);
}

// Оставляем RGB565 исходного файла, как в предыдущей версии.
inline void rgb565At(uint32_t offset, uint8_t& r, uint8_t& g, uint8_t& b) {
  const uint16_t c = pgm_read_word(&image_map[offset]);
  r = ((c >> 11) & 0x1F) * 255 / 31;
  g = ((c >> 5)  & 0x3F) * 255 / 63;
  b = (c & 0x1F) * 255 / 31;
}

void sendRobot36Frame() {
  sendVISHeader();

  for (uint16_t y = 0; y < SSTV_HEIGHT; ++y) {
    // Масштабирование по вертикали: 256 -> 240 без правки image_data.h.
    const uint16_t srcY = ((uint32_t)(2 * y + 1) * IMAGE_HEIGHT) /
                          (2 * SSTV_HEIGHT);
    const uint32_t rowOffset = (uint32_t)srcY * IMAGE_WIDTH;

    playTone(1200, 9000);  // Синхроимпульс 9 мс
    playTone(1500, 3000);  // Площадка 3 мс

    // Y: 320 * 275 мкс = 88 мс.
    for (uint16_t x = 0; x < SSTV_WIDTH; ++x) {
      uint8_t r, g, b;
      rgb565At(rowOffset + x, r, g, b);
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
      rgb565At(rowOffset + x, r, g, b);
      int16_t chroma = even
        ? (128 + (int16_t)(0.500f * r - 0.419f * g - 0.081f * b))
        : (128 + (int16_t)(-0.169f * r - 0.331f * g + 0.500f * b));
      if (chroma < 0) chroma = 0;
      if (chroma > 255) chroma = 255;
      const uint16_t frequencyC = 1500 + (uint32_t)chroma * 800 / 255;
      // 137+138 мкс = 275 мкс за каждые два пикселя.
      playTone(frequencyC, (x & 1U) ? 138 : 137);
    }
    // Итого на строку: 9+3+88+4,5+1,5+44 = 150 мс.
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("=== SSTV ROBOT 36 / DDS / ESP32 + CC1101 ===");

  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);
  // RadioLib 8 принимает герцы. Округляем после прибавления знаковой поправки.
  constexpr double txFrequencyHz = CARRIER_FREQ_MHZ * 1e6 + TX_FREQ_OFFSET_KHZ * 1e3;
  static_assert(txFrequencyHz >= 1.0 && txFrequencyHz <= UINT32_MAX,
                "Частота CC1101 с поправкой должна помещаться в uint32_t (Гц)");
  ConfigFSK_t config;
  config.frequency = static_cast<uint32_t>(txFrequencyHz + 0.5);
  config.power = TX_POWER_DBM;
  Serial.printf("Канал: %.6f МГц, поправка TX: %+.3f кГц, задано CC1101: %.6f МГц\n",
                CARRIER_FREQ_MHZ, TX_FREQ_OFFSET_KHZ, config.frequency / 1e6);

  int16_t state = radio.begin(config);
  Serial.printf("radio.begin = %d\n", state);
  if (state != RADIOLIB_ERR_NONE) {
    while (true) { delay(1000); }
  }

  state = radio.setFrequencyDeviation(RADIOLIB_UNIT_KILO(2.5));
  Serial.printf("setFrequencyDeviation = %d\n", state);
  if (state != RADIOLIB_ERR_NONE) {
    while (true) { delay(1000); }
  }

  audioTimer = timerBegin(AUDIO_TICK_HZ);
  if (audioTimer == nullptr) {
    Serial.println("ОШИБКА: timerBegin не создал таймер");
    while (true) { delay(1000); }
  }
  const uint32_t actualHz = timerGetFrequency(audioTimer);
  Serial.printf("DDS tick: %lu Гц\n", (unsigned long)actualHz);
  if (actualHz != AUDIO_TICK_HZ) {
    Serial.println("ОШИБКА: таймер не обеспечивает 80000 Гц");
    while (true) { delay(1000); }
  }
  timerAttachInterrupt(audioTimer, &audioISR);
  timerAlarm(audioTimer, 1, true, 0);
  timerStop(audioTimer);
  Serial.println("Готов: Robot 36, 320x240, GPIO4 DDS.");
}

void loop() {
  Serial.println("TX START: VIS + 240 строк, ожидается ~36.91 с");
  int16_t state = radio.transmitDirectAsync();
  Serial.printf("transmitDirectAsync = %d\n", state);
  if (state != RADIOLIB_ERR_NONE) {
    delay(3000);
    return;
  }

  pinMode(PIN_GDO0, OUTPUT);  // GPIO4 -> CC1101 GDO0
  digitalWrite(PIN_GDO0, LOW);
  phaseAcc = 0;
  phaseStep = frequencyToStep(1900);
  lateTones = 0;
  worstLateUs = 0;
  audioActive = true;
  timerRestart(audioTimer);
  timerStart(audioTimer);

  const uint32_t frameStartUs = micros();
  toneDeadlineUs = frameStartUs;
  sendRobot36Frame();

  audioActive = false;
  timerStop(audioTimer);
  digitalWrite(PIN_GDO0, LOW);
  state = radio.standby();

  const uint32_t actualMs = (uint32_t)(micros() - frameStartUs) / 1000;
  Serial.printf("TX STOP: длительность = %lu мс, standby = %d\n",
                (unsigned long)actualMs, state);
  Serial.printf("Опозданий >50 мкс: %lu, максимум = %lu мкс\n",
                (unsigned long)lateTones, (unsigned long)worstLateUs);
  Serial.println("Пауза 10 секунд. Затем повтор кадра.");
  delay(10000);
}
