#pragma once
#include <stdint.h>

bool rxRecording();
void startRxRecording(unsigned seconds, uint8_t dataPin);
void stopRxRecording(bool finishLive = false);
bool serviceRxCapture();
