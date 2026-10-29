"""Create the distributable ZIP from an already built Community package."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent


def create_archive(package, readme, destination):
    if not package.is_dir() or not readme.is_file():
        raise FileNotFoundError('Build the package and provide readme.txt before creating the ZIP.')
    with ZipFile(destination, 'w', compression=ZIP_DEFLATED) as archive:
        archive.write(readme, 'readme.txt')
        for file in sorted(package.rglob('*')):
            if file.is_file():
                archive.write(file, (Path(package.name) / file.relative_to(package)).as_posix())


if __name__ == '__main__':
    create_archive(ROOT / 'dist' / 'shift-z-continued', ROOT / 'readme.txt',
                   ROOT / 'dist' / 'shift-z-continued.zip')
