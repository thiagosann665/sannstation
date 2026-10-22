import json
import unittest
import urllib.parse

from sann import meta

WIKITEXT = """{{Short description|1995 video game}}
{{Infobox video game
| title = Chrono Trigger
| image = Chrono Trigger.jpg
| developer = [[Square (video game company)|Square]]<ref>{{cite web|url=x}}</ref>
| publisher = {{ubl|Square|[[Nintendo]] (PAL)}}
| director = {{ubl|Takashi Tokita|Yoshinori Kitase}}
| series = ''[[Chrono (series)|Chrono]]''
| platforms = [[Super Nintendo Entertainment System|SNES]], [[PlayStation (console)|PlayStation]]
| released = {{Collapsible list|title={{nobr|March 11, 1995}}|'''SNES'''{{vgrelease|JP|March 11, 1995|NA|August 22, 1995}}|'''PlayStation'''{{vgrelease|JP|November 2, 1999}}}}
| genre = [[Role-playing video game|Role-playing]]
| modes = [[Single-player video game|Single-player]]
}}
'''''Chrono Trigger''''' is a 1995 role-playing video game."""


class MetaTest(unittest.TestCase):
    def test_infobox_fields(self):
        fields = meta.parse_infobox(WIKITEXT)
        self.assertIn("developer", fields)
        info = meta.meta_from_infobox(fields)
        self.assertEqual(info["year"], 1995)
        self.assertEqual(info["genres"], ["RPG"])
        self.assertEqual(info["developer"], "Square")
        self.assertEqual(info["publisher"], "Square")
        self.assertEqual(info["series"], "Chrono")

    def test_modern_infobox(self):
        text = """{{Infobox video game
| title = Hollow Knight
| developer = [[Team Cherry]]
| publisher = Team Cherry
| engine = [[Unity (game engine)|Unity]]
| platforms = {{Plainlist|
* [[Windows]]
* [[macOS]]
}}
| released = {{Plainlist|
* '''Windows''', '''macOS'''
* {{Video game release|WW|February 24, 2017}}
* '''Switch'''
* {{Video game release|WW|June 12, 2018}}
}}
| genre = [[Action-adventure game|Action-adventure]], [[Metroidvania]]
| modes = [[Single-player video game|Single-player]]
}}"""
        info = meta.meta_from_infobox(meta.parse_infobox(text))
        self.assertEqual(info["year"], 2017)
        self.assertEqual(info["genres"], ["Ação e aventura", "Metroidvania"])
        self.assertEqual(info["developer"], "Team Cherry")
        self.assertEqual(meta.meta_from_infobox({"released": "{{Start date|1990|11|21}}"})["year"], 1990)

    def test_clean_value(self):
        self.assertEqual(meta.clean_value("[[Action game|Action]], [[platform game|platform]]<ref>x</ref>"),
                         "Action, platform")
        self.assertEqual(meta.clean_value("{{Plainlist|\n* [[Nintendo EAD]]\n* [[Retro Studios]]\n}}"),
                         "Nintendo EAD\nRetro Studios")

    def test_translate_genre(self):
        self.assertEqual(meta.translate_genre("Platform"), "Plataforma")
        self.assertEqual(meta.translate_genre("first-person shooter"), "Tiro em primeira pessoa")
        self.assertEqual(meta.translate_genre("Soulslike"), "Soulslike")

    def test_best_title(self):
        hits = ["Chrono Cross", "Chrono Trigger", "Chrono (series)"]
        self.assertEqual(meta.best_title(hits, "Chrono Trigger"), "Chrono Trigger")
        self.assertEqual(meta.best_title(["Doom (2016 video game)"], "DOOM"), "Doom (2016 video game)")
        self.assertIsNone(meta.best_title(["Something Else"], "Chrono Trigger"))

    def test_fetch_meta_with_portuguese_description(self):
        def fake(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            if q.get("list") == "search":
                return {"query": {"search": [{"title": "Chrono Trigger"}]}}
            if "pt.wikipedia" in url:
                return {"query": {"pages": [{"title": "Chrono Trigger", "extract": "Chrono Trigger é um RPG de 1995."}]}}
            return {"query": {"pages": [{"title": "Chrono Trigger", "extract": "Chrono Trigger is a 1995 RPG.",
                                         "langlinks": [{"lang": "pt", "title": "Chrono Trigger"}],
                                         "revisions": [{"slots": {"main": {"content": WIKITEXT}}}]}]}}
        info = meta.fetch_meta("Chrono Trigger", fake)
        self.assertEqual(info["description"], "Chrono Trigger é um RPG de 1995.")
        self.assertTrue(info["url"].startswith("https://pt.wikipedia.org/"))
        self.assertEqual(info["year"], 1995)
        json.dumps(info)


if __name__ == "__main__":
    unittest.main()
