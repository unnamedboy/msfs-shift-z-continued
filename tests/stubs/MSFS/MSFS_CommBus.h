#pragma once
enum FsCommBusBroadcastFlags { FsCommBusBroadcast_JS = 1 };
bool fsCommBusCall(const char*, const char*, unsigned int, FsCommBusBroadcastFlags);
