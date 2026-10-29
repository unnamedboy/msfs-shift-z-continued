"""Compile the actual FPS module against test doubles and run its native tests."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
vswhere = Path(os.environ.get('ProgramFiles(x86)', '')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
msbuild = os.environ.get('MSBUILD_EXE')
if not msbuild and vswhere.is_file():
    results = subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-find', r'MSBuild\**\Bin\MSBuild.exe'], text=True).splitlines()
    msbuild = results[0].strip() if results else None
if not msbuild:
    raise SystemExit('MSBuild not found; install Visual Studio C++ tools or set MSBUILD_EXE.')
with tempfile.TemporaryDirectory(prefix='shift-z-build-', dir=root) as temp:
    output = Path(temp) / 'out'
    intermediate = Path(temp) / 'obj'
    subprocess.run([msbuild, str(root / 'tests/fps_test.vcxproj'), '/p:Configuration=Debug', '/p:Platform=x64',
                    '/p:OutDir=' + str(output) + os.sep, '/p:IntDir=' + str(intermediate) + os.sep,
                    '/verbosity:minimal'], check=True)
    subprocess.run([str(output / 'fps_test.exe')], check=True)
print('C++ FPS module tests passed')
