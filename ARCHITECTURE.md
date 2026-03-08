# Architecture

Presence is not a wrapper around an LLM. It is a layered system where each component earns its existence by solving a specific problem the layer below it creates.

This document explains what each layer does, why it exists, and what the key design decisions were.

---

## The core problem

Any proactive AI system faces an immediate contradiction: to be useful, it has to interrupt. But interruption has a cost. Interrupt too much and users turn it off. Interrupt too rarely and it's invisible.

The solution is not a better heuristic for what's interesting. It's a model of the person specific enough to distinguish signal from noise *for them*.

That's what the memory architecture is for.

---

## Layer 1: Signal collection

The Chrome extension writes `activity_signal` rows continuously:

| Signal type | Source | What it captures |
|------------|--------|-----------------|
| `tab_focus` | Extension | Domain, URL, page title, dwell time |
| `scroll_depth` | Extension | Scroll %, time on page |
| `search_query` | Extension | Search terms |
| `topic_signal` | Extension + mic daemon | AI-extracted topic from page content or speech |
| `file_change` | File watcher daemon | Extracted text diff from modified files |
| `scout_intel` | Agent scout | Competitive intelligence findings |
| `system_heartbeat` | Mic daemon | Daemon liveness, chunk counts |

Signals are not triggers. Nothing fires per-signal. They accumulate as raw material for the sweep.

---

## Layer 2: The gatekeeper sweep

`pg_cron` calls `presence-gatekeeper` every 60 seconds. The function self-throttles to a 90-second minimum gap between firings.

### Stage 1 — Mode classification

The classifier reads `activity_signal` rows from the last 5 minutes and classifies into one of three modes:

**`focused`** — engaged with a small number of domains, meaningful dwell time (60s+ per tab), coherent activity. High interrupt bar.

**`fidgeting`** — bouncing between tabs, short dwell times, high domain variety, AI ↔ non-AI alternation pattern. Medium interrupt bar.

**`away`** — insufficient signals. Suppressed.

The classifier is deterministic — no LLM, no API call. It uses tab dwell distributions, bounce counts, and domain switching ratios. One edge case: passive consumption detection. Long sessions on YouTube or Netflix with shallow scroll depth classify as `fidgeting` even if dwell time is high, because passive ≠ focused.

### Stage 2 — Transition detection

Mode transitions are evaluated for meaning:

| Transition | Triggers Stage 3? |
|-----------|-----------------|
| `focused → fidgeting` | Yes |
| `focused → away` | Yes |
| `away → focused` | Yes |
| `fidgeting → focused` | No |
| Same mode (no change) | No |

Sustained fidgeting (>15 signals, 10+ minutes since last fire) also triggers Stage 3 directly without requiring a transition.

Most sweeps die here. The state machine suppresses without touching an LLM.

### Stage 3 — Judgment gate

This is where taste lives.

Sonnet receives the full activity window since the last fire and the mode transition. It answers one question: is this moment genuinely worth interrupting?

The prompt gives it calibration by mode:

- **Focused**: only fire for a strong novel connection, a direct contradiction, or time-sensitive scout intel
- **Fidgeting**: medium bar — surface anything genuinely interesting
- **Away/returning**: low bar — natural re-entry window

Sonnet returns `{"fire": true/false, "reason": "..."}`. If it declines, the sweep logs the reason and exits. No synthesis call.

This gate is where ~70% of would-be interruptions die. That's intentional.

### Stage 4 — Synthesis

Opus receives the full identity context:

- **15 memories by vitality** + **5 from sparse cognitive/domain cells** (diversity fill)
- Current **trajectory** (arcs, tensions, drift)
- Last **24 hours of activity**
- Latest **scout intel**
- **Platform knowledge** (facts from Claude/ChatGPT memory panels)
- **Recently surfaced** breadcrumbs (to avoid repetition)
- The **prime directive** if set

It returns a JSON object with two fields:

```json
{
  "notification": "One sentence or one question. Name the connection, the tension, or the gap.",
  "memory": "A single declarative sentence worth keeping — or null."
}
```

If `notification` is `"SILENCE"`, nothing fires. The synthesis model can still choose restraint.

If a memory is returned, it goes through `admit-memory` for competition.

---

## Layer 3: The 77-slot memory shelf

The shelf is the identity model. Not preferences. Not facts. Survived observations.

Every new memory goes through `admit-memory`, which is the single gateway — nothing writes to `memories` directly.

### Three paths

**Merge** (similarity > 0.85): The incoming memory is semantically close to an existing one. An LLM absorbs whatever is genuinely new from the candidate into the existing memory. The existing memory's heat increases. No new row.

**Insert** (shelf under 77): The incoming memory gets a slot. Heat defaults to 0.5, vitality = `heat × 0.6 + 0.4 × 0.5`.

**Compete** (shelf full): The incoming memory's provisional vitality is compared against the weakest incumbent. Winner takes the slot. Loser goes to `memory_compost`.

### Vitality

```
vitality_score = heat × 0.6 + 0.4 × base
```

Heat accumulates through synthesis (Opus cites this memory → heat boost) and validation (user grades breadcrumb E → `validate_memory` RPC → vitality +0.1, capped at 1.0).

Vitality decays passively over time. Memories that stop being relevant stop being cited, stop being validated, and eventually lose in competition.

### Cognitive type

Every memory is classified into one of five types:

| Type | Meaning |
|------|---------|
| `observation` | A noticed fact or pattern |
| `connection` | A link between previously separate things |
| `tension` | Two forces pulling in different directions |
| `question` | An open inquiry the person is carrying |
| `principle` | A durable rule of thumb from experience |

Classification happens at admit time via a Sonnet call. Used for diversity sampling.

### Compost and resurrection

Evicted memories go to `memory_compost` with their vitality at death and the content that killed them.

When a prime directive is set, the gatekeeper scans compost and re-submits relevant dead memories through `admit-memory` with a small heat boost (+0.2). They compete fairly — resurrection doesn't bypass the gate.

Each entry gets one second chance per directive, then `absorbed: true`.

---

## Layer 4: Trajectory

The trajectory layer compresses the full memory shelf into three signals:

- **Arcs** — what themes keep building (`"Accelerating toward X, Converging on Y"`)
- **Tensions** — unresolved structural conflicts (`"Empirical building ↔ theoretical publishing"`)
- **Drift** — where attention is fading

Trajectory regenerates on every memory admit — insert, merge, or evict. It's never stale by more than one memory change.

This means synthesis is not based on "what happened recently." It's based on where the person appears to be going. The distinction matters: activity is ephemeral, trajectory is structural.

---

## Diversity-aware sampling

Pure vitality ranking creates a self-reinforcing loop: memories that align with the current trajectory get cited → validated → survive → reinforce that same trajectory. The shelf becomes a mirror. Breadcrumbs stop surprising.

The fix is in the sampling layer, not the eviction layer. The shelf stays pure meritocracy. Diversity only enters what Opus sees.

The `get_diverse_memory_sample` RPC returns 20 memories:
- 15 by vitality (`top_vitality`)
- 5 from the sparsest `cognitive_type × life_domain` cells not already in the top 15 (`diversity_fill`)

Coverage is tracked in `memory_cognitive_coverage`, which auto-refreshes via Postgres trigger on every memory change. Never stale.

The result: Opus always has material from domains the current trajectory *doesn't* favor. Cross-domain connections require shelf diversity to be possible.

---

## Prime directive

A user-set lens that reshapes all Presence attention without limiting what it notices.

Set via the extension popup. Injected at highest priority in the synthesis context. Not "what I'm working on" — how you want to be seen right now.

Examples:
- `"Shipping X tonight"` — tactical filter
- `"I'm avoiding something"` — reflective mode
- `"Contradiction mode"` — surface tensions, not solutions
- `"I'm scared about launch"` — emotional register

Clearing the directive triggers compost resurrection — dead memories get a fresh competition under the previous lens context.

---

## Scout

`agent-scout` is a competitive intelligence scanner that runs on demand.

**Opus generates the research question** from 48h of attention digests and activity — not a generic scan but a specific question derived from what you've actually been doing.

**Keywords** are also generated by Opus, then used to filter HN top/new, GitHub recent repos, and Reddit hot posts.

**Haiku analyzes** the filtered results and flags relevant items by category: `competitor_move`, `new_entrant`, `research`, `thesis_validation`, `threat`, `opportunity`, `question_answer`.

Results write to `agent_runs` and `activity_signal` as `scout_intel`. The gatekeeper sees scout findings as signal — Opus connects to them when they're relevant, not just because they arrived.

Scout is not on the critical path. It enriches synthesis without blocking it.

---

## Attention digest

After each judgment gate fires, the gatekeeper writes a compressed `attention_digest` — a structured summary of the activity window:

```
[2026-03-08T14:22Z - 2026-03-08T14:47Z] | 43 signals
Focus: claude.ai (18m, "Presence architecture"), github.com (7m), linear.app (4m)
Mode: focused -> fidgeting -> focused
Topics: memory competition | trajectory synthesis
Searches: diversity sampling llm | compost resurrection
```

Digests serve two purposes: Scout uses the last 48h of digests as its research context, and they provide a compressed behavioral history that Opus can reference without needing raw signal rows.

---

## Platform memory

The extension scrapes memory panels from Claude.ai and ChatGPT using DOM selectors. Facts are stored in `platform_memories` as `(platform, content, first_seen_at, last_seen_at)`.

These inject into synthesis as `[PLATFORM KNOWLEDGE]` — facts other AI systems have learned about this person. The synthesis model can use these to contextualize without them competing for shelf space.

Currently: 180 Claude memories + 1 ChatGPT memory.

---

## What is actually novel

Not the extension. Not the cron job. Not the edge functions.

The novelty is the combination of:

1. **Fixed-capacity competitive memory** — identity as what survives, not what accumulates
2. **Trajectory from competition** — shape emerges from the shelf, not from explicit modeling
3. **Judgment before surfacing** — the gate exists to say no, and usually does
4. **Diversity in the sampling layer** — cross-domain connection requires cross-domain material

The thesis: **alignment emerges from memory architecture, not model weights**. A model that knows which specific human it's serving — through competed memories and derived trajectory — outperforms one aligned through retrieval or fine-tuning on that person's data.

---

## Future directions

The most interesting unresolved question: right now Opus decides what is worth interrupting for. If that judgment layer becomes increasingly formalized — scored, learned, partly deterministic — Presence stops being a workflow and starts becoming a new operating system primitive for personal intelligence.

That's where this wants to go.
