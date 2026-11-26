import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import gen_watched_commands as gen


class WatchedCommandTests(unittest.TestCase):
    def test_parses_first_column_and_filters(self):
        page = '\n'.join([
            '| Key Name | Event ID | Parameters | Description |',
            '|---|---|---|---|',
            '| {{< anchor id="AUTORUDDER_TOGGLE" />}}`AUTORUDDER_TOGGLE` | `KEY_AUTOCOORD_TOGGLE` | N/A | Auto rudder. |',
            '| {{< anchor id="AXIS_RUDDER_SET" />}}`AXIS_RUDDER_SET` | `KEY_AXIS_RUDDER_SET` | [0]: Position | Rudder. |',
            '| {{< anchor id="A1" />}}`ANTI_ICE_TOGGLE_ENG1`<span></span>{{< anchor id="A2" />}}<span class="legacy">'
            '`ANTI_ICE_TOGGLE_ENG2`</span> | `KEY_A1`<br>`KEY_A2` | N/A | Anti ice. |',
            '| {{< anchor id="AP_ALT_VAR_SET_ENGLISH" />}}`AP_ALT_VAR_SET_ENGLISH` | `KEY_X` | [0]: feet | Set. |',
            '| {{< anchor id="DEBUG_A" />}}`DEBUG_A` | `KEY_DEBUG_A` | N/A | Debug. |',
            '| {{< anchor id="BATTERY1_SET" />}}`BATTERY1_SET` | `KEY_B` | N/A | Set. |',
            '| Plain text row without an anchor | `NOT_A_COMMAND` | | |',
        ])
        names = gen.parse_names(page)
        self.assertEqual(names, ['AUTORUDDER_TOGGLE', 'AXIS_RUDDER_SET', 'ANTI_ICE_TOGGLE_ENG1', 'ANTI_ICE_TOGGLE_ENG2',
                                 'AP_ALT_VAR_SET_ENGLISH', 'DEBUG_A', 'BATTERY1_SET'])
        self.assertEqual(gen.watched(names + ['AUTORUDDER_TOGGLE']),
                         ['ANTI_ICE_TOGGLE_ENG1', 'ANTI_ICE_TOGGLE_ENG2', 'AUTORUDDER_TOGGLE'])
        self.assertEqual(gen.watched(names, {'ANTI_ICE_TOGGLE_ENG2'}), ['ANTI_ICE_TOGGLE_ENG1', 'AUTORUDDER_TOGGLE'])
        unknown_text = '\n'.join(['# comment', 'FLAPS_4', '', '  AP_MASTER_ALT ', ''])
        self.assertEqual(gen.read_unknown(unknown_text), {'FLAPS_4', 'AP_MASTER_ALT'})
        rendered = gen.render(['A_1', 'B'])
        self.assertTrue(rendered.startswith('// Generated'))
        self.assertIn('    "A_1",\n    "B",\n};', rendered)

    def test_committed_header_fits_simconnect_limits(self):
        names = re.findall(r'^    "([A-Z0-9_]+)",$', gen.OUTPUT.read_text(encoding='utf-8'), re.MULTILINE)
        self.assertIn('AUTORUDDER_TOGGLE', names)
        self.assertIn('SLEW_TOGGLE', names)
        self.assertEqual(names, sorted(set(names)))
        self.assertFalse([name for name in names if gen.EXCLUDED.search(name)])
        unknown = gen.read_unknown(gen.UNKNOWN.read_text(encoding='utf-8'))
        self.assertIn('AUTOCOORD_TOGGLE', unknown)
        self.assertFalse(unknown & set(names), 'names the sim rejected are not watched')
        # Groups 2 and up, 1000 events each; a SimConnect client has at most 20 groups.
        self.assertLessEqual(len(names), 18 * 1000)
        self.assertGreater(len(names), 1000)


if __name__ == '__main__':
    unittest.main()
