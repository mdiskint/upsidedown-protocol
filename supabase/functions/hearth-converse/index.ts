import "jsr:@supabase/functions-js/edge-runtime.d.ts";

var SUPABASE_URL = Deno.env.get("SUPABASE_URL");
var SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
var ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
var HEARTH_USER_ID = "95aa73e2-ac1a-4ac6-bfae-15a946b11131";
var MODEL = "claude-opus-4-6";

function restHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY || "",
    "Authorization": "Bearer " + (SUPABASE_ANON_KEY || ""),
  };
}

async function dbSelect(table: string, query: string): Promise<any[]> {
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + query, { headers: restHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { console.error("DB select error (" + table + "):", e); return []; }
}

async function fetchMemories(): Promise<string> {
  var rows = await dbSelect("memories",
    "order=vitality_score.desc.nullslast&limit=20&select=content,domain,type,vitality_score"
  );
  if (rows.length === 0) return "No memories loaded.";
  return rows.map(function(m: any) {
    return "- [" + (m.domain || "?") + "/" + (m.type || "?") + "] " + m.content;
  }).join("\n");
}

async function fetchPlatformMemories(): Promise<string> {
  var rows = await dbSelect("platform_memories",
    "removed_at=is.null&order=last_seen_at.desc&limit=100&select=platform,content,first_seen_at,last_seen_at"
  );
  if (rows.length === 0) return "";

  var grouped: Record<string, string[]> = {};
  for (var mem of rows) {
    var p = mem.platform || "unknown";
    if (!grouped[p]) grouped[p] = [];
    grouped[p].push(mem.content);
  }

  var block = "\n[PLATFORM KNOWLEDGE]\nFacts other AI systems have learned about this person:\n\n";
  for (var platform in grouped) {
    var label = platform === "claude" ? "Claude" :
                platform === "chatgpt" ? "ChatGPT" :
                platform === "gemini" ? "Gemini" : platform;
    block += "From " + label + ":\n";
    for (var fact of grouped[platform]) {
      block += "- " + fact + "\n";
    }
    block += "\n";
  }
  block += "[/PLATFORM KNOWLEDGE]";
  return block;
}

async function fetchTrajectory(): Promise<string> {
  var rows = await dbSelect("trajectories",
    "user_id=eq." + HEARTH_USER_ID + "&is_active=eq.true&order=generated_at.desc&limit=1&select=arcs,tensions,drift,memory_count"
  );
  if (rows.length === 0) return "No trajectory loaded.";
  var t = rows[0];
  return "ARCS: " + t.arcs + "\nTENSIONS: " + t.tensions + "\nDRIFT: " + t.drift + "\nMemory count: " + t.memory_count;
}

async function fetchActivitySignals(): Promise<string> {
  var cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  var rows = await dbSelect("activity_signal",
    "created_at=gte." + cutoff + "&order=created_at.desc&limit=50&select=signal_type,signal_value,created_at"
  );
  if (rows.length === 0) return "No recent activity signals.";

  var grouped: Record<string, string[]> = {};
  for (var r of rows) {
    var key = r.signal_type || "unknown";
    if (!grouped[key]) grouped[key] = [];
    if (grouped[key].length < 10) {
      grouped[key].push(r.signal_value || "(empty)");
    }
  }

  var lines: string[] = [];
  for (var type in grouped) {
    lines.push(type + ": " + grouped[type].join(" | "));
  }
  return lines.join("\n");
}

async function fetchScoutIntelligence(): Promise<string> {
  var rows = await dbSelect("agent_runs",
    "agent=eq.scout&status=eq.completed&order=completed_at.desc&limit=1&select=output_envelope,payload,completed_at"
  );
  if (rows.length === 0) return "No recent scout intelligence.";
  var run = rows[0];
  var assessment = "";
  if (run.output_envelope && run.output_envelope.reasoning) {
    assessment = run.output_envelope.reasoning;
  }
  var flags: string[] = [];
  if (run.payload && run.payload.flags) {
    for (var f of run.payload.flags) {
      if (f.relevance === "high" || f.relevance === "medium") {
        flags.push("- [" + f.relevance + "/" + f.category + "] " + f.title + ": " + f.summary);
      }
    }
  }
  var parts = ["Last scan: " + (run.completed_at || "unknown")];
  if (assessment) parts.push("Assessment: " + assessment);
  if (flags.length > 0) parts.push("Flags:\n" + flags.join("\n"));
  return parts.join("\n");
}

function buildSystemPrompt(memories: string, platformKnowledge: string, trajectory: string, activity: string, scout: string): string {
  return `You are Hearth \u2014 a personal AI presence layer. You know this person deeply through their memories, trajectory, and behavioral signals. You are not a generic assistant. You are aligned to THIS person.

Your role: help them think and act more effectively. Be direct. Skip pleasantries. Say what you see. Follow what\u2019s alive in their thinking. Be bold on ideas, careful on resource commitments.

When explaining: ground abstractions in real-world examples. Be thorough on substance, concise in delivery. Don\u2019t use three sentences where one works.

Take positions. When uncertain, say so \u2014 distinguish what you know from what you\u2019re inferring. Tangents and rabbit holes are welcome if they\u2019re alive.

You have access to a browser execution engine. If the user asks you to do something that requires browsing, searching, clicking, or navigating \u2014 respond with your thoughts AND include an action suggestion wrapped in [ACTION: description]. Example: [ACTION: open youtube.com and search for 'emergent behavior simple rules']. The user's panel will render this as a clickable button. You can include multiple [ACTION: ...] blocks if there are multiple steps. Always explain your thinking alongside the action \u2014 don\u2019t just return a bare action block.

[MEMORIES]
${memories}
${platformKnowledge}
[TRAJECTORY]
${trajectory}

[RECENT ACTIVITY]
${activity}

[RECENT INTELLIGENCE]
${scout}

Respond as someone who has been watching this person\u2019s life and work. Connect across data sources \u2014 activity + memories + intelligence + trajectory + platform knowledge. Don\u2019t just memory-match. Synthesize.`;
}

Deno.serve(async function(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      }
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    var body = await req.json();
    var messages: any[] = body.messages || [];

    if (body.question && messages.length === 0) {
      messages = [{ role: "user", content: body.question }];
    }

    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: "No messages provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    var startTime = Date.now();
    var results = await Promise.allSettled([
      fetchMemories(),
      fetchPlatformMemories(),
      fetchTrajectory(),
      fetchActivitySignals(),
      fetchScoutIntelligence()
    ]);

    var memories = results[0].status === "fulfilled" ? results[0].value : "Failed to load memories.";
    var platformKnowledge = results[1].status === "fulfilled" ? results[1].value : "";
    var trajectory = results[2].status === "fulfilled" ? results[2].value : "Failed to load trajectory.";
    var activity = results[3].status === "fulfilled" ? results[3].value : "No activity signals.";
    var scout = results[4].status === "fulfilled" ? results[4].value : "No scout intelligence.";

    var systemPrompt = buildSystemPrompt(memories, platformKnowledge, trajectory, activity, scout);

    var anthropicBody = {
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: messages
    };

    var apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicBody)
    });

    if (!apiRes.ok) {
      var errText = await apiRes.text();
      return new Response(JSON.stringify({
        error: "Anthropic API error",
        status: apiRes.status,
        detail: errText
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    var apiData = await apiRes.json();
    var responseText = "";
    if (apiData.content) {
      for (var block of apiData.content) {
        if (block.type === "text") responseText += block.text;
      }
    }

    var elapsed = Date.now() - startTime;

    return new Response(JSON.stringify({
      response: responseText,
      usage: apiData.usage || {},
      elapsed_ms: elapsed,
      model: MODEL
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
});
