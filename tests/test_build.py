import json
import zipfile
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
import package_release


class PackageTests(unittest.TestCase):
    def test_generated_project_and_package_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / 'project'
            project.mkdir()
            build.prepare_project(project)
            self.assertTrue((project / 'PackageDefinitions/shift-z-continued.xml').is_file())
            self.assertTrue((project / 'PackageSources/InGamePanels/ShiftZContinued.xml').is_file())
            built = project / 'Packages/shift-z-continued'
            (built / 'Build').mkdir(parents=True)
            (built / 'Build/ShiftZContinued.spb').write_bytes(b'spb')
            (built / 'manifest.json').write_text('{}', encoding='utf-8')
            (project / 'wasm-output').mkdir()
            (project / 'wasm-output/shift-z-continued-fps.wasm').write_bytes(b'wasm')
            target = root / 'package'
            build.assemble_package(project, target)
            entries = json.loads((target / 'layout.json').read_text(encoding='utf-8'))['content']
            self.assertIn('InGamePanels/ShiftZContinued.spb', [e['path'] for e in entries])
            self.assertIn('modules/shift-z-continued-fps.wasm', [e['path'] for e in entries])
            for entry in entries:
                self.assertEqual((target / entry['path']).stat().st_size, entry['size'])

    def test_rebuild_removes_stale_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / 'new-package'
            target = root / 'output'
            package.mkdir()
            target.mkdir()
            (package / 'current.js').write_text('new', encoding='utf-8')
            (target / 'old.js').write_text('old', encoding='utf-8')
            build.publish_package(package, target)
            self.assertEqual((target / 'current.js').read_text(encoding='utf-8'), 'new')
            self.assertFalse((target / 'old.js').exists())

    def test_release_zip_contains_readme_and_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / 'shift-z-continued'
            (package / 'modules').mkdir(parents=True)
            (package / 'manifest.json').write_text('{}', encoding='utf-8')
            (package / 'modules/fps.wasm').write_bytes(b'wasm')
            readme = root / 'readme.txt'
            readme.write_text('installation instructions', encoding='utf-8')
            destination = root / 'release.zip'
            package_release.create_archive(package, readme, destination)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(set(archive.namelist()), {
                    'readme.txt', 'shift-z-continued/manifest.json',
                    'shift-z-continued/modules/fps.wasm',
                })
                self.assertEqual(archive.read('readme.txt'), b'installation instructions')

    def test_missing_sdk_output_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, 'expected SPB and manifest'):
                build.assemble_package(root, root / 'output')


class SdkConfigTests(unittest.TestCase):
    def test_local_file_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / '.env').write_text('MSFS2024_SDK="local-sdk"\n', encoding='utf-8')
            with mock.patch.object(build, 'ROOT', root), mock.patch.dict('os.environ', {}, clear=True):
                self.assertEqual(build.local_sdk_root(), 'local-sdk')
                with mock.patch.dict('os.environ', {'MSFS2024_SDK': 'environment-sdk'}):
                    self.assertEqual(build.local_sdk_root(), 'environment-sdk')

    def test_missing_config_returns_none(self):
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(build, 'ROOT', Path(temp)), mock.patch.dict('os.environ', {}, clear=True):
                self.assertIsNone(build.local_sdk_root())


if __name__ == '__main__':
    unittest.main()
