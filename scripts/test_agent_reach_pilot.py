import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("agent-reach-pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotTests(unittest.TestCase):
    def test_dates_are_never_invented(self):
        self.assertIsNone(pilot.publication_ms(None))
        self.assertIsNone(pilot.publication_ms("yesterday"))
        self.assertEqual(pilot.publication_ms("2026-11-03"), pilot.publication_ms("2026-11-03T00:00:00Z"))

    def test_freshness_and_partial_provenance(self):
        now = pilot.publication_ms("2026-11-03T07:00:00Z")
        item = dict(url="https://www.reddit.com/r/tron/a?utm_source=test", title="Justin Sun", text="TRON blockchain " * 10, published_at="2026-11-03")
        post = pilot.make_post("reddit", item, [], now)
        self.assertFalse(post["completenessVerified"])
        self.assertEqual(post["url"], "https://reddit.com/r/tron/a")
        self.assertIsNone(pilot.make_post("reddit", {**item, "published_at": None}, [], now))
        self.assertIsNone(pilot.make_post("reddit", {**item, "published_at": "2026-10-30"}, [], now))

    def test_only_public_explicit_backend_no_key_or_cookie_environment(self):
        from unittest.mock import patch
        class Result:
            stdout = '{"schema_version":1,"ok":true,"items":[]}'
        with patch.object(pilot.subprocess, "run", return_value=Result()) as call:
            self.assertEqual(pilot.reach("xiaohongshu", "search", "孙宇晨"), [])
            args, kwargs = call.call_args
            self.assertIn("public-web", args[0])
            self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
            self.assertNotIn("OPENROUTER_API_KEY", kwargs["env"])
            self.assertIn("public-home", kwargs["env"]["HOME"])


if __name__ == "__main__":
    unittest.main()
