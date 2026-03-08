#!/usr/bin/env python3
"""
realtime_listener.py — Continuous real-time presence loop for Hearth+

Two nervous systems, same identity model:
  - Parasympathetic (presence.py): slow, 30-minute cycles, strategic
  - Sympathetic (this file): fast, 30-60 second cycles, tactical

Architecture:
  1. ffmpeg captures mic in 30s chunks → wav
  2. faster-whisper transcribes locally (free)
  3. Rolling 3-5 min transcript window in memory
  4. On each transcribed chunk, Haiku classifier: "worth interrupting?"
  5. On YES → Opus synthesis with full identity context
  6. Write to presence_notifications → floating window picks up

Cost: ~$0.06/hr (Haiku) + ~$0.10-0.50/hr (Opus on trigger). <$1/hr worst case.

Usage:
  python3 realtime_listener.py                  # start listening
  python3 realtime_listener.py --test-mic       # test mic capture only
  python3 realtime_listener.py --test-classify   # test classifier with fake transcript
  python3 realtime_listener.py --sensitivity 0.5 # adjust trigger sensitivity (0-1)
"""

import subprocess
import threading
import queue
import time
import logging
import os
import sys
import json
import tempfile
import hashlib
import sqlite3
import urllib.parse
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv
import requests
import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav
load_dotenv()

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
CHUNK_SECONDS = 10          # audio chunk length
WINDOW_CHUNKS = 12          # rolling window = ~2 minutes
# Smart cooldown config
COOLDOWN_SAME_TOPIC = 120     # Same topic: 2 minutes
COOLDOWN_RELATED_TOPIC = 60   # Related but distinct: 1 minute
COOLDOWN_NEW_TOPIC = 10       # Genuinely new: just prevent double-fire
BURST_MAX_TRIGGERS = 5        # Max triggers in burst window
BURST_WINDOW_SECONDS = 600    # 10-minute burst window
WHISPER_MODEL = "base.en"   # small + fast. upgrade to "small.en" for accuracy
SENSITIVITY = 0.5           # 0 = interrupt rarely, 1 = interrupt often
REALTIME_FLAG_CACHE_SECONDS = 10
REALTIME_PAUSE_SLEEP_SECONDS = 5
FINGERPRINT_STOPWORDS = {
    'the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could',
    'should','may','might','shall','can','need','dare','ought',
    'used','to','of','in','for','on','with','at','by','from',
    'as','into','through','during','before','after','above',
    'below','between','out','off','over','under','again','further',
    'then','once','here','there','when','where','why','how','all',
    'each','every','both','few','more','most','other','some','such',
    'no','nor','not','only','own','same','so','than','too','very',
    'just','because','but','and','or','if','while','that','this',
    'it','i','you','he','she','we','they','me','him','her','us',
    'them','my','your','his','its','our','their','what','which',
    'who','whom','whose','about','also','like','think','know',
    'going','really','yeah','okay','right','well','thing','things',
    'said','say','says','saying','get','got','getting','one','way',
    'much','many','even','still','actually','probably','maybe',
    'something','someone','kind','sort','lot','bit','pretty',
    'quite','rather','enough','around','back','now','up','down',
}
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

# ---------------------------------------------------------------------------
# STATE
# ---------------------------------------------------------------------------
transcript_buffer = []       # rolling window of (timestamp, text) tuples
audio_queue = queue.Queue()  # raw wav bytes waiting for transcription
trigger_history = deque(maxlen=20)  # (timestamp, fingerprint, reason)
thought_buffer = ""
SILENCE_THRESHOLD_WORDS = 3
MAX_BUFFER_SECONDS = 60
buffer_start_time = 0
running = True               # graceful shutdown flag
_realtime_active_cache = False
_realtime_active_checked_at = 0.0
SPEAKER_SIMILARITY_THRESHOLD = 0.75
VOICE_USER_ID = "default"
VOICE_ENCODER = None
ENROLLED_VOICE_EMBEDDING = None
SPEAKER_FILTERING_ENABLED = False

BASE_DIR = Path(__file__).parent
STATE_DB = BASE_DIR / "state.db"

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("realtime_listener")
_HEARTBEAT_LAST_SENT: dict[str, float] = {}
HEARTBEAT_INTERVAL_SECONDS = 5 * 60


def beat_heartbeat(agent_name: str) -> None:
    """Best-effort heartbeat to Supabase RPC. Non-fatal and self-throttled."""
    now = time.time()
    last_sent = _HEARTBEAT_LAST_SENT.get(agent_name, 0.0)
    if (now - last_sent) < HEARTBEAT_INTERVAL_SECONDS:
        return

    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    supabase_anon_key = (os.getenv("SUPABASE_ANON_KEY", "") or os.getenv("SUPABASE_KEY", "")).strip()
    if not supabase_url or not supabase_anon_key:
        return

    url = f"{supabase_url}/rest/v1/rpc/beat"
    metadata = None
    headers = {
        "apikey": supabase_anon_key,
        "Authorization": f"Bearer {supabase_anon_key}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(
            url,
            json={"p_name": agent_name, "p_meta": metadata or {}},
            headers=headers,
            timeout=10,
        )
        _HEARTBEAT_LAST_SENT[agent_name] = now
    except Exception as exc:
        logger.warning(f"[Heartbeat] {agent_name} beat failed: {exc}")

def write_activity_signal(
    signal_type: str,
    signal_value: str,
    metadata: dict | None = None,
    user_id: str = "default",
) -> bool:
    """Best-effort write to activity_signal. Non-fatal."""
    try:
        payload = {
            "signal_type": signal_type,
            "signal_value": signal_value,
            "metadata": metadata or {},
            "user_id": user_id,
        }
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/activity_signal",
            json=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            timeout=10,
        )
        if resp.status_code not in (200, 201, 204):
            print(
                f"[RT:Signal] Write failed: {resp.status_code} {resp.text[:200]}",
                file=sys.stderr,
            )
            return False
        return True
    except Exception as exc:
        print(f"[RT:Signal] Error writing activity_signal: {exc}", file=sys.stderr)
        return False


def compute_topic_fingerprint(transcript_text):
    """Extract topic fingerprint from transcript content, not classifier reason."""
    words = transcript_text.lower().split()
    significant = [w.strip('.,!?"\\\'()[]{}:;') for w in words]
    significant = [w for w in significant if w and len(w) > 2 and w not in FINGERPRINT_STOPWORDS]
    return frozenset(significant)


def topic_similarity(fp_a, fp_b):
    """Jaccard similarity between two fingerprints. Returns 0.0-1.0."""
    if not fp_a or not fp_b:
        return 0.0
    intersection = len(fp_a & fp_b)
    union = len(fp_a | fp_b)
    return intersection / union if union > 0 else 0.0


def smart_cooldown_check(transcript_text, reason):
    """Decide whether to fire, and with what cooldown classification.
    
    Returns: (should_fire: bool, classification: str, detail: str)
    """
    now = time.time()
    fingerprint = compute_topic_fingerprint(transcript_text)
    
    recent_triggers = [t for t, fp, r in trigger_history if now - t < BURST_WINDOW_SECONDS]
    if len(recent_triggers) >= BURST_MAX_TRIGGERS:
        oldest_in_window = min(recent_triggers)
        wait = int(BURST_WINDOW_SECONDS - (now - oldest_in_window))
        return False, 'burst_limited', f'Hit {BURST_MAX_TRIGGERS} triggers in {BURST_WINDOW_SECONDS}s window. Next eligible in ~{wait}s'
    
    if not trigger_history:
        return True, 'new_topic', 'First trigger — no history'
    
    max_sim = 0.0
    max_sim_age = 0.0
    for ts, fp, r in trigger_history:
        sim = topic_similarity(fingerprint, fp)
        if sim > max_sim:
            max_sim = sim
            max_sim_age = now - ts
    
    if max_sim > 0.4:
        if max_sim_age < COOLDOWN_SAME_TOPIC:
            return False, 'same_topic', f'Similarity {max_sim:.2f} to trigger {max_sim_age:.0f}s ago (need {COOLDOWN_SAME_TOPIC}s)'
        else:
            return True, 'same_topic', f'Similarity {max_sim:.2f} but {max_sim_age:.0f}s elapsed (cooldown {COOLDOWN_SAME_TOPIC}s expired)'
    elif max_sim > 0.15:
        if max_sim_age < COOLDOWN_RELATED_TOPIC:
            return False, 'related_topic', f'Similarity {max_sim:.2f} to trigger {max_sim_age:.0f}s ago (need {COOLDOWN_RELATED_TOPIC}s)'
        else:
            return True, 'related_topic', f'Similarity {max_sim:.2f}, {max_sim_age:.0f}s elapsed (cooldown {COOLDOWN_RELATED_TOPIC}s expired)'
    else:
        if max_sim_age < COOLDOWN_NEW_TOPIC:
            return False, 'new_topic', f'New topic but only {max_sim_age:.0f}s since last trigger (need {COOLDOWN_NEW_TOPIC}s gap)'
        else:
            return True, 'new_topic', f'Novel topic (max similarity {max_sim:.2f})'


def record_trigger(transcript_text, reason):
    """Call after successful synthesis to update trigger history."""
    fingerprint = compute_topic_fingerprint(transcript_text)
    trigger_history.append((time.time(), fingerprint, str(reason or "")))

# ---------------------------------------------------------------------------
# IDENTITY CONTEXT (reuses presence.py patterns)
# ---------------------------------------------------------------------------
def _supabase_get(path: str) -> list:
    """Fetch from Supabase REST API."""
    import requests
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    r = requests.get(url, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json()


def _cosine_similarity(vec_a: np.ndarray, vec_b: np.ndarray) -> float:
    denom = float(np.linalg.norm(vec_a) * np.linalg.norm(vec_b))
    if denom <= 0:
        return 0.0
    return float(np.dot(vec_a, vec_b) / denom)


def load_enrolled_voice_embedding(user_id: str = VOICE_USER_ID):
    """Load enrolled voice embedding from Supabase voice_embeddings table."""
    try:
        rows = _supabase_get(
            f"voice_embeddings?select=embedding,sample_count&user_id=eq.{user_id}&order=updated_at.desc&limit=1"
        )
        if not rows:
            return None, 0
        row = rows[0] or {}
        emb = row.get("embedding") or []
        if not isinstance(emb, list) or len(emb) == 0:
            return None, 0
        vec = np.array(emb, dtype=np.float32)
        count = int(row.get("sample_count") or 1)
        return vec, count
    except Exception as e:
        print(f"[RT:Speaker] Warning: failed to load enrolled voice embedding: {e}", file=sys.stderr)
        return None, 0


def classify_chunk_speaker(audio_path: str):
    """Compute chunk speaker similarity against enrolled voice."""
    global VOICE_ENCODER, ENROLLED_VOICE_EMBEDDING
    if not SPEAKER_FILTERING_ENABLED or VOICE_ENCODER is None or ENROLLED_VOICE_EMBEDDING is None:
        return "unknown", None

    try:
        wav = preprocess_wav(audio_path)
        chunk_embedding = VOICE_ENCODER.embed_utterance(wav)
        similarity = _cosine_similarity(
            np.asarray(chunk_embedding, dtype=np.float32),
            np.asarray(ENROLLED_VOICE_EMBEDDING, dtype=np.float32),
        )
        speaker = "user" if similarity >= SPEAKER_SIMILARITY_THRESHOLD else "other"
        logger.debug(f"[RT:Speaker] similarity={similarity:.3f} speaker={speaker}")
        return speaker, similarity
    except Exception as e:
        print(f"[RT:Speaker] Warning: speaker tagging failed for chunk: {e}", file=sys.stderr)
        return "unknown", None


def _as_bool(value) -> bool:
    raw = str(value or "").strip().lower()
    return raw in {"true", "1", "yes", "on"}


def get_realtime_active(force: bool = False) -> bool:
    """Read realtime_active toggle from Supabase hearth_settings with 10s cache."""
    global _realtime_active_cache, _realtime_active_checked_at
    now = time.time()
    if not force and (now - _realtime_active_checked_at) < REALTIME_FLAG_CACHE_SECONDS:
        return _realtime_active_cache

    try:
        rows = _supabase_get("hearth_settings?select=value&key=eq.realtime_active&limit=1")
        value = rows[0].get("value") if rows else "false"
        _realtime_active_cache = _as_bool(value)
    except Exception as e:
        print(f"[RT] Warning: couldn't read realtime_active flag: {e}", file=sys.stderr)
    finally:
        _realtime_active_checked_at = now

    return _realtime_active_cache

def load_identity_context() -> str:
    """Assemble compressed identity context from Supabase: memories + trajectory."""
    lines = []
    
    # Memories (top 20 by vitality)
    try:
        memories = _supabase_get(
            "memories?select=content,domain,memory_class&order=vitality_score.desc&limit=20"
        )
        if memories:
            lines.append("[IDENTITY — MEMORIES]")
            for m in memories:
                domain = m.get("domain") or "Unknown"
                memory_class = m.get("memory_class") or "unknown"
                content = (m.get("content") or "").strip()
                if content:
                    lines.append(f"- [{domain}/{memory_class}] {content}")
            lines.append("")
    except Exception as e:
        print(f"[RT] Warning: couldn't load memories: {e}", file=sys.stderr)
    
    # Trajectory (most recent)
    try:
        try:
            traj = _supabase_get(
                "trajectories?select=arcs,tensions,drift&order=created_at.desc&limit=1"
            )
        except Exception:
            traj = _supabase_get(
                "trajectories?select=arcs,tensions,drift&limit=1"
            )
        if traj:
            row = traj[0] or {}
            arcs = row.get("arcs") or []
            tensions = row.get("tensions") or []
            drift = row.get("drift") or ""
            lines.append("[IDENTITY — TRAJECTORY]")
            lines.append(f"ARCS: {arcs}")
            lines.append(f"TENSIONS: {tensions}")
            lines.append(f"DRIFT: {drift if drift else '(none)'}")
            lines.append("")
    except Exception as e:
        print(f"[RT] Warning: couldn't load trajectory: {e}", file=sys.stderr)
    
    # Recent activity signals (last hour)
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        encoded_cutoff = urllib.parse.quote(cutoff, safe="")
        signals = _supabase_get(
            "activity_signal?select=signal_type,signal_value,metadata,created_at"
            f"&created_at=gte.{encoded_cutoff}&order=created_at.desc&limit=50"
        )
        if signals:
            activity_lines = []
            for s in signals:
                signal_type = (s.get("signal_type") or "unknown").strip()
                signal_value = (s.get("signal_value") or "").strip()
                created_at = (s.get("created_at") or "").strip()
                metadata = s.get("metadata") or {}
                parts = [f"type={signal_type}"]
                if signal_value:
                    parts.append(f"value={signal_value[:160]}")
                if created_at:
                    parts.append(f"at={created_at}")
                if isinstance(metadata, dict) and metadata:
                    compact_meta = json.dumps(metadata, ensure_ascii=True, separators=(",", ":"))
                    parts.append(f"meta={compact_meta[:220]}")
                activity_lines.append(f"- {' | '.join(parts)}")
            if activity_lines:
                lines.append("[RECENT ACTIVITY]")
                lines.extend(activity_lines[:20])
                lines.append("")
    except Exception as e:
        print(f"[RT] Warning: couldn't load activity: {e}", file=sys.stderr)
    
    return "\n".join(lines) if lines else "(no identity context available)"


# ---------------------------------------------------------------------------
# AUDIO CAPTURE
# ---------------------------------------------------------------------------
def capture_audio():
    """Continuous mic capture in CHUNK_SECONDS chunks via ffmpeg."""
    global running
    print(f"[RT:Capture] Started — {CHUNK_SECONDS}s chunks from Mac mic")
    
    while running:
        try:
            if not get_realtime_active():
                print("[RT:Capture] Paused — toggle off")
                time.sleep(REALTIME_PAUSE_SLEEP_SECONDS)
                continue

            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            
            proc = subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "avfoundation", "-i", ":0",
                    "-t", str(CHUNK_SECONDS),
                    "-ac", "1", "-ar", "16000",
                    "-loglevel", "error",
                    tmp.name
                ],
                capture_output=True,
                timeout=CHUNK_SECONDS + 10
            )
            
            if os.path.exists(tmp.name) and os.path.getsize(tmp.name) > 1000:
                audio_queue.put(tmp.name)
            else:
                try:
                    os.unlink(tmp.name)
                except:
                    pass
                    
        except subprocess.TimeoutExpired:
            print("[RT:Capture] ffmpeg timed out, retrying", file=sys.stderr)
        except Exception as e:
            print(f"[RT:Capture] Error: {e}", file=sys.stderr)
            time.sleep(2)


# ---------------------------------------------------------------------------
# TRANSCRIPTION
# ---------------------------------------------------------------------------
def transcribe_worker():
    """Pull audio files, transcribe with faster-whisper, then classify immediately."""
    global running, thought_buffer, buffer_start_time
    
    from faster_whisper import WhisperModel
    print(f"[RT:Transcribe] Loading Whisper model '{WHISPER_MODEL}'...")
    model = WhisperModel(WHISPER_MODEL, compute_type="int8")
    print("[RT:Transcribe] Model loaded. Waiting for audio chunks.")
    identity = load_identity_context()
    identity_refresh_time = time.time()
    heartbeat_last_sent = time.time()
    chunks_processed = 0
    user_chunks = 0
    other_chunks = 0
    buffer_speakers = []
    
    while running:
        try:
            audio_path = audio_queue.get(timeout=5)
        except queue.Empty:
            continue
        
        try:
            segments, info = model.transcribe(audio_path, language="en")
            text = " ".join(s.text for s in segments).strip()
            speaker, similarity = classify_chunk_speaker(audio_path)
            chunks_processed += 1
            if speaker == "user":
                user_chunks += 1
            elif speaker == "other":
                other_chunks += 1
            
            # Clean up temp file
            try:
                os.unlink(audio_path)
            except:
                pass
            
            now = datetime.now().strftime("%H:%M:%S")
            transcript_buffer.append((now, text, speaker, similarity))
            
            # Trim to window size
            while len(transcript_buffer) > WINDOW_CHUNKS:
                transcript_buffer.pop(0)
            
            if text:
                sim_label = f"{similarity:.3f}" if similarity is not None else "n/a"
                print(f"[RT:Transcribe] [{now}] ({len(text)} chars, speaker={speaker}, sim={sim_label}) {text[:80]}...")
            else:
                print("[RT:Transcribe] Silent chunk")

            now_ts = time.time()
            if now_ts - heartbeat_last_sent >= HEARTBEAT_INTERVAL_SECONDS:
                wrote = write_activity_signal(
                    signal_type="system_heartbeat",
                    signal_value="realtime_listener",
                    metadata={
                        "chunks_processed": chunks_processed,
                        "user_chunks": user_chunks,
                        "other_chunks": other_chunks,
                        "source": "realtime_mic",
                    },
                    user_id="default",
                )
                if wrote:
                    chunks_processed = 0
                    user_chunks = 0
                    other_chunks = 0
                    heartbeat_last_sent = now_ts

            # Refresh identity context every 10 minutes.
            if time.time() - identity_refresh_time > 600:
                identity = load_identity_context()
                identity_refresh_time = time.time()
                print("[RT:Transcribe] Identity context refreshed")

            chunk_words = len(text.split()) if text else 0

            def flush_thought_buffer_if_needed(reason_label: str):
                nonlocal identity, buffer_speakers
                global thought_buffer, buffer_start_time
                if not thought_buffer.strip():
                    return
                logger.info(f"Thought boundary detected — flushing {len(thought_buffer.split())} words to classifier")
                classify_input = thought_buffer.strip()
                speaker_counts = {}
                for label in buffer_speakers:
                    speaker_counts[label] = speaker_counts.get(label, 0) + 1
                buffer_speaker = max(speaker_counts, key=speaker_counts.get) if speaker_counts else "unknown"
                thought_buffer = ""
                buffer_start_time = 0
                buffer_speakers = []

                triggered, reason = classify_interrupt(identity, classify_input)
                similarity_score = similarity if similarity is not None else float("nan")
                speaker_label = buffer_speaker
                print(f"[RT:Speaker] similarity={similarity_score:.3f}, speaker={speaker_label}")
                if speaker_label == "user":
                    signal_type = "topic_signal"
                    print(f"[RT:Signal] Writing to activity_signal: {signal_type}")
                    write_activity_signal(
                        signal_type=signal_type,
                        signal_value=classify_input,
                        metadata={
                            "speaker": "user",
                            "similarity_score": similarity,
                            "source": "realtime_mic",
                        },
                        user_id="default",
                    )
                if triggered:
                    should_fire, classification, detail = smart_cooldown_check(classify_input, reason)
                    if should_fire:
                        logger.info(f"[RT:Cooldown] FIRE ({classification}): {detail}")
                        # Keep Opus context wide (rolling transcript) even though classifier used thought buffer.
                        window_text = "\n".join(
                            f"[{ts}] [speaker={spk}] {chunk_text}"
                            for ts, chunk_text, spk, _sim in transcript_buffer
                        )
                        fire_realtime_synthesis(window_text, reason, speaker=speaker, speaker_similarity=similarity)
                    else:
                        logger.info(f"[RT:Cooldown] SUPPRESSED ({classification}): {detail}")
                else:
                    print("[RT:Classifier] No interrupt")

            if chunk_words > SILENCE_THRESHOLD_WORDS:
                if not thought_buffer:
                    buffer_start_time = time.time()
                    thought_buffer = text
                    buffer_speakers = [speaker]
                else:
                    thought_buffer = f"{thought_buffer}\n{text}"
                    buffer_speakers.append(speaker)
            elif thought_buffer.strip():
                flush_thought_buffer_if_needed("silence_boundary")
            else:
                # silence chunk while buffer empty: nothing to do
                pass

            if thought_buffer.strip() and buffer_start_time > 0:
                if time.time() - buffer_start_time > MAX_BUFFER_SECONDS:
                    flush_thought_buffer_if_needed("max_buffer_timeout")

            buffer_age_seconds = (time.time() - buffer_start_time) if buffer_start_time > 0 else 0.0
            logger.info(f"Thought buffer: {len(thought_buffer.split())} words, {buffer_age_seconds:.0f}s")
                
        except Exception as e:
            print(f"[RT:Transcribe] Error: {e}", file=sys.stderr)
            try:
                os.unlink(audio_path)
            except:
                pass


# ---------------------------------------------------------------------------
# CLASSIFIER (Haiku — cheap, fast)
# ---------------------------------------------------------------------------
def build_classifier_prompt(identity: str, transcript: str) -> str:
    sensitivity_desc = {
        0.0: "Only interrupt for genuinely critical, time-sensitive insights.",
        0.3: "Interrupt for important connections or corrections. Err on the side of silence.",
        0.5: "Interrupt when you notice something the person likely hasn't connected yet.",
        0.7: "Interrupt for anything potentially useful. Better to speak than miss something.",
        1.0: "Surface any observation that could be relevant."
    }
    # Find closest sensitivity level
    closest = min(sensitivity_desc.keys(), key=lambda k: abs(k - SENSITIVITY))
    threshold = sensitivity_desc[closest]
    
    return f"""You are an interrupt classifier for a real-time presence system.

You are listening to a live conversation/lecture/meeting. Given the person's identity context and the last few minutes of transcript, decide if anything warrants alerting them.

Threshold: {threshold}

Rules:
- Reply ONLY "YES: [one-line reason]" or "NO"
- YES means: something in this transcript connects to something in their identity/trajectory/activity in a way they probably haven't noticed
- NO means: nothing crosses the interrupt threshold right now
- Err toward NO. False positives erode trust faster than false negatives.
- Don't trigger on generic observations. Trigger on specific connections.
- If the transcript is silence, small talk, or ambient noise: NO.

{identity}

[LIVE TRANSCRIPT — last {len(transcript_buffer)} chunks]
{transcript}"""


def classify_interrupt(identity: str, transcript: str) -> tuple[bool, str]:
    """Ask Haiku if the current transcript warrants an interrupt."""
    import anthropic
    client = anthropic.Anthropic()
    
    prompt = build_classifier_prompt(identity, transcript)
    
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=100,
        messages=[{"role": "user", "content": prompt}]
    )
    
    verdict = response.content[0].text.strip()
    triggered = verdict.upper().startswith("YES")
    reason = verdict.split(":", 1)[1].strip() if triggered and ":" in verdict else verdict
    
    return triggered, reason


# ---------------------------------------------------------------------------
# SYNTHESIS (Opus — expensive, only on trigger)
# ---------------------------------------------------------------------------
def fire_realtime_synthesis(
    transcript_text: str,
    trigger_reason: str,
    speaker: str = "unknown",
    speaker_similarity: float | None = None,
):
    """Full Opus synthesis + write to presence_notifications."""
    import anthropic
    
    system_prompt = """You are Hearth+ real-time copilot. You just detected something relevant in a live conversation.

Your job: give the user something they can SAY or DO right now.

Format:
- One line. Two sentences max.
- Start with a verb: Say, Ask, Mention, Push back, Redirect, Note, Look up
- Be specific to what was just said. Generic advice is useless.
- If someone made a claim that contradicts something you know about this person, give them the counter-argument.
- If an opportunity opened up in the conversation, tell them how to take it.
- If nothing actionable exists, output SILENCE.

Examples of good output:
- Ask them how Trace handles identity persistence across sessions — their retrieval approach cant do that and it exposes the architectural gap.
- Mention your 30x sycophancy reduction data — what they just described as theoretical you have empirical proof for.
- Push back on the retrieval framing — context engineering solves information access, not alignment. Those are different problems.

Examples of bad output:
- Long paragraphs analyzing the competitive landscape
- This connects to your thesis about personalization...
- You might want to consider...

This is a teleprompter, not a journal."""

    user_content = f"""[TRIGGER REASON]
{trigger_reason}

[LIVE TRANSCRIPT — last few minutes]
{transcript_text}

What's worth knowing right now?"""

    client = anthropic.Anthropic()
    
    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=100,
            system=[{
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": user_content}]
        )
        
        output = response.content[0].text.strip()
        record_trigger(transcript_text, trigger_reason)
        
        # Check for SILENCE
        if output.upper().startswith("SILENCE"):
            print(f"[RT:Synthesis] Model chose silence: {output[:100]}")
            return
        
        print(f"\n{'='*60}")
        print(f"[RT:PRESENCE] {output}")
        print(f"{'='*60}\n")
        
        # Write to presence_notifications
        write_notification(
            output,
            "realtime",
            trigger_reason,
            speaker=speaker,
            speaker_similarity=speaker_similarity,
        )
        
    except Exception as e:
        print(f"[RT:Synthesis] Error: {e}", file=sys.stderr)


def write_notification(
    message: str,
    trigger_type: str,
    trigger_reason: str = "",
    speaker: str = "unknown",
    speaker_similarity: float | None = None,
):
    """Write to Supabase presence_notifications table using the same payload shape as presence.py."""
    import requests
    
    try:
        # Match presence.py: message, trigger_type, score_token, oracle_confidence, oracle_signal_type
        token = hashlib.md5(f"{message[:50]}{time.time()}".encode()).hexdigest()[:8]
        payload = {
            "message": message,
            "trigger_type": trigger_type,
            "score_token": token,
            "oracle_confidence": None,
            "oracle_signal_type": speaker,
            "metadata": {
                "speaker": speaker,
                "speaker_similarity": speaker_similarity,
            },
        }
        
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/presence_notifications",
            json=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
            timeout=10
        )
        
        if r.status_code in (200, 201):
            print(f"[RT:Notify] Written to presence_notifications (token: {token})")
        else:
            print(f"[RT:Notify] Write failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
            
    except Exception as e:
        print(f"[RT:Notify] Error: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# TEST MODES
# ---------------------------------------------------------------------------
def test_mic():
    """Quick mic test — records 10 seconds and transcribes."""
    from faster_whisper import WhisperModel
    
    print("Recording 10 seconds from Mac mic...")
    tmp = "/tmp/hearth_rt_test.wav"
    subprocess.run([
        "ffmpeg", "-y", "-f", "avfoundation", "-i", ":0",
        "-t", "10", "-ac", "1", "-ar", "16000",
        "-loglevel", "error", tmp
    ])
    
    print("Transcribing...")
    model = WhisperModel(WHISPER_MODEL, compute_type="int8")
    segments, _ = model.transcribe(tmp, language="en")
    text = " ".join(s.text for s in segments).strip()
    print(f"Transcript: {text}")
    os.unlink(tmp)


def test_classify():
    """Test classifier with fake transcript."""
    identity = load_identity_context()
    print(f"Identity context loaded ({len(identity)} chars)")
    
    fake_transcript = (
        "[09:15:00] So the key issue with context engineering is that "
        "most systems treat it as a retrieval problem when it's really "
        "an alignment problem. The model needs to know not just what "
        "information to surface but how this specific user thinks about it."
    )
    
    print(f"\nFake transcript: {fake_transcript}")
    print(f"\nClassifying...")
    
    triggered, reason = classify_interrupt(identity, fake_transcript)
    print(f"\nTriggered: {triggered}")
    print(f"Reason: {reason}")


# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------
def main():
    global SENSITIVITY, running, VOICE_ENCODER, ENROLLED_VOICE_EMBEDDING, SPEAKER_FILTERING_ENABLED
    
    if "--test-mic" in sys.argv:
        test_mic()
        return
    
    if "--test-classify" in sys.argv:
        test_classify()
        return
    
    # Parse sensitivity
    for i, arg in enumerate(sys.argv):
        if arg == "--sensitivity" and i + 1 < len(sys.argv):
            SENSITIVITY = float(sys.argv[i + 1])
    
    # Validate deps
    if not ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY not set in .env", file=sys.stderr)
        sys.exit(1)
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL/SUPABASE_SERVICE_KEY not set in .env", file=sys.stderr)
        sys.exit(1)

    print("[RT:Speaker] Loading resemblyzer encoder...")
    VOICE_ENCODER = VoiceEncoder()
    ENROLLED_VOICE_EMBEDDING, sample_count = load_enrolled_voice_embedding(VOICE_USER_ID)
    if ENROLLED_VOICE_EMBEDDING is None:
        SPEAKER_FILTERING_ENABLED = False
        print("No voice enrollment found. Run enroll_voice.py. Processing all audio.")
    else:
        SPEAKER_FILTERING_ENABLED = True
        print(
            f"[RT:Speaker] Voice enrollment loaded (sample_count={sample_count}). "
            f"Speaker filtering enabled (threshold={SPEAKER_SIMILARITY_THRESHOLD:.2f})."
        )
    
    print(f"""
╔══════════════════════════════════════════════╗
║  Hearth+ Real-Time Listener                  ║
║  Chunk: {CHUNK_SECONDS}s | Window: {WINDOW_CHUNKS} chunks ({CHUNK_SECONDS * WINDOW_CHUNKS // 60}min)     ║
║  Classify: immediate on each transcript | Sensitivity: {SENSITIVITY}    ║
║  Cooldown: same={COOLDOWN_SAME_TOPIC}s related={COOLDOWN_RELATED_TOPIC}s new={COOLDOWN_NEW_TOPIC}s ║
║  Ctrl+C to stop                              ║
╚══════════════════════════════════════════════╝
""")
    
    # Start threads
    capture_thread = threading.Thread(target=capture_audio, daemon=True, name="capture")
    transcribe_thread = threading.Thread(target=transcribe_worker, daemon=True, name="transcribe")
    
    capture_thread.start()
    transcribe_thread.start()
    
    try:
        while True:
            beat_heartbeat("realtime_listener")
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[RT] Shutting down...")
        running = False
        time.sleep(2)
        print("[RT] Stopped.")


if __name__ == "__main__":
    main()
