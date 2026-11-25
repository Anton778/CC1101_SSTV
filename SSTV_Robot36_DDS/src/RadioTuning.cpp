#include "RadioTuning.h"
#include <nvs.h>

namespace {
constexpr char Group[] = "sstv-radio";
constexpr char Key[] = "tuning-v1";
}

bool RadioTuning::valid() const {
  if (offsetHz < -200000 || offsetHz > 200000) return false;
  constexpr int powers[] = {-30, -20, -15, -10, 0, 5, 7, 10};
  for (int power : powers)
    if (power == powerDbm) return true;
  return false;
}

bool readTuning(RadioTuning& tuning) {
  nvs_handle_t handle;
  if (nvs_open(Group, NVS_READONLY, &handle) != ESP_OK) return false;
  RadioTuning value{};
  size_t size = sizeof(value);
  const esp_err_t result = nvs_get_blob(handle, Key, &value, &size);
  nvs_close(handle);
  if (result != ESP_OK || size != sizeof(value) || !value.valid()) return false;
  tuning = value;
  return true;
}

bool storeTuning(const RadioTuning& tuning, bool restoreDefaults) {
  nvs_handle_t handle;
  if (nvs_open(Group, NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t result = restoreDefaults ? nvs_erase_key(handle, Key)
                                    : nvs_set_blob(handle, Key, &tuning, sizeof(tuning));
  if (restoreDefaults && result == ESP_ERR_NVS_NOT_FOUND) result = ESP_OK;
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result == ESP_OK;
}
