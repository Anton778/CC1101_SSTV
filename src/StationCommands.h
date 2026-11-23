#pragma once
#include "SstvRadio.h"

enum class Command { Invalid, Help, Status, Tx, Rx, StartImage, StopImage, Scan, Ping, Record, StopRecording,
                     ImageHello, ImageBegin, ImageBlock, ImageEnd, ImageCancel, ImageInvalid };
struct StationCommand {
  Command kind = Command::Invalid;
  double rxMHz = 0;             // Ноль означает текущий канал приёма.
  ScanRange scan{};
  unsigned seconds = 0;
  uint32_t imageCrc = 0;
  int imageSizeOrOffset = 0;
  const char* payload = nullptr;
};

bool readStationCommand(const ScanRange& defaults, StationCommand& result);
