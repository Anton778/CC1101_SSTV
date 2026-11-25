#pragma once
#include <Arduino.h>

enum SstvMode { SSTV_TX, SSTV_RX, SSTV_SCAN, SSTV_CHAT };
struct ScanRange {
  int startKHz, endKHz, stepKHz;
  float thresholdDbm;
};

void beginStation(SstvMode mode, double channelMHz, double correctionKHz, int8_t powerDbm,
                  const ScanRange& defaults, double chatMHz = 433.500);
SstvMode pollStation();
void transmitPicture(uint16_t pauseSeconds);
void listenForPicture();
const ScanRange& scanSettings();
bool scanDue();
float measureReceiveRssi(int frequencyKHz);
void reportScanPoint(int frequencyKHz, float rssi, bool above);
void finishScan(int hits, int peakKHz, float peakDbm);
void listenForChat();
