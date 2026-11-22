#pragma once
#include <Arduino.h>

enum SstvMode { SSTV_TX, SSTV_RX, SSTV_SCAN };
struct ScanRange {
  int startKHz, endKHz, stepKHz;
  float thresholdDbm;
};

void beginStation(SstvMode mode, double channelMHz, double correctionKHz, int8_t powerDbm,
                  const ScanRange& defaults);
SstvMode pollStation();
void transmitPicture(uint16_t pauseSeconds);
void listenForPicture();
const ScanRange& scanSettings();
bool scanDue();
float measureReceiveRssi(int frequencyKHz);
void finishScan();
