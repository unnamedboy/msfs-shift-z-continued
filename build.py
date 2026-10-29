"""Generate an MSFS SDK project from src and build a Community package."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'src'


def prepare_project(project):
    shutil.copy2(SOURCE / 'sdk' / 'ShiftZContinued.xml', project / 'ShiftZContinued.xml')
    shutil.copytree(SOURCE / 'sdk' / 'PackageDefinitions', project / 'PackageDefinitions')
    shutil.copytree(SOURCE / 'InGamePanels', project / 'PackageSources' / 'InGamePanels')
    shutil.copytree(SOURCE / 'html_ui', project / 'PackageSources' / 'html_ui')



def build_wasm(project, sdk_root):
    vswhere = Path(os.environ.get('ProgramFiles(x86)', '')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    msbuild = os.environ.get('MSBUILD_EXE')
    if not msbuild and vswhere.is_file():
        found = subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-find', r'MSBuild\**\Bin\MSBuild.exe'], text=True).splitlines()
        msbuild = found[0].strip() if found else None
    if not msbuild:
        raise RuntimeError('MSBuild not found; install Visual Studio C++ tools or set MSBUILD_EXE.')
    source = project / 'wasm-source'
    shutil.copytree(SOURCE / 'wasm', source)
    out = project / 'wasm-output'
    obj = project / 'wasm-obj'
    env = os.environ.copy()
    env['MSFS2024_SDK'] = str(Path(sdk_root).resolve()) + os.sep
    subprocess.run([msbuild, str(source / 'fps.vcxproj'), '/p:Configuration=Release', '/p:Platform=MSFS',
                    '/p:OutDir=' + str(out) + os.sep, '/p:IntDir=' + str(obj) + os.sep,
                    '/verbosity:minimal'], cwd=project, env=env, check=True)
    if not (out / 'shift-z-continued-fps.wasm').is_file():
        raise RuntimeError('MSBuild did not produce the FPS WASM module.')


def assemble_package(project, target):
    built = project / 'Packages' / 'shift-z-continued'
    spb, manifest = built / 'Build' / 'ShiftZContinued.spb', built / 'manifest.json'
    if not spb.is_file() or not manifest.is_file():
        raise RuntimeError('SDK did not produce the expected SPB and manifest; inspect its build log.')
    (target / 'InGamePanels').mkdir(parents=True)
    shutil.copy2(spb, target / 'InGamePanels' / spb.name)
    shutil.copy2(manifest, target / 'manifest.json')
    shutil.copytree(project / 'PackageSources' / 'html_ui', target / 'html_ui')
    (target / 'modules').mkdir()
    shutil.copy2(project / 'wasm-output' / 'shift-z-continued-fps.wasm', target / 'modules' / 'shift-z-continued-fps.wasm')
    entries = []
    for file in sorted(target.rglob('*')):
        if file.is_file() and file.name not in ('manifest.json', 'layout.json'):
            stat = file.stat()
            entries.append({'path': file.relative_to(target).as_posix(), 'size': stat.st_size,
                            'date': int((stat.st_mtime + 11644473600) * 10000000)})
    (target / 'layout.json').write_text(json.dumps({'content': entries}, indent=2), encoding='utf-8')


def publish_package(package, target):
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(package, target)


def local_sdk_root():
    """Read the optional local SDK setting without overriding the environment."""
    if os.environ.get('MSFS2024_SDK'):
        return os.environ['MSFS2024_SDK']
    config = ROOT / '.env'
    if config.is_file():
        for line in config.read_text(encoding='utf-8-sig').splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip() == 'MSFS2024_SDK':
                return value.strip().strip('"').strip("'")
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sdk', default=local_sdk_root(), help='MSFS 2024 SDK root (or set MSFS2024_SDK)')
    args = parser.parse_args()
    if not args.sdk:
        parser.error('Set MSFS2024_SDK in the environment or .env, or pass --sdk.')
    tool = Path(args.sdk) / 'Tools' / 'bin' / 'fspackagetool.exe'
    if not tool.is_file():
        parser.error(f'MSFS 2024 SDK package tool not found: {tool}')
    with tempfile.TemporaryDirectory(prefix='shift-z-build-', dir=ROOT) as temp:
        project = Path(temp) / 'project'
        project.mkdir()
        prepare_project(project)
        build_wasm(project, args.sdk)
        subprocess.run([str(tool), '-nopause', str(project / 'ShiftZContinued.xml')], cwd=project, check=True)
        package = Path(temp) / 'shift-z-continued'
        assemble_package(project, package)
        target = ROOT / 'dist' / 'shift-z-continued'
        publish_package(package, target)
    print(f'Package ready: {target}')


if __name__ == '__main__':
    main()
