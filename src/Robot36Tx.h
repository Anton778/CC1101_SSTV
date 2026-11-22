#pragma once
#include <stdint.h>

namespace Robot36Tx {
bool prepare(uint8_t pin);
void start();
bool advance();    // Один шаг заголовка или одна строка. true в конце кадра.
bool active();
void stop();
void printTiming();
}
