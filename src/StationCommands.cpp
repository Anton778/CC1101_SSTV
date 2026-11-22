#include "StationCommands.h"
#include <cerrno>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace {
bool integer(const char* text, int& result) {
  char* end;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (end == text || *end || errno || value < INT_MIN || value > INT_MAX) return false;
  result = static_cast<int>(value);
  return true;
}
bool number(const char* text, double& result) {
  char* end;
  result = strtod(text, &end);
  return end != text && !*end && std::isfinite(result);
}
void parse(char* line, const ScanRange& defaults, StationCommand& cmd) {
  for (char* p = line; *p; ++p) {
    if (*p >= 'a' && *p <= 'z') *p -= 'a' - 'A';
    else if (*p == '_') *p = ' ';
  }
  char* words[5];
  size_t n = 0;
  char* position = nullptr;
  for (char* word = strtok_r(line, " \t", &position); word; word = strtok_r(nullptr, " \t", &position)) {
    if (n == 5) return;
    words[n++] = word;
  }
  if (!n) return;
  const char* name = words[0];
  if (n == 1 && (!strcmp(name, "HELP") || !strcmp(name, "?"))) cmd.kind = Command::Help;
  else if (n == 1 && !strcmp(name, "STATUS")) cmd.kind = Command::Status;
  else if (n == 1 && !strcmp(name, "TX")) cmd.kind = Command::Tx;
  else if (!strcmp(name, "RX") && (n == 1 || (n == 2 && number(words[1], cmd.rxMHz) && cmd.rxMHz > 0))) cmd.kind = Command::Rx;
  else if (n == 2 && !strcmp(words[1], "SSTV")) {
    if (!strcmp(name, "START")) cmd.kind = Command::StartImage;
    if (!strcmp(name, "STOP")) cmd.kind = Command::StopImage;
  } else if (!strcmp(name, "SCAN")) {
    cmd.scan = defaults;
    if (n != 1) {
      double threshold;
      if ((n != 4 && n != 5) || !integer(words[1], cmd.scan.startKHz) ||
          !integer(words[2], cmd.scan.endKHz) || !number(words[3], threshold) ||
          (n == 5 && !integer(words[4], cmd.scan.stepKHz))) return;
      cmd.scan.thresholdDbm = static_cast<float>(threshold);
    }
    cmd.kind = Command::Scan;
  } else if (n == 1 && !strcmp(name, "PING")) cmd.kind = Command::Ping;
  else if (n == 1 && !strcmp(name, "STOP")) cmd.kind = Command::StopRecording;
  else if (!strcmp(name, "REC")) {
    int seconds;
    cmd.kind = Command::Record;
    if (n == 2 && integer(words[1], seconds) && seconds >= 40 && seconds <= 120)
      cmd.seconds = static_cast<unsigned>(seconds);
  }
}
}  // namespace

bool readStationCommand(const ScanRange& defaults, StationCommand& result) {
  static char line[80];
  static size_t used = 0;
  static bool discard = false;
  for (unsigned i = 0; i < sizeof(line) && Serial.available(); ++i) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (!used && !discard) continue;
      line[used] = '\0';
      if (!discard) parse(line, defaults, result);
      used = 0;
      discard = false;
      return true;
    }
    if (used + 1 >= sizeof(line) || (!isprint(static_cast<unsigned char>(c)) && c != '\t')) discard = true;
    else if (!discard) line[used++] = c;
  }
  return false;
}
