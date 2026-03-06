// Side Panel mode: UI is rendered by Chrome Side Panel API via panel/panel.html.

// ============================================================
// UPSIDE DOWN — panel/panel.js
// The Shell: handles UI state, sends messages to background.js
// ============================================================

const statusBar      = document.getElementById('status-bar');
const messageDisplay = document.getElementById('message-display');
const taskInput      = document.getElementById('task-input'); // legacy optional
const sendBtn        = document.getElementById('send-btn');   // legacy optional
const approvalPanel  = document.getElementById('approval-panel');
const declineNote    = document.getElementById('decline-note');
const approveBtn     = document.getElementById('approve-btn');
const declineBtn     = document.getElementById('decline-btn');
const apiKeySection  = document.getElementById('api-key-section');
const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');
const statusText      = document.getElementById('status-text');
const settingsToggle  = document.getElementById('settings-toggle');
const recoveryRow     = document.getElementById('recovery-row');
const recoverBtn      = document.getElementById('recover-btn');
const teachPanel      = document.getElementById('teach-panel');
const showMeBtn       = document.getElementById('show-me-btn');
const cancelTeachBtn  = document.getElementById('cancel-teach-btn');
const askPanel        = document.getElementById('ask-panel');
const askAnswer       = document.getElementById('ask-answer');
const answerBtn       = document.getElementById('answer-btn');
const cancelAskBtn    = document.getElementById('cancel-ask-btn');

// ============================================================
// UI STATE
// ============================================================

function setStatus(status, message) {
  // Status bar color
  statusBar.className = '';
  if (status === 'working')              statusBar.classList.add('working');
  if (status === 'awaiting_approval')    statusBar.classList.add('approval');
  if (status === 'awaiting_user_answer') statusBar.classList.add('needs-help');
  if (status === 'needs_help')           statusBar.classList.add('needs-help');

  // Status text
  const labels = {
    idle: 'idle',
    working: 'working...',
    awaiting_approval: 'ready for approval',
    awaiting_user_answer: 'has a question',
    needs_help: 'needs your help'
  };
  statusText.textContent = labels[status] || status;

  // Show message if provided
  if (message) {
    messageDisplay.textContent = message;
    messageDisplay.classList.add('visible');
  }

  // Show/hide approval panel
  if (status === 'awaiting_approval') {
    approvalPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
  } else {
    approvalPanel.classList.remove('visible');
    if (sendBtn) sendBtn.disabled = false;
    declineNote.value = '';
  }

  // Show/hide ask panel
  if (status === 'awaiting_user_answer') {
    askPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
    if (askAnswer) {
      askAnswer.value = '';
      askAnswer.focus();
    }
  } else {
    askPanel.classList.remove('visible');
  }

  // Show/hide teach panel
  if (status === 'needs_help') {
    teachPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
  } else {
    teachPanel.classList.remove('visible');
  }

  // Clear queue log when returning to idle (after a delay so user can read)
  if (status === 'idle' && queueLog && queueLog.classList.contains('visible')) {
    setTimeout(() => {
      if (!isQueueMode) {
        queueLog.classList.remove('visible');
        queueLog.innerHTML = '';
      }
    }, 10000); // keep visible 10s after completion
  }
}

function showMessage(text) {
  messageDisplay.textContent = text;
  messageDisplay.classList.add('visible');
}

function showRecovery(visible) {
  if (!recoveryRow) return;
  if (visible) recoveryRow.classList.add('visible');
  else recoveryRow.classList.remove('visible');
}

function formatRuntimeError(err) {
  const msg = String(err?.message || err || '');
  if (msg.includes('Extension context invalidated')) {
    return 'Extension updated/reloaded. Refresh this tab, then try again.';
  }
  return msg || 'Unknown error';
}

// ============================================================
// SEND TASK
// ============================================================

async function sendTask(inputText) {
  const text = (typeof inputText === 'string' ? inputText : (taskInput ? taskInput.value : '')).trim();
  if (!text) return;

  if (taskInput) {
    taskInput.value = '';
  }
  if (messageDisplay) {
    messageDisplay.classList.add('visible');
  }
  setStatus('working');
  showMessage('Working...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'USER_MESSAGE',
      text
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    if (response.type === 'authWall') {
      showMessage(response.message);
      setStatus('idle');
      return;
    }

    // Track queue mode for skip button
    if (response.isQueue) {
      isQueueMode = true;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Skip Task';
    } else {
      isQueueMode = false;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Cancel';
    }

    setStatus(response.status, response.message);
    showRecovery(false);

  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// APPROVE
// ============================================================

async function approve() {
  setStatus('working');
  showMessage('Executing...');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'APPROVE' });
    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
    } else {
      showMessage(response.message || 'Done.');
      showRecovery(false);
    }
    setStatus('idle');
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// DECLINE
// ============================================================

async function decline() {
  const note = declineNote.value.trim() || 'Try again with a different option.';
  setStatus('working');
  showMessage('Retrying...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DECLINE',
      note
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    if (response.type === 'authWall') {
      showMessage(response.message);
      setStatus('idle');
      return;
    }

    setStatus(response.status, response.message);
    showRecovery(false);

  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// API KEY
// ============================================================

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  try {
    await chrome.runtime.sendMessage({ type: 'SET_API_KEY', key });
    apiKeyInput.value = '';
    apiKeySection.classList.remove('visible');
    showMessage('API key saved.');
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
  }
}

if (settingsToggle) {
  settingsToggle.addEventListener('click', () => {
    apiKeySection.classList.toggle('visible');
  });
}

if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveApiKey);

// ============================================================
// EVENT LISTENERS
// ============================================================

if (sendBtn) sendBtn.addEventListener('click', sendTask);

if (taskInput) {
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTask();
    }
  });
}

if (approveBtn) approveBtn.addEventListener('click', approve);
if (declineBtn) declineBtn.addEventListener('click', decline);
if (recoverBtn) {
  recoverBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'RELOAD_ACTIVE_TAB' });
      showMessage('Reloading tab...');
      showRecovery(false);
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// USER ANSWER (askUser response)
// ============================================================

async function sendAnswer() {
  const text = askAnswer.value.trim();
  if (!text) return;

  askAnswer.value = '';
  setStatus('working');
  showMessage('Got it, continuing...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'USER_ANSWER',
      text
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    // Track queue mode for skip button
    if (response.isQueue) {
      isQueueMode = true;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Skip Task';
    } else {
      isQueueMode = false;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Cancel';
    }

    setStatus(response.status, response.message);
    showRecovery(false);
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

if (answerBtn) answerBtn.addEventListener('click', sendAnswer);

if (askAnswer) {
  askAnswer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAnswer();
    }
  });
}

let isQueueMode = false;

if (cancelAskBtn) {
  cancelAskBtn.addEventListener('click', async () => {
    try {
      if (isQueueMode) {
        // In queue mode, skip the parked task
        const response = await chrome.runtime.sendMessage({ type: 'SKIP_PARKED_TASK' });
        if (response.status === 'awaiting_user_answer') {
          setStatus(response.status, response.message);
        } else {
          setStatus('idle', response.message);
          isQueueMode = false;
          cancelAskBtn.textContent = 'Cancel';
        }
      } else {
        await chrome.runtime.sendMessage({ type: 'CANCEL_ASK' });
        setStatus('idle');
        showMessage('Cancelled.');
      }
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// TEACH / "SHOW ME"
// ============================================================

if (showMeBtn) {
  showMeBtn.addEventListener('click', async () => {
    showMessage('Switch to the target tab and click the element...');
    showMeBtn.disabled = true;
    showMeBtn.textContent = 'Watching...';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'START_TEACH_CAPTURE' });
      if (response?.error) {
        showMessage(`Error: ${response.error}`);
        showMeBtn.disabled = false;
        showMeBtn.textContent = '\ud83c\udfaf Show Me';
      }
      // If success, we wait for TEACH_CAPTURE_RESULT to come back
      // which will trigger a STATUS_UPDATE -> working -> resuming
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
      showMeBtn.disabled = false;
      showMeBtn.textContent = '\ud83c\udfaf Show Me';
    }
  });
}

if (cancelTeachBtn) {
  cancelTeachBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TEACH' });
      setStatus('idle');
      showMessage('Cancelled.');
      showMeBtn.disabled = false;
      showMeBtn.textContent = '\ud83c\udfaf Show Me';
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// INIT — restore status on open
// ============================================================

async function init() {
  try {
    const session = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (session && session.status) {
      setStatus(session.status, session.proposalText || null);
    }
  } catch {
    // background not ready yet, fine
  }
}

// ── Drag handle — sends mouse position to parent page ──
const dragHandle = document.getElementById('drag-handle');
if (dragHandle) {
  dragHandle.addEventListener('mousedown', (e) => {
    window.parent.postMessage({
      type: 'UD_DRAG_START',
      x: e.screenX,
      y: e.screenY
    }, '*');
    e.preventDefault();
  });
}
document.addEventListener('mouseup', () => {
  window.parent.postMessage({ type: 'UD_DRAG_END' }, '*');
});

function applyStatusUpdate(status, message) {
  setStatus(status, message);
  if (status !== 'needs_help' && showMeBtn) {
    showMeBtn.disabled = false;
    showMeBtn.textContent = '\ud83c\udfaf Show Me';
  }
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'UD_STATUS_UPDATE') {
    applyStatusUpdate(e.data.status, e.data.message);
  }
});

// ============================================================
// QUEUE MISSION LOG
// ============================================================

const queueLog = document.getElementById('queue-log');

function renderQueueLog(tasks, queueStatus) {
  if (!queueLog || !tasks || tasks.length === 0) {
    if (queueLog) queueLog.classList.remove('visible');
    return;
  }

  const statusEmoji = (status) => {
    switch (status) {
      case 'completed': return '\u2705';
      case 'failed':    return '\u274c';
      case 'parked':    return '\u23f8\ufe0f';
      case 'running':   return '\ud83d\udd04';
      case 'pending':   return '\u2b55';
      default:          return '\u2b55';
    }
  };

  const truncate = (str, len) => str && str.length > len ? str.slice(0, len) + '\u2026' : (str || '');

  let html = tasks.map(t => {
    const resultLine = t.status === 'completed' && t.result
      ? `<div class="result">${truncate(t.result, 60)}</div>`
      : t.status === 'parked' && t.parkedQuestion
        ? `<div class="result">${truncate(t.parkedQuestion, 60)}</div>`
        : t.status === 'failed' && t.error
          ? `<div class="result">${truncate(t.error, 60)}</div>`
          : '';

    return `<div class="queue-task ${t.status}">
      <span class="emoji">${statusEmoji(t.status)}</span>
      <div>
        <div class="mission">${t.id}. ${truncate(t.mission, 50)}</div>
        ${resultLine}
      </div>
    </div>`;
  }).join('');

  if (queueStatus === 'completed') {
    html += '<div style="color:#4ade80;font-size:11px;margin-top:6px;text-align:center;">\u2714 Batch complete \u2014 see report tab</div>';
  } else if (queueStatus === 'parked_waiting') {
    html += '<div style="color:#fbbf24;font-size:11px;margin-top:6px;text-align:center;">\u23f8 Waiting for your help on parked tasks</div>';
  }

  queueLog.innerHTML = html;
  queueLog.classList.add('visible');
  queueLog.scrollTop = queueLog.scrollHeight;
}

// Listen for QUEUE_UPDATE from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'QUEUE_UPDATE') {
    renderQueueLog(msg.tasks, msg.queueStatus);
  }
  if (msg.type === 'STATUS_UPDATE') {
    applyStatusUpdate(msg.status, msg.message);
  }
});

init();

// === PRESENCE DIRECTIVE + NOTIFICATIONS ===
const SUPABASE_URL_STORAGE_KEY = 'supabase_url';
const SUPABASE_ANON_KEY_STORAGE_KEY = 'supabase_anon_key';
const USER_ID_STORAGE_KEY = 'user_id';
const SETUP_COMPLETE_STORAGE_KEY = 'setup_complete';
var displayedPresenceNotifications = [];
var dismissedPresenceNotificationIds = new Set();
var runtimeConfig = null;

function supabaseAuthHeaders() {
  if (!runtimeConfig?.anonKey) throw new Error('Supabase anon key missing. Complete setup first.');
  return {
    'Authorization': 'Bearer ' + runtimeConfig.anonKey,
    'Content-Type': 'application/json',
    'apikey': runtimeConfig.anonKey,
    'x-user-id': runtimeConfig.userId || ''
  };
}

function getSupabaseUrl() {
  if (!runtimeConfig?.url) throw new Error('Supabase URL missing. Complete setup first.');
  return runtimeConfig.url;
}

const directiveActiveEl = document.getElementById('directive-active');
const directiveEditorEl = document.getElementById('directive-editor');
const directiveTextEl = document.getElementById('directive-text');
const directiveMetaEl = document.getElementById('directive-meta');
const directiveInputEl = document.getElementById('directive-input');
const directiveSubmitBtn = document.getElementById('directive-submit-btn');
const directiveUpdateBtn = document.getElementById('directive-update-btn');
const directiveClearBtn = document.getElementById('directive-clear-btn');
const intakeScreenEl = document.getElementById('intake-screen');
const intakeFileInputEl = document.getElementById('intake-file-input');
const intakeUploadBtnEl = document.getElementById('intake-upload-btn');
const intakeSkipBtnEl = document.getElementById('intake-skip-btn');
const intakeProgressEl = document.getElementById('intake-progress');
const intakeResultEl = document.getElementById('intake-result');
const setupScreenEl = document.getElementById('setup-screen');
const setupUrlInputEl = document.getElementById('setup-supabase-url');
const setupAnonKeyInputEl = document.getElementById('setup-supabase-anon-key');
const setupContinueBtnEl = document.getElementById('setup-continue-btn');
const setupErrorEl = document.getElementById('setup-error');
const presenceDirectivePanelEl = document.getElementById('presence-directive-panel');
const outputFeedEl = document.getElementById('output-feed');
const footerEl = document.getElementById('footer');
let normalPopupInitialized = false;

async function loadRuntimeConfig() {
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
  runtimeConfig = { url, anonKey, userId, setupComplete };
  return runtimeConfig;
}

function isConfigReady() {
  return Boolean(runtimeConfig && runtimeConfig.setupComplete && runtimeConfig.url && runtimeConfig.anonKey && runtimeConfig.userId);
}

function relativeTimeFromIso(isoString) {
  if (!isoString) return '';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  if (seconds < 60) return 'Set just now';
  if (seconds < 3600) return 'Set ' + Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return 'Set ' + Math.floor(seconds / 3600) + 'h ago';
  return 'Set ' + Math.floor(seconds / 86400) + 'd ago';
}

function renderDirectiveState(directive, directiveSetAt) {
  const hasDirective = Boolean(String(directive || '').trim());
  if (hasDirective) {
    directiveActiveEl && directiveActiveEl.classList.remove('directive-hidden');
    directiveTextEl && (directiveTextEl.textContent = String(directive).trim());
    directiveMetaEl && (directiveMetaEl.textContent = relativeTimeFromIso(directiveSetAt));
    if (directiveEditorEl) directiveEditorEl.classList.add('directive-hidden');
    if (directiveInputEl) directiveInputEl.value = '';
    if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Set';
    return;
  }

  directiveActiveEl && directiveActiveEl.classList.add('directive-hidden');
  if (directiveEditorEl) directiveEditorEl.classList.remove('directive-hidden');
  if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Set';
}

async function fetchPrimeDirective() {
  const response = await fetch(
    getSupabaseUrl() + '/rest/v1/presence_state?id=eq.1&select=prime_directive,directive_set_at&limit=1',
    {
      headers: supabaseAuthHeaders()
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('directive fetch failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    primeDirective: row?.prime_directive || null,
    directiveSetAt: row?.directive_set_at || null
  };
}

async function setPrimeDirective(directive) {
  const response = await fetch(getSupabaseUrl() + '/functions/v1/presence-gatekeeper', {
    method: 'POST',
    headers: supabaseAuthHeaders(),
    body: JSON.stringify({
      action: 'set_directive',
      directive: directive,
      user_id: runtimeConfig?.userId || null
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('directive set failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
}

function parseTruthySetting(raw) {
  var value = String(raw || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

async function hasOnboardingComplete() {
  const response = await fetch(
    getSupabaseUrl() + '/rest/v1/hearth_settings?select=value&key=eq.onboarding_complete&limit=1',
    { headers: supabaseAuthHeaders() }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('onboarding flag read failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return parseTruthySetting(rows[0] && rows[0].value);
}

function setIntakeMode(active) {
  if (setupScreenEl) setupScreenEl.classList.add('setup-hidden');
  if (intakeScreenEl) intakeScreenEl.classList.toggle('intake-hidden', !active);
  if (presenceDirectivePanelEl) presenceDirectivePanelEl.style.display = active ? 'none' : '';
  if (outputFeedEl) outputFeedEl.style.display = active ? 'none' : '';
  if (messageDisplay) messageDisplay.style.display = active ? 'none' : '';
  if (queueLog) queueLog.style.display = active ? 'none' : '';
  if (recoveryRow) recoveryRow.style.display = active ? 'none' : '';
  if (approvalPanel) approvalPanel.style.display = active ? 'none' : '';
  if (askPanel) askPanel.style.display = active ? 'none' : '';
  if (teachPanel) teachPanel.style.display = active ? 'none' : '';
  if (apiKeySection) apiKeySection.style.display = active ? 'none' : '';
  if (footerEl) footerEl.style.display = active ? 'none' : '';
}

function setSetupMode(active) {
  if (setupScreenEl) setupScreenEl.classList.toggle('setup-hidden', !active);
  if (intakeScreenEl) intakeScreenEl.classList.add('intake-hidden');
  if (presenceDirectivePanelEl) presenceDirectivePanelEl.style.display = active ? 'none' : '';
  if (outputFeedEl) outputFeedEl.style.display = active ? 'none' : '';
  if (messageDisplay) messageDisplay.style.display = active ? 'none' : '';
  if (queueLog) queueLog.style.display = active ? 'none' : '';
  if (recoveryRow) recoveryRow.style.display = active ? 'none' : '';
  if (approvalPanel) approvalPanel.style.display = active ? 'none' : '';
  if (askPanel) askPanel.style.display = active ? 'none' : '';
  if (teachPanel) teachPanel.style.display = active ? 'none' : '';
  if (apiKeySection) apiKeySection.style.display = active ? 'none' : '';
  if (footerEl) footerEl.style.display = active ? 'none' : '';
}

function estimateBatchCount(rawJson) {
  try {
    var parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return 1;
    return Math.max(1, Math.ceil(parsed.length / 20));
  } catch (_) {
    return 1;
  }
}

async function processIntakeFile(rawJson) {
  const response = await fetch(getSupabaseUrl() + '/functions/v1/process-intake', {
    method: 'POST',
    headers: supabaseAuthHeaders(),
    body: JSON.stringify({ raw_json: rawJson, user_id: runtimeConfig?.userId || null })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : ('HTTP ' + response.status));
  }
  return payload;
}

async function markOnboardingComplete() {
  const response = await fetch(getSupabaseUrl() + '/rest/v1/hearth_settings?on_conflict=key', {
    method: 'POST',
    headers: {
      ...supabaseAuthHeaders(),
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      key: 'onboarding_complete',
      value: 'true'
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Failed to skip onboarding: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
}

async function handleIntakeUpload() {
  if (!intakeFileInputEl || !intakeUploadBtnEl) return;
  var file = intakeFileInputEl.files && intakeFileInputEl.files[0];
  if (!file) {
    intakeProgressEl && (intakeProgressEl.textContent = 'Choose conversations.json first.');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.json')) {
    intakeProgressEl && (intakeProgressEl.textContent = 'Please upload a .json file.');
    return;
  }

  intakeUploadBtnEl.disabled = true;
  if (intakeResultEl) intakeResultEl.textContent = '';

  try {
    var rawJson = await file.text();
    var totalBatches = estimateBatchCount(rawJson);
    var currentBatch = 1;
    if (intakeProgressEl) intakeProgressEl.textContent = 'Reading your history... (batch 1 of ' + totalBatches + ')';
    var progressTimer = setInterval(function() {
      currentBatch = Math.min(totalBatches, currentBatch + 1);
      if (intakeProgressEl) intakeProgressEl.textContent = 'Reading your history... (batch ' + currentBatch + ' of ' + totalBatches + ')';
    }, 1500);

    var result;
    try {
      result = await processIntakeFile(rawJson);
    } finally {
      clearInterval(progressTimer);
    }

    var memoriesWritten = Number(result && result.memories_written || 0);
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = 'Imported. ' + memoriesWritten + ' memories written.';
    setTimeout(function() {
      setIntakeMode(false);
      initNormalPopup();
    }, 600);
  } catch (err) {
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = 'Import failed: ' + (err?.message || String(err));
  } finally {
    intakeUploadBtnEl.disabled = false;
  }
}

async function handleIntakeSkip() {
  if (!intakeSkipBtnEl) return;
  intakeSkipBtnEl.disabled = true;
  if (intakeUploadBtnEl) intakeUploadBtnEl.disabled = true;
  if (intakeResultEl) intakeResultEl.textContent = '';
  if (intakeProgressEl) intakeProgressEl.textContent = 'Skipping intake...';
  try {
    await markOnboardingComplete();
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    setIntakeMode(false);
    initNormalPopup();
  } catch (err) {
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = err?.message || String(err);
  } finally {
    intakeSkipBtnEl.disabled = false;
    if (intakeUploadBtnEl) intakeUploadBtnEl.disabled = false;
  }
}

async function refreshPrimeDirective() {
  try {
    const state = await fetchPrimeDirective();
    renderDirectiveState(state.primeDirective, state.directiveSetAt);
  } catch (err) {
    console.warn('[Presence] Failed to load directive:', err?.message || err);
    renderDirectiveState(null, null);
  }
}

async function submitDirective() {
  if (!directiveInputEl) return;
  const value = directiveInputEl.value.trim();
  if (!value) return;

  if (directiveSubmitBtn) directiveSubmitBtn.disabled = true;
  try {
    await setPrimeDirective(value);
    await refreshPrimeDirective();
  } catch (err) {
    showMessage('Directive update failed: ' + (err?.message || String(err)));
  } finally {
    if (directiveSubmitBtn) directiveSubmitBtn.disabled = false;
  }
}

async function clearDirective() {
  if (directiveClearBtn) directiveClearBtn.disabled = true;
  try {
    await setPrimeDirective(null);
    await refreshPrimeDirective();
  } catch (err) {
    showMessage('Directive clear failed: ' + (err?.message || String(err)));
  } finally {
    if (directiveClearBtn) directiveClearBtn.disabled = false;
  }
}

function renderPresenceReadyState() {
  var container = document.getElementById('output-feed');
  if (!container) return;

  var existing = container.querySelector('.presence-empty-state');
  var hasPresenceCards = !!container.querySelector('.presence-notification');

  if (hasPresenceCards) {
    if (existing) existing.remove();
    return;
  }

  if (!existing) {
    var ready = document.createElement('div');
    ready.className = 'presence-empty-state';
    ready.textContent = 'No pending presence notifications.';
    ready.style.cssText = 'padding:10px 12px; color:#999; font-size:12px; border:1px dashed #2f2f2f; border-radius:8px; margin-bottom:8px;';
    container.prepend(ready);
  }
}

function removePresenceNotificationById(notificationId) {
  var id = String(notificationId);
  dismissedPresenceNotificationIds.add(id);
  displayedPresenceNotifications = displayedPresenceNotifications.filter(function(n) {
    return String(n && n.id) !== id;
  });

  var container = document.getElementById('output-feed');
  if (!container) return;
  var el = container.querySelector('[data-id="' + id + '"]');
  if (!el) {
    renderPresenceReadyState();
    return;
  }
  el.classList.add('fade-out');
  setTimeout(function() {
    el.remove();
    renderPresenceReadyState();
  }, 300);
}

function timeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function renderPresenceNotification(notification) {
  var container = document.getElementById('output-feed');
  if (!container) return;
  if (container.querySelector('[data-id="' + notification.id + '"]')) return;

  var el = document.createElement('div');
  el.className = 'presence-notification';
  el.dataset.id = notification.id;

  var confidence = notification.oracle_confidence;
  var confidenceColor = confidence >= 0.7 ? '#4ade80' : confidence >= 0.4 ? '#fbbf24' : '#f87171';
  var labels = { state_change: 'State Change', email_trigger: 'Reply', scout_alert: 'Scout Alert', manual: 'Manual' };
  var ago = timeAgo(new Date(notification.created_at));

  el.innerHTML = '<div class="presence-header">' +
    '<span class="presence-type">' + (labels[notification.trigger_type] || notification.trigger_type) + '</span>' +
    (confidence ? '<span class="presence-confidence" style="color:' + confidenceColor + '">' + Math.round(confidence * 100) + '%</span>' : '') +
    '<span class="presence-time">' + ago + '</span></div>' +
    '<div class="presence-message">' + notification.message.replace(/</g, '&lt;') + '</div>' +
    '<div class="presence-expand-row">' +
    '<button class="presence-expand-btn" type="button">Expand</button>' +
    '<span class="presence-expand-loading"></span>' +
    '</div>' +
    '<div class="presence-expand-body presence-expand-hidden"></div>' +
    '<div class="presence-actions">' +
    '<button class="score-btn score-e" data-score="E" title="Excellent">E</button>' +
    '<button class="score-btn score-g" data-score="G" title="Good">G</button>' +
    '<button class="score-btn score-d" data-score="D" title="Didn\'t land">D</button>' +
    '<button class="dismiss-btn" title="Dismiss">✕</button></div>';

  var expandBtn = el.querySelector('.presence-expand-btn');
  var expandLoading = el.querySelector('.presence-expand-loading');
  var expandBody = el.querySelector('.presence-expand-body');
  var expandTextCache = '';
  var expandOpen = false;

  function setExpandUi() {
    if (!expandBtn || !expandBody) return;
    expandBtn.textContent = expandOpen ? 'Collapse' : 'Expand';
    expandBody.classList.toggle('presence-expand-hidden', !expandOpen);
  }

  function extractConverseText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload.response === 'string') return payload.response.trim();
    if (typeof payload.message === 'string') return payload.message.trim();
    if (typeof payload.text === 'string') return payload.text.trim();
    if (payload.data && typeof payload.data.response === 'string') return payload.data.response.trim();
    if (Array.isArray(payload.content) && payload.content[0] && typeof payload.content[0].text === 'string') {
      return payload.content[0].text.trim();
    }
    return '';
  }

  async function expandBreadcrumb() {
    if (!expandBtn || !expandBody || !expandLoading) return;
    if (expandOpen) {
      expandOpen = false;
      setExpandUi();
      return;
    }

    if (expandTextCache) {
      expandBody.textContent = expandTextCache;
      expandOpen = true;
      setExpandUi();
      return;
    }

    expandBtn.disabled = true;
    expandLoading.textContent = 'Loading...';
    try {
      const response = await fetch(getSupabaseUrl() + '/functions/v1/hearth-converse', {
        method: 'POST',
        headers: supabaseAuthHeaders(),
        body: JSON.stringify({
          question: 'Explain this breadcrumb in 2-3 paragraphs — what pattern you saw, why it was worth surfacing, and what connection you made. Be specific. Breadcrumb: ' + notification.message
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload && payload.error) || ('HTTP ' + response.status));
      }
      const expanded = extractConverseText(payload);
      if (!expanded) {
        throw new Error('No expansion text returned');
      }
      expandTextCache = expanded;
      expandBody.textContent = expandTextCache;
      expandOpen = true;
      setExpandUi();
    } catch (err) {
      showMessage('Expand failed: ' + (err?.message || String(err)));
    } finally {
      expandBtn.disabled = false;
      expandLoading.textContent = '';
    }
  }

  function finalizeScore(outcome) {
    el.querySelector('.presence-actions').innerHTML = '<span class="score-result">Scored: ' + outcome + '</span>';
    setTimeout(function() { removePresenceNotificationById(notification.id); }, 600);
  }

  function showDismissReasonInput() {
    var actions = el.querySelector('.presence-actions');
    if (!actions) return;
    actions.innerHTML =
      '<div class="presence-reason-wrap">' +
      '<label class="presence-reason-label" for="presence-reason-' + notification.id + '">What was wrong?</label>' +
      '<input id="presence-reason-' + notification.id + '" class="presence-reason-input" type="text" placeholder="bad timing / stale info / wrong connection / other" />' +
      '<div class="presence-reason-actions">' +
      '<button class="presence-reason-submit">Submit D</button>' +
      '<button class="presence-reason-skip">Skip</button>' +
      '</div>' +
      '</div>';

    var input = actions.querySelector('.presence-reason-input');
    var submit = actions.querySelector('.presence-reason-submit');
    var skip = actions.querySelector('.presence-reason-skip');

    function submitDismissScore() {
      var reason = input ? input.value.trim() : '';
      chrome.runtime.sendMessage({
        type: 'SCORE_NOTIFICATION',
        notificationId: notification.id,
        outcome: 'D',
        gradeReason: reason
      });
      finalizeScore('D');
    }

    if (submit) {
      submit.addEventListener('click', submitDismissScore);
    }
    if (skip) {
      skip.addEventListener('click', function() {
        chrome.runtime.sendMessage({
          type: 'SCORE_NOTIFICATION',
          notificationId: notification.id,
          outcome: 'D',
          gradeReason: ''
        });
        finalizeScore('D');
      });
    }
    if (input) {
      input.focus();
      input.addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitDismissScore();
        }
      });
    }
  }

  el.querySelectorAll('.score-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var outcome = btn.dataset.score;
      if (outcome === 'D') {
        showDismissReasonInput();
        return;
      }
      chrome.runtime.sendMessage({
        type: 'SCORE_NOTIFICATION',
        notificationId: notification.id,
        outcome: outcome
      });
      finalizeScore(outcome);
    });
  });

  el.querySelector('.dismiss-btn').addEventListener('click', function() {
    chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
    removePresenceNotificationById(notification.id);
  });
  if (expandBtn) {
    expandBtn.addEventListener('click', expandBreadcrumb);
  }

  chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
  container.prepend(el);
  renderPresenceReadyState();
}

function mergePresenceNotifications(incoming) {
  var list = Array.isArray(incoming) ? incoming : [];
  var byId = new Map(displayedPresenceNotifications.map(function(n) {
    return [String(n.id), n];
  }));
  var added = [];

  list.forEach(function(notification) {
    var id = String(notification && notification.id);
    if (!id || dismissedPresenceNotificationIds.has(id) || byId.has(id)) return;
    byId.set(id, notification);
    displayedPresenceNotifications.push(notification);
    added.push(notification);
  });

  return added;
}

// Listen for presence notifications
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'PRESENCE_NOTIFICATIONS') {
    var newlyAdded = mergePresenceNotifications(msg.notifications || []);
    newlyAdded.forEach(renderPresenceNotification);
    renderPresenceReadyState();
  }
});

const realtimeToggleBtn = document.getElementById('realtime-toggle-btn');
const realtimeStatusDot = document.getElementById('realtime-status-dot');
const realtimeStatusText = document.getElementById('realtime-status-text');
const watchFolderBtn = document.getElementById('watch-folder-btn');
const watchFolderStatusEl = document.getElementById('watch-folder-status');
let activeWatchedFolder = '';

function setRealtimeToggleUi(active) {
  if (!realtimeToggleBtn || !realtimeStatusDot || !realtimeStatusText) return;
  realtimeToggleBtn.classList.toggle('active', active);
  realtimeStatusDot.classList.toggle('active', active);
  realtimeStatusText.textContent = active ? 'recording' : 'off';
  realtimeStatusText.style.color = active ? '#ef4444' : '#777';
}

function truncateFolderPath(path) {
  var value = String(path || '').trim();
  if (value.length <= 64) return value;
  return '...' + value.slice(-61);
}

function setWatchFolderUi(folderPath) {
  activeWatchedFolder = String(folderPath || '').trim();
  if (watchFolderBtn) {
    watchFolderBtn.textContent = activeWatchedFolder ? 'Stop Watching' : 'Watch Folder';
  }
  if (!watchFolderStatusEl) return;
  if (!activeWatchedFolder) {
    watchFolderStatusEl.textContent = 'No folder selected.';
    return;
  }
  watchFolderStatusEl.innerHTML = 'Watching: <span class="watch-folder-path">' + truncateFolderPath(activeWatchedFolder).replace(/</g, '&lt;') + '</span>';
}

async function refreshWatchFolderStatus() {
  if (!watchFolderStatusEl) return;
  try {
    var response = await fetch('http://localhost:5556/status');
    if (!response.ok) {
      // Backward compatibility with older daemon builds that only expose /health.
      response = await fetch('http://localhost:5556/health');
    }
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    var payload = await response.json();
    setWatchFolderUi(payload?.watched_folder || payload?.watch_folder || payload?.watchFolder || payload?.folder || '');
  } catch (err) {
    console.warn('[Presence] Failed to load watch folder status:', err?.message || err);
    setWatchFolderUi('');
  }
}

async function toggleWatchFolder() {
  if (!watchFolderBtn) return;
  watchFolderBtn.disabled = true;
  try {
    const endpoint = activeWatchedFolder ? 'http://localhost:5556/stop-watching' : 'http://localhost:5556/pick-folder';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || ('HTTP ' + response.status));
    }
    if (payload?.ok === false) {
      throw new Error(payload?.error || 'Folder picker failed');
    }
    await refreshWatchFolderStatus();
  } catch (err) {
    showMessage('Watch folder failed: ' + (err?.message || String(err)));
  } finally {
    watchFolderBtn.disabled = false;
  }
}

async function refreshRealtimeToggle() {
  if (!realtimeToggleBtn) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_REALTIME_ACTIVE' });
    if (result && result.success) {
      setRealtimeToggleUi(Boolean(result.active));
    } else {
      console.warn('[UD] Failed to read realtime toggle state:', result && result.error);
    }
  } catch (err) {
    console.warn('[UD] Failed to refresh realtime toggle:', err);
  }
}

async function toggleRealtimeActive() {
  if (!realtimeToggleBtn) return;
  const nextActive = !realtimeToggleBtn.classList.contains('active');
  realtimeToggleBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SET_REALTIME_ACTIVE', active: nextActive });
    if (result && result.success) {
      setRealtimeToggleUi(Boolean(result.active));
    } else {
      console.warn('[UD] Realtime toggle update failed:', result && result.error);
      showMessage('Realtime toggle failed: ' + ((result && result.error) || 'unknown error'));
    }
  } catch (err) {
    console.warn('[UD] Realtime toggle error:', err);
    showMessage('Realtime toggle error: ' + (err?.message || String(err)));
  } finally {
    realtimeToggleBtn.disabled = false;
  }
}

if (realtimeToggleBtn) {
  realtimeToggleBtn.addEventListener('click', toggleRealtimeActive);
}
if (watchFolderBtn) {
  watchFolderBtn.addEventListener('click', toggleWatchFolder);
}

if (directiveSubmitBtn) {
  directiveSubmitBtn.addEventListener('click', submitDirective);
}
if (directiveInputEl) {
  directiveInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitDirective();
    }
  });
}
if (directiveUpdateBtn) {
  directiveUpdateBtn.addEventListener('click', () => {
    if (directiveEditorEl) directiveEditorEl.classList.remove('directive-hidden');
    if (directiveInputEl && directiveTextEl) {
      directiveInputEl.value = directiveTextEl.textContent || '';
      directiveInputEl.focus();
      directiveInputEl.select();
    }
    if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Update';
  });
}
if (directiveClearBtn) {
  directiveClearBtn.addEventListener('click', clearDirective);
}

function initNormalPopup() {
  if (normalPopupInitialized) return;
  normalPopupInitialized = true;
  setSetupMode(false);
  setIntakeMode(false);
  refreshRealtimeToggle();
  refreshWatchFolderStatus();
  refreshPrimeDirective();

  chrome.storage.session.get('presenceNotifications', function(data) {
    var seeded = mergePresenceNotifications(data.presenceNotifications || []);
    seeded.forEach(renderPresenceNotification);
    renderPresenceReadyState();
  });
}

async function saveSetupConfiguration() {
  const url = String(setupUrlInputEl?.value || '').trim().replace(/\/+$/, '');
  const anonKey = String(setupAnonKeyInputEl?.value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Enter a valid Supabase URL.');
  }
  if (!anonKey) {
    throw new Error('Supabase anon key is required.');
  }
  const existing = await chrome.storage.local.get(USER_ID_STORAGE_KEY);
  const userId = String(existing[USER_ID_STORAGE_KEY] || '') || crypto.randomUUID();
  await chrome.storage.local.set({
    [SUPABASE_URL_STORAGE_KEY]: url,
    [SUPABASE_ANON_KEY_STORAGE_KEY]: anonKey,
    [USER_ID_STORAGE_KEY]: userId,
    [SETUP_COMPLETE_STORAGE_KEY]: true
  });
  runtimeConfig = {
    url,
    anonKey,
    userId,
    setupComplete: true
  };
}

async function handleSetupContinue() {
  if (!setupContinueBtnEl) return;
  setupContinueBtnEl.disabled = true;
  if (setupErrorEl) setupErrorEl.textContent = '';
  try {
    await saveSetupConfiguration();
    await bootOnboardingGate();
  } catch (err) {
    if (setupErrorEl) setupErrorEl.textContent = err?.message || String(err);
  } finally {
    setupContinueBtnEl.disabled = false;
  }
}

async function bootOnboardingGate() {
  try {
    await loadRuntimeConfig();
    if (!isConfigReady()) {
      setSetupMode(true);
      return;
    }

    var onboardingComplete = await hasOnboardingComplete();
    var needsIntake = !onboardingComplete;
    setIntakeMode(needsIntake);
    if (needsIntake) return;
  } catch (err) {
    console.warn('[Presence] Intake gate check failed:', err?.message || err);
    setSetupMode(false);
    setIntakeMode(false);
  }
  initNormalPopup();
}

if (intakeUploadBtnEl) {
  intakeUploadBtnEl.addEventListener('click', handleIntakeUpload);
}
if (intakeSkipBtnEl) {
  intakeSkipBtnEl.addEventListener('click', handleIntakeSkip);
}
if (setupContinueBtnEl) {
  setupContinueBtnEl.addEventListener('click', handleSetupContinue);
}
if (setupUrlInputEl) {
  setupUrlInputEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSetupContinue();
    }
  });
}
if (setupAnonKeyInputEl) {
  setupAnonKeyInputEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSetupContinue();
    }
  });
}

bootOnboardingGate();
