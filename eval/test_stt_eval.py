"""
Offline checks for stt_eval.py: text normalisation, the language split, and the HTTP engine
adapters against stubbed responses — the request each provider expects and how its answer is read.
No API key and no network. Run from this folder:

    python -m unittest test_stt_eval
"""
from __future__ import annotations

import base64
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import stt_eval  # noqa: E402

SAMPLE = Path(__file__).parent / "sample_calls" / "call_001.wav"


class FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self.payload, self.status_code = payload, status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self.payload


class NormalizeTests(unittest.TestCase):
    def test_arabic_variants_and_french_accents_fold(self):
        self.assertEqual(
            stt_eval.normalize("نحب نأخذ rendez-vous غدوة الصباح"),
            stt_eval.normalize("نحب ناخذ rendez vous غدوه الصباح"),
        )
        self.assertEqual(stt_eval.normalize("Détartrage, docteur!"), "detartrage docteur")

    def test_segment_language(self):
        self.assertEqual(stt_eval.segment_language("عسلامة cabinet"), "mixed")
        self.assertEqual(stt_eval.segment_language("الجمعة 10 الصباح"), "darija")
        self.assertEqual(stt_eval.segment_language("bonjour"), "french")
        self.assertEqual(stt_eval.segment_language("10"), "empty")

    def test_score_is_word_error_rate_over_normalised_text(self):
        wer, n = stt_eval.score("a b c d", "a b x d")
        self.assertEqual((round(wer, 2), n), (0.25, 4))


class OpenAIEngineTests(unittest.TestCase):
    @mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"})
    def test_request_shape_and_parsing(self):
        with mock.patch("requests.post", return_value=FakeResponse({"text": "عسلامة cabinet"})) as post:
            self.assertEqual(stt_eval.engine_openai(SAMPLE), "عسلامة cabinet")
        (url,), kw = post.call_args
        self.assertEqual(url, "https://api.openai.com/v1/audio/transcriptions")
        self.assertEqual(kw["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(kw["data"]["model"], "gpt-4o-transcribe")
        self.assertEqual(kw["data"]["language"], "ar")
        self.assertIn("derja", kw["data"]["prompt"])
        name, content, mime = kw["files"]["file"]
        self.assertEqual((name, mime), ("call_001.wav", "audio/wav"))
        self.assertEqual(content, SAMPLE.read_bytes())

    @mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test", "OPENAI_STT_MODEL": "whisper-1"})
    def test_model_override(self):
        with mock.patch("requests.post", return_value=FakeResponse({"text": "x"})) as post:
            stt_eval.engine_openai(SAMPLE)
        self.assertEqual(post.call_args.kwargs["data"]["model"], "whisper-1")

    def test_missing_key_stops_the_run(self):
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            stt_eval.engine_openai(SAMPLE)


GEMINI_OK = {
    "candidates": [
        {
            "content": {"parts": [{"text": "عسلامة cabinet docteur ben salem\n"}, {"text": "نحب نأخذ rendez-vous"}], "role": "model"},
            "finishReason": "STOP",
        }
    ]
}


class GeminiEngineTests(unittest.TestCase):
    @mock.patch.dict(os.environ, {"GEMINI_API_KEY": "g-test"})
    def test_request_shape_and_parsing(self):
        with mock.patch("requests.post", return_value=FakeResponse(GEMINI_OK)) as post:
            text = stt_eval.engine_gemini(SAMPLE)
        self.assertEqual(text, "عسلامة cabinet docteur ben salem\nنحب نأخذ rendez-vous")
        (url,), kw = post.call_args
        self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")
        self.assertEqual(kw["headers"]["x-goog-api-key"], "g-test")
        parts = kw["json"]["contents"][0]["parts"]
        self.assertIn("derja", parts[0]["text"])
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "audio/wav")
        self.assertEqual(base64.b64decode(parts[1]["inline_data"]["data"]), SAMPLE.read_bytes())
        self.assertEqual(kw["json"]["generationConfig"]["temperature"], 0)

    @mock.patch.dict(os.environ, {"GOOGLE_API_KEY": "g2", "GEMINI_STT_MODEL": "gemini-2.5-pro"})
    def test_google_key_and_model_override(self):
        with mock.patch("requests.post", return_value=FakeResponse(GEMINI_OK)) as post:
            stt_eval.engine_gemini(SAMPLE)
        self.assertIn("gemini-2.5-pro:generateContent", post.call_args.args[0])

    @mock.patch.dict(os.environ, {"GEMINI_API_KEY": "g-test"})
    def test_blocked_answer_is_a_failure_not_a_perfect_empty_transcript(self):
        blocked = {"promptFeedback": {"blockReason": "OTHER"}}
        with mock.patch("requests.post", return_value=FakeResponse(blocked)), self.assertRaises(RuntimeError):
            stt_eval.engine_gemini(SAMPLE)

    def test_missing_key_stops_the_run(self):
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            stt_eval.engine_gemini(SAMPLE)


class RegistryTests(unittest.TestCase):
    def test_every_engine_is_registered(self):
        self.assertEqual(list(stt_eval.ENGINES), ["dryrun", "deepgram", "azure", "elevenlabs", "openai", "gemini", "hf"])

    def test_dryrun_scores_the_sample_calls(self):
        results = stt_eval.run(SAMPLE.parent, ["dryrun"])
        self.assertEqual(len(results), 3)
        self.assertTrue(all(0 < r.wer < 0.5 for r in results))
        summary = stt_eval.summarize(results)
        self.assertEqual(summary["dryrun"]["files"], 3)


if __name__ == "__main__":
    unittest.main()
