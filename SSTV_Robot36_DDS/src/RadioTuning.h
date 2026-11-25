#pragma once
#include <stdint.h>

struct RadioTuning {
  int32_t powerDbm;
  int32_t offsetHz;
  bool valid() const;
};

bool readTuning(RadioTuning& tuning);
bool storeTuning(const RadioTuning& tuning, bool restoreDefaults);
