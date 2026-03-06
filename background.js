// ============================================================
// UPSIDE DOWN — background.js
// The Brain: orchestrates Claude, manages mission state,
// routes actions to content scripts.
// ============================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-5-20250929';
const API_KEY_STORAGE_KEY = 'ud_api_key';
const BUNDLED_SITE_MAPS_PATH = 'data/site-maps.json';
const SUPABASE_URL_STORAGE_KEY = 'supabase_url';
const SUPABASE_ANON_KEY_STORAGE_KEY = 'supabase_anon_key';
const USER_ID_STORAGE_KEY = 'user_id';
const SETUP_COMPLETE_STORAGE_KEY = 'setup_complete';
const NOTIFICATION_POLL_INTERVAL = 30000;
let notificationPollTimer = null;
const PLATFORM_MEMORY_SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // check every hour
const PLATFORM_MEMORY_SCRAPE_STALE_MS = 24 * 60 * 60 * 1000; // scrape every 24h
const PLATFORM_MEMORY_SCRAPE_KEY = 'lastPlatformMemoryScrape';
let platformMemoryScrapeTimer = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.warn('[UD] sidePanel behavior setup failed:', err?.message || err);
});

// Snapshot mode: 'aria' (flat list, original) or 'semantic' (hierarchical with landmarks)
// Toggle this to switch between snapshot strategies. Both use the same ref registry.
const SNAPSHOT_MODE = 'semantic'; // ← change to 'aria' to revert

// Keep service worker alive
function keepAlive() {
  chrome.runtime.getPlatformInfo(() => {});
}
setInterval(keepAlive, 20000); // ping every 20s

async function getSupabaseRuntimeConfig() {
  const data = await chrome.storage.local.get([
    SUPABASE_URL_STORAGE_KEY,
    SUPABASE_ANON_KEY_STORAGE_KEY,
    USER_ID_STORAGE_KEY,
    SETUP_COMPLETE_STORAGE_KEY
  ]);
  const url = String(data[SUPABASE_URL_STORAGE_KEY] || '').trim().replace(/\/+$/, '');
  const anonKey = String(data[SUPABASE_ANON_KEY_STORAGE_KEY] || '').trim();
  const userId = String(data[USER_ID_STORAGE_KEY] || '').trim();
  const setupComplete = Boolean(data[SETUP_COMPLETE_STORAGE_KEY]);
  return { url, anonKey, userId, setupComplete };
}

function isSupabaseConfigReady(cfg) {
  return Boolean(cfg && cfg.url && cfg.anonKey && cfg.setupComplete);
}

function supabaseHeaders(cfg, extraHeaders = {}) {
  return {
    'apikey': cfg.anonKey,
    'Authorization': 'Bearer ' + cfg.anonKey,
    'x-user-id': cfg.userId || '',
    'Content-Type': 'application/json',
    ...extraHeaders
  };
}

async function loadBundledSiteMaps() {
  try {
    const url = chrome.runtime.getURL(BUNDLED_SITE_MAPS_PATH);
    const res = await fetch(url);
    if (!res.ok) return {};
    const payload = await res.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch (err) {
    console.warn('[UD] Failed loading bundled site maps:', err?.message || err);
    return {};
  }
}

async function hydrateBundledSiteMapsOnInstall() {
  const maps = await loadBundledSiteMaps();
  const hostnames = Object.keys(maps);
  if (hostnames.length === 0) return;

  for (const hostname of hostnames) {
    const entry = maps[hostname] || {};
    const teachMap = entry.teachMap;
    if (!teachMap) continue;

    const memoryKey = `siteMemory_${hostname}`;
    const existingResult = await chrome.storage.local.get(memoryKey);
    const existing = existingResult[memoryKey] || {};
    const userTeachMap = existing.__teachMap__ || null;
    const currentBundled = existing.__bundledMap__ || {};
    const next = {
      ...existing,
      __teachMap__: userTeachMap, // user demonstration always wins
      __bundledMap__: {
        content: teachMap,
        source: 'bundled',
        generatedAt: entry.generatedAt || null,
        hydratedAt: Date.now(),
        lastVerified: currentBundled.lastVerified || Date.now()
      }
    };
    if (!next.__teachMap__) delete next.__teachMap__;
    await chrome.storage.local.set({ [memoryKey]: next });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await hydrateBundledSiteMapsOnInstall();
});

async function ensureBundledSiteMapForHostname(hostname) {
  if (!hostname) return;
  const memoryKey = `siteMemory_${hostname}`;
  const result = await chrome.storage.local.get(memoryKey);
  const existing = result[memoryKey] || {};
  if (existing.__teachMap__?.content || existing.__bundledMap__?.content) return;
  const maps = await loadBundledSiteMaps();
  const entry = maps[hostname];
  if (!entry?.teachMap) return;
  await chrome.storage.local.set({
    [memoryKey]: {
      ...existing,
      __bundledMap__: {
        content: entry.teachMap,
        source: 'bundled',
        generatedAt: entry.generatedAt || null,
        hydratedAt: Date.now(),
        lastVerified: Date.now()
      }
    }
  });
}

// ============================================================
// SESSION STATE
// chrome.storage.session persists across tabs for the
// duration of the browser session. All tabs share this.
// ============================================================

async function getSession() {
  const result = await chrome.storage.session.get('ud_session');
  return result.ud_session || {
    history: [],
    mission: null,
    status: 'idle', // idle | working | awaiting_approval | awaiting_user_answer | needs_help
    pendingActions: [],
    proposalText: null,
    pendingQuestion: null,
    stuckContext: null // { failedAction, targetTabUrl, intent, loopState }
  };
}

async function saveSession(session) {
  await chrome.storage.session.set({ ud_session: session });
}

async function clearSession() {
  await chrome.storage.session.remove('ud_session');
}

/**
 * Safely get the active HTTP tab. Falls back to any http tab if the panel
 * window is focused (which has no http tab as "active").
 * Returns null if no http tabs exist at all.
 */
async function getActiveHttpTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('http')) return tab;
  // Fallback: any http tab
  const httpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return httpTabs[0] || null;
}

// ============================================================
// API KEY
// ============================================================

async function getApiKey() {
  const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return result[API_KEY_STORAGE_KEY] || null;
}

async function pollPresenceNotifications() {
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) return;
    const response = await fetch(
      cfg.url + '/rest/v1/presence_notifications?read=eq.false&order=created_at.desc&limit=5',
      { headers: supabaseHeaders(cfg) }
    );
    if (!response.ok) return;
    const notifications = await response.json();
    const data = await chrome.storage.session.get('presenceNotifications');
    const existing = Array.isArray(data.presenceNotifications) ? data.presenceNotifications : [];
    const existingById = new Map(existing.map((n) => [String(n?.id), n]));

    const newlyDiscovered = [];
    for (const notification of (Array.isArray(notifications) ? notifications : [])) {
      const id = String(notification?.id || '');
      if (!id) continue;
      if (!existingById.has(id)) {
        newlyDiscovered.push(notification);
      }
      existingById.set(id, notification);
    }

    const merged = Array.from(existingById.values());
    await chrome.storage.session.set({ presenceNotifications: merged });
    if (newlyDiscovered.length > 0) {
      chrome.runtime.sendMessage({ type: 'PRESENCE_NOTIFICATIONS', notifications: newlyDiscovered }).catch(() => {});
    }
  } catch (err) { console.error('[PRESENCE] Poll error:', err); }
}

async function removeNotificationFromSession(notificationId) {
  try {
    const data = await chrome.storage.session.get('presenceNotifications');
    const current = Array.isArray(data.presenceNotifications) ? data.presenceNotifications : [];
    const next = current.filter((n) => String(n?.id) !== String(notificationId));
    await chrome.storage.session.set({ presenceNotifications: next });
  } catch (err) {
    console.error('[PRESENCE] Session notification remove failed:', err);
  }
}

async function markNotificationRead(notificationId) {
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) return;
    await fetch(
      cfg.url + '/rest/v1/presence_notifications?id=eq.' + notificationId,
      { method: 'PATCH', headers: supabaseHeaders(cfg, { 'Prefer': 'return=minimal' }), body: JSON.stringify({ read: true }) }
    );
    await removeNotificationFromSession(notificationId);
  } catch (err) { console.error('[PRESENCE] Mark read failed:', err); }
}

async function scoreNotification(notificationId, outcome, gradeReason) {
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) return;
    const reason = typeof gradeReason === 'string' ? gradeReason.trim() : '';
    const patch = { outcome: outcome, scored: true, read: true };
    if (outcome === 'D') {
      patch.grade_reason = reason || null;
    }

    await fetch(
      cfg.url + '/rest/v1/presence_notifications?id=eq.' + notificationId,
      { method: 'PATCH', headers: supabaseHeaders(cfg, { 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) }
    );

    if (outcome === 'E') {
      await validateNotificationContextMemories(notificationId, cfg);
    }

    await removeNotificationFromSession(notificationId);
  } catch (err) { console.error('[PRESENCE] Score failed:', err); }
}

async function fetchNotificationContextMemories(notificationId, cfg) {
  const response = await fetch(
    cfg.url + '/rest/v1/presence_notifications?id=eq.' + notificationId + '&select=context_memories&limit=1',
    { headers: supabaseHeaders(cfg) }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('fetch context_memories failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
  const rows = await response.json();
  const context = rows && rows[0] ? rows[0].context_memories : null;
  if (!Array.isArray(context)) return [];
  return context
    .map((id) => String(id || '').trim())
    .filter((id) => id.length > 0);
}

async function validateMemory(memoryId, cfg) {
  const url = cfg.url + '/rest/v1/rpc/validate_memory';
  const headers = supabaseHeaders(cfg);

  const primary = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      p_memory_id: memoryId,
      p_validation_state: 'validated'
    })
  });

  if (primary.ok) return;

  // Backward-compat fallback for older validate_memory signatures.
  const fallback = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      memory_id: memoryId,
      new_state: 'validated',
      increment_count: true
    })
  });

  if (!fallback.ok) {
    const detail = await fallback.text().catch(() => '');
    throw new Error('validate_memory failed for ' + memoryId + ': HTTP ' + fallback.status + (detail ? ' ' + detail : ''));
  }
}

async function validateNotificationContextMemories(notificationId, cfg) {
  try {
    const memoryIds = await fetchNotificationContextMemories(notificationId, cfg);
    if (memoryIds.length === 0) {
      console.log('[PRESENCE] No context memories to validate for notification', notificationId);
      return;
    }

    let validated = 0;
    for (const memoryId of memoryIds) {
      try {
        await validateMemory(memoryId, cfg);
        validated += 1;
      } catch (error) {
        console.warn('[PRESENCE] validate_memory failed for context memory', memoryId, error?.message || error);
      }
    }
    console.log('[PRESENCE] E-grade validated context memories:', validated + '/' + memoryIds.length, 'notification=', notificationId);
  } catch (error) {
    console.warn('[PRESENCE] E-grade validation loop failed:', error?.message || error);
  }
}

async function setRealtimeActive(active) {
  if (typeof active !== 'boolean') {
    return { success: false, error: 'active must be a boolean' };
  }
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) {
      return { success: false, error: 'Supabase config missing. Complete setup first.' };
    }
    const response = await fetch(
      cfg.url + '/rest/v1/hearth_settings?on_conflict=key',
      {
        method: 'POST',
        headers: supabaseHeaders(cfg, { 'Prefer': 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify([{ key: 'realtime_active', value: active ? 'true' : 'false' }])
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('HTTP ' + response.status + (detail ? ' ' + detail : ''));
    }
    return { success: true, active };
  } catch (err) {
    console.error('[PRESENCE] Realtime toggle set failed:', err);
    return { success: false, error: err.message };
  }
}

async function getRealtimeActive() {
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) {
      return { success: false, error: 'Supabase config missing. Complete setup first.', active: false };
    }
    const response = await fetch(
      cfg.url + '/rest/v1/hearth_settings?select=value&key=eq.realtime_active&limit=1',
      {
        headers: supabaseHeaders(cfg)
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('HTTP ' + response.status + (detail ? ' ' + detail : ''));
    }
    const rows = await response.json();
    const raw = String(rows?.[0]?.value || '').toLowerCase();
    const active = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
    return { success: true, active };
  } catch (err) {
    console.error('[PRESENCE] Realtime toggle get failed:', err);
    return { success: false, error: err.message, active: false };
  }
}

async function hearthConverse(messages) {
  try {
    const cfg = await getSupabaseRuntimeConfig();
    if (!isSupabaseConfigReady(cfg)) {
      return { error: 'Supabase config missing. Complete setup first.' };
    }
    const response = await fetch(cfg.url + '/functions/v1/hearth-converse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, user_id: cfg.userId || null })
    });
    if (!response.ok) throw new Error('API ' + response.status);
    return await response.json();
  } catch (err) { console.error('[HEARTH] Converse error:', err); return { error: err.message }; }
}

function startNotificationPoller() {
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  pollPresenceNotifications();
  notificationPollTimer = setInterval(pollPresenceNotifications, NOTIFICATION_POLL_INTERVAL);
  console.log('[PRESENCE] Notification poller started');
}

function normalizePlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'claude' || p === 'chatgpt') return p;
  return null;
}

function sanitizePlatformMemories(platform, memories) {
  const normalizedPlatform = normalizePlatform(platform);
  if (!normalizedPlatform || !Array.isArray(memories)) return [];
  const nowIso = new Date().toISOString();
  return memories
    .map((m) => ({
      platform: normalizedPlatform,
      content: String(m?.content || '').trim(),
      content_hash: String(m?.content_hash || '').trim(),
      last_seen_at: nowIso,
      removed_at: null
    }))
    .filter((m) => m.content && m.content_hash);
}

async function patchRemovedAtById(id, removedAtIso, cfg) {
  try {
    await fetch(
      `${cfg.url}/rest/v1/platform_memories?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(cfg, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ removed_at: removedAtIso })
      }
    );
  } catch (err) {
    console.error('[PLATFORM_MEMORIES] Failed PATCH removed_at for id', id, err);
  }
}

async function syncPlatformMemories(payload) {
  const cfg = await getSupabaseRuntimeConfig();
  if (!isSupabaseConfigReady(cfg)) {
    return { success: false, error: 'Supabase config missing. Complete setup first.' };
  }
  const platform = normalizePlatform(payload?.platform);
  const rows = sanitizePlatformMemories(platform, payload?.memories || []);
  if (!platform) return { success: false, error: 'invalid_platform' };
  if (rows.length === 0) return { success: true, upserted: 0, removed: 0 };

  const upsertRes = await fetch(
    `${cfg.url}/rest/v1/platform_memories?on_conflict=content_hash`,
    {
      method: 'POST',
      headers: supabaseHeaders(cfg, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows)
    }
  );

  if (!upsertRes.ok) {
    const detail = await upsertRes.text().catch(() => '');
    throw new Error(`upsert failed ${upsertRes.status}: ${detail}`);
  }

  const activeRes = await fetch(
    `${cfg.url}/rest/v1/platform_memories?select=id,content_hash&platform=eq.${encodeURIComponent(platform)}&removed_at=is.null`,
    {
      headers: supabaseHeaders(cfg)
    }
  );
  if (!activeRes.ok) {
    const detail = await activeRes.text().catch(() => '');
    throw new Error(`active query failed ${activeRes.status}: ${detail}`);
  }

  const activeRows = await activeRes.json();
  const scrapedHashes = new Set(rows.map((r) => r.content_hash));
  const removedAtIso = new Date().toISOString();
  const toMarkRemoved = (Array.isArray(activeRows) ? activeRows : []).filter(
    (r) => r?.content_hash && !scrapedHashes.has(String(r.content_hash))
  );

  for (const row of toMarkRemoved) {
    if (row?.id) {
      await patchRemovedAtById(row.id, removedAtIso, cfg);
    }
  }

  return { success: true, upserted: rows.length, removed: toMarkRemoved.length };
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (done) return;
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function requestScrapeFromTab(tabId) {
  const maxAttempts = 8;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_PLATFORM_MEMORIES' });
      if (result && result.success) return result;
    } catch (err) {
      // Content script not ready yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { success: false, error: 'scrape_timeout' };
}

async function scrapePlatformInBackgroundTab(target) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: target.url, active: false });
    await waitForTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 2500));
    const result = await requestScrapeFromTab(tab.id);
    if (!result?.success) {
      console.warn(`[PLATFORM_MEMORIES] scrape failed for ${target.platform}:`, result?.error || 'unknown');
    }
    return result;
  } catch (err) {
    console.error(`[PLATFORM_MEMORIES] scrape tab error for ${target.platform}:`, err);
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    }
  }
}

async function periodicMemoryScrape() {
  try {
    const data = await chrome.storage.local.get(PLATFORM_MEMORY_SCRAPE_KEY);
    const lastTs = Number(data?.[PLATFORM_MEMORY_SCRAPE_KEY] || 0);
    const now = Date.now();
    if (lastTs && (now - lastTs) < PLATFORM_MEMORY_SCRAPE_STALE_MS) {
      return;
    }

    const targets = [
      { platform: 'claude', url: 'https://claude.ai/settings' },
      { platform: 'chatgpt', url: 'https://chatgpt.com/#settings' }
    ];

    console.log('[PLATFORM_MEMORIES] Running periodic scrape...');
    for (const target of targets) {
      await scrapePlatformInBackgroundTab(target);
    }
    await chrome.storage.local.set({ [PLATFORM_MEMORY_SCRAPE_KEY]: now });
  } catch (err) {
    console.error('[PLATFORM_MEMORIES] periodic scrape failed:', err);
  }
}

function startPlatformMemoryScrapeCycle() {
  if (platformMemoryScrapeTimer) clearInterval(platformMemoryScrapeTimer);
  periodicMemoryScrape();
  platformMemoryScrapeTimer = setInterval(periodicMemoryScrape, PLATFORM_MEMORY_SCRAPE_INTERVAL_MS);
  console.log('[PLATFORM_MEMORIES] periodic scrape cycle started');
}

// ============================================================
// CLAUDE API
// ============================================================

async function askClaude(history, systemPrompt, model = HAIKU_MODEL) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set. Open the panel and add your key.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
      }),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic API error');

    const content = data?.content;
    if (Array.isArray(content)) {
      return content.map((block) => block?.text || '').join('');
    }
    return '';

  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeWithSonnet(session, draftMessage, openTabs) {
  const synthesisPrompt = `You are final response synthesis. Write one concise final message for the user.
Mission: ${session.mission || 'unknown'}
Draft result: ${draftMessage || ''}
Open tabs:
${(openTabs || []).map((t) => `- ${t.title} (${t.url})`).join('\n')}
If reporting findings from browsing, end with "→ See tab: [site name]".`;
  return askClaude([{ role: 'user', content: 'Synthesize the final response now.' }], synthesisPrompt, SONNET_MODEL);
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

async function getSiteMemory(hostname) {
  await ensureBundledSiteMapForHostname(hostname);
  return new Promise((resolve) => {
    const memoryKey = `siteMemory_${hostname}`;
    chrome.storage.local.get(memoryKey, (result) => {
      const memory = result[memoryKey] || {};
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const lines = [];
      if (memory.__teachMap__?.content) {
        lines.push('SITE MAP (learned from user demonstration):');
        lines.push(memory.__teachMap__.content);
        lines.push('');
      } else if (memory.__bundledMap__?.content) {
        lines.push('SITE MAP (bundled baseline):');
        lines.push(memory.__bundledMap__.content);
        lines.push('');
      }
      const fresh = Object.entries(memory)
        .filter(([key, v]) => key !== '__teachMap__' && key !== '__bundledMap__' && v.lastVerified > thirtyDaysAgo)
        .map(([selector, v]) => `${v.type}: "${selector}" (verified ${v.successCount}x)`);
      lines.push(...fresh);
      resolve(lines);
    });
  });
}

async function getSiteMemoryEntries(hostname) {
  await ensureBundledSiteMapForHostname(hostname);
  const memoryKey = `siteMemory_${hostname}`;
  const result = await chrome.storage.local.get(memoryKey);
  return result[memoryKey] || {};
}

// ============================================================
// PERCEPTION CONFIDENCE SIGNAL
// Runs after every snapshot. Detects broken/degraded perception
// and returns a confidence level that determines whether to
// proceed, warn the AI, or auto-escalate.
// ============================================================

function assessPerceptionConfidence(snapshot, mission, previousSnapshot, previousUrl, currentUrl) {
  const issues = [];
  const snapshotText = String(snapshot || '');
  const missionText = String(mission || '').toLowerCase();

  // ── Count interactive refs ──
  // Refs look like: role[N] or word[N] at the start of a trimmed line
  const refMatches = snapshotText.match(/^\s*\S+\[\d+\]/gm) || [];
  const refCount = refMatches.length;

  // ── Check 1: Thin snapshot ──
  // A real page should have at least 5 interactive elements.
  // Blank/error pages might have 0, hostile DOMs might have 1-2.
  if (refCount === 0) {
    issues.push({ severity: 'high', signal: 'empty_snapshot', detail: 'Zero interactive elements detected. Page may not have loaded, or DOM is completely non-semantic.' });
  } else if (refCount < 5) {
    issues.push({ severity: 'high', signal: 'thin_snapshot', detail: `Only ${refCount} interactive element(s) found. Page may have hostile DOM or failed to render.` });
  }

  // ── Check 2: Missing main region ──
  // Most real pages have a [MAIN CONTENT] region. Its absence suggests
  // the page structure wasn't detected (div-soup) or page is in an
  // error/loading state.
  const hasMain = /\[MAIN CONTENT\]/i.test(snapshotText);
  const hasAnyContent = refCount > 0;
  if (!hasMain && hasAnyContent && refCount >= 5) {
    // Only flag if there ARE elements but no main — otherwise thin_snapshot covers it
    issues.push({ severity: 'medium', signal: 'no_main_region', detail: 'No [MAIN CONTENT] landmark detected. Page may use non-semantic markup.' });
  }

  // ── Check 3: Expected elements missing based on mission context ──
  // If the mission mentions specific actions, check for related elements.
  const expectations = [
    { keywords: ['compose', 'write', 'send', 'email', 'reply'], elements: ['textbox', 'send', 'to', 'subject', 'body'], label: 'compose/email fields' },
    { keywords: ['search', 'find', 'look for', 'look up'], elements: ['search', 'textbox'], label: 'search input' },
    { keywords: ['buy', 'purchase', 'add to cart', 'checkout'], elements: ['button', 'add to cart', 'buy', 'cart'], label: 'purchase/cart elements' },
    { keywords: ['login', 'sign in', 'log in'], elements: ['textbox', 'password', 'sign in', 'log in'], label: 'login fields' },
  ];
  const snapshotLower = snapshotText.toLowerCase();
  for (const exp of expectations) {
    const missionMatches = exp.keywords.some(kw => missionText.includes(kw));
    if (!missionMatches) continue;
    const hasExpected = exp.elements.some(el => snapshotLower.includes(el));
    if (!hasExpected) {
      issues.push({ severity: 'medium', signal: 'expected_elements_missing', detail: `Mission suggests ${exp.label} should be present, but none found in snapshot.` });
    }
  }

  // ── Check 4: Stale snapshot after navigation ──
  // If the URL changed but the snapshot is identical to the previous one,
  // the content script may not have re-run or the page didn't actually update.
  if (previousSnapshot && previousUrl && currentUrl) {
    const urlChanged = previousUrl !== currentUrl;
    // Compare a normalized version (strip ref numbers since they reset each snapshot)
    const normalize = (s) => String(s).replace(/\[\d+\]/g, '[N]').trim();
    const snapshotIdentical = normalize(snapshotText) === normalize(previousSnapshot);
    if (urlChanged && snapshotIdentical) {
      issues.push({ severity: 'high', signal: 'stale_snapshot', detail: `URL changed from ${previousUrl} to ${currentUrl} but snapshot is identical. Content script may need re-injection.` });
    }
  }

  // ── Determine overall confidence level ──
  const hasHigh = issues.some(i => i.severity === 'high');
  const hasMedium = issues.some(i => i.severity === 'medium');

  let confidence;
  if (hasHigh) confidence = 'low';
  else if (hasMedium) confidence = 'medium';
  else confidence = 'high';

  return { confidence, issues, refCount };
}

/**
 * Build a warning block to inject into the AI's context when perception is degraded.
 * Returns empty string if confidence is high (no warning needed).
 */
function buildPerceptionWarning(assessment) {
  if (assessment.confidence === 'high') return '';

  const lines = [];
  if (assessment.confidence === 'low') {
    lines.push('⚠️ PERCEPTION WARNING (LOW CONFIDENCE):');
    lines.push('The page snapshot may be broken or severely incomplete. Consider:');
    lines.push('- Using readDOM to re-read the page');
    lines.push('- The page may not have finished loading');
    lines.push('- The site may use non-standard DOM that the snapshot cannot read');
    lines.push('- If stuck, report what you can see and ask the user for help');
  } else {
    lines.push('⚠️ PERCEPTION NOTE (MEDIUM CONFIDENCE):');
    lines.push('The page snapshot may be missing some elements.');
  }

  for (const issue of assessment.issues) {
    lines.push(`  - [${issue.severity.toUpperCase()}] ${issue.signal}: ${issue.detail}`);
  }

  return '\n' + lines.join('\n') + '\n';
}

// ============================================================
// PERCEPTION → askUser QUESTION BUILDER
// Generates specific, actionable questions when perception is
// degraded. The goal: never say "I'm stuck." Always ask
// something the user can answer in one sentence.
// ============================================================

function buildPerceptionQuestion(assessment, mission, currentUrl) {
  const issues = assessment.issues || [];
  const missionText = String(mission || '').toLowerCase();
  let hostname = 'this page';
  try { hostname = new URL(currentUrl).hostname; } catch {}

  // Priority: most specific question first

  // Empty/thin snapshot — we can't see anything
  const emptyOrThin = issues.find(i => i.signal === 'empty_snapshot' || i.signal === 'thin_snapshot');
  if (emptyOrThin) {
    if (missionText) {
      return `I'm trying to ${mission}, but I can only see ${assessment.refCount} interactive element(s) on ${hostname}. Can you describe what's on the screen right now? Specifically, do you see any buttons, links, or input fields I should interact with?`;
    }
    return `I can barely read ${hostname} — only ${assessment.refCount} element(s) visible to me. What do you see on the page? Are there buttons, menus, or forms I'm missing?`;
  }

  // Expected elements missing — we can see the page but not what we need
  const missingExpected = issues.find(i => i.signal === 'expected_elements_missing');
  if (missingExpected) {
    // Extract what we expected from the detail string
    const detailMatch = missingExpected.detail.match(/suggests (.+?) should be present/);
    const expectedThing = detailMatch ? detailMatch[1] : 'the expected fields';
    return `I can see ${hostname} but I can't find ${expectedThing}. Is there a dialog, popup, or section on the page that might contain what I need? Describe what you see and I'll adjust.`;
  }

  // No main region — page structure is broken for us
  const noMain = issues.find(i => i.signal === 'no_main_region');
  if (noMain) {
    return `I can see some elements on ${hostname} but I can't understand the page layout. Can you tell me what the main content area shows? I'll use that to navigate.`;
  }

  // Stale snapshot — page didn't update after navigation
  const stale = issues.find(i => i.signal === 'stale_snapshot');
  if (stale) {
    return `I navigated to a new page on ${hostname} but my view didn't update. Has the page finished loading? If it looks stuck, try refreshing and I'll pick up where I left off.`;
  }

  // Generic fallback — shouldn't normally hit this
  return `I'm having trouble reading ${hostname} reliably. Can you describe what you see on the screen so I can figure out my next step?`;
}

/**
 * Build an askUser question specifically for auth walls (CAPTCHA, 2FA, login).
 * Returns a targeted question instead of a generic "sign in needed" message.
 */
function buildAuthWallQuestion(domContent, currentUrl) {
  const text = String(domContent || '').toLowerCase();
  let hostname = 'this page';
  try { hostname = new URL(currentUrl).hostname; } catch {}

  if (/captcha|verify you are human|recaptcha/i.test(text)) {
    return `I hit a CAPTCHA on ${hostname}. Can you solve it? Once you're past it, just say "done" and I'll pick up right where I left off.`;
  }
  if (/two[- ]factor|2fa|verification code|authenticator/i.test(text)) {
    return `${hostname} is asking for two-factor authentication. Can you complete the 2FA step? Say "done" when you're through and I'll continue.`;
  }
  if (/paywall|subscribe to continue|premium content/i.test(text)) {
    return `I hit a paywall on ${hostname}. Do you have access, or should I try a different approach?`;
  }
  // Generic login wall
  return `${hostname} needs you to sign in. Can you log in on that tab? Say "done" when you're in and I'll resume.`;
}

// ============================================================
// SCREENSHOT FALLBACK (Layer 3)
// When semantic snapshot + rescue pass can't read a page,
// capture a screenshot and have Claude vision analyze it.
// Then bridge back to DOM refs via viewport grid scanning.
// ============================================================

/**
 * Capture the visible tab as a base64 PNG.
 * The tab must be the active tab in its window.
 * For background tabs, the caller should activate the tab first.
 */
async function captureTabScreenshot(tabId) {
  try {
    // Get the tab's window ID
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error('Tab not found');

    // If tab isn't active, briefly activate it for capture
    const wasActive = tab.active;
    if (!wasActive) {
      await chrome.tabs.update(tabId, { active: true });
      // Brief pause for render
      await new Promise(r => setTimeout(r, 300));
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 80
    });

    // Restore previous tab if we switched
    if (!wasActive) {
      // Find the previously active tab and switch back
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      const prevActive = tabs.find(t => t.active && t.id !== tabId);
      // Don't switch back — the agentic loop will handle tab management
    }

    // Strip data URL prefix to get raw base64
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    console.log(`[UD] Screenshot captured: ${Math.round(base64.length / 1024)}KB`);
    return base64;
  } catch (err) {
    console.error('[UD] Screenshot capture failed:', err.message);
    return null;
  }
}

/**
 * Send a message to Claude with an image (screenshot) using the vision API.
 * Uses the same API key and configuration as regular askClaude.
 */
async function askClaudeWithImage(textMessages, systemPrompt, imageBase64, model = HAIKU_MODEL) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set.');

  // Build the last user message with the image
  const messages = [...textMessages];
  // The last message should include the image
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    // Replace the last user message with a multimodal one
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: imageBase64
          }
        },
        {
          type: 'text',
          text: lastMsg.content
        }
      ]
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000); // longer timeout for vision

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages
      }),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Vision API error');

    const content = data?.content;
    if (Array.isArray(content)) {
      return content.map((block) => block?.text || '').join('');
    }
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run the screenshot fallback pipeline:
 * 1. Capture screenshot of the tab
 * 2. Ask Claude vision to describe what's on the page
 * 3. Run viewport grid scan to find interactive elements
 * 4. Return combined perception: vision description + grid scan refs
 *
 * Returns null if the fallback fails or finds nothing useful.
 */
async function screenshotFallback(tabId, mission, existingSnapshot) {
  console.log('[UD] Screenshot fallback: starting...');

  // Step 1: Capture screenshot
  const screenshot = await captureTabScreenshot(tabId);
  if (!screenshot) {
    console.log('[UD] Screenshot fallback: capture failed, aborting.');
    return null;
  }

  // Step 2: Ask Claude vision to analyze the page
  const visionPrompt = `You are a visual page analyzer for a browser automation system.
The user's AI agent is trying to navigate a website but the DOM-based page reader couldn't find enough interactive elements.
Look at this screenshot and describe:
1. What page/site this is
2. The main content areas and their layout
3. All visible interactive elements: buttons, links, input fields, tabs, cards, menus
4. For each interactive element, describe its approximate position (top/middle/bottom of page, left/center/right)
5. Any popups, modals, overlays, or blocking elements

Be concise and factual. Focus on elements the agent could interact with.
${mission ? `The agent is trying to: ${mission}` : ''}
${existingSnapshot ? `The DOM reader found these elements (might be incomplete):\n${existingSnapshot.slice(0, 500)}` : ''}`;

  let visionAnalysis;
  try {
    visionAnalysis = await askClaudeWithImage(
      [{ role: 'user', content: 'Analyze this page screenshot. What interactive elements do you see?' }],
      visionPrompt,
      screenshot,
      HAIKU_MODEL
    );
    console.log(`[UD] Screenshot fallback: vision analysis complete (${visionAnalysis.length} chars)`);
  } catch (err) {
    console.error('[UD] Screenshot fallback: vision analysis failed:', err.message);
    return null;
  }

  // Step 3: Run viewport grid scan to get DOM refs for what vision saw
  let gridResult;
  try {
    gridResult = await chrome.tabs.sendMessage(tabId, {
      type: 'SCAN_VIEWPORT_GRID',
      gridCols: 12,
      gridRows: 10
    });
    console.log(`[UD] Screenshot fallback: grid scan found ${gridResult?.count || 0} elements across ${gridResult?.points || 0} points`);
  } catch (err) {
    console.error('[UD] Screenshot fallback: grid scan failed:', err.message);
    gridResult = { text: '[GRID SCAN FAILED]', count: 0 };
  }

  // Step 4: Combine results
  const combinedPerception = [
    '=== SCREENSHOT ANALYSIS (what the page looks like) ===',
    visionAnalysis,
    '',
    '=== DOM GRID SCAN (interactive elements with refs you can use) ===',
    gridResult.text || 'No elements found.',
    '',
    'IMPORTANT: Use the ref numbers from the grid scan for click/fill actions.',
    'The screenshot description tells you WHAT to look for; the grid scan gives you the refs to ACT on.'
  ].join('\n');

  const totalElements = gridResult.count || 0;
  if (totalElements === 0 && (!visionAnalysis || visionAnalysis.length < 50)) {
    console.log('[UD] Screenshot fallback: no useful results from either vision or grid scan.');
    return null;
  }

  return {
    perception: combinedPerception,
    visionAnalysis,
    gridElements: totalElements,
    screenshotBase64: screenshot // keep for potential follow-up questions
  };
}

function isAuthWall(domContent = '') {
  const text = String(domContent || '').toLowerCase();
  const signals = [
    /sign in/i,
    /log in/i,
    /login/i,
    /continue with google/i,
    /enter password/i,
    /captcha/i,
    /verify you are human/i,
    /two[- ]factor/i,
    /2fa/i,
    /paywall/i,
    /subscribe to continue/i
  ];
  let hits = 0;
  for (const re of signals) if (re.test(text)) hits += 1;
  return hits >= 2;
}

/**
 * Detect when the AI's response message indicates the user needs to
 * intervene (CAPTCHA, login, 2FA, verification) before the mission
 * can continue. Used to override premature complete:true signals.
 */
function needsHumanIntervention(messageText) {
  const text = String(messageText || '').toLowerCase();
  const patterns = [
    /captcha/i,
    /verify you are human/i,
    /human verification/i,
    /recaptcha/i,
    /robot check/i,
    /sign[- ]?in/i,
    /log[- ]?in/i,
    /login/i,
    /enter.+password/i,
    /two[- ]factor/i,
    /2fa/i,
    /authentication/i,
    /verification code/i,
    /paywall/i,
    /subscribe to continue/i,
    /please complete/i,
    /needs? (your |human )?attention/i,
    /requires? (your |human )?(action|intervention|input)/i,
  ];
  let hits = 0;
  for (const re of patterns) if (re.test(text)) hits++;
  return hits >= 1;
}

function isEmailSendMission(mission) {
  const text = String(mission || '').toLowerCase();
  return /(send|compose|write)/.test(text) && /(email|gmail|message)/.test(text);
}

function isSendLikeAction(action) {
  if (!action || action.type !== 'click') return false;
  const hay = [action.selector, action.text, action.ariaLabel, action.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /\bsend\b/.test(hay);
}

function isLikelyGmailMission(mission, tabs = []) {
  const text = String(mission || '').toLowerCase();
  if (/gmail|mail\.google\.com/.test(text)) return true;
  return tabs.some((t) => {
    try {
      return new URL(t.url).hostname.includes('mail.google.com');
    } catch {
      return false;
    }
  });
}

/**
 * Mission bleed check: verify that a completion message relates to the
 * original mission. Prevents the AI from pivoting to an unrelated open
 * tab and reporting that content as if it completed the mission.
 *
 * Returns true if the response appears relevant (or if we can't tell).
 * Returns false if there's zero keyword overlap — strong signal of bleed.
 */
function isMissionRelevant(mission, responseMessage) {
  if (!mission || !responseMessage) return true; // fail open
  const missionLower = mission.toLowerCase();
  const responseLower = responseMessage.toLowerCase();

  // Stop words to skip when extracting mission keywords
  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'have',
    'are', 'was', 'were', 'been', 'will', 'would', 'could', 'should',
    'can', 'may', 'might', 'shall', 'into', 'also', 'just', 'than',
    'then', 'when', 'what', 'which', 'where', 'who', 'how', 'all',
    'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'only', 'very', 'find', 'get', 'make', 'look', 'help',
    'please', 'want', 'need', 'like', 'use', 'about', 'there'
  ]);

  // Extract significant words (3+ chars, not stop words)
  const missionWords = missionLower.match(/\b[a-z]{3,}\b/g) || [];
  const significant = missionWords.filter(w => !stopWords.has(w));

  if (significant.length === 0) return true; // can't check, fail open

  // Check if ANY mission keyword appears in the response
  const hasOverlap = significant.some(word => responseLower.includes(word));

  if (!hasOverlap) {
    console.log(`[UD] Mission bleed detected: mission keywords [${significant.join(', ')}] not found in response: "${responseMessage.slice(0, 200)}"`);
  }
  return hasOverlap;
}

function canonicalActionType(rawType) {
  const type = String(rawType || '').trim();
  const normalized = type.toLowerCase();
  const aliases = {
    presskey: 'key',
    press_key: 'key',
    readdom: 'readDOM',
    read_dom: 'readDOM',
    read: 'readDOM',
    opentab: 'openTab',
    open_tab: 'openTab',
    actontab: 'actOnTab',
    act_on_tab: 'actOnTab',
    askuser: 'askUser',
    ask_user: 'askUser',
    ask: 'askUser'
  };
  return aliases[normalized] || type;
}

function normalizeActOnTabAction(action) {
  if (!action || action.type !== 'actOnTab') return action;
  const payload = action.action && typeof action.action === 'object'
    ? { ...action.action }
    : { ...action };
  const rawInnerType = payload.type === 'actOnTab' ? payload.primitive || payload.actionType : payload.type;
  const innerType = canonicalActionType(rawInnerType);
  return {
    type: 'actOnTab',
    tabUrl: action.tabUrl || action.url || payload.tabUrl || payload.url || '',
    action: {
      ...payload,
      type: innerType,
      tabUrl: undefined,
      url: undefined,
      action: undefined,
      primitive: undefined,
      actionType: undefined
    }
  };
}

function normalizeActions(actions = []) {
  return actions
    .filter(Boolean)
    .map((action) => ({ ...action, type: canonicalActionType(action.type) }))
    .map((action) => normalizeActOnTabAction(action));
}

function validateActOnTabAction(action) {
  if (!action || action.type !== 'actOnTab') return { valid: false, error: 'Not an actOnTab action' };
  if (!action.tabUrl || typeof action.tabUrl !== 'string') {
    return { valid: false, error: 'actOnTab requires tabUrl' };
  }
  const inner = action.action;
  if (!inner || typeof inner !== 'object') {
    return { valid: false, error: 'actOnTab requires an action object' };
  }
  const allowed = new Set(['fill', 'click', 'key', 'scroll', 'readDOM']);
  if (!allowed.has(inner.type)) {
    return { valid: false, error: `actOnTab inner action type not supported: ${inner.type || 'unknown'}` };
  }
  if ((inner.type === 'fill' || inner.type === 'click') && !inner.selector && inner.ref == null) {
    return { valid: false, error: `actOnTab ${inner.type} requires ref or selector` };
  }
  if (inner.type === 'fill' && typeof inner.value !== 'string') {
    return { valid: false, error: 'actOnTab fill requires string value' };
  }
  if (inner.type === 'key' && !inner.value) {
    return { valid: false, error: 'actOnTab key requires value' };
  }
  return { valid: true };
}

async function readGmailSendSignals(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const regions = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'));
        const regionText = regions.map((n) => n.innerText || n.textContent || '').join(' ').toLowerCase();
        const pageText = (document.body?.innerText || '').slice(0, 5000).toLowerCase();
        const url = window.location.href.toLowerCase();
        return {
          hasToast: /message sent|your message has been sent|sending\.\.\./i.test(regionText),
          hasUndo: /\bundo\b/i.test(regionText),
          urlLooksSent: /[#&]sent|\/sent\b/.test(url),
          bodyMentionsSent: /\bmessage sent\b/.test(pageText),
          sample: regionText.slice(0, 200)
        };
      }
    });
    return result?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function hasStrongGmailSendConfirmation() {
  const tabs = await chrome.tabs.query({});
  const gmailTabs = tabs.filter((t) => {
    try {
      return new URL(t.url || '').hostname.includes('mail.google.com');
    } catch {
      return false;
    }
  });
  for (const tab of gmailTabs) {
    const signals = await readGmailSendSignals(tab.id);
    if (!signals) continue;
    if ((signals.hasToast && signals.hasUndo) || (signals.hasToast && signals.bodyMentionsSent) || signals.urlLooksSent) {
      return true;
    }
  }
  return false;
}

async function buildSystemPrompt(mission, pageContext, openTabs, activeTabUrl) {
  let memoryBlock = '';
  if (activeTabUrl) {
    try {
      const hostname = new URL(activeTabUrl).hostname;
      const cached = await getSiteMemory(hostname);
      if (cached.length) {
        memoryBlock = `\n\nSITE MEMORY for ${hostname}:\n${cached.join('\n')}\n`;
      }
    } catch {}
  }
  return `You are Upside Down, an AI agent that acts on web pages on behalf of the user.${memoryBlock}

${mission ? `CURRENT MISSION: ${mission}` : 'No active mission.'}

OPEN TABS (you can act on any of these):
${openTabs ? openTabs.map(t => `- "${t.title}" → ${t.url}`).join('\n') : 'Unknown'}

CURRENT PAGE CONTEXT (structured snapshot — interactive elements grouped by page region):
${pageContext || 'No page context available.'}

The page context shows interactive elements grouped under page landmarks/regions:
  [REGION_TYPE] "region name"
    role[ref] "name" value="..." → href
Examples: button[3] "Submit", textbox[7] "Search" value="", link[12] "Home" → https://...
Regions like [HEADER], [NAVIGATION], [MAIN CONTENT], [SIDEBAR], [FOOTER] show page structure.
[ITEM] groups represent repeated elements like product cards or list items.
[RESCUED ELEMENTS] contains elements that are visible on the page but were inside hidden DOM containers. These are fully interactive — trust their refs.
[GRID SCAN RESULTS] contains elements found by probing the viewport with elementsFromPoint(). These appear when the normal DOM reader can't find enough elements (hostile/div-soup sites). Elements marked [pointer] were detected by cursor:pointer heuristic rather than semantic HTML. All grid scan refs are actionable — use them just like any other ref.

To act on an element, use its ref number. The ref is resolved at execution time against the live page.
Use the region structure to understand WHERE elements are on the page (e.g. which product card an "Add to Cart" belongs to).

When the page context includes "=== SCREENSHOT ANALYSIS ===", the system took a screenshot because the DOM reader couldn't understand the page. The screenshot description tells you WHAT is on the page; the grid scan refs tell you HOW to interact. Always use grid scan refs for actions, never try to click by coordinates.

You can respond in three ways:

1. ACTIONS — to interact with the page:
\`\`\`json
{
  "actions": [
    {"type": "fill", "ref": 7, "value": "white socks", "tabUrl": "google.com"},
    {"type": "click", "ref": 3, "tabUrl": "google.com"},
    {"type": "openTab", "url": "https://www.ticketmaster.com/search?q=LA+Kings"}
  ],
  "message": "Searching for white socks now.",
  "complete": false
}
\`\`\`

2. PROPOSAL — when you need approval before a write action (purchase, send):
\`\`\`json
{
  "proposal": true,
  "actions": [
    {"type": "click", "ref": 15, "tabUrl": "amazon.com"}
  ],
  "message": "Found Hanes crew socks 6-pack for $12.99. Ready to purchase. Approve?",
  "complete": false
}
\`\`\`

3. COMPLETE — when the mission is done:
\`\`\`json
{
  "actions": [],
  "message": "Purchase complete. Order confirmed.",
  "complete": true
}
\`\`\`

ACTION TYPES:
- {"type": "click", "ref": N, "tabUrl": "domain.com"} — click an element
- {"type": "fill", "ref": N, "value": "text", "tabUrl": "domain.com"} — type into an input/textbox
- {"type": "key", "ref": N, "value": "Enter", "tabUrl": "domain.com"} — press a key (ref optional, defaults to active element)
- {"type": "scroll", "direction": "down", "tabUrl": "domain.com"} — scroll the page
- {"type": "readDOM", "tabUrl": "domain.com"} — re-read a tab's content
- {"type": "openTab", "url": "https://..."} — open a new tab
- {"type": "actOnTab", "tabUrl": "domain.com", "action": {"type": "click", "ref": N}} — act on a background tab
- {"type": "askUser", "question": "I can see a checkout page but can't find the total. What's the order total showing?"} — ask the user a specific question when you're stuck or need information you can't read from the page

RULES:
- Use "ref" to target elements. Pick the ref number from the ARIA snapshot above.
- Always wrap JSON in triple backticks
- ONLY use proposal: true for purchases (clicking buy/checkout/pay) and sending messages (clicking send/post/submit)
- Reads, searches, navigation, and opening tabs do NOT require proposals
- Adding to cart is NOT a purchase. Continue through checkout and send a proposal BEFORE the final purchase button.
- NEVER say a purchase is complete unless the order confirmation page is showing.
- CHECKOUT RULE: When you reach a checkout/payment page ("Place your order", "Review your order"), ALWAYS send a proposal with the item name, price, and delivery details visible on the page. Never ask clarifying questions or start over from a checkout page. The cart contents ARE the mission — propose the purchase.
- Never open a new tab or restart a search when you are already on a cart, checkout, or payment page. If unsure what's in the cart, use readDOM on the current page.
- When sending a proposal, be precise: "Click 'Place your order' to complete the $17.39 purchase"
- Only set complete: true when the order confirmation is showing, OR when reporting findings (non-purchase missions)
- Use openTab ONLY when visiting a site without an existing tab. Otherwise use fill/click/key with the existing tabUrl.
- NEVER use the navigate action. It is disabled.
- Keep messages short and direct
- Always include tabUrl in every action — use the domain (e.g. "google.com", "mail.google.com")
- When reporting findings, set complete: true with the summary in message. End with "→ See tab: [site name]".
- If you encounter a login wall, paywall, or captcha, set complete: true and tell the user which tab needs attention.
- Be efficient. Combine actions when possible. Aim for 5 steps or fewer.
- MISSION FOCUS: Only report findings that directly relate to the current mission. If the target page is unreadable or hostile, report THAT failure honestly — do NOT pivot to an unrelated open tab and report its content instead. Stay on mission or explain what's blocking you.
- SEARCH FIRST: When the user asks for a specific product, item, or page by name, use the site's search bar with the exact name. Do NOT try to find it by clicking through existing results or browsing. Search is always faster and more reliable than scrolling through a results page.
- When a search results page has hundreds of refs, do NOT guess which ref is the right product link. Instead, use readDOM or scroll to find the exact item, then click its specific link.
- For background tab actions: {"type":"actOnTab","tabUrl":"mail.google.com","action":{"type":"click","ref":N}}
- Canonical action types only: fill, click, key, scroll, readDOM, openTab, actOnTab, askUser.
- Never return step-by-step instructions. You are the executor: output JSON only.
- For summarize/report tasks, run readDOM on the relevant tab first, then return complete with findings.
- Never navigate to or re-open a URL you have already visited in this mission. If you already ran readDOM on a page, you have its content — synthesize and complete.
- After running readDOM, your next response should be complete: true with your findings unless you genuinely need to navigate to a DIFFERENT page. Re-reading the same page is almost never correct.
- USE askUser WHEN: you can't read the page reliably (perception warning), you hit a CAPTCHA/2FA, you need clarification on which item or option to pick, or you've tried 2+ approaches and are still stuck. Ask a SPECIFIC question — not "I'm stuck" but "I see 3 products matching 'white socks' — which one: Hanes 6-pack ($12.99), Nike 3-pack ($15.99), or Fruit of the Loom 10-pack ($9.99)?" The askUser action pauses the loop until the user responds, then you continue with their answer.`;

}

function waitForPageSettle(tabId, timeout = 8000) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => new Promise((res) => {
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            res('settled');
          }, 500);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          res('settled');
        }, 500);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      })
    }).then(() => resolve('settled')).catch(() => resolve('error'));
    setTimeout(() => resolve('timeout'), timeout);
  });
}

// ============================================================
// ACTION EXECUTOR
// Sends actions to the target tab's content script
// ============================================================

async function executeActions(actions, fallbackTabId) {
  async function executeSingleAction(targetTabId, action) {
    try {
      const result = await chrome.tabs.sendMessage(targetTabId, {
        type: 'EXECUTE_ACTION',
        action
      });
      return { ...(result || {}), targetTabId, action };
    } catch (err) {
      console.warn('[UD] No content script on tab, injecting...', err.message);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['content/content.js']
        });
        const result = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_ACTION',
          action
        });
        return { ...(result || {}), targetTabId, action };
      } catch (retryErr) {
        console.error('[UD] executeActions error after inject:', retryErr.message, action);
        return { success: false, error: retryErr.message, targetTabId, action };
      }
    }
  }

  const results = [];
  const allTabs = await chrome.tabs.query({});

  for (const action of actions) {
    // Find target tab by tabUrl substring, fall back to fallbackTabId
    let targetTabId = fallbackTabId;
    if (action.tabUrl) {
      const match = allTabs.find(t => t.url && t.url.includes(action.tabUrl));
      if (match) targetTabId = match.id;
    }

    let hostname = null;
    const targetTab = allTabs.find((t) => t.id === targetTabId);
    if (targetTab?.url) {
      try { hostname = new URL(targetTab.url).hostname; } catch {}
    }

    const candidateActions = [];
    if (hostname && (action.type === 'fill' || action.type === 'click')) {
      const memory = await getSiteMemoryEntries(hostname);
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const cachedSelectors = Object.entries(memory)
        .filter(([selector, meta]) =>
          selector &&
          selector !== action.selector &&
          meta &&
          meta.type === action.type &&
          Number(meta.lastVerified || 0) > thirtyDaysAgo
        )
        .sort((a, b) => {
          const scoreA = (a[1].successCount || 0) * 1000 + (a[1].lastVerified || 0);
          const scoreB = (b[1].successCount || 0) * 1000 + (b[1].lastVerified || 0);
          return scoreB - scoreA;
        })
        .map(([selector]) => selector)
        .slice(0, 5);

      for (const selector of cachedSelectors) {
        candidateActions.push({ ...action, selector });
      }
    }
    candidateActions.push(action);

    let finalResult = null;
    for (const candidate of candidateActions) {
      const attempt = await executeSingleAction(targetTabId, candidate);
      if (attempt?.success) {
        finalResult = attempt;
        break;
      }
      finalResult = attempt;
    }

    results.push(finalResult || { success: false, error: 'Action not attempted', targetTabId, action });
  }
  return results;
}

function normalizeOpenTabUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const value = rawUrl.trim().toLowerCase();
  if (!value) return null;

  // Common shorthand intents from model output.
  if (value === 'gmail' || value === 'open gmail' || value === 'mail') {
    return 'https://mail.google.com';
  }

  let candidate = rawUrl.trim();
  if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

async function runAgenticLoop(session, activeTab, openTabs, maxSteps = 20) {
  function trimHistory() {
    if (session.history.length > 8) {
      session.history = [session.history[0], ...session.history.slice(-6)];
    }
  }

  let steps = 0;
  let jsonRecoveryUsed = false;
  let sendActionExecuted = false;
  let gmailSendConfirmed = false;
  let consecutiveFailedSteps = 0;
  let lastFailedAction = null;
  let lastFailedTabUrl = null;
  let recentIntents = []; // track last N step intents for repetition detection
  let stuckAskCount = 0; // track askUser attempts for action failures (separate from perception)
  let previousSnapshot = null;
  let previousUrl = null;
  let consecutiveLowConfidence = 0;
  let perceptionAskCount = 0; // track how many times we've asked user about perception
  let screenshotAttempted = false; // track whether we've tried screenshot fallback this mission

  while (steps < maxSteps) {
    steps++;
    let stepHadClickFillSuccess = false;
    let stepClickFillAttempted = false;
    let stepLastFailedAction = null;
    let stepLastFailedTabUrl = null;

    // Refresh activeTab metadata — URL/title change after navigation
    // but the original object passed to runAgenticLoop is never updated.
    try {
      const freshTab = await chrome.tabs.get(activeTab.id);
      activeTab = freshTab;
      // If the tab is still loading (e.g. after a navigation), wait for it
      if (freshTab.status === 'loading') {
        await new Promise((resolve) => {
          const onUpdated = (tabId, info) => {
            if (tabId === activeTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }, 10000); // 10s max wait
        });
        // Re-fetch tab info after load completes (URL may have changed again)
        try {
          const loadedTab = await chrome.tabs.get(activeTab.id);
          activeTab = loadedTab;
        } catch {}
        // Brief settle after load
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}

    const pageContext = await getTabContext(activeTab.id);
    if (isAuthWall(pageContext)) {
      // Instead of hard-stopping, ask the user to handle the auth wall
      // and resume when they're done. Only hard-stop if we've already
      // asked and they came back but the wall is still there.
      const question = buildAuthWallQuestion(pageContext, activeTab.url);
      session.status = 'awaiting_user_answer';
      session.pendingQuestion = question;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_user_answer',
        message: question
      }).catch(() => {});
      console.log(`[UD] Auth wall detected — asking user: "${question}"`);
      return { status: 'awaiting_user_answer', message: question };
    }
    const freshTabs = await chrome.tabs.query({});
    const currentOpenTabs = freshTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    // ── Perception confidence signal ──
    const currentUrl = activeTab.url;
    const perception = assessPerceptionConfidence(pageContext, session.mission, previousSnapshot, previousUrl, currentUrl);
    previousSnapshot = pageContext;
    previousUrl = currentUrl;

    console.log(`[UD] Step ${steps} perception: confidence=${perception.confidence}, refs=${perception.refCount}, issues=${perception.issues.length}`);
    if (perception.issues.length > 0) {
      console.log(`[UD] Perception issues:`, perception.issues.map(i => `${i.severity}:${i.signal}`).join(', '));
    }

    // Recovery: if stale snapshot detected, re-inject content script and retry once
    let effectivePageContext = pageContext;
    const hasStale = perception.issues.some(i => i.signal === 'stale_snapshot');
    if (hasStale) {
      console.log(`[UD] Stale snapshot detected — re-injecting content script and retrying.`);
      try {
        await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content/content.js'] });
        await waitForPageSettle(activeTab.id);
        const retryContext = await getTabContext(activeTab.id);
        const retryPerception = assessPerceptionConfidence(retryContext, session.mission, previousSnapshot, previousUrl, currentUrl);
        if (retryPerception.confidence !== 'low') {
          console.log(`[UD] Stale recovery succeeded: confidence=${retryPerception.confidence}, refs=${retryPerception.refCount}`);
          Object.assign(perception, retryPerception);
          previousSnapshot = retryContext;
          effectivePageContext = retryContext; // use fresh snapshot for AI
        }
      } catch (e) {
        console.warn(`[UD] Stale recovery failed:`, e.message);
      }
    }

    // Track consecutive low-confidence reads for auto-escalation
    if (perception.confidence === 'low') {
      consecutiveLowConfidence++;
    } else {
      consecutiveLowConfidence = 0;
      // If perception recovered (e.g. after user's answer helped), reset ask budget
      if (perception.confidence === 'high') perceptionAskCount = 0;
    }

    // Auto-escalate: 2+ consecutive low-confidence reads
    // Escalation ladder (4 tiers):
    //   0. Screenshot fallback — capture tab, vision analysis + grid scan (once per mission)
    //   1. askUser — specific perception question (if screenshot didn't help)
    //   2. askUser again — different question if still broken
    //   3. needs_help / Show Me — user physically demonstrates
    if (consecutiveLowConfidence >= 2) {

      // STEP 0: Try screenshot fallback (once per mission)
      if (!screenshotAttempted) {
        screenshotAttempted = true;
        console.log(`[UD] Low confidence ${consecutiveLowConfidence}x — trying screenshot fallback (Layer 3)...`);
        try {
          const fallbackResult = await screenshotFallback(activeTab.id, session.mission, effectivePageContext);
          if (fallbackResult && (fallbackResult.gridElements > 0 || fallbackResult.visionAnalysis)) {
            // Screenshot worked — inject combined perception and continue the loop
            console.log(`[UD] Screenshot fallback succeeded: ${fallbackResult.gridElements} grid elements, vision=${fallbackResult.visionAnalysis?.length || 0} chars`);
            effectivePageContext = fallbackResult.perception;
            consecutiveLowConfidence = 0; // reset since we have fresh perception
            // Inject the screenshot perception into conversation history
            session.history.push({
              role: 'user',
              content: `The DOM reader couldn't understand this page, so I took a screenshot and ran a grid scan. Here's what I found:\n\n${fallbackResult.perception}\n\nUse the ref numbers from the grid scan to interact with the page. Continue with the mission.`
            });
            trimHistory();
            await saveSession(session);
            continue; // re-enter loop with screenshot perception
          }
        } catch (screenshotErr) {
          console.error(`[UD] Screenshot fallback error:`, screenshotErr.message);
        }
        console.log(`[UD] Screenshot fallback didn't help — proceeding to askUser ladder.`);
      }

      // STEP 1-2: askUser ladder (after screenshot failed or already attempted)
      if (perceptionAskCount < 2) {
        perceptionAskCount++;
        const question = buildPerceptionQuestion(perception, session.mission, currentUrl);
        session.status = 'awaiting_user_answer';
        session.pendingQuestion = question;
        await saveSession(session);
        chrome.runtime.sendMessage({
          type: 'STATUS_UPDATE',
          status: 'awaiting_user_answer',
          message: question
        }).catch(() => {});
        console.log(`[UD] Perception askUser (attempt ${perceptionAskCount}): "${question}"`);
        return { status: 'awaiting_user_answer', message: question };
      } else {
        // STEP 3: User already answered but perception is still broken → Show Me
        const issueList = perception.issues.map(i => i.detail).join(' ');
        session.status = 'needs_help';
        session.stuckContext = {
          failedAction: null,
          targetTabUrl: currentUrl,
          targetTabHostname: (() => { try { return new URL(currentUrl).hostname; } catch { return 'the page'; } })(),
          intent: 'read the page (perception still broken after screenshot + asking)',
          stepNumber: steps,
          activeTabId: activeTab.id
        };
        await saveSession(session);
        const helpMessage = `I still can't read this page even after taking a screenshot and asking you. ${issueList} Can you show me the element I need to interact with?`;
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'needs_help', message: helpMessage }).catch(() => {});
        console.log(`[UD] Perception escalation to Show Me after screenshot + ${perceptionAskCount} askUser attempts.`);
        return { status: 'needs_help', message: helpMessage };
      }
    }

    // Inject perception warning into page context for the AI
    const perceptionWarning = buildPerceptionWarning(perception);
    const augmentedPageContext = perceptionWarning ? effectivePageContext + perceptionWarning : effectivePageContext;

    const systemPrompt = await buildSystemPrompt(session.mission, augmentedPageContext, currentOpenTabs, activeTab.url);

    const historyText = JSON.stringify(session.history);
    if (historyText.length > 400000) {
      session.history = [session.history[0], ...session.history.slice(-4)];
    }

    const responseText = await askClaude(session.history, systemPrompt, HAIKU_MODEL);
    let parsed = parseAgentResponse(responseText);
    parsed.actions = normalizeActions(parsed.actions || []);
    session.history.push({ role: 'assistant', content: responseText });
    trimHistory();
    console.log(`[UD] Loop step ${steps}:`, JSON.stringify(parsed));

    if (!parsed.hadJson && !jsonRecoveryUsed) {
      jsonRecoveryUsed = true;
      session.history.push({
        role: 'user',
        content: 'Your last response did not include valid JSON actions. Do not give instructions to the user. Return only a JSON block with executable actions, proposal, or complete.'
      });
      trimHistory();
      await saveSession(session);
      continue;
    }

    // Proposal — stop and ask user
    if (parsed.proposal) {
      session.status = 'awaiting_approval';
      session.pendingActions = parsed.actions;
      session.proposalText = parsed.message;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_approval',
        message: parsed.message
      }).catch(() => {});
      return { status: 'awaiting_approval', message: parsed.message };
    }

    // askUser — AI needs user input to continue
    const askUserAction = (parsed.actions || []).find(a => a.type === 'askUser');
    if (askUserAction) {
      const question = askUserAction.question || parsed.message || 'I need your help to continue.';
      session.status = 'awaiting_user_answer';
      session.pendingQuestion = question;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_user_answer',
        message: question
      }).catch(() => {});
      console.log(`[UD] askUser: "${question}"`);
      return { status: 'awaiting_user_answer', message: question };
    }

    // Execute actions
    if (parsed.actions?.length > 0) {
      for (const action of parsed.actions) {
        if (action.type === 'openTab') {
          const normalizedUrl = normalizeOpenTabUrl(action.url);
          if (!normalizedUrl) {
            session.history.push({
              role: 'user',
              content: `Action failed:\nopenTab("${action.url}") is not a valid URL.\nUse a full URL or valid domain and try again.`
            });
            trimHistory();
            await saveSession(session);
            continue;
          }

          const newTab = await chrome.tabs.create({ url: normalizedUrl, active: false, selected: false });
          await new Promise(resolve => {
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === newTab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
            setTimeout(resolve, 5000);
          });
          // Read the new tab's content immediately and inject into history
          const newTabContext = await getTabContextById(newTab.id);
          if (newTabContext) {
            session.history.push({
              role: 'user',
              content: `New tab loaded: "${newTabContext.title}" (${newTabContext.url})\n\nPage content:\n${newTabContext.body}`
            });
            trimHistory();
            await saveSession(session);
          }
        }
      }

      const actOnTabActions = parsed.actions.filter((a) => a.type === 'actOnTab');
      if (actOnTabActions.length > 0) {
        for (const action of actOnTabActions) {
          const validation = validateActOnTabAction(action);
          if (!validation.valid) {
            session.history.push({
              role: 'user',
              content: `Action failed:\nactOnTab(${JSON.stringify(action)}): ${validation.error}`
            });
            trimHistory();
            continue;
          }
          const innerType = action.action?.type;
          if (innerType === 'click' || innerType === 'fill') stepClickFillAttempted = true;

          const tabResult = await actOnBackgroundTab(action);
          if (!tabResult?.success) {
            session.history.push({
              role: 'user',
              content: `Action failed:\nactOnTab(${JSON.stringify(action)}): ${tabResult?.error || 'unknown error'}`
            });
            trimHistory();
            if (innerType === 'click' || innerType === 'fill') {
              stepLastFailedAction = action.action;
              stepLastFailedTabUrl = action.tabUrl;
            }
          } else {
            if (innerType === 'click' || innerType === 'fill') stepHadClickFillSuccess = true;
            if (isSendLikeAction(action.action)) sendActionExecuted = true;
          }
        }

        // Refresh context for all tabs touched by actOnTab actions
        const actOnTabTouchedIds = new Set();
        for (const action of actOnTabActions) {
          const matchKey = action.tabUrl || action.url;
          if (matchKey) {
            const allTabsNow = await chrome.tabs.query({});
            const matchedTab = allTabsNow.find(t => t.url && t.url.includes(matchKey));
            if (matchedTab) actOnTabTouchedIds.add(matchedTab.id);
          }
        }
        for (const tabId of actOnTabTouchedIds) {
          await waitForPageSettle(tabId);
          // Extra delay for Gmail compose animation
          try {
            const t = await chrome.tabs.get(tabId);
            if (t?.url?.includes('mail.google.com')) await new Promise(r => setTimeout(r, 1500));
          } catch {}
          const tabContext = await getTabContextById(tabId);
          if (tabContext) {
            console.log(`[UD] actOnTab context for ${tabContext.url} (${tabContext.body?.split('\n').length} lines, first 500 chars):`, tabContext.body?.slice(0, 500));
            session.history.push({
              role: 'user',
              content: `Tab updated: "${tabContext.title}" (${tabContext.url})\n\nPage content:\n${tabContext.body}`
            });
            trimHistory();
          }
        }
      }

      // Execute non-openTab/non-actOnTab actions
      const regularActions = parsed.actions.filter(a => a.type !== 'openTab' && a.type !== 'actOnTab');
      if (regularActions.length > 0) {
        // Track click/fill attempts
        for (const a of regularActions) {
          if (a.type === 'click' || a.type === 'fill') stepClickFillAttempted = true;
        }

        const actionResults = await executeActions(regularActions, activeTab.id);
        const failures = actionResults.filter((r) => !r?.success);
        if (failures.length > 0) {
          const lines = failures.map((f) => `${f?.action?.type || 'action'}(${f?.action?.selector || 'unknown'}): ${f?.error || 'failed'}`);
          session.history.push({
            role: 'user',
            content: `Action failed:\n${lines.join('\n')}\nUse a different selector/approach and try again.`
          });
          trimHistory();
        }

        // Track click/fill success/failure for stuck detection
        for (let i = 0; i < regularActions.length; i++) {
          const aType = regularActions[i]?.type;
          if (aType === 'click' || aType === 'fill') {
            if (actionResults[i]?.success) {
              stepHadClickFillSuccess = true;
            } else {
              stepLastFailedAction = regularActions[i];
              stepLastFailedTabUrl = regularActions[i]?.tabUrl;
            }
          }
        }

        const sendSucceeded = actionResults.some((r, i) => r?.success && isSendLikeAction(regularActions[i]));
        if (sendSucceeded) sendActionExecuted = true;

        const touchedTabIds = [...new Set(
          actionResults.map((r) => r?.targetTabId).filter((id) => Number.isInteger(id))
        )];
        for (const tabId of touchedTabIds) {
          await waitForPageSettle(tabId);
          // Extra delay for Gmail compose animation
          try {
            const t = await chrome.tabs.get(tabId);
            if (t?.url?.includes('mail.google.com')) await new Promise(r => setTimeout(r, 1500));
          } catch {}
          const tabContext = await getTabContextById(tabId);
          if (!tabContext) continue;
          console.log(`[UD] Tab context for ${tabContext.url} (${tabContext.body?.split('\n').length} lines, first 500 chars):`, tabContext.body?.slice(0, 500));
          console.log(`[UD] Tab context TAIL (last 500 chars):`, tabContext.body?.slice(-500));
          // Diagnostic: check why compose fields might be missing from ARIA snapshot
          if (tabContext.url?.includes('mail.google.com')) {
            try {
              const diag = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const checks = [
                    { label: 'To input', sel: 'input[aria-label*="To"]' },
                    { label: 'To input (name)', sel: 'input[name="to"]' },
                    { label: 'Subject input', sel: 'input[name="subjectbox"]' },
                    { label: 'Subject (aria)', sel: 'input[aria-label="Subject"]' },
                    { label: 'Body textbox', sel: 'div[role="textbox"][aria-label*="Body"]' },
                    { label: 'Body contenteditable', sel: 'div[contenteditable="true"][aria-label*="Body"]' },
                    { label: 'Body any contenteditable', sel: 'div[contenteditable="true"][role="textbox"]' },
                    { label: 'Send button', sel: 'div[role="button"][aria-label="Send"]' },
                    { label: 'Send button (data)', sel: '[data-tooltip="Send"]' },
                    { label: 'Compose dialog', sel: 'div[role="dialog"]' },
                    { label: 'Any combobox', sel: '[role="combobox"]' },
                  ];
                  const results = [];
                  for (const c of checks) {
                    const el = document.querySelector(c.sel);
                    if (!el) {
                      results.push(`${c.label}: NOT FOUND`);
                      continue;
                    }
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    // Walk ancestors checking display/visibility
                    let hiddenAncestor = null;
                    let current = el.parentElement;
                    while (current && current !== document.body) {
                      const cs = window.getComputedStyle(current);
                      if (cs.display === 'none') { hiddenAncestor = `display:none on <${current.tagName} class="${(current.className||"").toString().slice(0,50)}">`; break; }
                      if (cs.visibility === 'hidden') { hiddenAncestor = `visibility:hidden on <${current.tagName} class="${(current.className||"").toString().slice(0,50)}">`; break; }
                      current = current.parentElement;
                    }
                    results.push(`${c.label}: FOUND tag=${el.tagName} display=${style.display} vis=${style.visibility} rect=${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)} offsetParent=${el.offsetParent?.tagName||'NULL'} hiddenAncestor=${hiddenAncestor||'none'}`);
                  }
                  return results;
                }
              });
              console.log('[UD] Gmail compose diagnostic:', diag?.[0]?.result);
            } catch (e) {
              console.warn('[UD] Gmail diagnostic failed:', e.message);
            }
          }
          session.history.push({
            role: 'user',
            content: `Tab updated: "${tabContext.title}" (${tabContext.url})\n\nPage content:\n${tabContext.body}`
          });
          trimHistory();
        }
      }
      if (sendActionExecuted && isLikelyGmailMission(session.mission, currentOpenTabs)) {
        gmailSendConfirmed = await hasStrongGmailSendConfirmation();
      }
    }

    // ── Stuck detection ──
    // If all click/fill attempts failed for 2 consecutive steps, escalate to "Show Me".
    if (stepClickFillAttempted) {
      if (stepHadClickFillSuccess) {
        consecutiveFailedSteps = 0;
        lastFailedAction = null;
        lastFailedTabUrl = null;
        stuckAskCount = 0; // reset ask budget on success
      } else {
        consecutiveFailedSteps++;
        lastFailedAction = stepLastFailedAction;
        lastFailedTabUrl = stepLastFailedTabUrl;
      }

      if (consecutiveFailedSteps >= 2) {
          // Build a human-readable description of what we're stuck on
          const intent = lastFailedAction
            ? `${lastFailedAction.type} '${lastFailedAction.ariaLabel || lastFailedAction.text || lastFailedAction.selector || 'an element'}'`
            : 'an action';

          // Determine the target tab
          let stuckTabUrl = lastFailedTabUrl || activeTab.url;
          let stuckTabHostname = 'the page';
          try { stuckTabHostname = new URL(stuckTabUrl).hostname; } catch {}

          // Escalation ladder: askUser first, Show Me second
          if (stuckAskCount < 1) {
            stuckAskCount++;
            const question = `I'm trying to ${intent} on ${stuckTabHostname} but it keeps failing. Can you tell me what you see in that area of the page? Is the element visible, or is there a popup/dialog blocking it?`;
            session.status = 'awaiting_user_answer';
            session.pendingQuestion = question;
            await saveSession(session);
            chrome.runtime.sendMessage({
              type: 'STATUS_UPDATE',
              status: 'awaiting_user_answer',
              message: question
            }).catch(() => {});
            console.log(`[UD] Stuck askUser (attempt ${stuckAskCount}): "${question}"`);
            return { status: 'awaiting_user_answer', message: question };
          }

          // Already asked — escalate to Show Me
          session.status = 'needs_help';
          session.stuckContext = {
            failedAction: lastFailedAction,
            targetTabUrl: stuckTabUrl,
            targetTabHostname: stuckTabHostname,
            intent,
            stepNumber: steps,
            activeTabId: activeTab.id
          };
          await saveSession(session);

          const helpMessage = `I still can't ${intent} on ${stuckTabHostname} even after your help. Can you show me the element?`;
          chrome.runtime.sendMessage({
            type: 'STATUS_UPDATE',
            status: 'needs_help',
            message: helpMessage
          }).catch(() => {});

          console.log(`[UD] Stuck escalation to Show Me after ${stuckAskCount} askUser attempts.`, session.stuckContext);
          return { status: 'needs_help', message: helpMessage };
        }
    }

    // ── Repetition-based stuck detection ──
    // Even if individual actions "succeed" at the DOM level, detect when the
    // model keeps retrying the same logical intent across multiple steps.
    if (parsed.actions?.length > 0) {
      const clickFillActions = (parsed.actions || []).filter(a => {
        const t = a.type === 'actOnTab' ? a.action?.type : a.type;
        return t === 'click' || t === 'fill';
      });
      if (clickFillActions.length > 0) {
        // Build a normalized intent fingerprint from the target labels
        const intentParts = clickFillActions.map(a => {
          const inner = a.type === 'actOnTab' ? (a.action || {}) : a;
          return (inner.ariaLabel || inner.text || inner.name || '').toLowerCase().trim();
        }).filter(Boolean);
        // Deduplicate and take the primary target — avoids "compose" vs "compose|compose" mismatch
        const uniqueIntents = [...new Set(intentParts)].sort();
        const intentKey = uniqueIntents.join('|') || 'unknown';
        recentIntents.push(intentKey);
        if (recentIntents.length > 5) recentIntents.shift();

        // If any single intent appears 3+ times in the last 5 pushes, the model is spinning
        if (recentIntents.length >= 3) {
          const counts = {};
          for (const ri of recentIntents) { counts[ri] = (counts[ri] || 0) + 1; }
          const dominant = Object.entries(counts).find(([k, v]) => v >= 3 && k !== 'unknown');
          if (dominant) {
            const stuckAction = clickFillActions[0];
            const inner = stuckAction.type === 'actOnTab' ? (stuckAction.action || {}) : stuckAction;
            const intent = `${inner.type || 'click'} '${inner.ariaLabel || inner.text || inner.selector || 'an element'}'`;
            let stuckTabUrl = (stuckAction.type === 'actOnTab' ? stuckAction.tabUrl : inner.tabUrl) || activeTab.url;
            let stuckTabHostname = 'the page';
            try { stuckTabHostname = new URL(stuckTabUrl).hostname; } catch {}

            // Escalation ladder: askUser first, Show Me second
            if (stuckAskCount < 1) {
              stuckAskCount++;
              const question = `I keep trying to ${intent} on ${stuckTabHostname} (${dominant[1]} attempts) but it's not working. Is there something blocking the element? A popup, overlay, or cookie banner maybe? Describe what you see and I'll try a different approach.`;
              session.status = 'awaiting_user_answer';
              session.pendingQuestion = question;
              await saveSession(session);
              chrome.runtime.sendMessage({
                type: 'STATUS_UPDATE',
                status: 'awaiting_user_answer',
                message: question
              }).catch(() => {});
              console.log(`[UD] Repetition stuck askUser (attempt ${stuckAskCount}): intent "${dominant[0]}" appeared ${dominant[1]}x`);
              return { status: 'awaiting_user_answer', message: question };
            }

            // Already asked — escalate to Show Me
            session.status = 'needs_help';
            session.stuckContext = {
              failedAction: inner,
              targetTabUrl: stuckTabUrl,
              targetTabHostname: stuckTabHostname,
              intent,
              stepNumber: steps,
              activeTabId: activeTab.id
            };
            await saveSession(session);

            const helpMessage = `I still can't ${intent} on ${stuckTabHostname} even after your description. Can you show me the element directly?`;
            chrome.runtime.sendMessage({
              type: 'STATUS_UPDATE',
              status: 'needs_help',
              message: helpMessage
            }).catch(() => {});

            console.log(`[UD] Repetition stuck escalation to Show Me after ${stuckAskCount} askUser attempts.`);
            return { status: 'needs_help', message: helpMessage };
          }
        }
      }
    }

    // ── Human intervention intercept ──
    // If the AI says complete:true but its message mentions CAPTCHA,
    // login, 2FA, or other human-required steps, DON'T complete.
    // Instead, pause the loop and wait for the user to handle it.
    // The mission stays alive so "continue" resumes where we left off.
    if (parsed.complete && needsHumanIntervention(parsed.message)) {
      const question = parsed.message.includes('?')
        ? parsed.message  // AI already phrased it as a question
        : `${parsed.message} Once you've handled it, say "continue" and I'll pick up where I left off.`;
      session.status = 'awaiting_user_answer';
      session.pendingQuestion = question;
      // Do NOT clear mission — we want to resume
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_user_answer',
        message: question
      }).catch(() => {});
      console.log(`[UD] Human intervention detected in complete response — pausing instead of completing. Mission preserved: "${session.mission}"`);
      return { status: 'awaiting_user_answer', message: question };
    }

    // Complete — report back and stop
    if (parsed.complete) {
      // ── Mission bleed check ──
      // Prevent the AI from pivoting to an unrelated tab and calling it done.
      // If the completion message has zero keyword overlap with the mission,
      // reject it and force the AI back on track.
      if (!isMissionRelevant(session.mission, parsed.message)) {
        session.history.push({
          role: 'user',
          content: `Completion rejected: your response doesn't relate to the mission "${session.mission}". Do NOT report findings from unrelated tabs. Focus on the original mission. If the target page is unreadable, say so honestly and I'll help.`
        });
        trimHistory();
        await saveSession(session);
        console.log(`[UD] Mission bleed: rejected off-topic completion. Mission: "${session.mission}", Response: "${(parsed.message || '').slice(0, 150)}"`);
        continue;
      }
      if (isEmailSendMission(session.mission) && !sendActionExecuted) {
        session.history.push({
          role: 'user',
          content: 'Completion check failed: no successful Send action was executed yet. Continue until the email is actually sent.'
        });
        trimHistory();
        await saveSession(session);
        continue;
      }
      if (isEmailSendMission(session.mission) && isLikelyGmailMission(session.mission, currentOpenTabs) && !gmailSendConfirmed) {
        session.history.push({
          role: 'user',
          content: 'Completion check failed: Gmail send confirmation is missing. Confirm send toast/undo signal or Sent state before completing.'
        });
        trimHistory();
        await saveSession(session);
        continue;
      }
      session.status = 'idle';
      session.mission = null;
      await saveSession(session);
      const synthesized = await synthesizeWithSonnet(session, parsed.message, currentOpenTabs);
      return { status: 'idle', message: synthesized || parsed.message };
    }

    // No actions and not complete — model is thinking/reporting, we're done
    if (!parsed.actions || parsed.actions.length === 0) {
      // Mission bleed check on implicit completion too
      if (!isMissionRelevant(session.mission, parsed.message)) {
        session.history.push({
          role: 'user',
          content: `Your response doesn't relate to the mission "${session.mission}". Focus on the original mission. If the target page is unreadable, say so and I'll help.`
        });
        trimHistory();
        await saveSession(session);
        console.log(`[UD] Mission bleed (implicit exit): rejected off-topic response.`);
        continue;
      }
      session.status = 'idle';
      await saveSession(session);
      const synthesized = await synthesizeWithSonnet(session, parsed.message, currentOpenTabs);
      return { status: 'idle', message: synthesized || parsed.message };
    }

    // Wait for page to settle before next step
    await waitForPageSettle(activeTab.id);
    const hostname = new URL(activeTab.url).hostname;
    if (hostname.includes('mail.google.com')) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise(r => setTimeout(r, 2000));

    // Feed updated context back
    const updatedContext = await getTabContext(activeTab.id);
    session.history.push({
      role: 'user',
      content: `Page updated. Current context:\n${updatedContext}\n\nContinue the mission.`
    });
    trimHistory();
    await saveSession(session);
  }

  return { status: 'idle', message: 'Reached maximum steps.' };
}

async function actOnBackgroundTab(action) {
  const tabs = await chrome.tabs.query({});
  const matchKey = action.tabUrl || action.url;
  const target = tabs.find(t => t.url && matchKey && t.url.includes(matchKey));
  if (!target) return { success: false, error: `No tab found matching: ${matchKey || 'unknown target'}` };
  const innerAction = action.action && typeof action.action === 'object' ? action.action : action;

  // Route through content script message handler (supports both ref and selector)
  // This lets resolveRef() and findTarget() work with the ref registry.
  try {
    const result = await chrome.tabs.sendMessage(target.id, {
      type: 'EXECUTE_ACTION',
      action: innerAction
    });
    return { ...(result || {}), targetTabId: target.id };
  } catch {
    // Content script not loaded — inject and retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        files: ['content/content.js']
      });
      // If this is a ref-based action, we need a fresh snapshot on the newly-injected script
      if (innerAction.ref != null) {
        const snapshotType = SNAPSHOT_MODE === 'semantic' ? 'GET_SEMANTIC_SNAPSHOT' : 'GET_ARIA_SNAPSHOT';
        await chrome.tabs.sendMessage(target.id, { type: snapshotType });
      }
      const result = await chrome.tabs.sendMessage(target.id, {
        type: 'EXECUTE_ACTION',
        action: innerAction
      });
      return { ...(result || {}), targetTabId: target.id };
    } catch (retryErr) {
      console.warn('[UD] actOnBackgroundTab: content script route failed, falling back to inline script.', retryErr.message);
    }
  }

  // Fallback: inline script execution (selector-only, no ref support)
  const results = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: (innerAction) => {
      let el = null;
      if (innerAction.selector) {
        try { el = document.querySelector(innerAction.selector); } catch {}
      }
      // Fallback: try aria-label extracted from selector or context
      if (!el && innerAction.selector) {
        const ariaMatch = innerAction.selector.match(/aria-label=['"]([^'"]+)['"]/);
        const label = innerAction.ariaLabel || (ariaMatch && ariaMatch[1]);
        if (label) {
          el = document.querySelector(`[aria-label="${label}"]`);
        }
      }
      // Fallback: try visible text match for clickables
      if (!el && innerAction.text) {
        const target = String(innerAction.text).toLowerCase().trim();
        const clickables = document.querySelectorAll('button, a, [role="button"], [role="link"], div[role="button"]');
        for (const c of clickables) {
          if ((c.innerText || '').toLowerCase().trim() === target) { el = c; break; }
        }
        if (!el) {
          for (const c of clickables) {
            if ((c.innerText || '').toLowerCase().includes(target)) { el = c; break; }
          }
        }
      }
      if (!el) el = document.activeElement;
      if ((innerAction.type === 'fill' || innerAction.type === 'click') && !el) {
        return { success: false, error: `Selector not found: ${innerAction.selector}` };
      }
      if (innerAction.type === 'fill') {
        const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
          el.getAttribute('role') === 'textbox' ||
          el.isContentEditable;

        if (isContentEditable) {
          el.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          const inserted = document.execCommand('insertText', false, innerAction.value);
          if (!inserted) {
            el.textContent = innerAction.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          nativeValueSetter.call(el, innerAction.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { success: true };
      }
      if (innerAction.type === 'click') {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { success: true };
      }
      if (innerAction.type === 'key') {
        const key = innerAction.value || '';
        if (!el) return { success: false, error: 'No active element for key action' };
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        return { success: true };
      }
      if (innerAction.type === 'scroll') {
        const amount = Number(innerAction.amount || 500);
        const direction = innerAction.direction === 'up' ? -1 : 1;
        if (innerAction.selector && el) {
          el.scrollBy(0, direction * amount);
        } else {
          window.scrollBy(0, direction * amount);
        }
        return { success: true };
      }
      if (innerAction.type === 'readDOM') {
        return {
          success: true,
          url: window.location.href,
          title: document.title,
          body: document.body?.innerText?.slice(0, 3000) || ''
        };
      }
      return { success: false, error: `Unknown action type: ${innerAction.type}` };
    },
    args: [innerAction]
  });

  return { ...(results[0]?.result || { success: false, error: 'Script execution failed' }), targetTabId: target.id };
}

// ============================================================
// GET PAGE CONTEXT from a tab
// ============================================================

async function getTabContext(tabId) {
  const msgType = SNAPSHOT_MODE === 'semantic' ? 'GET_SEMANTIC_SNAPSHOT' : 'GET_ARIA_SNAPSHOT';
  // Prefer structured snapshot via content script message
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: msgType });
    if (result?.body) {
      return result.body;
    }
  } catch {
    // Content script not loaded — try injecting
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      });
      const result = await chrome.tabs.sendMessage(tabId, { type: msgType });
      if (result?.body) {
        return result.body;
      }
    } catch {}
  }
  // Fallback: raw innerText (shouldn't normally reach here)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: window.location.href,
        title: document.title,
        body: document.body.innerText.slice(0, 3000)
      })
    });
    return JSON.stringify(results[0]?.result || {});
  } catch {
    return 'Could not read page context.';
  }
}

async function getTabContextById(tabId) {
  const msgType = SNAPSHOT_MODE === 'semantic' ? 'GET_SEMANTIC_SNAPSHOT' : 'GET_ARIA_SNAPSHOT';
  // Prefer structured snapshot
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: msgType });
    if (result?.body) {
      return { url: result.url, title: result.title, body: result.body };
    }
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      });
      const result = await chrome.tabs.sendMessage(tabId, { type: msgType });
      if (result?.body) {
        return { url: result.url, title: result.title, body: result.body };
      }
    } catch {}
  }
  // Fallback
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: window.location.href,
        title: document.title,
        body: document.body.innerText.slice(0, 3000)
      })
    });
    return results[0]?.result || null;
  } catch {
    return null;
  }
}

// ============================================================
// PARSE AGENT RESPONSE
// Extracts JSON block from model text response
// ============================================================

function parseAgentResponse(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return { actions: [], message: text, complete: false, proposal: false, hadJson: false };
  try {
    const parsed = JSON.parse(match[1]);
    return { ...parsed, hadJson: true };
  } catch {
    return { actions: [], message: text, complete: false, proposal: false, hadJson: false };
  }
}

// ============================================================
// MULTI-TASK QUEUE SYSTEM (Phase 7)
// Parse numbered lists, run tasks sequentially, park & skip
// on blockers, generate batch report when done.
// ============================================================

/**
 * Detect whether user input is a numbered task list.
 * Matches patterns like "1. Do X" or "1) Do X" across 2+ lines.
 */
function isNumberedList(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  let numberedCount = 0;
  for (const line of lines) {
    if (/^\s*\d+[.)\-]\s+\S/.test(line)) numberedCount++;
  }
  return numberedCount >= 2 && numberedCount >= lines.length * 0.6;
}

/**
 * Parse a numbered list into a task queue array.
 */
function parseTaskQueue(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const tasks = [];
  let id = 0;
  for (const line of lines) {
    const match = line.match(/^\s*\d+[.)\-]\s+(.+)/);
    if (match) {
      id++;
      tasks.push({
        id,
        mission: match[1].trim(),
        status: 'pending',
        result: null,
        error: null,
        savedHistory: null,
        parkedQuestion: null,
        parkedReason: null,
        startedAt: null,
        completedAt: null
      });
    }
  }
  return tasks;
}

/**
 * Send queue status update to panel for mission log rendering.
 */
function sendQueueUpdate(tasks, queueStatus = 'running') {
  chrome.runtime.sendMessage({
    type: 'QUEUE_UPDATE',
    tasks: tasks.map(t => ({
      id: t.id,
      mission: t.mission,
      status: t.status,
      result: t.result,
      error: t.error,
      parkedQuestion: t.parkedQuestion
    })),
    queueStatus
  }).catch(() => {});
}

/**
 * Run a full task queue: iterate tasks sequentially, park on blockers,
 * circle back to parked tasks, generate batch report when done.
 */
async function runTaskQueue(tasks) {
  const MAX_API_CALLS = 100;
  let totalApiCalls = 0;

  async function runSingleTask(task, existingHistory = null) {
    task.status = 'running';
    task.startedAt = task.startedAt || Date.now();
    sendQueueUpdate(tasks);

    const taskSession = await getSession();
    taskSession.history = existingHistory || [];
    taskSession.mission = task.mission;
    taskSession.status = 'working';
    taskSession.pendingActions = [];
    taskSession.proposalText = null;
    taskSession.pendingQuestion = null;
    taskSession.stuckContext = null;

    if (!existingHistory || existingHistory.length === 0) {
      taskSession.history.push({ role: 'user', content: task.mission });
    }

    await saveSession(taskSession);

    chrome.runtime.sendMessage({
      type: 'STATUS_UPDATE',
      status: 'working',
      message: `Task ${task.id}: ${task.mission}`
    }).catch(() => {});

    const activeTab = await getActiveHttpTab();
    if (!activeTab) {
      return { result: { status: 'idle', message: 'No browser tab available to act on.' }, savedHistory: taskSession.history };
    }
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    const result = await runAgenticLoop(taskSession, activeTab, openTabs);
    totalApiCalls += 5;

    return { result, savedHistory: taskSession.history };
  }

  // ── PASS 1: Run all tasks sequentially ──
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (totalApiCalls >= MAX_API_CALLS) {
      task.status = 'failed';
      task.error = 'API call budget exceeded';
      continue;
    }

    const { result, savedHistory } = await runSingleTask(task);

    switch (result.status) {
      case 'idle':
        task.status = 'completed';
        task.result = result.message;
        task.completedAt = Date.now();
        break;

      case 'awaiting_user_answer':
        task.status = 'parked';
        task.parkedQuestion = result.message;
        task.parkedReason = 'needs_user';
        task.savedHistory = savedHistory;
        break;

      case 'awaiting_approval':
        task.status = 'parked';
        task.parkedQuestion = result.message;
        task.parkedReason = 'approval';
        task.savedHistory = savedHistory;
        break;

      case 'needs_help':
        task.status = 'parked';
        task.parkedQuestion = result.message;
        task.parkedReason = 'needs_help';
        task.savedHistory = savedHistory;
        break;

      default:
        task.status = 'failed';
        task.error = result.message || 'Unknown status';
        break;
    }

    sendQueueUpdate(tasks);
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Check if any tasks are parked ──
  const parkedTasks = tasks.filter(t => t.status === 'parked');
  if (parkedTasks.length > 0) {
    const session = await getSession();
    session.queue = { tasks, startedAt: Date.now() };
    session.status = 'awaiting_user_answer';
    session.pendingQuestion = parkedTasks[0].parkedQuestion;
    await saveSession(session);
    sendQueueUpdate(tasks, 'parked_waiting');
    return { tasks, waitingForUser: true };
  }

  // ── All tasks resolved — generate batch report ──
  const report = generateBatchReport(tasks);
  sendQueueUpdate(tasks, 'completed');

  const session = await getSession();
  session.queue = null;
  session.status = 'idle';
  session.mission = null;
  await saveSession(session);

  return { tasks, report, waitingForUser: false };
}

/**
 * Resume parked tasks after user has taken action.
 */
async function resumeParkedTasks(tasks, userAnswer) {
  const parked = tasks.filter(t => t.status === 'parked');
  if (parked.length === 0) return { tasks, waitingForUser: false };

  const task = parked[0];
  const history = task.savedHistory || [];
  const injectedContent = task.parkedQuestion
    ? `System asked the user: "${task.parkedQuestion}"\nUser replied: ${userAnswer}`
    : `User response: ${userAnswer}`;
  history.push({ role: 'user', content: injectedContent });

  if (task.parkedReason === 'approval') {
    const isApproved = /^(yes|approve|ok|go|do it|confirmed|proceed)/i.test(userAnswer.trim());
    if (isApproved) {
      const session = await getSession();
      if (session.pendingActions?.length > 0) {
        const activeTab = await getActiveHttpTab();
        if (activeTab) await executeActions(session.pendingActions, activeTab.id);
      }
      task.status = 'completed';
      task.result = 'Approved and executed.';
      task.completedAt = Date.now();
    } else {
      task.status = 'failed';
      task.error = `Declined: ${userAnswer}`;
      task.completedAt = Date.now();
    }
  } else {
    task.status = 'running';
    sendQueueUpdate(tasks);

    const taskSession = await getSession();
    taskSession.history = history;
    taskSession.mission = task.mission;
    taskSession.status = 'working';
    taskSession.pendingQuestion = null;
    taskSession.stuckContext = null;
    await saveSession(taskSession);

    const activeTab = await getActiveHttpTab();
    if (!activeTab) {
      task.status = 'failed';
      task.error = 'No browser tab available.';
      task.completedAt = Date.now();
    } else {
      const allTabs = await chrome.tabs.query({});
      const openTabs = allTabs
        .filter(t => t.url && t.url.startsWith('http'))
        .map(t => ({ title: t.title, url: t.url }));

      const result = await runAgenticLoop(taskSession, activeTab, openTabs);

      if (result.status === 'idle') {
        task.status = 'completed';
        task.result = result.message;
        task.completedAt = Date.now();
      } else {
        task.status = 'failed';
        task.error = result.message || 'Still blocked after user help';
        task.completedAt = Date.now();
      }
    }
  }

  sendQueueUpdate(tasks);

  const stillParked = tasks.filter(t => t.status === 'parked');
  if (stillParked.length > 0) {
    const session = await getSession();
    session.queue = { tasks, startedAt: session.queue?.startedAt || Date.now() };
    session.status = 'awaiting_user_answer';
    session.pendingQuestion = stillParked[0].parkedQuestion;
    await saveSession(session);
    sendQueueUpdate(tasks, 'parked_waiting');
    return { tasks, waitingForUser: true };
  }

  const report = generateBatchReport(tasks);
  sendQueueUpdate(tasks, 'completed');

  const session = await getSession();
  session.queue = null;
  session.status = 'idle';
  session.mission = null;
  await saveSession(session);

  return { tasks, report, waitingForUser: false };
}

/**
 * Generate an HTML batch report summarizing all task results.
 */
function generateBatchReport(tasks) {
  const now = new Date();
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;
  const parkedCount = tasks.filter(t => t.status === 'parked').length;

  const statusEmoji = (status) => {
    switch (status) {
      case 'completed': return '\u2705';
      case 'failed': return '\u274c';
      case 'parked': return '\u23f8\ufe0f';
      default: return '\u2b55';
    }
  };

  const taskRows = tasks.map(t => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #222;color:#888;">${t.id}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #222;">
        <span style="font-size:16px;margin-right:6px;">${statusEmoji(t.status)}</span>
        ${escapeHtml(t.mission)}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #222;color:${t.status === 'completed' ? '#4ade80' : t.status === 'failed' ? '#f87171' : '#fbbf24'};">
        ${t.status.charAt(0).toUpperCase() + t.status.slice(1)}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #222;color:#ccc;font-size:13px;">
        ${escapeHtml(t.result || t.error || t.parkedQuestion || '\u2014')}
      </td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Presence \u2014 Batch Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0e0e; color: #f0f0f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 24px; }
  .summary { display: flex; gap: 24px; margin-bottom: 32px; }
  .stat { background: #1a1a1a; border-radius: 8px; padding: 16px 24px; text-align: center; }
  .stat .num { font-size: 32px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; overflow: hidden; }
  th { padding: 12px; text-align: left; background: #222; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
</style></head><body>
  <h1>\u2b07\ufe0f Presence \u2014 Batch Report</h1>
  <div class="meta">${now.toLocaleString()} \u2014 ${tasks.length} tasks</div>
  <div class="summary">
    <div class="stat"><div class="num" style="color:#4ade80;">${completedCount}</div><div class="label">Completed</div></div>
    <div class="stat"><div class="num" style="color:#f87171;">${failedCount}</div><div class="label">Failed</div></div>
    <div class="stat"><div class="num" style="color:#fbbf24;">${parkedCount}</div><div class="label">Parked</div></div>
  </div>
  <table>
    <tr><th>#</th><th>Task</th><th>Status</th><th>Result</th></tr>
    ${taskRows}
  </table>
</body></html>`;

  return html;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openBatchReport(html) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  await chrome.tabs.create({ url, active: true });
}

// ============================================================
// MAIN MESSAGE HANDLER
// Receives messages from panel.js
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  const session = await getSession();

  // --- Save API key ---
  if (message.type === 'SET_API_KEY') {
    await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: message.key });
    return { success: true };
  }

  // --- Get current status ---
  if (message.type === 'GET_STATUS') {
    return session;
  }

  if (message.type === 'MARK_NOTIFICATION_READ') {
    markNotificationRead(message.notificationId);
    return { success: true };
  }

  if (message.type === 'SCORE_NOTIFICATION') {
    scoreNotification(message.notificationId, message.outcome, message.gradeReason);
    return { success: true };
  }

  if (message.type === 'PLATFORM_MEMORIES_SCRAPED') {
    try {
      const result = await syncPlatformMemories(message);
      return result;
    } catch (err) {
      console.error('[PLATFORM_MEMORIES] sync failed:', err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  if (message.type === 'SET_REALTIME_ACTIVE') {
    // Do not coerce undefined/null to false on startup or malformed callers.
    // If no explicit boolean is provided, preserve DB state by reading it.
    if (typeof message.active !== 'boolean') {
      return await getRealtimeActive();
    }
    return await setRealtimeActive(message.active);
  }

  if (message.type === 'GET_REALTIME_ACTIVE') {
    return await getRealtimeActive();
  }

  if (message.type === 'HEARTH_CONVERSE') {
    const result = await hearthConverse(message.messages || []);
    chrome.runtime.sendMessage({
      type: 'HEARTH_CONVERSE_RESPONSE',
      result: result,
      requestId: message.requestId
    }).catch(() => {});
    return { success: true };
  }

  // --- User sends a new message or task ---
  if (message.type === 'USER_MESSAGE') {
    const text = message.text || '';

    // ── Queue detection: numbered list = multi-task queue ──
    if (isNumberedList(text)) {
      const tasks = parseTaskQueue(text);
      if (tasks.length > 0 && tasks.length <= 5) {
        console.log(`[UD] Queue detected: ${tasks.length} tasks`);
        session.status = 'working';
        session.mission = `Batch: ${tasks.length} tasks`;
        await saveSession(session);

        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'working', message: `Running ${tasks.length} tasks...` }).catch(() => {});
        sendQueueUpdate(tasks, 'running');

        const queueResult = await runTaskQueue(tasks);

        if (queueResult.waitingForUser) {
          // Some tasks parked — panel will show ask UI
          const parked = queueResult.tasks.filter(t => t.status === 'parked');
          return {
            status: 'awaiting_user_answer',
            message: parked[0]?.parkedQuestion || 'Some tasks need your help.',
            isQueue: true
          };
        }

        // All done — open batch report
        if (queueResult.report) {
          await openBatchReport(queueResult.report);
        }

        const completed = queueResult.tasks.filter(t => t.status === 'completed').length;
        const total = queueResult.tasks.length;
        return {
          status: 'idle',
          message: `Batch complete: ${completed}/${total} tasks done. See report tab for details.`,
          isQueue: true
        };
      } else if (tasks.length > 5) {
        return { status: 'idle', message: 'Max 5 tasks per batch. Split your list and try again.' };
      }
    }

    // ── Single task (existing flow) ──
    const activeTab = await getActiveHttpTab();
    if (!activeTab) return { status: 'idle', message: 'No browser tab available to act on.' };
    const pageContext = await getTabContext(activeTab.id);
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    session.history.push({ role: 'user', content: text });
    if (!session.mission) session.mission = text;
    session.status = 'working';
    await saveSession(session);

    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'working' }).catch(() => {});

    const result = await runAgenticLoop(session, activeTab, openTabs);
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab) {
      chrome.tabs.sendMessage(currentTab.id, {
        type: 'UD_STATUS_UPDATE',
        status: result.status,
        message: result.message
      }).catch(() => {});
    }
    return result;
  }

  // --- User approves a proposal ---
  if (message.type === 'APPROVE') {
    const activeTab = await getActiveHttpTab();
    if (session.pendingActions?.length > 0 && activeTab) {
      await executeActions(session.pendingActions, activeTab.id);
    }
    session.status = 'idle';
    session.pendingActions = [];
    session.proposalText = null;
    session.mission = null;
    await saveSession(session);
    return { success: true, message: 'Actions executed.' };
  }

  // --- User cancels an askUser question ---
  if (message.type === 'CANCEL_ASK') {
    session.status = 'idle';
    session.pendingQuestion = null;
    await saveSession(session);
    return { success: true, message: 'Cancelled.' };
  }

  // --- User answers an askUser question ---
  if (message.type === 'USER_ANSWER') {
    const answer = message.text || '';

    // ── Queue resume: if there's an active queue with parked tasks ──
    if (session.queue && session.queue.tasks) {
      const tasks = session.queue.tasks;
      const parked = tasks.filter(t => t.status === 'parked');
      if (parked.length > 0) {
        console.log(`[UD] Queue resume: answering parked task ${parked[0].id}`);
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'working', message: 'Resuming parked task...' }).catch(() => {});

        const queueResult = await resumeParkedTasks(tasks, answer);

        if (queueResult.waitingForUser) {
          const stillParked = queueResult.tasks.filter(t => t.status === 'parked');
          return {
            status: 'awaiting_user_answer',
            message: stillParked[0]?.parkedQuestion || 'Another task needs your help.',
            isQueue: true
          };
        }

        // All done — open batch report
        if (queueResult.report) {
          await openBatchReport(queueResult.report);
        }

        const completed = queueResult.tasks.filter(t => t.status === 'completed').length;
        const total = queueResult.tasks.length;
        return {
          status: 'idle',
          message: `Batch complete: ${completed}/${total} tasks done. See report tab for details.`,
          isQueue: true
        };
      }
    }

    // ── Single task answer (existing flow) ──
    const originalQuestion = session.pendingQuestion || '';
    const injectedContent = originalQuestion
      ? `System asked the user: "${originalQuestion}"
User replied: ${answer}`
      : `User response: ${answer}`;
    session.history.push({
      role: 'user',
      content: injectedContent
    });
    session.status = 'working';
    session.pendingQuestion = null;
    await saveSession(session);

    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'working', message: 'Got it, continuing...' }).catch(() => {});

    const activeTab = await getActiveHttpTab();
    if (!activeTab) return { status: 'idle', message: 'No browser tab available.' };
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    const result = await runAgenticLoop(session, activeTab, openTabs);
    return result;
  }

  // --- User declines with a note ---
  if (message.type === 'DECLINE') {
    session.pendingActions = [];
    session.proposalText = null;
    session.history.push({ role: 'user', content: `Declined. Note: ${message.note}` });
    session.status = 'working';
    await saveSession(session);

    const activeTab = await getActiveHttpTab();
    if (!activeTab) return { status: 'idle', message: 'No browser tab available.' };
    const pageContext = await getTabContext(activeTab.id);
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));
    const responseText = await askClaude(session.history, await buildSystemPrompt(session.mission, pageContext, openTabs, activeTab.url), HAIKU_MODEL);
    const parsed = parseAgentResponse(responseText);

    session.history.push({ role: 'assistant', content: responseText });

    if (parsed.proposal) {
      session.status = 'awaiting_approval';
      session.pendingActions = parsed.actions;
      session.proposalText = parsed.message;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_approval',
        message: parsed.message
      }).catch(() => {});
      return { status: 'awaiting_approval', message: parsed.message };
    }

    await saveSession(session);
    return { status: session.status, message: parsed.message };
  }

  // --- Clear session ---
  if (message.type === 'CLEAR') {
    await clearSession();
    return { success: true };
  }

  // --- Skip parked task in queue ---
  if (message.type === 'SKIP_PARKED_TASK') {
    if (session.queue && session.queue.tasks) {
      const tasks = session.queue.tasks;
      const parked = tasks.filter(t => t.status === 'parked');
      if (parked.length > 0) {
        parked[0].status = 'failed';
        parked[0].error = 'Skipped by user';
        parked[0].completedAt = Date.now();

        const stillParked = tasks.filter(t => t.status === 'parked');
        if (stillParked.length > 0) {
          session.pendingQuestion = stillParked[0].parkedQuestion;
          await saveSession(session);
          sendQueueUpdate(tasks, 'parked_waiting');
          return { status: 'awaiting_user_answer', message: stillParked[0].parkedQuestion, isQueue: true };
        }

        // All resolved
        const report = generateBatchReport(tasks);
        session.queue = null;
        session.status = 'idle';
        session.mission = null;
        await saveSession(session);
        sendQueueUpdate(tasks, 'completed');
        if (report) await openBatchReport(report);
        const completed = tasks.filter(t => t.status === 'completed').length;
        return { status: 'idle', message: `Batch complete: ${completed}/${tasks.length} tasks done.`, isQueue: true };
      }
    }
    return { status: 'idle', message: 'No parked tasks to skip.' };
  }

  // --- Start teach capture (user clicked "Show Me") ---
  if (message.type === 'START_TEACH_CAPTURE') {
    const stuck = session.stuckContext;
    if (!stuck) return { error: 'No stuck context found.' };

    // Find the target tab and activate it so user can click
    const allTabs = await chrome.tabs.query({});
    const targetTab = allTabs.find(t => t.url && stuck.targetTabUrl && t.url.includes(stuck.targetTabUrl));
    if (!targetTab) return { error: `Target tab not found: ${stuck.targetTabUrl}` };

    // Focus the target tab
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });

    // Wait briefly for tab to be active, then activate teach capture
    await new Promise(r => setTimeout(r, 300));

    // Ensure content script is loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        files: ['content/content.js']
      });
    } catch {}

    try {
      await chrome.tabs.sendMessage(targetTab.id, { type: 'ACTIVATE_TEACH_CAPTURE' });
    } catch (err) {
      return { error: `Could not activate teach capture: ${err.message}` };
    }

    return { success: true, targetTabId: targetTab.id };
  }

  // --- Teach capture result (content script captured user's click) ---
  if (message.type === 'TEACH_CAPTURE_RESULT') {
    const captured = message.context;
    const stuck = session.stuckContext;
    if (!captured || !stuck) {
      return { error: 'No capture context or stuck context.' };
    }

    console.log('[UD] Teach capture received:', captured);

    // 1. Write the learned selector to site memory
    const hostname = captured.hostname || stuck.targetTabHostname;
    if (hostname && captured.selector) {
      const memoryKey = `siteMemory_${hostname}`;
      const existing = (await chrome.storage.local.get(memoryKey))[memoryKey] || {};
      existing[captured.selector] = {
        type: captured.actionType || 'click',
        lastVerified: Date.now(),
        successCount: 1,
        source: 'teach',
        ariaLabel: captured.ariaLabel,
        text: captured.text,
        role: captured.role
      };
      await chrome.storage.local.set({ [memoryKey]: existing });
      console.log(`[UD] Site memory written: ${captured.selector} for ${hostname}`);
    }

    // 2. Execute the action the model was trying to do, using the learned selector
    const failedAction = stuck.failedAction || {};
    const retryAction = {
      type: failedAction.type || captured.actionType || 'click',
      selector: captured.selector,
      ariaLabel: captured.ariaLabel,
      text: captured.text,
      value: failedAction.value || undefined,
      tabUrl: stuck.targetTabUrl
    };

    // Find the target tab
    const allTabs = await chrome.tabs.query({});
    const targetTab = allTabs.find(t => t.url && stuck.targetTabUrl && t.url.includes(stuck.targetTabUrl));
    if (targetTab) {
      const result = await executeActions([retryAction], targetTab.id);
      const success = result?.[0]?.success;
      console.log(`[UD] Retry with learned selector: ${success ? 'SUCCESS' : 'FAILED'}`);

      // Inject success into history
      session.history.push({
        role: 'user',
        content: success
          ? `User showed me the correct element. Action succeeded: ${retryAction.type} using selector "${captured.selector}". This selector is now saved to site memory. Continue the mission.`
          : `User showed me an element ("${captured.selector}") but the retry still failed. Trying a different approach.`
      });
    }

    // 3. Resume the agentic loop
    session.status = 'working';
    session.stuckContext = null;
    await saveSession(session);

    // Send intermediate update to panel (via content script relay)
    const [resumeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (resumeTab) {
      chrome.tabs.sendMessage(resumeTab.id, {
        type: 'UD_STATUS_UPDATE',
        status: 'working',
        message: 'Got it! Resuming...'
      }).catch(() => {});
    }

    // Re-enter the loop with remaining steps
    const activeTab = await getActiveHttpTab();
    if (!activeTab) return { status: 'idle', message: 'No browser tab available.' };
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    const remainingSteps = Math.max(10, 20 - (stuck.stepNumber || 0));
    const result = await runAgenticLoop(session, activeTab, openTabs, remainingSteps);

    // Send final result to panel
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab) {
      chrome.tabs.sendMessage(currentTab.id, {
        type: 'UD_STATUS_UPDATE',
        status: result.status,
        message: result.message
      }).catch(() => {});
    }

    return result;
  }

  // --- Cancel teach / go back to idle ---
  if (message.type === 'CANCEL_TEACH') {
    // Deactivate teach capture on any active tab
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'DEACTIVATE_TEACH_CAPTURE' });
      } catch {}
    }
    session.status = 'idle';
    session.stuckContext = null;
    session.mission = null;
    await saveSession(session);
    return { success: true };
  }

  if (message.type === 'RELOAD_ACTIVE_TAB') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return { error: 'No active tab found' };
    await chrome.tabs.reload(activeTab.id, { bypassCache: true });
    return { success: true };
  }

  return { error: 'Unknown message type' };
}

startNotificationPoller();
startPlatformMemoryScrapeCycle();
