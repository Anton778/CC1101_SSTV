#pragma once
#include <stdint.h>

// Обмен с USB-конвертером. Возвращает true во время записи.
bool serviceRxCapture(uint8_t dataPin);
