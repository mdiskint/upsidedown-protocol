#!/usr/bin/env python3
"""
enroll_voice.py — enroll or update the user's voice embedding for Presence realtime filtering.

Usage:
  python3 enroll_voice.py
  python3 enroll_voice.py --file /path/to/audio.wav
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import numpy as np
import requests
from dotenv import load_dotenv
from resemblyzer import VoiceEncoder, preprocess_wav


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(SCRIPT_DIR, ".env"), override=True)

RECORD_SECONDS = 30
SAMPLE_RATE = 16000
USER_ID = "default"

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
SUPABASE_KEY = (
    os.getenv("SUPABASE_SERVICE_KEY")
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_ANON_KEY")
    or os.getenv("SUPABASE_KEY")
    or ""
).strip()


def supabase_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def record_mic_numpy(duration_seconds: int, sample_rate: int) -> np.ndarray:
    """
    Record mono PCM from default macOS mic via ffmpeg and keep audio in memory only.
    Returns float32 waveform in range [-1, 1].
    """
    cmd = [
        "ffmpeg",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-t",
        str(duration_seconds),
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-loglevel",
        "error",
        "pipe:1",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    if proc.stdout is None:
        raise RuntimeError("ffmpeg stdout unavailable for mic capture")

    expected_bytes = duration_seconds * sample_rate * 2  # int16 mono
    collected = bytearray()
    next_tick = 1
    start = time.time()
    print("Speak naturally...")

    while len(collected) < expected_bytes:
        chunk = proc.stdout.read(min(8192, expected_bytes - len(collected)))
        if not chunk:
            break
        collected.extend(chunk)

        elapsed = int(time.time() - start)
        while elapsed >= next_tick and next_tick <= duration_seconds:
            if next_tick % 10 == 0 or next_tick == duration_seconds:
                print(f"... {next_tick}s")
            next_tick += 1

    stdout_remainder = proc.stdout.read() or b""
    if stdout_remainder:
        collected.extend(stdout_remainder)
    stderr = (proc.stderr.read() or b"").decode("utf-8", errors="ignore") if proc.stderr else ""
    return_code = proc.wait(timeout=5)

    if return_code != 0:
        raise RuntimeError(f"ffmpeg mic capture failed ({return_code}): {stderr[:240]}")
    if len(collected) < sample_rate * 2:  # <1 second
        raise RuntimeError("Mic capture too short or silent; no usable audio collected")

    pcm16 = np.frombuffer(bytes(collected), dtype=np.int16)
    audio = (pcm16.astype(np.float32) / 32768.0).copy()
    del collected
    del pcm16
    return audio


def compute_embedding_from_mic(encoder: VoiceEncoder) -> np.ndarray:
    audio = record_mic_numpy(RECORD_SECONDS, SAMPLE_RATE)
    wav = preprocess_wav(audio, source_sr=SAMPLE_RATE)
    embedding = encoder.embed_utterance(wav)
    del audio
    del wav
    return embedding


def compute_embedding_from_file(encoder: VoiceEncoder, path: str) -> np.ndarray:
    wav = preprocess_wav(path)
    embedding = encoder.embed_utterance(wav)
    del wav
    return embedding


def get_existing_embedding(user_id: str) -> dict | None:
    url = (
        f"{SUPABASE_URL}/rest/v1/voice_embeddings"
        f"?select=id,embedding,sample_count&user_id=eq.{user_id}&order=updated_at.desc&limit=1"
    )
    resp = requests.get(url, headers=supabase_headers(), timeout=20)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        return None
    return rows[0]


def upsert_embedding(user_id: str, new_embedding: np.ndarray) -> int:
    now_iso = datetime.now(timezone.utc).isoformat()
    existing = get_existing_embedding(user_id)

    if existing:
        old_vec = np.array(existing.get("embedding") or [], dtype=np.float32)
        old_count = int(existing.get("sample_count") or 1)
        if old_vec.shape[0] != new_embedding.shape[0]:
            blended = new_embedding
            new_count = 1
        else:
            new_count = old_count + 1
            blended = ((old_vec * old_count) + new_embedding) / float(new_count)

        update_url = f"{SUPABASE_URL}/rest/v1/voice_embeddings?id=eq.{existing['id']}"
        payload = {
            "embedding": blended.astype(float).tolist(),
            "sample_count": new_count,
            "updated_at": now_iso,
        }
        resp = requests.patch(
            update_url,
            headers={**supabase_headers(), "Prefer": "return=minimal"},
            json=payload,
            timeout=20,
        )
        resp.raise_for_status()
        return new_count

    insert_url = f"{SUPABASE_URL}/rest/v1/voice_embeddings"
    payload = {
        "user_id": user_id,
        "embedding": new_embedding.astype(float).tolist(),
        "sample_count": 1,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    resp = requests.post(
        insert_url,
        headers={**supabase_headers(), "Prefer": "return=minimal"},
        json=payload,
        timeout=20,
    )
    resp.raise_for_status()
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Enroll/update a voice embedding for Presence realtime filtering.")
    parser.add_argument("--file", dest="audio_file", help="Optional audio file path to enroll instead of live mic.")
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE key env vars are required.", file=sys.stderr)
        return 1

    print("Loading voice encoder...")
    encoder = VoiceEncoder()

    if args.audio_file:
        print(f"Using audio file: {args.audio_file}")
        embedding = compute_embedding_from_file(encoder, args.audio_file)
    else:
        print(f"Recording from default mic for {RECORD_SECONDS} seconds...")
        embedding = compute_embedding_from_mic(encoder)

    sample_n = upsert_embedding(USER_ID, embedding)
    del embedding
    print(f"Voice enrolled. Embedding stored. (sample {sample_n})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
