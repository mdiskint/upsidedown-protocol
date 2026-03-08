import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const SHELF_CAPACITY = 77;
const SIMILARITY_MERGE_THRESHOLD = 0.85;
const MODEL_SONNET = "claude-sonnet-4-5-20250929";
const DEFAULT_USER_ID = "95aa73e2-ac1a-4ac6-bfae-15a946b11131";

const VALID_COGNITIVE_TYPES = ["observation","connection","tension","question","principle"] as const;
type CognitiveType = typeof VALID_COGNITIVE_TYPES[number];

function computeVitality(heat: number): number {
  return heat * 0.6 + 0.4 * 0.5;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Embedding generation failed: ${err}`); }
  const data = await res.json();
  return data.data[0].embedding;
}

async function classifyCognitiveType(content: string): Promise<CognitiveType> {
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 10,
      messages: [{
        role: "user",
        content: [
          "Classify this memory into exactly one of these cognitive types:",
          "- observation: a noticed fact or pattern about the world",
          "- connection: a link between two previously separate things",
          "- tension: two active commitments or forces pulling in different directions",
          "- question: an open inquiry the person is carrying",
          "- principle: a durable rule of thumb extracted from experience",
          "",
          `Memory: ${content}`,
          "",
          "Reply with ONLY one word from the list above. No explanation.",
        ].join("\n"),
      }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "") as CognitiveType;
    return VALID_COGNITIVE_TYPES.includes(raw) ? raw : "observation";
  } catch (err) {
    console.warn("[admit-memory] classifyCognitiveType failed, defaulting to observation:", err);
    return "observation";
  }
}

async function absorbNovelty(existingContent: string, candidateContent: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", max_tokens: 300, temperature: 0.3,
      messages: [
        { role: "system", content: "You are a memory curator. You have an existing memory and a new candidate that is semantically similar.\n\nYour job: produce a single, updated memory that preserves everything from the existing memory AND absorbs whatever is genuinely new or more specific from the candidate.\n\nRules:\n- Output ONLY the updated memory text. No explanation, no preamble.\n- Keep it to 1-2 sentences. Dense, behavioral, specific.\n- If the candidate adds nothing new, return the existing memory unchanged.\n- Prefer the more specific or recent framing when both say the same thing.\n- Never lose information from the existing memory." },
        { role: "user", content: `EXISTING MEMORY:\n${existingContent}\n\nCANDIDATE MEMORY:\n${candidateContent}\n\nOutput the updated memory:` },
      ],
    }),
  });
  if (!res.ok) { console.error("Absorb novelty LLM call failed, keeping existing memory"); return existingContent; }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function regenerateTrajectory(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  currentShelfCount: number
): Promise<{ success: boolean; message: string }> {
  try {
    const { data: memories, error: memErr } = await supabase
      .from("memories")
      .select("content, vitality_score, heat")
      .eq("user_id", userId)
      .order("vitality_score", { ascending: false })
      .limit(20);

    if (memErr || !memories || memories.length === 0) {
      return { success: false, message: `No memories found for user_id=${userId}` };
    }

    const { data: prevTraj } = await supabase
      .from("trajectories")
      .select("memory_count")
      .eq("is_active", true)
      .limit(1)
      .single();

    const prevCount = prevTraj?.memory_count ?? 0;
    const memoriesSinceLast = Math.max(0, currentShelfCount - prevCount);

    const memoryList = memories
      .map((m, i) => `[${i + 1}] (vitality=${(m.vitality_score ?? 0).toFixed(2)}) ${m.content}`)
      .join("\n");

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const prompt = [
      "You are analyzing a person's memory shelf — the top 20 memories currently surviving in their presence system, ranked by vitality.",
      "",
      "Output ONLY valid JSON with exactly three fields:",
      "{",
      '  "arcs": "2-4 short phrases (comma-separated). Start each with a verb: Accelerating toward, Pivoting to, Converging on, Drifting from.",',
      '  "tensions": "2-3 active tensions in the form X vs Y (comma-separated).",',
      '  "drift": "1-2 short phrases describing what is losing signal or fading."',
      "}",
      "",
      "[MEMORY SHELF]",
      memoryList,
    ].join("\n");

    const resp = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: { arcs: string; tensions: string; drift: string };
    try { parsed = JSON.parse(rawText); }
    catch { return { success: false, message: `Sonnet returned invalid JSON: ${rawText.slice(0, 200)}` }; }

    const now = new Date().toISOString();
    const compressed = `ARCS: ${parsed.arcs}\nTENSIONS: ${parsed.tensions}\nDRIFT: ${parsed.drift}`;

    await supabase
      .from("trajectories")
      .update({ is_active: false, superseded_at: now })
      .eq("is_active", true)
      .eq("user_id", userId);

    const { error: insertErr } = await supabase.from("trajectories").insert({
      user_id: userId,
      arcs: parsed.arcs ?? "",
      tensions: parsed.tensions ?? "",
      drift: parsed.drift ?? "",
      compressed,
      memory_count: currentShelfCount,
      memories_since_last: memoriesSinceLast,
      generated_at: now,
      is_active: true,
    });

    if (insertErr) return { success: false, message: `Insert failed: ${JSON.stringify(insertErr)}` };

    console.log(`[trajectory] Regenerated. shelf=${currentShelfCount}, since_last=${memoriesSinceLast}`);
    return { success: true, message: `Regenerated from ${memories.length} memories. shelf=${currentShelfCount}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[trajectory] Regen error:", msg);
    return { success: false, message: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== SUPABASE_SERVICE_KEY) {
    console.warn("[admit-memory] Unauthorized call — token mismatch");
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  try {
    const payload = await req.json();
    const { action, content, user_id: rawUserId, memory_type, embedding: providedEmbedding, id: _stripId, ...extraFields } = payload;
    const user_id = rawUserId || DEFAULT_USER_ID;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (action === "regenerate_trajectory") {
      const { count: shelfCount } = await supabase
        .from("memories")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user_id);
      const result = await regenerateTrajectory(supabase, user_id, shelfCount ?? 0);
      return new Response(JSON.stringify({ action: "trajectory_regenerated", ...result, shelf_count: shelfCount }), { status: result.success ? 200 : 500, headers: { "Content-Type": "application/json" } });
    }

    if (!content) {
      return new Response(JSON.stringify({ error: "content required (or use action: 'regenerate_trajectory')" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const embedding = providedEmbedding || await generateEmbedding(content);

    const { data: similar, error: simError } = await supabase.rpc("match_memories_for_competition", { query_embedding: embedding, match_user_id: user_id, similarity_threshold: SIMILARITY_MERGE_THRESHOLD, match_count: 1 });
    if (simError) console.error("Similarity search error:", simError);

    if (similar && similar.length > 0) {
      const match = similar[0];
      const enrichedContent = await absorbNovelty(match.content, content);
      const contentChanged = enrichedContent !== match.content;
      const updatePayload: Record<string, any> = { heat: Math.min((match.heat || 0) + 0.15, 1.0), access_count: (match.access_count || 0) + 1, updated_at: new Date().toISOString() };
      if (contentChanged) {
        updatePayload.content = enrichedContent;
        updatePayload.embedding = await generateEmbedding(enrichedContent);
        updatePayload.cognitive_type = await classifyCognitiveType(enrichedContent);
      }
      const { error: updateError } = await supabase.from("memories").update(updatePayload).eq("id", match.id);
      if (updateError) return new Response(JSON.stringify({ error: "merge_failed", details: updateError }), { status: 500, headers: { "Content-Type": "application/json" } });
      const { count: shelfCount } = await supabase.from("memories").select("*", { count: "exact", head: true }).eq("user_id", user_id);
      await regenerateTrajectory(supabase, user_id, shelfCount ?? 0);
      return new Response(JSON.stringify({ action: "merged", merged_into: match.id, similarity: match.similarity, content_changed: contentChanged, enriched_content: contentChanged ? enrichedContent : undefined, trajectory_regenerated: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const { count: shelfCount, error: countError } = await supabase.from("memories").select("*", { count: "exact", head: true }).eq("user_id", user_id);
    if (countError) return new Response(JSON.stringify({ error: "shelf_count_failed", details: countError }), { status: 500, headers: { "Content-Type": "application/json" } });

    const cognitive_type = await classifyCognitiveType(content);

    if ((shelfCount || 0) < SHELF_CAPACITY) {
      const insertHeat = extraFields.heat || 0.5;
      const insertVitality = computeVitality(insertHeat);
      const { data: inserted, error: insertError } = await supabase.from("memories").insert({ content, user_id, memory_type: memory_type || "user", cognitive_type, embedding, heat: insertHeat, vitality_score: insertVitality, ...extraFields }).select("id").single();
      if (insertError) return new Response(JSON.stringify({ error: "insert_failed", details: insertError }), { status: 500, headers: { "Content-Type": "application/json" } });
      const newCount = (shelfCount || 0) + 1;
      await regenerateTrajectory(supabase, user_id, newCount);
      return new Response(JSON.stringify({ action: "inserted", id: inserted.id, vitality_score: insertVitality, shelf_count: newCount, cognitive_type, trajectory_regenerated: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const candidateHeat = extraFields.heat || 0.5;
    const provisionalVitality = computeVitality(candidateHeat);
    const { data: weakest, error: weakError } = await supabase.from("memories").select("id, content, vitality_score, heat").eq("user_id", user_id).order("vitality_score", { ascending: true }).limit(1).single();
    if (weakError) return new Response(JSON.stringify({ error: "competition_failed", details: weakError }), { status: 500, headers: { "Content-Type": "application/json" } });

    if (provisionalVitality > (weakest.vitality_score || 0)) {
      await supabase.from("memory_compost").insert({ content: weakest.content, vitality_at_death: weakest.vitality_score, killed_by_content: content, death_reason: "vitality_competition", user_id });
      await supabase.from("memories").delete().eq("id", weakest.id);
      const { data: inserted, error: insertError } = await supabase.from("memories").insert({ content, user_id, memory_type: memory_type || "user", cognitive_type, embedding, heat: candidateHeat, vitality_score: provisionalVitality, ...extraFields }).select("id").single();
      if (insertError) return new Response(JSON.stringify({ error: "eviction_insert_failed", details: insertError }), { status: 500, headers: { "Content-Type": "application/json" } });
      await regenerateTrajectory(supabase, user_id, shelfCount ?? SHELF_CAPACITY);
      return new Response(JSON.stringify({ action: "evicted", id: inserted.id, vitality_score: provisionalVitality, evicted_id: weakest.id, evicted_vitality: weakest.vitality_score, cognitive_type, trajectory_regenerated: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    } else {
      return new Response(JSON.stringify({ action: "discarded", reason: "lost_competition", provisional_vitality: provisionalVitality, incumbent_vitality: weakest.vitality_score, trajectory_regenerated: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  } catch (err) {
    console.error("admit-memory error:", err);
    return new Response(JSON.stringify({ error: "internal_error", message: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
