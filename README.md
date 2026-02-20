# Upside Down

**A presence layer for AI on the web.**

Every AI agent today runs in a separate browser. Like a stranger walking into your life. Upside Down runs inside your browser. No passwords. No auth credentials. Just you and your personal AI, doing the work that needs doing.

---

## The Core Insight

When an AI agent needs to access Gmail, it has two options:

1. **Ask for credentials** — hand over a password, set up OAuth, configure API access. The agent is a visitor being granted entry.
2. **Be present** — run inside the user's actual Chrome session, where Gmail is already open and authenticated. The agent inherits identity rather than being handed it.

Every major agentic browser today — OpenAI Operator, Perplexity Comet, Microsoft Copilot Mode, Browser Use, Browserbase — takes option 1. They spin up a fresh headless browser with no session history. It has no cookies, no saved passwords, no authenticated state. It's a stranger.

Upside Down takes option 2.

---

## What It Does

Upside Down is a Chrome extension that injects a floating panel into every tab. The user types a task in plain English, the system acts across any tab that's open, including background tabs the user isn't looking at, or it can open new tabs on its own.

**Confirmed working (February 2026):**

- Searched Google and Ticketmaster for LA Kings tickets, compared prices, reported back — user never left their current tab
- Read Gmail from a background tab without password auth, API access, or the user switching tabs
- Bought socks on Amazon with a plain English command — full purchase flow, proposal gate before checkout, user approved, order placed

No partnerships. No API agreements. No credentials handed over. No new browser. The user's existing session IS the permission layer.

---

## Architecture

Three files. Three layers.

```
upside-down/
├── manifest.json          — MV3, all permissions
├── background.js          — Brain: Claude API, agentic loop, session state
├── content/content.js     — Hands: fill, click, scroll, navigate, read
└── panel/panel.html+js    — Shell: floating iframe on every page
```

**The Shell** — A floating iframe injected into every tab automatically. Drag/resize. Orange = working, green = awaiting approval. Sends tasks up, displays results down. Knows nothing about AI.

**The Brain** — The only file that talks to Claude. Manages `runAgenticLoop()` — up to 20 steps, loops until complete. Reads tab DOM via `getTabContextById(tabId)` and injects content into Claude's conversation history. Routes actions to the correct tab by URL substring match. Manages proposal/approve/decline flow.

**The Hands** — Executes fill, click, key, scroll, read. React-safe. Double-injection guard. `navigate` is disabled — Claude uses `openTab` for new domains and fill/click for within-site navigation.

### The Key Technical Decision

Most browser automation uses Chrome DevTools Protocol (CDP) via Puppeteer or Playwright. CDP is detectable — it sets WebDriver flags, opens WebSocket connections, and leaves fingerprints. Sites actively block it.

Upside Down uses Chrome Extension APIs instead. No CDP. No WebSocket. No detectable flags. The automation is indistinguishable from normal browsing because it *is* normal browsing — the same APIs a password manager uses.

### Session Inheritance

When Upside Down opens a background tab to Gmail, Chrome sends the user's real session cookies — the same ones sent when the user opens it manually. The server sees an authenticated request from the user's IP, browser fingerprint, and session. There's no handoff. The AI just *is* the user, in terms of what the web can observe.

This is the architectural gap every other agent has failed to close.

---

## The Agentic Loop

```
User types task → panel sends to background.js
background.js → Claude API (task + DOM context from target tab)
Claude → action (fill / click / key / openTab / readDOM)
background.js → content.js on target tab (execute action)
content.js → background.js (success + updated DOM)
[3 second settle delay]
background.js → Claude API (updated context, continue?)
... loops until complete: true, proposal triggered, or step cap
```

The user never intervenes between steps. The loop runs until the mission is done or a write action (purchase, send message) requires explicit approval.

---

## The Proposal Gate

Write actions require user approval. Read actions and navigation run autonomously.

- **Orange panel** = working in background
- **Green panel** = proposal ready for review
- **Approve** → executes
- **Decline + note** → note becomes new instruction, task re-queues

This isn't just a safety feature. It's the product. Every other agentic system treats human approval as friction to be eliminated. Upside Down treats it as the trust architecture.

---

## Why This Doesn't Exist Yet

The web was built assuming a human navigates manually. Every layer — auth, ads, UX, revenue models — assumes human eyeballs moving between pages.

AI agents broke that assumption faster than anyone built an answer. The labs are focused on capability. The infrastructure companies are focused on scale. The identity layer — the part that lets an AI travel with a person across their authenticated life — doesn't exist.

**AP2** (Google's Agent Payments Protocol, launched September 2025 with 60+ partners) solved commerce: AI buys things for you safely. It doesn't solve presence: AI travels with you as your identity across the entire web.

**Browser Use, Browserbase, Hyperbrowser, Skyvern** solve automation at scale: run thousands of browser instances in the cloud. They don't solve the personal session problem — they're strangers at scale.

**Upside Down sits in the gap:** everything before and after the transaction. The identity. The context. The relationship between a person and their AI moving through the web together.

---

## The Competitive Landscape (February 2026)

| System | Architecture | Session | Background Tabs | Real Accounts |
|--------|-------------|---------|-----------------|---------------|
| OpenAI Operator | Sandboxed browser | Fresh | No | No |
| Perplexity Comet | Separate browser | Fresh | No | No |
| Browser Use | CDP/Playwright | Copied cookies | No | Fragile |
| Browserbase | Cloud headless | Fresh | No | No |
| rtrvr.ai | Chrome Extension | Real ✓ | No | Yes ✓ |
| **Upside Down** | **Chrome Extension** | **Real ✓** | **Yes ✓** | **Yes ✓** |

The only column that matters for personal use is the last one. The only system that checks all three boxes is this one.

---

## The Presence Layer

This is the framing that distinguishes Upside Down from automation tools:

**Automation tools** ask: *what task can I complete for you?*

**A presence layer** asks: *where are you, and how can I help you from here?*

The difference is identity and continuity. An automation tool is stateless — it's hired for a job. A presence layer travels with you. It knows what you have open. It knows your context. It acts when you ask, from inside your authenticated life, without you having to explain who you are or hand over the keys.

This is what agents need to actually be useful to real people: not more capability, but presence.

---

## ToS & Risk

Amazon and Google prohibit automated access. Enforcement targets scrapers and bots at scale.

A single user with a Chrome extension who explicitly approves every write action looks almost identical to a human using 1Password autofill to the server — same IP, same browser fingerprint, same session. The human-in-the-loop is both the ethical design and the legal defense.

Scale is the actual risk threshold, not personal use. At scale, the conversation with sites changes: "we're bringing you customers with intent and approval gates" — which is a better deal than what they have now, which is users asking AI to bypass their sites entirely.

---

## Status

**February 20, 2026** — Working prototype. Two confirmed demos on video.

- Research loop: confirmed working
- Purchase flow: confirmed working (Amazon, real session, real order)
- Gmail background read: confirmed working
- Agentic loop: up to 20 steps, autonomous
- Proposal gate: working

Known issues: timing on slow-loading pages, occasional tab tracking loss, no error recovery loop yet. These are polish problems, not architecture problems.

---

## What's Next

1. Clean demo video — Gmail background read is the hero
2. Error recovery — surface action failures back to Claude for retry
3. Protocol spec — one page: handshake structure, mission parameters, access expiration
4. The question worth sitting with: the right architecture for presence and the right architecture for scale are the same one. What does that mean?

---

*Built February 2026. The web currently asks users to go to tools. This flips it.*
