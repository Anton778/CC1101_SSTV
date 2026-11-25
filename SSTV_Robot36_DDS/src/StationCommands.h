#pragma once
#include "SstvRadio.h"
#include "RadioTuning.h"

enum class Command { Invalid, Help, Status, Tx, TxInvalid, Rx, StartImage, StopImage, Scan, Ping, Record, StopRecording,
                     Info, TuningGet, TuningSet, TuningDefault, TuningInvalid, RecordLive, Chat, ChatMessage, ImageHello, ImageBegin, ImageBlock, ImageEnd, ImageCancel, ImageInvalid };
struct StationCommand {
  Command kind = Command::Invalid;
  double channelMHz = 0;        // Ноль означает текущий канал выбранного режима.
  ScanRange scan{};
  unsigned seconds = 0;
  RadioTuning tuning{};
  uint32_t imageCrc = 0;
  int imageSizeOrOffset = 0;
  const char* payload = nullptr;
};

bool readStationCommand(const ScanRange& defaults, StationCommand& result);
