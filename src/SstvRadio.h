#pragma once

#include <Arduino.h>

enum SstvMode { SSTV_TX, SSTV_RX, SSTV_SCAN };

void beginStation(SstvMode mode, double channelMHz, double correctionKHz, int8_t powerDbm);
void transmitPicture(uint16_t pauseSeconds);
void listenForPicture();
float measureReceiveRssi(int frequencyKHz);
