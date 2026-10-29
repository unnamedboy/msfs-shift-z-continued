#pragma once
#include <MSFS/MSFS_WindowsTypes.h>
using SIMCONNECT_CLIENT_EVENT_ID = unsigned int;
constexpr int S_OK = 0;
constexpr int SIMCONNECT_RECV_ID_EVENT_FRAME = 1;
struct SIMCONNECT_RECV { DWORD dwID; };
struct SIMCONNECT_RECV_EVENT_FRAME : SIMCONNECT_RECV { DWORD uEventID; float fFrameRate; float fSimSpeed; };
using DispatchProc = void (*)(SIMCONNECT_RECV*, DWORD, void*);
int SimConnect_Open(HANDLE*, const char*, void*, DWORD, int, DWORD);
int SimConnect_SubscribeToSystemEvent(HANDLE, SIMCONNECT_CLIENT_EVENT_ID, const char*);
int SimConnect_CallDispatch(HANDLE, DispatchProc, void*);
int SimConnect_Close(HANDLE);
