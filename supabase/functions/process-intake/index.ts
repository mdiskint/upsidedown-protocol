import Anthropic from "npm:@anthropic-ai/sdk";

type Json = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const MODEL_SONNET = "claude-sonnet-4-5-20250929";
const CONVERSATIONS_PER_BATCH = 20;
const MAX_CANDIDATES = 150;

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function response(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

function jsonHeaders(): HeadersInit {
  return {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    const obj = value as Json;
    if (typeof obj.text === "string") return obj.text.trim();
    if ("parts" in obj) return normalizeText(obj.parts);
    if ("content" in obj) return normalizeText(obj.content);
  }
  return "";
}

function extractChatGptConversation(conversation: unknown): string {
  const conv = (conversation && typeof conversation === "object") ? (conversation as Json) : {};
  const mapping = conv.mapping && typeof conv.mapping === "object" ? (conv.mapping as Json) : {};
  const messages: string[] = [];
  for (const node of Object.values(mapping)) {
    if (!node || typeof node !== "object") continue;
    const message = (node as Json).message;
    if (!message || typeof message !== "object") continue;
    const author = (message as Json).author;
    const role = (author && typeof author === "object") ? String((author as Json).role ?? "") : "";
    if (role !== "user") continue;
    const content = normalizeText((message as Json).content);
    if (content) messages.push(content);
  }
  return messages.join("\n").trim();
}

function extractClaudeConversation(conversation: unknown): string {
  const conv = (conversation && typeof conversation === "object") ? (conversation as Json) : {};
  const chatMessages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  const messages: string[] = [];
  for (const msg of chatMessages) {
    if (!msg || typeof msg !== "object") continue;
    const row = msg as Json;
    const role = String(row.role ?? "").toLowerCase();
    if (role !== "human") continue;
    const content = normalizeText(row.content);
    if (content) messages.push(content);
  }
  return messages.join("\n").trim();
}

function detectFormat(conversations: unknown[]): "chatgpt" | "claude" | null {
  for (const entry of conversations) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Json;
    if (row.mapping && typeof row.mapping === "object") return "chatgpt";
    if (Array.isArray(row.chat_messages)) return "claude";
  }
  return null;
}

function extractConversationTexts(raw: unknown): { format: "chatgpt" | "claude"; conversations: string[] } | null {
  if (!Array.isArray(raw)) return null;
  const format = detectFormat(raw);
  if (!format) return null;

  const conversations: string[] = [];
  for (const conv of raw) {
    const text = format === "chatgpt"
      ? extractChatGptConversation(conv)
      : extractClaudeConversation(conv);
    if (text) conversations.push(text);
  }
  return { format, conversations };
}

function parseJsonArray(text: string): string[] {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

async function extractMemoryCandidates(conversations: string[]): Promise<string[]> {
  if (conversations.length === 0) return [];
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const chunks = chunkArray(conversations, CONVERSATIONS_PER_BATCH);
  const candidates: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk
      .map((conv, idx) => `Conversation ${i * CONVERSATIONS_PER_BATCH + idx + 1}:\n${conv.slice(0, 12000)}`)
      .join("\n\n---\n\n");

    const prompt = [
      "You are reading someone's AI conversation history. Extract up to 5 durable, specific memories about this person — beliefs, patterns, working styles, recurring tensions, skills, values, ways of thinking.",
      "Each memory should be a single sentence. Be concrete, not generic. Do not write 'the user prefers X' — write 'Prefers X because of Y.' Return as a JSON array of strings.",
      "",
      chunkText,
    ].join("\n");

    const response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) continue;
    const parsed = parseJsonArray(text);
    for (const candidate of parsed) {
      if (candidates.length >= MAX_CANDIDATES) break;
      candidates.push(candidate);
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates.slice(0, MAX_CANDIDATES);
}

async function admitMemoryCandidate(content: string): Promise<Json | null> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/admit-memory`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      content,
      user_id: "default",
      memory_type: "user",
      source: "onboarding_intake",
    }),
  });

  const payload = await resp.json().catch(() => ({} as Json));
  if (!resp.ok) {
    console.warn("process-intake: admit-memory failed", resp.status, payload);
    return null;
  }
  return payload as Json;
}

async function markOnboardingComplete(): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/hearth_settings?on_conflict=key`, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([
      {
        key: "onboarding_complete",
        value: "true",
      },
    ]),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`failed to write onboarding_complete (${resp.status}): ${text}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return response({}, 200);
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return response({ error: "Missing required env vars." }, 500);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Json;
    const rawJson = String(body.raw_json ?? "");
    if (!rawJson.trim()) {
      return response({ error: "Missing raw_json payload." }, 400);
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(rawJson);
    } catch {
      return response({ error: "Invalid JSON file. Could not parse conversations.json." }, 400);
    }

    const extracted = extractConversationTexts(parsedRaw);
    if (!extracted) {
      return response({ error: "Unrecognized format. Try exporting again from ChatGPT or Claude." }, 400);
    }

    const candidates = await extractMemoryCandidates(extracted.conversations);
    let memoriesWritten = 0;

    for (const candidate of candidates) {
      const admitted = await admitMemoryCandidate(candidate);
      if (!admitted) continue;
      const action = String(admitted.action ?? "").toLowerCase();
      if (action !== "discarded") memoriesWritten += 1;
    }

    await markOnboardingComplete();

    return response({
      format: extracted.format,
      conversations_processed: extracted.conversations.length,
      candidates_considered: candidates.length,
      memories_written: memoriesWritten,
      batches_processed: Math.ceil(extracted.conversations.length / CONVERSATIONS_PER_BATCH),
    });
  } catch (err) {
    return response({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
