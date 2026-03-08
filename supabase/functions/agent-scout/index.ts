import "jsr:@supabase/functions-js/edge-runtime.d.ts";

var SUPABASE_URL = Deno.env.get("SUPABASE_URL");
var SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
var ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
var HEARTH_USER_ID = "95aa73e2-ac1a-4ac6-bfae-15a946b11131";

var activeKeywords: string[] = [];

var CORE_KEYWORDS = [
  "hearth", "personal ai", "proactive ai", "ambient ai", "identity",
  "alignment", "sycophancy", "context engineering", "mcp",
  "specification engineering", "limitless", "screenpipe",
  "personal intelligence", "gemini personal"
];

var FALLBACK_KEYWORDS = [
  "ai agent", "llm", "anthropic", "openai", "claude", "gpt", "gemini",
  "ai assistant", "ai safety", "inference",
  "multi-agent", "agent framework", "tool use", "function calling",
  "personalization", "ai memory", "memory", "context window", "persistent memory",
  "ai companion", "ai wearable", "lifelogging",
  "chatgpt pulse", "apple intelligence", "siri", "rabbit r1",
  "tab ai", "friend ai", "omi ai", "manus",
  "model context protocol", "rag", "embedding",
  "chrome extension ai", "browser agent",
  "prompt engineering", "fine-tuning",
  "preference learning", "user modeling", "intent engineering"
];

function restHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY || "",
    "Authorization": "Bearer " + (SUPABASE_ANON_KEY || ""),
    "Prefer": "return=representation"
  };
}

async function dbInsert(table: string, data: any): Promise<any> {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST", headers: restHeaders(), body: JSON.stringify(data)
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error("DB insert failed (" + res.status + "): " + err);
  }
  var result = await res.json();
  return result[0] || result;
}

async function dbSelect(table: string, query: string): Promise<any[]> {
  var h: any = restHeaders();
  delete h["Prefer"];
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + query, { headers: h });
  if (!res.ok) return [];
  return await res.json();
}

async function rpcBeat(name: string, meta: any): Promise<void> {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/rpc/beat", {
      method: "POST",
      headers: restHeaders(),
      body: JSON.stringify({ p_name: name, p_meta: meta || {} })
    });
  } catch (e) { console.warn("Heartbeat failed:", e); }
}

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(function() { clearTimeout(timer); });
}

function matchesKeywords(text: string): boolean {
  var lower = text.toLowerCase();
  var allKeywords = CORE_KEYWORDS.concat(activeKeywords);
  for (var i = 0; i < allKeywords.length; i++) {
    if (lower.includes(allKeywords[i])) return true;
  }
  return false;
}

async function generateResearchFocus(hearthContext: string): Promise<{question: string, keywords: string[], reasoning: string}> {
  var fallback = {
    question: "What competitive moves and research are happening in the personal AI and identity-aware agent space?",
    keywords: FALLBACK_KEYWORDS,
    reasoning: "Fallback to default competitive scan"
  };

  if (!ANTHROPIC_API_KEY) return fallback;

  try {
    var activityResults = await Promise.allSettled([
      dbSelect("activity_signal", "select=signal_type,signal_value,metadata,created_at&order=created_at.desc&limit=50"),
      dbSelect("presence_notifications", "select=message,trigger_type,created_at&order=created_at.desc&limit=5"),
      dbSelect("attention_digest", "select=digest,window_start,window_end,created_at&order=created_at.desc&limit=20&created_at=gte." + new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()),
      dbSelect("presence_gate", "select=detail,status,created_at&status=eq.fired&order=created_at.desc&limit=5"),
      dbSelect("agent_runs", "select=payload,created_at&agent=eq.scout&status=eq.completed&order=created_at.desc&limit=1")
    ]);

    var activity = activityResults[0].status === "fulfilled" ? activityResults[0].value : [];
    var notifications = activityResults[1].status === "fulfilled" ? activityResults[1].value : [];
    var digests = activityResults[2].status === "fulfilled" ? activityResults[2].value : [];
    var recentFires = activityResults[3].status === "fulfilled" ? activityResults[3].value : [];
    var lastScoutRun = activityResults[4].status === "fulfilled" ? activityResults[4].value : [];

    var lastQuestion = "";
    if (lastScoutRun.length > 0 && lastScoutRun[0].payload && lastScoutRun[0].payload.research_focus) {
      lastQuestion = lastScoutRun[0].payload.research_focus.question || "";
    }

    var userContent = hearthContext +
      "\n[ATTENTION DIGESTS — LAST 48 HOURS]\n" + 
      digests.map(function(d: any) { return d.digest; }).join("\n\n") +
      "\n\n[RECENT ACTIVITY SIGNALS — LAST 50]\n" + JSON.stringify(activity, null, 2) +
      "\n\n[RECENT PRESENCE NOTIFICATIONS]\n" + JSON.stringify(notifications, null, 2) +
      "\n\n[RECENT FIRE DECISIONS]\n" + JSON.stringify(recentFires, null, 2) +
      (lastQuestion ? "\n\n[LAST SCOUT QUESTION — DO NOT REPEAT THIS]\n" + lastQuestion : "");

    var res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 500,
        system: "You are the research director for a personal AI system called Presence. You see what this person has been doing, thinking about, and working on over the last 48 hours.\n\nYour job: generate ONE research question for the next intelligence scan. The question must be:\n\n1. INSPIRED BY WHAT'S ACTUALLY HAPPENING — not generic industry scanning. Look at their attention digests, their browsing, their searches.\n2. CONNECTIVE — bridge something in their current work to something in the outside world they haven't encountered.\n3. DIFFERENT FROM LAST TIME — you'll see the previous scout question. Go somewhere new.\n4. SPECIFIC — 'What's new in personal AI' is useless. Specific questions are useful.\n\nAlso generate 5-8 search keywords. Respond ONLY with valid JSON, no markdown backticks:\n{\"question\": \"...\", \"keywords\": [\"...\"], \"reasoning\": \"one sentence on why this matters right now\"}",
        messages: [{ role: "user", content: userContent }]
      })
    }, 60000);

    var data = await res.json();
    var text = data.content && data.content[0] ? data.content[0].text : "";
    var parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());

    if (parsed.question && parsed.keywords && Array.isArray(parsed.keywords)) {
      return {
        question: parsed.question,
        keywords: parsed.keywords.map(function(k: string) { return k.toLowerCase(); }),
        reasoning: parsed.reasoning || "No reasoning provided"
      };
    }
    return fallback;
  } catch (e) {
    console.error("Research focus generation failed:", e);
    return fallback;
  }
}

async function fetchHNTop(): Promise<any[]> {
  try {
    var topRes = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/topstories.json");
    var topIds: number[] = await topRes.json();
    var stories = await Promise.all(
      topIds.slice(0, 60).map(async function(id) {
        try {
          var res = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/item/" + id + ".json", {}, 5000);
          return await res.json();
        } catch (e) { return null; }
      })
    );
    return stories.filter(function(s) {
      return s && s.title && matchesKeywords(s.title + " " + (s.url || ""));
    }).map(function(s) {
      return { source: "hn_top", title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), score: s.score, comments: s.descendants || 0 };
    });
  } catch (e) { console.error("HN top error:", e); return []; }
}

async function fetchHNNew(): Promise<any[]> {
  try {
    var newRes = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/newstories.json");
    var newIds: number[] = await newRes.json();
    var stories = await Promise.all(
      newIds.slice(0, 100).map(async function(id) {
        try {
          var res = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/item/" + id + ".json", {}, 5000);
          return await res.json();
        } catch (e) { return null; }
      })
    );
    return stories.filter(function(s) {
      return s && s.title && matchesKeywords(s.title + " " + (s.url || ""));
    }).map(function(s) {
      return { source: "hn_new", title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), score: s.score || 0 };
    });
  } catch (e) { console.error("HN new error:", e); return []; }
}

async function fetchGitHub(): Promise<any[]> {
  try {
    var since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    var queries = activeKeywords.slice(0, 4).map(function(kw) {
      return kw.replace(/\s+/g, "+") + "+created:>" + since;
    });
    if (queries.length === 0) {
      queries = ["personal+ai+memory+created:>" + since, "proactive+ai+assistant+created:>" + since];
    }
    var allRepos: any[] = [];
    for (var q of queries) {
      try {
        var res = await fetchWithTimeout(
          "https://api.github.com/search/repositories?q=" + q + "&sort=stars&order=desc&per_page=10",
          { headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Hearth-Scout" } }
        );
        var data = await res.json();
        if (data.items) {
          for (var r of data.items) {
            allRepos.push({ source: "github", title: r.full_name, url: r.html_url, description: r.description || "", stars: r.stargazers_count });
          }
        }
      } catch (e) { }
    }
    var seen = new Set();
    return allRepos.filter(function(r) { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
  } catch (e) { return []; }
}

async function fetchReddit(): Promise<any[]> {
  try {
    var subreddits = ["LocalLLaMA", "MachineLearning", "ChatGPT", "ClaudeAI", "singularity"];
    var allPosts: any[] = [];
    for (var sub of subreddits) {
      try {
        var res = await fetchWithTimeout("https://www.reddit.com/r/" + sub + "/hot.json?limit=25", { headers: { "User-Agent": "Hearth-Scout/1.0" } });
        var data = await res.json();
        if (data && data.data && data.data.children) {
          for (var child of data.data.children) {
            var post = child.data;
            if (!post || post.stickied) continue;
            if (!matchesKeywords(post.title + " " + (post.selftext || ""))) continue;
            allPosts.push({ source: "reddit", subreddit: sub, title: post.title, url: "https://reddit.com" + post.permalink, score: post.score });
          }
        }
      } catch (e) { }
    }
    return allPosts;
  } catch (e) { return []; }
}

async function getHearthContext(): Promise<string> {
  var results = await Promise.all([
    dbSelect("opspecs", "user_id=eq." + HEARTH_USER_ID + "&limit=1"),
    dbSelect("memories", "heat=gte.0.6&order=heat.desc&limit=20&select=content,domain,type,heat"),
    dbSelect("trajectories", "user_id=eq." + HEARTH_USER_ID + "&is_active=eq.true&order=generated_at.desc&limit=1&select=arcs,tensions,drift"),
    dbSelect("attention_digest", "select=digest&order=created_at.desc&limit=10&created_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  ]);
  var opspec = results[0] && results[0][0];
  var memories = results[1] || [];
  var trajectory = results[2] && results[2][0];
  var digests = results[3] || [];
  var context = "[HEARTH CONTEXT FOR SCOUT AGENT]\nPresence is an alignment layer — proactive AI system that surfaces what the person can't see from inside their own momentum.\n\n";
  if (opspec) context += "[VALUES]\nCognitive Architecture: " + opspec.cognitive_architecture + "\nIdentity: " + opspec.identity + "\n\n";
  if (memories.length > 0) context += "[KEY MEMORIES]\n" + memories.map(function(m: any) { return "- [" + m.domain + "/" + m.type + "] " + m.content; }).join("\n") + "\n\n";
  if (trajectory) context += "[TRAJECTORY]\nARCS: " + trajectory.arcs + "\nTENSIONS: " + trajectory.tensions + "\nDRIFT: " + trajectory.drift + "\n\n";
  if (digests.length > 0) context += "[RECENT ATTENTION]\n" + digests.map(function(d: any) { return d.digest; }).join("\n\n") + "\n\n";
  return context;
}

async function analyzeWithLLM(hearthContext: string, researchFocus: {question: string, keywords: string[], reasoning: string}, hnTop: any[], hnNew: any[], gh: any[], reddit: any[]): Promise<any> {
  if (!ANTHROPIC_API_KEY) return { flags: [], reasoning: "No API key" };
  var prompt = hearthContext +
    "\n[SCOUT TASK]\nRESEARCH QUESTION: " + researchFocus.question +
    "\nWHY THIS MATTERS: " + researchFocus.reasoning +
    "\n\nKNOWN COMPETITORS (always flag):\n- ChatGPT Pulse, Google Gemini Personal, Apple Intelligence, Limitless, Screenpipe, Glean, Tab AI, Friend AI, Omi AI\n\n" +
    "FLAG IF: directly answers the research question, competitor ships features or raises funding, research validates/challenges Presence thesis.\n\n" +
    "For each flagged item: relevance (high/medium/low), category (competitor_move/new_entrant/research/thesis_validation/threat/opportunity/question_answer), one-sentence summary, confidence (0-1).\n\n" +
    "HN Top:\n" + JSON.stringify(hnTop, null, 2) +
    "\n\nHN New:\n" + JSON.stringify(hnNew, null, 2) +
    "\n\nGitHub:\n" + JSON.stringify(gh, null, 2) +
    "\n\nReddit:\n" + JSON.stringify(reddit, null, 2) +
    '\n\nRespond ONLY with valid JSON:\n{"flags":[{"source":"...","title":"...","url":"...","relevance":"high|medium|low","category":"...","summary":"...","confidence":0.0}],"overall_assessment":"2-3 sentences"}';

  var res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  }, 60000);
  var data = await res.json();
  var text = data.content && data.content[0] ? data.content[0].text : "";
  try { return JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()); }
  catch (e) { return { flags: [], reasoning: "Parse failed" }; }
}

Deno.serve(async function(req: Request) {
  var startTime = Date.now();
  try {
    var hearthCtx = await getHearthContext();
    var researchFocus = await generateResearchFocus(hearthCtx);
    activeKeywords = researchFocus.keywords;

    var results = await Promise.allSettled([
      fetchHNTop(), fetchHNNew(), fetchGitHub(), fetchReddit()
    ]);

    var hnTop = results[0].status === "fulfilled" ? results[0].value : [];
    var hnNew = results[1].status === "fulfilled" ? results[1].value : [];
    var gh = results[2].status === "fulfilled" ? results[2].value : [];
    var reddit = results[3].status === "fulfilled" ? results[3].value : [];

    var analysis = await analyzeWithLLM(hearthCtx, researchFocus, hnTop, hnNew, gh, reddit);
    var flagList = analysis.flags || [];
    var highCount = flagList.filter((f: any) => f.relevance === "high").length;

    var run = await dbInsert("agent_runs", {
      agent: "scout",
      status: "completed",
      triggered_by: "manual",
      model: "claude-opus-4-6+claude-haiku-4-5-20251001",
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      output_envelope: {
        source_agent: "scout",
        timestamp: new Date().toISOString(),
        confidence: flagList.length > 0 ? flagList.reduce((s: number, f: any) => s + (f.confidence || 0.5), 0) / flagList.length : 0,
        reasoning: analysis.overall_assessment || "Scan completed"
      },
      payload: {
        research_focus: { question: researchFocus.question, keywords: researchFocus.keywords, reasoning: researchFocus.reasoning },
        flags: flagList,
        scan_stats: { hn_top: hnTop.length, hn_new: hnNew.length, github: gh.length, reddit: reddit.length, flagged: flagList.length, high: highCount }
      }
    });

    if (flagList.length > 0 || analysis.overall_assessment) {
      try {
        await dbInsert("activity_signal", {
          signal_type: "scout_intel",
          signal_value: (researchFocus.question || "competitive scan").substring(0, 200),
          metadata: { run_id: run.id || null, finding_count: flagList.length, high_relevance: highCount, assessment_preview: (analysis.overall_assessment || "").substring(0, 300), source: "agent-scout-v17" }
        });
      } catch (bridgeErr) { console.warn("[Scout Bridge] Failed:", bridgeErr); }
    }

    await rpcBeat("scout", { last_run: new Date().toISOString(), findings: flagList.length, high: highCount });

    return new Response(JSON.stringify({
      run_id: run.id,
      research_question: researchFocus.question,
      items_flagged: flagList.length,
      high_relevance: highCount,
      elapsed_ms: Date.now() - startTime
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
