#pragma once
typedef int FsLVarId;
typedef int FsUnitId;
enum FsVarError : unsigned int { FS_VAR_ERROR_NONE = 0, FS_VAR_ERROR_FAIL = 0xffffffff };
#define FS_VAR_INVALID_ID -1
#define FS_INVALID_UNIT -1
FsUnitId fsVarsGetUnitId(const char*);
FsLVarId fsVarsRegisterLVar(const char*);
FsVarError fsVarsLVarGet(FsLVarId, FsUnitId, double*);
