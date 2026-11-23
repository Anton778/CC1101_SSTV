#pragma once
#include <stdint.h>

namespace Robot36Tx {
bool prepare(uint8_t pin);
bool start();
bool advance();    // Один шаг заголовка или одна строка. true в конце кадра.
bool active();
bool readFailed();
void stop();
void printTiming();
}
