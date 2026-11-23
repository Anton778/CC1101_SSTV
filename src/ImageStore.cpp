#include "ImageStore.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_jpg_decode.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <mbedtls/base64.h>
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

// Декодер ESP32 отдаёт прямоугольники по порядку. Буфер держит до 16 строк,
// поэтому ни полный RGB-кадр, ни PSRAM не требуются.
struct Decoder {
  File out;
  uint16_t band[16 * Width];
  uint16_t x = 0, y = 0, bandHeight = 0;
  uint32_t crc = 0;
  bool geometryOK = false;
  bool writeFailed = false;
};
size_t readJpeg(void*, size_t offset, uint8_t* dst, size_t n) {
  if (offset > used || n > used - offset) return 0;
  if (dst) memcpy(dst, jpeg.get() + offset, n);
  return n;
}
bool writeTile(void* arg, uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint8_t* rgb) {
  auto& d = *static_cast<Decoder*>(arg);
  if (!rgb) {
    if (x == 0 && y == 0) d.geometryOK = w == Width && h == Height;
    return d.geometryOK;
  }
  if (!d.geometryOK || !w || !h || h > 16 || x != d.x || y != d.y ||
      x + w > Width || y + h > Height || (x && h != d.bandHeight)) return false;
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
    if (d.out.write(bytes, n) != n) { d.writeFailed = true; return false; }
    d.crc = esp_rom_crc32_le(d.crc, bytes, n);
    d.x = 0;
    d.y += h;
  }
  return true;
}
const char* decodeToPending() {
  std::unique_ptr<Decoder> d(new (std::nothrow) Decoder);
  if (!d) return "MEMORY";
  d->out = LittleFS.open(Pending, "w");
  if (!d->out) return "STORAGE";
  const auto result = esp_jpg_decode(used, JPG_SCALE_NONE, readJpeg, writeTile, d.get());
  if (d->writeFailed) return "STORAGE";
  if (result != ESP_OK || !d->geometryOK || d->x || d->y != Height) return "JPEG";
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
