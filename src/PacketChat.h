#pragma once
#include <RadioLib.h>

namespace PacketChat {
int16_t configure(CC1101& radio);
int16_t send(CC1101& radio, const char* hex);
int16_t receive(CC1101& radio);
}
