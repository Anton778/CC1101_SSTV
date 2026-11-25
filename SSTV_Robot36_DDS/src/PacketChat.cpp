#include "PacketChat.h"
#include <Arduino.h>
#include <esp_random.h>
#include <cstring>

namespace PacketChat {
namespace {
// Заголовок и 48 байт данных помещаются в FIFO вместе с длиной и статусом.
constexpr size_t Header = 12, Chunk = 48, Parts = 4, MaxBytes = Chunk * Parts;
constexpr size_t MaxPacket = Header + Chunk;
uint32_t stationId;
struct Assembly {
  bool used = false;
  uint32_t source, id, touched;
  uint8_t count, mask, length;
  uint8_t text[MaxBytes];
};
Assembly inbox[2];

void put32(uint8_t* out, uint32_t v) {
  for (unsigned i = 0; i < 4; ++i) out[i] = uint8_t(v >> (8 * i));
}
uint32_t get32(const uint8_t* p) {
  uint32_t v = 0;
  for (unsigned i = 0; i < 4; ++i) v |= uint32_t(p[i]) << (8 * i);
  return v;
}
int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
void accept(const uint8_t* p, size_t n) {
  if (n <= Header || n > MaxPacket || p[0] != 'R' || p[1] != 1) return;
  const uint32_t source = get32(p + 2), id = get32(p + 6), now = millis();
  const unsigned part = p[10], count = p[11];
  const size_t bytes = n - Header;
  if (!count || count > Parts || part >= count || (part + 1 < count && bytes != Chunk)) return;
  Assembly* slot = nullptr;
  for (auto& a : inbox) {
    if (a.used && now - a.touched > 3000) a.used = false;
    if (a.used && a.source == source && a.id == id) { slot = &a; break; }
    if (!a.used) slot = &a;
  }
  if (!slot) return;
  auto& a = *slot;
  if (!a.used) {
    a.used = true; a.source = source; a.id = id; a.count = count; a.mask = 0; a.length = 0;
  }
  if (a.count != count || (a.mask & (1U << part))) return;
  memcpy(a.text + part * Chunk, p + Header, bytes);
  a.touched = now;
  a.mask |= 1U << part;
  if (part + 1 == count) a.length = part * Chunk + bytes;
  if (a.mask != (1U << count) - 1) return;
  // Радиоданные остаются в hex в строковом протоколе USB.
  char hex[2 * MaxBytes + 1];
  constexpr char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < a.length; ++i) {
    hex[2*i] = digits[a.text[i] >> 4];
    hex[2*i+1] = digits[a.text[i] & 15];
  }
  hex[2*a.length] = 0;
  Serial.printf("CHAT RX %08lx %08lx %s\n", (unsigned long)source, (unsigned long)id, hex);
  a.used = false;
}
}

int16_t configure(CC1101& radio) {
  for (auto& a : inbox) a.used = false;
  if (!stationId) stationId = esp_random();
  int16_t e = radio.setPromiscuousMode(false);
  if (!e) e = radio.packetMode();
  if (!e) e = radio.setSyncWord(0x52, 0x43);
  if (!e) e = radio.setCrcFiltering(true);
  if (!e) e = radio.variablePacketLengthMode(MaxPacket);
  if (!e) e = radio.startReceive();
  return e;
}
int16_t send(CC1101& radio, const char* hex) {
  const size_t chars = strlen(hex);
  if (!chars || (chars & 1) || chars > MaxBytes * 2) { Serial.println("CHAT ERROR SIZE"); return 0; }
  uint8_t data[MaxBytes];
  const size_t length = chars / 2;
  for (size_t i = 0; i < length; ++i) {
    int a = nibble(hex[2*i]), b = nibble(hex[2*i+1]);
    if (a < 0 || b < 0) { Serial.println("CHAT ERROR TEXT"); return 0; }
    data[i] = (a << 4) | b;
  }
  uint32_t id = esp_random();
  uint8_t packet[MaxPacket] = {'R', 1};
  put32(packet + 2, stationId);
  put32(packet + 6, id);
  packet[11] = (length + Chunk - 1) / Chunk;
  int16_t result = 0;
  for (uint8_t part = 0; part < packet[11]; ++part) {
    packet[10] = part;
    size_t offset = part * Chunk;
    size_t n = length - offset < Chunk ? length - offset : Chunk;
    memcpy(packet + Header, data + offset, n);
    result = radio.transmit(packet, Header + n);
    if (result) break;
    if (part + 1 < packet[11]) delay(20);
  }
  int16_t rx = radio.startReceive();
  if (result) Serial.printf("CHAT ERROR TX %d\n", result);
  else Serial.printf("CHAT SENT %08lx\n", (unsigned long)id);
  return rx;
}
int16_t receive(CC1101& radio) {
  uint8_t packet[MaxPacket];
  const size_t n = radio.getPacketLength();
  const int16_t result = radio.readData(packet, MaxPacket);
  if (!result && n <= MaxPacket) accept(packet, n);
  return radio.startReceive();
}
}
