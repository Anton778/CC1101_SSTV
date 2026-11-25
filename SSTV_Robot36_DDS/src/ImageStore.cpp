#include "ImageStore.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <esp_rom_crc.h>
#include <mbedtls/base64.h>
#include <rom/tjpgd.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <memory>
#include <new>
#include <utility>

namespace ImageStore {
namespace {
constexpr char Current[] = "/sstv-tx.rgb";
constexpr char Pending[] = "/sstv-tx.tmp";
constexpr size_t PixelBytes = Width * Height * sizeof(uint16_t);
struct Footer { uint32_t magic, pixelsCrc; };
constexpr uint32_t Magic = 0x31565453;

bool mounted = false, saved = false;
File frame;
std::unique_ptr<uint8_t[]> jpeg, ramJpeg;
size_t ramSize = 0;
size_t expected = 0, used = 0;
uint32_t wantedCrc = 0, lastBlockMs = 0;

const esp_partition_t* dataPartition = nullptr;
bool triedMountForWriting = false;

bool blankPartition(const esp_partition_t* p) {
  uint8_t bytes[512];
  for (size_t offset = 0; offset < p->size; offset += sizeof(bytes)) {
    const size_t n = std::min(sizeof(bytes), size_t(p->size - offset));
    if (esp_partition_read(p, offset, bytes, n) != ESP_OK) return false;
    for (size_t i = 0; i < n; ++i) if (bytes[i] != 0xff) return false;
  }
  return true;
}
bool mountForWriting() {
  if (mounted || triedMountForWriting || !dataPartition) return mounted;
  triedMountForWriting = true;
  // Создаём LittleFS только на полностью стёртом разделе.
  if (blankPartition(dataPartition)) mounted = LittleFS.begin(true, "/littlefs", 10, dataPartition->label);
  return mounted;
}
bool validFile(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f || f.size() != PixelBytes + sizeof(Footer)) return false;
  uint8_t bytes[1024];
  uint32_t crc = 0;
  for (size_t offset = 0; offset < PixelBytes; offset += sizeof(bytes)) {
    const size_t n = std::min(sizeof(bytes), PixelBytes - offset);
    if (f.read(bytes, n) != n) return false;
    crc = esp_rom_crc32_le(crc, bytes, n);
  }
  Footer tail{};
  return f.read(reinterpret_cast<uint8_t*>(&tail), sizeof(tail)) == sizeof(tail) &&
         tail.magic == Magic && tail.pixelsCrc == crc;
}

// Декодер в ROM у ESP32 и ESP32-S3 отдаёт блоки RGB888 по порядку.
// 3100 байт — рабочая память TJpgDec при стандартном буфере ввода 512 байт.
using BandWriter = bool (*)(void*, const uint16_t*, unsigned);
struct Decoder {
  const uint8_t* input;
  size_t size;
  BandWriter write;
  void* target;
  alignas(4) uint8_t work[3100];
  uint16_t band[16 * Width];
  size_t inputOffset = 0;
  uint16_t x = 0, y = 0, bandHeight = 0;
  bool writeFailed = false;
};
unsigned readJpeg(JDEC* jpg, uint8_t* dst, unsigned requested) {
  auto& d = *static_cast<Decoder*>(jpg->device);
  const size_t n = std::min<size_t>(requested, d.size - d.inputOffset);
  if (dst && n) memcpy(dst, d.input + d.inputOffset, n);
  d.inputOffset += n;  // При dst == nullptr декодер просит пропустить байты.
  return n;
}
unsigned writeTile(JDEC* jpg, void* pixels, JRECT* rect) {
  auto& d = *static_cast<Decoder*>(jpg->device);
  const unsigned x = rect->left, y = rect->top;
  if (x != d.x || y != d.y || rect->right < x || rect->right >= Width ||
      rect->bottom < y || rect->bottom >= Height) return 0;
  const unsigned w = rect->right - x + 1, h = rect->bottom - y + 1;
  if (h > 16 || (x && h != d.bandHeight)) return 0;
  const auto* rgb = static_cast<const uint8_t*>(pixels);
  d.bandHeight = h;
  for (unsigned row = 0; d.write && row < h; ++row) {
    uint16_t* dst = d.band + row * Width + x;
    for (unsigned col = 0; col < w; ++col, rgb += 3)
      dst[col] = ((rgb[0] & 0xf8) << 8) | ((rgb[1] & 0xfc) << 3) | (rgb[2] >> 3);
  }
  d.x += w;
  if (d.x == Width) {
    if (d.write && !d.write(d.target, d.band, h)) { d.writeFailed = true; return 0; }
    d.x = 0;
    d.y += h;
  }
  return 1;
}
const char* decode(const uint8_t* data, size_t size, BandWriter write, void* target) {
  std::unique_ptr<Decoder> d(new (std::nothrow) Decoder);
  if (!d) return "MEMORY";
  d->input = data;
  d->size = size;
  d->write = write;
  d->target = target;
  JDEC jpg{};
  if (jd_prepare(&jpg, readJpeg, d->work, sizeof(d->work), d.get()) != JDR_OK ||
      jpg.width != Width || jpg.height != Height) return "JPEG";
  const JRESULT result = jd_decomp(&jpg, writeTile, 0);
  if (d->writeFailed) return "STORAGE";
  return result == JDR_OK && d->x == 0 && d->y == Height ? nullptr : "JPEG";
}

struct FileOutput { File out; uint32_t crc = 0; };
bool writeFileBand(void* target, const uint16_t* pixels, unsigned rows) {
  auto& f = *static_cast<FileOutput*>(target);
  const auto* bytes = reinterpret_cast<const uint8_t*>(pixels);
  const size_t n = rows * Width * sizeof(uint16_t);
  if (f.out.write(bytes, n) != n) return false;
  f.crc = esp_rom_crc32_le(f.crc, bytes, n);
  return true;
}
const char* saveToFlash() {
  FileOutput f{LittleFS.open(Pending, "w")};
  if (!f.out) return "STORAGE";
  if (const char* error = decode(jpeg.get(), used, writeFileBand, &f)) return error;
  Footer tail{Magic, f.crc};
  if (f.out.write(reinterpret_cast<const uint8_t*>(&tail), sizeof(tail)) != sizeof(tail)) return "STORAGE";
  f.out.close();
  return validFile(Pending) && LittleFS.rename(Pending, Current) ? nullptr : "STORAGE";
}

// При передаче из ОЗУ храним сжатый JPEG. Декодер готовит несколько строк
// заранее, пока передатчик выдаёт VIS и предыдущие строки. PSRAM не требуется.
QueueHandle_t rowsReady = nullptr;
SemaphoreHandle_t decoderDone = nullptr;
std::atomic<bool> stopping{false};
bool workerStarted = false;

bool queueBand(void*, const uint16_t* pixels, unsigned rows) {
  for (unsigned row = 0; row < rows; ++row) {
    while (!stopping.load()) {
      if (xQueueSend(rowsReady, pixels + row * Width, pdMS_TO_TICKS(20)) == pdTRUE) break;
    }
    if (stopping.load()) return false;
  }
  return true;
}
void prepareRows(void*) {
  decode(ramJpeg.get(), ramSize, queueBand, nullptr);
  xSemaphoreGive(decoderDone);
  vTaskDelete(nullptr);
}
void stopRows() {
  if (workerStarted) {
    stopping.store(true);
    xSemaphoreTake(decoderDone, portMAX_DELAY);
    workerStarted = false;
  }
  if (rowsReady) { vQueueDelete(rowsReady); rowsReady = nullptr; }
  if (decoderDone) { vSemaphoreDelete(decoderDone); decoderDone = nullptr; }
}
bool startRows() {
  rowsReady = xQueueCreate(8, Width * sizeof(uint16_t));
  decoderDone = xSemaphoreCreateBinary();
  stopping.store(false);
  if (rowsReady && decoderDone) {
    const BaseType_t core = portNUM_PROCESSORS > 1 ? 1 - xPortGetCoreID() : 0;
    workerStarted = xTaskCreatePinnedToCore(prepareRows, "sstv-jpeg", 4096, nullptr,
                                           tskIDLE_PRIORITY + 1, nullptr, core) == pdPASS;
  }
  // Отсчёт времени Robot 36 начнётся, когда готова первая строка.
  uint16_t firstRow[Width];
  if (workerStarted && xQueuePeek(rowsReady, firstRow, pdMS_TO_TICKS(500)) == pdTRUE) return true;
  stopRows();
  return false;
}
}  // namespace

void load() {
  closeFrame();
  ramJpeg.reset();
  ramSize = 0;
  triedMountForWriting = false;
  dataPartition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
  if (!dataPartition)
    dataPartition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_LITTLEFS, nullptr);
  mounted = dataPartition && LittleFS.begin(false, "/littlefs", 10, dataPartition->label);
  const bool exists = mounted && LittleFS.exists(Current);
  saved = exists && validFile(Current);
  if (exists && !saved) Serial.println("Сохранённый кадр повреждён. Выбран встроенный кадр.");
  if (mounted && LittleFS.exists(Pending)) LittleFS.remove(Pending);
}
const char* begin(size_t size, uint32_t crc) {
  if (busy()) return "BUSY";
  if (size < 4 || size > MaxJpeg) return "SIZE";
  jpeg.reset(new (std::nothrow) uint8_t[size]);
  if (!jpeg) return "MEMORY";
  expected = size;
  wantedCrc = crc;
  used = 0;
  lastBlockMs = millis();
  return nullptr;
}
const char* append(size_t offset, const char* base64) {
  if (!busy() || offset != used) return "OFFSET";
  const size_t n = std::min(BlockSize, expected - used);
  if (!n || strlen(base64) != 4 * ((n + 2) / 3)) return "BLOCK";
  size_t decoded = 0;
  if (mbedtls_base64_decode(jpeg.get() + used, n, &decoded,
                            reinterpret_cast<const uint8_t*>(base64), strlen(base64)) || decoded != n) return "BLOCK";
  used += n;
  lastBlockMs = millis();
  return nullptr;
}
const char* commit(uint32_t crc) {
  if (!busy() || used != expected || crc != wantedCrc ||
      esp_rom_crc32_le(0, jpeg.get(), used) != crc) return "CRC";
  if (jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[used-2] != 0xff || jpeg[used-1] != 0xd9) return "JPEG";
  if (mountForWriting()) {
    const char* error = saveToFlash();
    if (!error) {
      ramJpeg.reset();
      ramSize = 0;
      saved = true;
      return nullptr;
    }
    LittleFS.remove(Pending);
    if (strcmp(error, "STORAGE") != 0) return error;
  }
  // Проверяем весь JPEG перед заменой предыдущего кадра.
  if (const char* error = decode(jpeg.get(), used, nullptr, nullptr)) return error;
  ramJpeg = std::move(jpeg);
  ramSize = used;
  return nullptr;
}
void cancel() { jpeg.reset(); used = expected = 0; }
bool busy() { return bool(jpeg); }
size_t received() { return used; }
bool expired(uint32_t now) { return busy() && now - lastBlockMs > 12000; }
bool inRam() { return bool(ramJpeg); }
bool hasImage() { return inRam() || saved; }
bool openFrame() {
  if (inRam()) return startRows();
  if (!saved) return true;
  frame = LittleFS.open(Current, "r");
  return bool(frame);
}
bool readRow(uint16_t* pixels) {
  if (workerStarted) return xQueueReceive(rowsReady, pixels, pdMS_TO_TICKS(250)) == pdTRUE;
  return frame && frame.read(reinterpret_cast<uint8_t*>(pixels), Width * 2) == Width * 2;
}
void closeFrame() { stopRows(); frame.close(); }
}  // namespace ImageStore
