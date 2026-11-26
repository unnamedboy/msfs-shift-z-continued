#pragma once
enum FsCommBusBroadcastFlags { FsCommBusBroadcast_JS = 1 };
typedef void (*fsCommBusWasmCallback)(const char*, unsigned int, void*);
bool fsCommBusCall(const char*, const char*, unsigned int, FsCommBusBroadcastFlags);
bool fsCommBusRegister(const char*, fsCommBusWasmCallback, void* = nullptr);
int fsCommBusUnregister(const char*, fsCommBusWasmCallback = nullptr);
