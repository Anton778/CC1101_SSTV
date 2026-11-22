#pragma once
#include "SstvRadio.h"

enum class Command { Invalid, Help, Status, Tx, Rx, StartImage, StopImage, Scan, Ping, Record, StopRecording };
struct StationCommand {
  Command kind = Command::Invalid;
  double rxMHz = 0;             // Ноль означает текущий канал приёма.
  ScanRange scan{};
  unsigned seconds = 0;
};

bool readStationCommand(const ScanRange& defaults, StationCommand& result);
