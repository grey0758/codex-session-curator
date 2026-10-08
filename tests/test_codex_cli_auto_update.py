import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "codex-cli-auto-update.py"
spec = importlib.util.spec_from_file_location("codex_cli_auto_update", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class DiscoveryTest(unittest.TestCase):
    def test_detects_existing_official_channels_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            npm_package = home / ".local/lib/node_modules/@openai/codex"
            npm_package.mkdir(parents=True)
            (npm_package / "bin").mkdir()
            (npm_package / "package.json").write_text("{}")
            (npm_package / "bin/codex.js").write_text("#!/usr/bin/env node\n")
            npm_bin = home / ".local/bin/codex"
            npm_bin.parent.mkdir(parents=True)
            npm_bin.symlink_to("../lib/node_modules/@openai/codex/bin/codex.js")
            self.assertEqual(module.installation(npm_bin, home), ("npm", home / ".local"))

            standalone = home / ".codex/packages/standalone/releases/1.2.3/bin/codex"
            standalone.parent.mkdir(parents=True)
            standalone.write_text("binary")
            link = home / ".codex/packages/standalone/current"
            link.symlink_to("releases/1.2.3")
            entry = home / ".local/bin/codex-standalone"
            entry.symlink_to(link / "bin/codex")
            self.assertEqual(module.installation(entry, home), ("standalone", link.parent))

            unrelated = home / ".npm-global/bin/codex"
            unrelated.parent.mkdir(parents=True)
            unrelated.write_text("unrelated binary")
            self.assertIsNone(module.installation(unrelated, home))


if __name__ == "__main__":
    unittest.main()
