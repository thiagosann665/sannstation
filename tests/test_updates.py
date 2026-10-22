import unittest

from sann import updates
from sann.version import VERSION


class UpdatesTest(unittest.TestCase):
    def test_versions(self):
        self.assertEqual(updates.parse_version("v1.10.2"), (1, 10, 2))
        self.assertTrue(updates.is_newer("1.10.0", "1.9.9"))
        self.assertTrue(updates.is_newer("v1.1.1", "1.1"))
        self.assertFalse(updates.is_newer("1.1.0", "1.1"))
        self.assertFalse(updates.is_newer("1.0.6", VERSION))

    def release(self, tag, **extra):
        base = f"https://github.com/{updates.REPO}/releases/download/{tag}/"
        return {"tag_name": tag, "html_url": "https://github.com/x", "body": "Novidades",
                "assets": [{"name": f"SannStation-Portatil-{tag[1:]}.zip", "browser_download_url": base + "p.zip"},
                           {"name": f"SannStation-Setup-{tag[1:]}.exe", "browser_download_url": base + f"SannStation-Setup-{tag[1:]}.exe"}],
                **extra}

    def test_check_picks_setup(self):
        info = updates.check(lambda url: self.release("v9.0.0"), "1.1.0")
        self.assertTrue(info["available"])
        self.assertTrue(info["setup"].endswith("SannStation-Setup-9.0.0.exe"))
        self.assertFalse(updates.check(lambda url: self.release("v1.1.0"), "1.1.0")["available"])
        self.assertFalse(updates.check(lambda url: self.release("v9.0.0", prerelease=True), "1.1.0")["available"])

    def test_rejects_asset_from_other_place(self):
        rel = self.release("v9.0.0")
        rel["assets"][1]["browser_download_url"] = "https://evil.example/SannStation-Setup-9.0.0.exe"
        self.assertIsNone(updates.check(lambda url: rel, "1.1.0")["setup"])


if __name__ == "__main__":
    unittest.main()
