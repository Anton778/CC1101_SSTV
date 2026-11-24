#include "ImageStore.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <mbedtls/base64.h>
#include <rom/tjpgd.h>
#include <algorithm>
#include <cstring>
#include <memory>
#include <new>

namespace ImageStore {
namespace {
constexpr char Current[] = "/sstv-tx.rgb";
constexpr char Pending[] = "/sstv-tx.tmp";
constexpr size_t PixelBytes = Width * Height * sizeof(uint16_t);
struct Footer { uint32_t magic, pixelsCrc; };
constexpr uint32_t Magic = 0x31565453;

bool mounted = false, saved = false;
File frame;
std::unique_ptr<uint8_t[]> jpeg;
size_t expected = 0, used = 0;
uint32_t wantedCrc = 0, lastBlockMs = 0;

bool blankPartition() {
  const auto* p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
  if (!p) return false;
  uint8_t bytes[512];
  for (size_t offset = 0; offset < p->size; offset += sizeof(bytes)) {
    const size_t n = std::min(sizeof(bytes), size_t(p->size - offset));
    if (esp_partition_read(p, offset, bytes, n) != ESP_OK) return false;
    for (size_t i = 0; i < n; ++i) if (bytes[i] != 0xff) return false;
  }
  return true;
}
bool mountForWriting() {
  if (mounted) return true;
  // Первый запуск на новой плате. Раздел с чужими данными не форматируем.
  if (blankPartition()) mounted = LittleFS.begin(true);
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
struct Decoder {
  File out;
  alignas(4) uint8_t work[3100];
  uint16_t band[16 * Width];
  size_t inputOffset = 0;
  uint16_t x = 0, y = 0, bandHeight = 0;
  uint32_t crc = 0;
  bool writeFailed = false;
};
unsigned readJpeg(JDEC* jpg, uint8_t* dst, unsigned requested) {
  auto& d = *static_cast<Decoder*>(jpg->device);
  const size_t n = std::min<size_t>(requested, used - d.inputOffset);
  if (dst && n) memcpy(dst, jpeg.get() + d.inputOffset, n);
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
  for (unsigned row = 0; row < h; ++row) {
    uint16_t* dst = d.band + row * Width + x;
    for (unsigned col = 0; col < w; ++col, rgb += 3)
      dst[col] = ((rgb[0] & 0xf8) << 8) | ((rgb[1] & 0xfc) << 3) | (rgb[2] >> 3);
  }
  d.x += w;
  if (d.x == Width) {
    const auto* bytes = reinterpret_cast<const uint8_t*>(d.band);
    const size_t n = h * Width * sizeof(uint16_t);
    if (d.out.write(bytes, n) != n) { d.writeFailed = true; return 0; }
    d.crc = esp_rom_crc32_le(d.crc, bytes, n);
    d.x = 0;
    d.y += h;
  }
  return 1;
}
const char* decodeToPending() {
  std::unique_ptr<Decoder> d(new (std::nothrow) Decoder);
  if (!d) return "MEMORY";
  JDEC jpg{};
  if (jd_prepare(&jpg, readJpeg, d->work, sizeof(d->work), d.get()) != JDR_OK ||
      jpg.width != Width || jpg.height != Height) return "JPEG";
  d->out = LittleFS.open(Pending, "w");
  if (!d->out) return "STORAGE";
  const JRESULT result = jd_decomp(&jpg, writeTile, 0);
  if (d->writeFailed) return "STORAGE";
  if (result != JDR_OK || d->x || d->y != Height) return "JPEG";
  Footer tail{Magic, d->crc};
  if (d->out.write(reinterpret_cast<const uint8_t*>(&tail), sizeof(tail)) != sizeof(tail)) return "STORAGE";
  d->out.close();
  return validFile(Pending) ? nullptr : "STORAGE";
}
}  // namespace

void load() {
  mounted = LittleFS.begin(false);
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
  if (!mountForWriting()) return "PARTITION";
  const char* error = decodeToPending();
  if (!error && !LittleFS.rename(Pending, Current)) error = "STORAGE";
  if (error) LittleFS.remove(Pending);
  else saved = true;
  return error;
}
void cancel() { jpeg.reset(); used = expected = 0; }
bool busy() { return bool(jpeg); }
size_t received() { return used; }
bool expired(uint32_t now) { return busy() && now - lastBlockMs > 12000; }
bool hasImage() { return saved; }
bool openFrame() {
  if (!saved) return true;
  frame = LittleFS.open(Current, "r");
  return bool(frame);
}
bool readRow(uint16_t* pixels) {
  return frame && frame.read(reinterpret_cast<uint8_t*>(pixels), Width * 2) == Width * 2;
}
void closeFrame() { frame.close(); }
}  // namespace ImageStore
