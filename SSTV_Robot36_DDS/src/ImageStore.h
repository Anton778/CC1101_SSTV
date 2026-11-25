#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ImageStore {
constexpr size_t Width = 320, Height = 240, MaxJpeg = 64 * 1024, BlockSize = 768;
void load();                         // Выбрать последний проверенный кадр при включении.
const char* begin(size_t size, uint32_t crc);
const char* append(size_t offset, const char* base64);
const char* commit(uint32_t crc);
void cancel();
bool busy();
size_t received();
bool expired(uint32_t now);
bool hasImage();
bool inRam();                        // Активный USB-кадр хранится до перезапуска.
bool openFrame();
bool readRow(uint16_t* pixels);
void closeFrame();
}
