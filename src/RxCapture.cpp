#include "RxCapture.h"
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "soc/gpio_struct.h"

namespace {

constexpr unsigned SAMPLE_RATE = 32000;
constexpr unsigned BLOCK_BYTES = 200;        // Один бит на отсчёт, старший бит идёт первым.
constexpr unsigned BLOCKS_PER_SECOND = SAMPLE_RATE / (8 * BLOCK_BYTES);
constexpr unsigned TIMER_HZ = 4000000;
constexpr unsigned QUEUE_DEPTH = 8;
constexpr char HEX_DIGITS[] = "0123456789abcdef";

struct Block { uint8_t data[BLOCK_BYTES]; };
QueueHandle_t blocks = nullptr;
hw_timer_t* sampleTimer = nullptr;
Block assembling;
uint32_t dataMask = 0;
unsigned bitCount = 0;
uint8_t packedByte = 0;
volatile unsigned blocksRemaining = 0;
volatile bool overrun = false;
bool recording = false;
unsigned blockCount = 0;
unsigned sent = 0;
uint32_t checksum = 0;

void IRAM_ATTR samplePin() {
  if (!blocksRemaining || overrun) return;
  packedByte = (packedByte << 1) | ((GPIO.in & dataMask) != 0);
  ++bitCount;
  if ((bitCount & 7) != 0) return;
  assembling.data[(bitCount >> 3) - 1] = packedByte;
  if (bitCount == 8 * BLOCK_BYTES) {
    // Копирование и пробуждение потребителя нужны только 20 раз в секунду.
    if (xQueueSendFromISR(blocks, &assembling, nullptr) != pdTRUE) overrun = true;
    --blocksRemaining;
    bitCount = 0;
  }
}

}  // namespace

bool rxRecording() { return recording; }

void stopRxRecording() {
  if (recording) timerStop(sampleTimer);
  recording = false;
}

void startRxRecording(unsigned seconds, uint8_t dataPin) {
  if (!blocks) blocks = xQueueCreate(QUEUE_DEPTH, sizeof(Block));
  if (!sampleTimer) {
    sampleTimer = timerBegin(TIMER_HZ);
    if (sampleTimer) {
      timerStop(sampleTimer);
      timerAttachInterrupt(sampleTimer, &samplePin);
      timerAlarm(sampleTimer, TIMER_HZ / SAMPLE_RATE, true, 0);
    }
  }
  if (!blocks || !sampleTimer || timerGetFrequency(sampleTimer) != TIMER_HZ) {
    Serial.println("SSTV ERROR TIMER");
    return;
  }
  xQueueReset(blocks);
  bitCount = 0;
  packedByte = 0;
  dataMask = 1UL << dataPin;
  overrun = false;
  sent = 0;
  checksum = 2166136261UL;  // FNV-1a для проверки всего файла при передаче через порт.
  blockCount = seconds * BLOCKS_PER_SECOND;
  blocksRemaining = blockCount;
  Serial.printf("SSTV BEGIN %u %u %u\n", SAMPLE_RATE, BLOCK_BYTES, blockCount);
  recording = true;
  timerRestart(sampleTimer);
  timerStart(sampleTimer);
}

bool serviceRxCapture() {
  if (!recording) return false;
  if (overrun) {
    stopRxRecording();
    Serial.println("SSTV ERROR OVERRUN");
    return false;
  }
  Block block;
  if (xQueueReceive(blocks, &block, 0) != pdTRUE) return true;

  char line[2 * BLOCK_BYTES + 32];
  size_t pos = snprintf(line, sizeof(line), "SSTV DATA %u ", sent);
  for (uint8_t value : block.data) {
    line[pos++] = HEX_DIGITS[value >> 4];
    line[pos++] = HEX_DIGITS[value & 15];
    checksum = (checksum ^ value) * 16777619UL;
  }
  line[pos++] = '\n';
  Serial.write(reinterpret_cast<const uint8_t*>(line), pos);
  if (++sent == blockCount) {
    stopRxRecording();
    Serial.printf("SSTV END %u %08lx\n", sent, static_cast<unsigned long>(checksum));
  }
  return recording;
}
