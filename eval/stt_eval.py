#!/usr/bin/env python3
"""
STT evaluation for Tunisian Darija / French phone audio.

Decides the week-1 question: does any off-the-shelf engine get under 20% WER
on real cabinet calls, or do we fine-tune Whisper?

Usage
-----
  python3 stt_eval.py --data ./calls --engines deepgram,azure,elevenlabs,openai,gemini,hf --out results.json
  python3 stt_eval.py --data ./calls --engines dryrun          # no API keys, sanity check
  python3 -m unittest test_stt_eval                            # offline: normalisation + engine adapters on stubbed HTTP

Data layout (one pair per call, same stem):
  calls/
    call_001.wav      16 kHz mono preferred; 8 kHz telephony is fine (that is the real condition)
    call_001.txt      reference transcript, one utterance per line, Arabic script and/or French

Reference transcript conventions
  - Write Darija in Arabic script, French words in Latin script, as spoken:
      "عسلامة، نحب نأخذ rendez-vous غدوة الصباح"
  - Latin-script Darija (Tunizi) in the reference is allowed but will be scored as 'french' by the
    language splitter; prefer Arabic script for Darija so the mixed/Darija split is meaningful.
  - Numbers as digits.

Env vars (only for the engines you run)
  DEEPGRAM_API_KEY
  AZURE_SPEECH_KEY, AZURE_SPEECH_REGION          (e.g. westeurope)
  ELEVENLABS_API_KEY
  OPENAI_API_KEY, OPENAI_STT_MODEL               (default: gpt-4o-transcribe)
  GEMINI_API_KEY or GOOGLE_API_KEY, GEMINI_STT_MODEL   (default: gemini-2.5-flash; audio sent inline, < 20 MB)
  HF_MODEL                                       (default: openai/whisper-large-v3; set to a Tunisian fine-tune)

openai and gemini are the LLM providers' batch transcription: the whole file goes up, the text comes
back. A win for them in the table does not by itself make them usable on a live call — the call
pipeline (Vapi) needs a streaming transcriber — so read their row as the ceiling that provider
reaches on our audio, and check what the pipeline can stream before choosing one.

Output: a table per engine with WER overall and split by segment language, plus per-file detail in --out.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable

import jiwer

# --------------------------------------------------------------------------------------
# Text normalisation: Arabic + French, tuned for WER fairness, not for display.
# --------------------------------------------------------------------------------------

_ARABIC_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭ]")
_TATWEEL = "ـ"
_PUNCT = re.compile(r"[^\w\s']", flags=re.UNICODE)
_ARABIC_RANGE = re.compile(r"[؀-ۿ]")
_LATIN_RANGE = re.compile(r"[A-Za-zÀ-ÿ]")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _ARABIC_DIACRITICS.sub("", text)
    text = text.replace(_TATWEEL, "")
    # Unify alef/ya/ta-marbuta variants (standard Arabic ASR normalisation)
    text = re.sub(r"[إأآا]", "ا", text)
    text = text.replace("ى", "ي").replace("ة", "ه")
    text = text.lower()
    # Strip French accents only for scoring (rendez-vous == rendez vous == rendezvous handled below)
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    text = text.replace("-", " ")
    text = _PUNCT.sub(" ", text)
    return " ".join(text.split())


def segment_language(text: str) -> str:
    """'darija' (Arabic script only), 'french' (Latin only), 'mixed' (both), 'empty'."""
    has_ar = bool(_ARABIC_RANGE.search(text))
    has_la = bool(_LATIN_RANGE.search(text))
    if has_ar and has_la:
        return "mixed"
    if has_ar:
        return "darija"
    if has_la:
        return "french"
    return "empty"


# --------------------------------------------------------------------------------------
# Engine adapters: each takes a wav path and returns a transcript string.
# --------------------------------------------------------------------------------------

def _require(var: str) -> str:
    val = os.environ.get(var)
    if not val:
        sys.exit(f"Missing env var {var}")
    return val


def engine_dryrun(wav: Path) -> str:
    """Returns the reference with small corruptions, so the pipeline can be checked without keys."""
    ref = wav.with_suffix(".txt").read_text(encoding="utf-8")
    words = ref.split()
    out = [w for i, w in enumerate(words) if i % 9 != 4]  # drop ~11% of words
    return " ".join(out)


def engine_deepgram(wav: Path) -> str:
    import requests

    key = _require("DEEPGRAM_API_KEY")
    params = {"model": "nova-3", "language": "ar-TN", "smart_format": "false", "punctuate": "false"}
    r = requests.post(
        "https://api.deepgram.com/v1/listen",
        params=params,
        headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
        data=wav.read_bytes(),
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["results"]["channels"][0]["alternatives"][0]["transcript"]


def engine_azure(wav: Path) -> str:
    import azure.cognitiveservices.speech as speechsdk  # pip install azure-cognitiveservices-speech

    key, region = _require("AZURE_SPEECH_KEY"), _require("AZURE_SPEECH_REGION")
    cfg = speechsdk.SpeechConfig(subscription=key, region=region)
    cfg.speech_recognition_language = "ar-TN"
    audio = speechsdk.audio.AudioConfig(filename=str(wav))
    rec = speechsdk.SpeechRecognizer(speech_config=cfg, audio_config=audio)
    parts: list[str] = []
    done = False

    def on_recognized(evt):
        if evt.result.text:
            parts.append(evt.result.text)

    def on_stop(_):
        nonlocal done
        done = True

    rec.recognized.connect(on_recognized)
    rec.session_stopped.connect(on_stop)
    rec.canceled.connect(on_stop)
    rec.start_continuous_recognition()
    while not done:
        time.sleep(0.2)
    rec.stop_continuous_recognition()
    return " ".join(parts)


def engine_elevenlabs(wav: Path) -> str:
    import requests

    key = _require("ELEVENLABS_API_KEY")
    r = requests.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": key},
        files={"file": (wav.name, wav.read_bytes(), "audio/wav")},
        data={"model_id": "scribe_v1", "language_code": "ara"},
        timeout=300,
    )
    r.raise_for_status()
    return r.json()["text"]


# Vocabulary hint shared by the LLM-provider engines: what the reference transcripts look like.
_STT_HINT = (
    "Appel téléphonique à un cabinet dentaire tunisien. Tunisien (derja) en écriture arabe, "
    "mots français en lettres latines tels que prononcés (rendez-vous, détartrage, docteur), nombres en chiffres."
)


def engine_openai(wav: Path) -> str:
    """OpenAI audio transcription, gpt-4o-transcribe by default (OPENAI_STT_MODEL overrides, e.g. whisper-1)."""
    import requests

    key = _require("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_STT_MODEL", "gpt-4o-transcribe")
    r = requests.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {key}"},
        files={"file": (wav.name, wav.read_bytes(), "audio/wav")},
        data={"model": model, "language": "ar", "prompt": _STT_HINT, "response_format": "json"},
        timeout=300,
    )
    r.raise_for_status()
    return r.json()["text"]


def engine_gemini(wav: Path) -> str:
    """Gemini generateContent with the audio inline (fine under 20 MB, about 10 min of 16 kHz mono).
    gemini-2.5-flash by default; GEMINI_STT_MODEL overrides."""
    import base64
    import requests

    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        sys.exit("Missing env var GEMINI_API_KEY (or GOOGLE_API_KEY)")
    model = os.environ.get("GEMINI_STT_MODEL", "gemini-2.5-flash")
    instruction = (
        f"Transcris mot à mot cet appel. {_STT_HINT} Réponds uniquement avec la transcription, "
        "une ligne par tour de parole, sans nom de locuteur, sans horodatage, sans commentaire."
    )
    body = {
        "contents": [
            {
                "parts": [
                    {"text": instruction},
                    {"inline_data": {"mime_type": "audio/wav", "data": base64.b64encode(wav.read_bytes()).decode("ascii")}},
                ]
            }
        ],
        "generationConfig": {"temperature": 0},
    }
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=body,
        timeout=300,
    )
    r.raise_for_status()
    data = r.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        # A safety block or an empty candidate must show up as a failed file, not as a perfect empty transcript.
        raise RuntimeError(f"Gemini returned no transcript: {json.dumps(data, ensure_ascii=False)[:300]}")
    return "\n".join(p["text"].strip() for p in parts if p.get("text")).strip()


_hf_pipe = None


def engine_hf(wav: Path) -> str:
    """Hugging Face Whisper (base or a Tunisian fine-tune). pip install transformers torch torchaudio"""
    global _hf_pipe
    if _hf_pipe is None:
        from transformers import pipeline

        model = os.environ.get("HF_MODEL", "openai/whisper-large-v3")
        _hf_pipe = pipeline("automatic-speech-recognition", model=model, chunk_length_s=30)
    out = _hf_pipe(str(wav), generate_kwargs={"language": "arabic", "task": "transcribe"})
    return out["text"]


ENGINES: dict[str, Callable[[Path], str]] = {
    "dryrun": engine_dryrun,
    "deepgram": engine_deepgram,
    "azure": engine_azure,
    "elevenlabs": engine_elevenlabs,
    "openai": engine_openai,
    "gemini": engine_gemini,
    "hf": engine_hf,
}

# --------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------


@dataclass
class FileResult:
    file: str
    engine: str
    language: str
    ref_words: int
    wer: float
    hyp: str
    seconds: float


def score(ref: str, hyp: str) -> tuple[float, int]:
    r, h = normalize(ref), normalize(hyp)
    if not r:
        return 0.0, 0
    return jiwer.wer(r, h), len(r.split())


def run(data: Path, engines: list[str]) -> list[FileResult]:
    wavs = sorted(data.glob("*.wav"))
    if not wavs:
        sys.exit(f"No .wav files in {data}")
    results: list[FileResult] = []
    for name in engines:
        fn = ENGINES[name]
        for wav in wavs:
            ref_path = wav.with_suffix(".txt")
            if not ref_path.exists():
                print(f"  skip {wav.name}: no reference .txt", file=sys.stderr)
                continue
            ref = ref_path.read_text(encoding="utf-8")
            t0 = time.time()
            try:
                hyp = fn(wav)
            except Exception as e:  # keep going; one bad file should not kill the run
                print(f"  {name} failed on {wav.name}: {e}", file=sys.stderr)
                continue
            dt = time.time() - t0
            wer, n = score(ref, hyp)
            results.append(FileResult(wav.name, name, segment_language(ref), n, wer, hyp, round(dt, 2)))
            print(f"  {name:11s} {wav.name:24s} {segment_language(ref):7s} WER {wer*100:5.1f}%  ({dt:.1f}s)")
    return results


def summarize(results: list[FileResult]) -> dict:
    """Word-weighted WER per engine, overall and per language bucket."""
    summary: dict[str, dict[str, float]] = {}
    for engine in sorted({r.engine for r in results}):
        rows = [r for r in results if r.engine == engine]
        summary[engine] = {}
        for bucket in ["overall", "darija", "french", "mixed"]:
            sel = rows if bucket == "overall" else [r for r in rows if r.language == bucket]
            total = sum(r.ref_words for r in sel)
            summary[engine][bucket] = (
                round(sum(r.wer * r.ref_words for r in sel) / total * 100, 1) if total else float("nan")
            )
        summary[engine]["files"] = len(rows)
    return summary


def print_table(summary: dict) -> None:
    print("\nWord error rate (%), word-weighted. Decision rule: <20 use it; >25 fine-tune.\n")
    print(f"{'engine':12s} {'overall':>8s} {'darija':>8s} {'french':>8s} {'mixed':>8s} {'files':>6s}")
    for engine, s in summary.items():
        cells = [f"{s[b]:8.1f}" if s[b] == s[b] else f"{'-':>8s}" for b in ["overall", "darija", "french", "mixed"]]
        print(f"{engine:12s} {' '.join(cells)} {s['files']:6d}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="folder with .wav + .txt pairs")
    ap.add_argument("--engines", default="dryrun", help="comma list: dryrun,deepgram,azure,elevenlabs,openai,gemini,hf")
    ap.add_argument("--out", type=Path, default=None, help="write per-file JSON results here")
    args = ap.parse_args()

    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    unknown = [e for e in engines if e not in ENGINES]
    if unknown:
        sys.exit(f"Unknown engine(s): {unknown}. Known: {list(ENGINES)}")

    results = run(args.data, engines)
    summary = summarize(results)
    print_table(summary)
    if args.out:
        args.out.write_text(
            json.dumps({"summary": summary, "files": [asdict(r) for r in results]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\nDetail written to {args.out}")


if __name__ == "__main__":
    main()
