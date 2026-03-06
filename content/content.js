// ============================================================
// UPSIDE DOWN — content/content.js
// The Hands: executes actions on the current page.
// Knows nothing about model/provider details or missions.
// Receives action objects, executes them, reports back.
// ============================================================

// Version gate: allow re-injection when extension updates
var __UD_VERSION = 12; // var so re-declaration doesn't throw
if (window.__udLoaded === __UD_VERSION) {
  // same version already loaded, do nothing
} else {
  window.__udLoaded = __UD_VERSION;

  function safeSend(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[UD] Runtime disconnected:', chrome.runtime.lastError.message);
          return;
        }
        if (callback) callback(response);
      });
    } catch (e) {
      console.warn('[UD] sendMessage threw:', e.message);
    }
  }

  function pruneDOM() {
    const doc = document;
    const result = [];
    result.push(`PAGE: ${doc.title}`);
    result.push(`URL: ${window.location.href}`);

    const interactive = doc.querySelectorAll(
      'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="textbox"]'
    );
    interactive.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const id = el.id ? `#${el.id}` : '';
      const name = el.name ? `name="${el.name}"` : '';
      const placeholder = el.placeholder ? `placeholder="${el.placeholder}"` : '';
      const ariaLabel = el.getAttribute('aria-label') ? `aria-label="${el.getAttribute('aria-label')}"` : '';
      const text = el.innerText?.trim().slice(0, 50) || '';
      const value = el.value?.slice(0, 50) || '';
      const href = el.href ? `href="${el.href.slice(0, 80)}"` : '';
      const descriptor = [tag, type, id, name, placeholder, ariaLabel, text, value, href]
        .filter(Boolean).join(' ');
      if (descriptor.trim()) result.push(`[INTERACTIVE] ${descriptor}`);
    });

    const textNodes = doc.querySelectorAll('h1, h2, h3, h4, p, li, td, th, span[class], div[class]');
    textNodes.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      if (el.closest('nav, footer, script, style, [role="navigation"]')) return;
      const text = el.innerText?.trim();
      if (text && text.length > 20 && text.length < 500) result.push(`[TEXT] ${text}`);
    });

    const seen = new Set();
    return result.filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    }).join('\n');
  }

  // ============================================================
  // ARIA SNAPSHOT — Accessibility-tree based page reading
  // Produces a compact labeled list of interactive elements.
  // Each element gets a numeric ref stored in __udRefRegistry
  // for resilient execution-time lookup.
  // ============================================================

  // Global ref registry: ref number → { element, fingerprint }
  // Rebuilt on every snapshot call.
  window.__udRefRegistry = window.__udRefRegistry || new Map();
  let __udNextRef = 1;

  function getAccessibleName(el) {
    const doc = el.ownerDocument || document;
    // 1. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    // 2. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim()).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    // 3. <label> for inputs
    if (el.id) {
      const label = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    // 4. placeholder
    if (el.placeholder) return el.placeholder;
    // 5. title attribute
    if (el.title) return el.title.trim();
    // 6. alt text for images / image inputs
    if (el.alt) return el.alt.trim();
    // 7. visible text (short)
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 80) return text;
    if (text) return text.slice(0, 77) + '...';
    return '';
  }

  function getElementRole(el) {
    // Explicit ARIA role wins
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    // Implicit roles from tag
    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    const roleMap = {
      a: 'link', button: 'button', select: 'combobox',
      textarea: 'textbox', details: 'group', summary: 'button',
      nav: 'navigation', main: 'main', header: 'banner',
      footer: 'contentinfo', aside: 'complementary',
      form: 'form', dialog: 'dialog', table: 'table',
      img: 'img', h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading'
    };
    if (tag === 'input') {
      const inputRoles = {
        checkbox: 'checkbox', radio: 'radio', range: 'slider',
        search: 'searchbox', email: 'textbox', tel: 'textbox',
        url: 'textbox', number: 'spinbutton', submit: 'button',
        reset: 'button', button: 'button', text: 'textbox', '': 'textbox'
      };
      return inputRoles[type] || 'textbox';
    }
    // contenteditable
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'textbox';
    return roleMap[tag] || null;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    // Standard interactive elements
    if (['input', 'textarea', 'select', 'button', 'details', 'summary'].includes(tag)) return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    // ARIA interactive roles
    const role = el.getAttribute('role');
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'tab', 'switch', 'slider', 'spinbutton', 'searchbox', 'treeitem'
    ]);
    if (role && interactiveRoles.has(role)) return true;
    // Contenteditable
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    // tabindex makes anything focusable/interactive
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
    return false;
  }

  function isVisible(el) {
    // Use the element's own window for getComputedStyle (cross-iframe support)
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    // Element's own computed style says hidden — skip
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (!el.offsetParent && el.tagName.toLowerCase() !== 'body' && el.tagName.toLowerCase() !== 'html') {
      // No offsetParent — could be fixed/sticky, or inside a visibility:hidden ancestor
      // that this element overrides. Allow if element itself is visible.
      if (style.position !== 'fixed' && style.position !== 'sticky') {
        // Check if the element actually has layout (rect size > 0)
        // Gmail compose: parent is visibility:hidden, child is visibility:visible
        // offsetParent may be null but element renders fine
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        // Has size — it's rendering despite null offsetParent
      }
    }
    const rect = el.getBoundingClientRect();
    // Element must have some size
    if (rect.width === 0 && rect.height === 0) return false;
    // NOTE: No viewport bounds check — overlays like Gmail compose can be
    // positioned anywhere. Size + display/visibility checks are sufficient.
    return true;
  }

  /**
   * Walk a document (or document fragment) collecting interactive, visible elements.
   * Used by snapshotARIA to traverse both the main page and same-origin iframes.
   */
  function collectInteractiveElements(doc, elements) {
    const root = doc.body || doc.documentElement;
    if (!root) return;
    const win = doc.defaultView || window;
    const walker = doc.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          const style = win.getComputedStyle(node);
          if (style.display === 'none') return NodeFilter.FILTER_REJECT;
          if (style.visibility === 'hidden') return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node = walker.nextNode();
    while (node) {
      if (isInteractive(node) && isVisible(node)) {
        elements.push(node);
      }
      node = walker.nextNode();
    }
  }

  /**
   * Collect headings (h1-h3) from a document for structural context.
   */
  function collectHeadings(doc, headingLines) {
    const headings = doc.querySelectorAll('h1, h2, h3');
    headings.forEach(h => {
      const text = (h.innerText || '').trim();
      if (text && text.length < 200) {
        headingLines.push(`${h.tagName.toLowerCase()}: ${text}`);
      }
    });
  }

  /**
   * Get all same-origin iframe documents accessible from the main page.
   * Silently skips cross-origin iframes.
   */
  function getSameOriginIframeDocs() {
    const docs = [];
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument;
        if (iframeDoc && iframeDoc.body) {
          docs.push(iframeDoc);
          // Also check for nested iframes (one level deep)
          const nested = iframeDoc.querySelectorAll('iframe');
          for (const ni of nested) {
            try {
              const nestedDoc = ni.contentDocument;
              if (nestedDoc && nestedDoc.body) docs.push(nestedDoc);
            } catch (e) { /* cross-origin nested iframe */ }
          }
        }
      } catch (e) { /* cross-origin iframe — skip */ }
    }
    return docs;
  }

  function snapshotARIA() {
    // Reset registry
    window.__udRefRegistry = new Map();
    __udNextRef = 1;

    const lines = [];
    lines.push(`PAGE: ${document.title}`);
    lines.push(`URL: ${window.location.href}`);
    lines.push('');

    // Collect headings from main doc + iframes for structural context
    const headingLines = [];
    collectHeadings(document, headingLines);
    const iframeDocs = getSameOriginIframeDocs();
    for (const iframeDoc of iframeDocs) {
      collectHeadings(iframeDoc, headingLines);
    }
    if (headingLines.length > 0) {
      lines.push(...headingLines.slice(0, 20)); // cap at 20 headings
      lines.push('');
    }

    // Walk main document + all same-origin iframes for interactive elements
    const seen = new Set(); // dedup by fingerprint
    const elements = [];
    collectInteractiveElements(document, elements);
    for (const iframeDoc of iframeDocs) {
      collectInteractiveElements(iframeDoc, elements);
    }

    // Remove children-of-interactive: if a button contains a span that's
    // also interactive, keep only the outer button
    const filtered = elements.filter((el, i) => {
      for (let j = 0; j < elements.length; j++) {
        if (i !== j && elements[j].contains(el) && elements[j] !== el) return false;
      }
      return true;
    });

    // Collapse repeated structures (e.g. 50 Gmail rows)
    // Group by role+position pattern, collapse if >5 identical structures
    const groups = new Map(); // role → count

    for (const el of filtered) {
      const role = getElementRole(el) || el.tagName.toLowerCase();
      const name = getAccessibleName(el);
      const tag = el.tagName.toLowerCase();

      // Build fingerprint for dedup and execution-time resolution
      const fingerprint = {
        role,
        name,
        tag,
        type: (el.type || '').toLowerCase(),
        id: el.id || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        placeholder: el.placeholder || null,
        href: (tag === 'a' && el.href) ? el.href.slice(0, 120) : null
      };

      // Dedup: skip if identical role+name already emitted (same button twice)
      const dedupKey = `${role}:${name}:${fingerprint.type}`;
      if (seen.has(dedupKey) && !name) { // allow same-named items if they have names
        continue;
      }
      if (!name && seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Assign ref
      const ref = __udNextRef++;
      window.__udRefRegistry.set(ref, { element: el, fingerprint });

      // Format line
      let line = '';
      const displayName = name ? ` "${name}"` : '';
      const valueStr = el.value && (role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton')
        ? ` value="${el.value.slice(0, 50)}"`
        : '';
      const checkedStr = (role === 'checkbox' || role === 'radio') && el.checked ? ' [checked]' : '';
      const disabledStr = el.disabled ? ' [disabled]' : '';
      const hrefStr = fingerprint.href ? ` → ${fingerprint.href.slice(0, 60)}` : '';

      line = `${role}[${ref}]${displayName}${valueStr}${checkedStr}${disabledStr}${hrefStr}`;
      lines.push(line);

      // Track role frequency for collapse detection
      groups.set(role, (groups.get(role) || 0) + 1);
    }

    // If total refs exceed 200, log a warning (page is very dense)
    if (__udNextRef > 200) {
      console.warn(`[UD] ARIA snapshot: ${__udNextRef - 1} interactive elements. Consider viewport filtering.`);
    }

    return lines.join('\n');
  }

  // ============================================================
  // SEMANTIC SNAPSHOT — Hierarchical page reading
  // Like snapshotARIA but preserves page structure:
  // landmarks, regions, and sections become grouping headers
  // so the AI gets a *map* of the page, not a flat list.
  // Shares the same ref registry as snapshotARIA — resolveRef
  // and findTarget work identically for both.
  // ============================================================

  function snapshotSemantic() {
    // Reset ref registry (shared with resolveRef)
    window.__udRefRegistry = new Map();
    __udNextRef = 1;

    const lines = [];
    lines.push(`PAGE: ${document.title}`);
    lines.push(`URL: ${window.location.href}`);
    lines.push('');

    const emittedElements = new Set(); // children-of-interactive dedup

    // ── Landmark detection ──
    const landmarkTagMap = {
      header: 'HEADER', nav: 'NAVIGATION', main: 'MAIN CONTENT',
      aside: 'SIDEBAR', footer: 'FOOTER', section: 'SECTION',
      article: 'ITEM', form: 'FORM', dialog: 'DIALOG', search: 'SEARCH'
    };
    const landmarkRoleMap = {
      banner: 'HEADER', navigation: 'NAVIGATION', main: 'MAIN CONTENT',
      complementary: 'SIDEBAR', contentinfo: 'FOOTER', search: 'SEARCH',
      form: 'FORM', dialog: 'DIALOG', region: 'REGION', alertdialog: 'DIALOG'
    };

    // Class/ID heuristics for div-soup sites with no semantic HTML
    const classHeuristics = [
      { pattern: /\b(nav|navigation|menu)\b/i, label: 'NAVIGATION' },
      { pattern: /\b(header|masthead|top-?bar)\b/i, label: 'HEADER' },
      { pattern: /\b(footer|bottom-?bar)\b/i, label: 'FOOTER' },
      { pattern: /\b(sidebar|side-?bar|aside|filter)\b/i, label: 'SIDEBAR' },
      { pattern: /\bsearch\b/i, label: 'SEARCH' },
      { pattern: /\b(main|content|results|product-?list|feed)\b/i, label: 'MAIN CONTENT' },
      { pattern: /\b(card|product|item|listing|result)\b/i, label: 'ITEM' },
      { pattern: /\b(modal|overlay|popup|dialog|drawer)\b/i, label: 'DIALOG' },
    ];

    function detectLandmark(el) {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      if (role && landmarkRoleMap[role]) return landmarkRoleMap[role];
      if (landmarkTagMap[tag]) return landmarkTagMap[tag];
      // Heuristic: only for generic containers
      if (tag === 'div' || tag === 'ul' || tag === 'span') {
        const cls = (el.className || '').toString();
        const id = el.id || '';
        const testStr = `${cls} ${id}`;
        for (const h of classHeuristics) {
          if (h.pattern.test(testStr)) return h.label;
        }
      }
      return null;
    }

    function getLandmarkName(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const doc = el.ownerDocument || document;
        const parts = labelledBy.split(/\s+/)
          .map(id => doc.getElementById(id)?.textContent?.trim())
          .filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      // First direct-child heading
      const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
      if (heading) {
        const text = (heading.innerText || '').trim();
        if (text && text.length < 80) return text;
      }
      return null;
    }

    // Ref budgets for low-value regions (collapse after N refs)
    const regionRefBudgets = {
      'FOOTER': 5,
      'NAVIGATION': 10
    };

    function emitInteractive(el, depth, budget) {
      // Skip if inside an already-emitted interactive ancestor
      for (const emitted of emittedElements) {
        if (emitted !== el && emitted.contains(el)) return;
      }

      // Native form element priority: if this element is an ARIA wrapper
      // (div, span, etc. with a role) that CONTAINS a native form element
      // (input, textarea, select, [contenteditable="true"]), skip the wrapper.
      // The native element is what fill actions operate on — giving a ref
      // to a div[role="listbox"] is useless for text entry.
      // The walk will reach the native child next and emit it instead.
      const elTag = el.tagName.toLowerCase();
      const isNativeFormElement = ['input', 'textarea', 'select'].includes(elTag)
        || el.getAttribute('contenteditable') === 'true';
      if (!isNativeFormElement) {
        const nativeChild = el.querySelector(
          'input, textarea, select, [contenteditable="true"]'
        );
        if (nativeChild && isInteractive(nativeChild)) {
          // Check that the native child isn't hidden itself
          try {
            const win = nativeChild.ownerDocument?.defaultView || window;
            const childStyle = win.getComputedStyle(nativeChild);
            if (childStyle.display !== 'none' && childStyle.visibility !== 'hidden') {
              // Skip this wrapper — let the native child claim the ref
              return;
            }
          } catch {}
        }
      }

      // Check budget
      if (budget && budget.emitted >= budget.limit) {
        budget.overflow++;
        return;
      }

      const role = getElementRole(el) || el.tagName.toLowerCase();
      const name = getAccessibleName(el);
      const tag = el.tagName.toLowerCase();

      const fingerprint = {
        role, name, tag,
        type: (el.type || '').toLowerCase(),
        id: el.id || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        placeholder: el.placeholder || null,
        href: (tag === 'a' && el.href) ? el.href.slice(0, 120) : null
      };

      const ref = __udNextRef++;
      window.__udRefRegistry.set(ref, { element: el, fingerprint });
      emittedElements.add(el);
      if (budget) budget.emitted++;

      const displayName = name ? ` "${name}"` : '';
      const valueStr = el.value && ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(role)
        ? ` value="${el.value.slice(0, 50)}"` : '';
      const checkedStr = (role === 'checkbox' || role === 'radio') && el.checked ? ' [checked]' : '';
      const disabledStr = el.disabled ? ' [disabled]' : '';
      const hrefStr = fingerprint.href ? ` → ${fingerprint.href.slice(0, 60)}` : '';

      const indent = '  '.repeat(depth);
      lines.push(`${indent}${role}[${ref}]${displayName}${valueStr}${checkedStr}${disabledStr}${hrefStr}`);
    }

    // ── Recursive tree walker ──
    function walk(el, depth, parentBudget) {
      const win = el.ownerDocument?.defaultView || window;

      // Skip hidden subtrees
      try {
        const style = win.getComputedStyle(el);
        if (style.display === 'none') return;
      } catch { return; }

      // Detect landmark
      const landmark = detectLandmark(el);
      let budgetForChildren = parentBudget;

      if (landmark) {
        const name = getLandmarkName(el);
        const indent = '  '.repeat(depth);
        const label = name ? `[${landmark}] "${name}"` : `[${landmark}]`;
        lines.push(`${indent}${label}`);

        // Create scoped budget for low-value regions
        const cap = regionRefBudgets[landmark];
        if (cap != null) {
          budgetForChildren = { limit: cap, emitted: 0, overflow: 0 };
        }
        depth++;
      }

      // Emit interactive element (skip structural-only landmarks)
      if (isInteractive(el) && isVisible(el)) {
        const tag = el.tagName.toLowerCase();
        const isStructuralOnly = landmark
          && !['details', 'summary'].includes(tag)
          && !(el.hasAttribute('tabindex') && el.tabIndex >= 0);
        if (!isStructuralOnly) {
          emitInteractive(el, depth, budgetForChildren);
        }
      }

      // Recurse children
      for (const child of el.children) {
        walk(child, depth, budgetForChildren);
      }

      // After a budgeted landmark, emit overflow summary
      if (landmark && budgetForChildren && budgetForChildren !== parentBudget && budgetForChildren.overflow > 0) {
        const indent = '  '.repeat(depth);
        lines.push(`${indent}...and ${budgetForChildren.overflow} more items`);
      }
    }

    // Walk main document
    if (document.body) {
      walk(document.body, 0, null);
    }

    // Walk same-origin iframes (critical for Gmail compose, etc.)
    const iframeDocs = getSameOriginIframeDocs();
    if (iframeDocs.length > 0) {
      for (const iframeDoc of iframeDocs) {
        lines.push('');
        lines.push('[IFRAME]');
        if (iframeDoc.body) {
          walk(iframeDoc.body, 1, null);
        }
      }
    }

    // ── Rescue pass: catch interactive elements the tree walk missed ──
    // The tree walk skips display:none subtrees. But some sites (Gmail)
    // pre-render compose dialogs inside display:none containers that get
    // toggled visible after the page "settles". The elements themselves
    // have meaningful aria-labels and roles but zero bounding rects
    // because their ancestor is display:none.
    //
    // Strategy: query ALL interactive elements, skip those already emitted,
    // and rescue those with strong identity (aria-label, role+name, or
    // named input). Skip truly hidden elements (own display:none or
    // visibility:hidden), but do NOT require bounding rect > 0.
    const rescueSelector = [
      'input', 'textarea', 'select', 'button',
      '[role="button"]', '[role="textbox"]', '[role="combobox"]',
      '[contenteditable="true"]'
    ].join(', ');

    function rescueFromDoc(doc) {
      const win = doc.defaultView || window;
      const candidates = doc.querySelectorAll(rescueSelector);
      let count = 0;
      for (const el of candidates) {
        if (emittedElements.has(el)) continue;
        if (!isInteractive(el)) continue;
        // Element's OWN computed style must not be explicitly hidden
        try {
          const style = win.getComputedStyle(el);
          if (style.display === 'none') continue;
          // For visibility: check the element itself, not ancestors.
          // visibility:hidden is inherited, so computed may say hidden
          // even when the element has no explicit override. But if the
          // element or a close ancestor explicitly sets visibility:visible,
          // getComputedStyle returns 'visible'. If it returns 'hidden',
          // the element truly inherits hidden with no override → skip.
          if (style.visibility === 'hidden') continue;
        } catch { continue; }
        // Require identity signals — prevents rescuing random hidden divs.
        // An element qualifies if it has ANY of:
        //   - aria-label
        //   - name attribute
        //   - placeholder
        //   - role with explicit aria-label/aria-labelledby
        //   - id that looks functional (not random hash)
        const ariaLabel = el.getAttribute('aria-label');
        const elName = el.getAttribute('name');
        const placeholder = el.getAttribute('placeholder');
        const labelledBy = el.getAttribute('aria-labelledby');
        const id = el.id;
        const role = el.getAttribute('role');
        const hasIdentity = ariaLabel || elName || placeholder || labelledBy
          || (role && (ariaLabel || labelledBy))
          || (id && !/^[a-f0-9]{8,}$/i.test(id)); // skip random hash IDs
        if (!hasIdentity) {
          // Last chance: if element has visible text content (buttons with labels)
          const text = (el.innerText || el.textContent || '').trim();
          if (!text || text.length > 80) continue;
        }
        // Skip if inside an already-emitted interactive parent
        // EXCEPTION: native form elements (input, textarea, select,
        // contenteditable) are never skipped — they're what fill
        // actions need, even if an ARIA wrapper parent was emitted.
        let insideEmitted = false;
        const elTag = el.tagName.toLowerCase();
        const isNativeForm = ['input', 'textarea', 'select'].includes(elTag)
          || el.getAttribute('contenteditable') === 'true';
        if (!isNativeForm) {
          for (const emitted of emittedElements) {
            if (emitted !== el && emitted.contains(el)) { insideEmitted = true; break; }
          }
        }
        if (insideEmitted) continue;
        // Emit it
        emitInteractive(el, 1, null);
        count++;
      }
      return count;
    }

    let rescueCount = rescueFromDoc(document);
    for (const iframeDoc of iframeDocs) {
      rescueCount += rescueFromDoc(iframeDoc);
    }
    if (rescueCount > 0) {
      const rescueStart = lines.length - rescueCount;
      lines.splice(rescueStart, 0, '', '[RESCUED ELEMENTS] (in hidden container but interactive)');
      console.log(`[UD] Semantic snapshot: rescued ${rescueCount} elements missed by tree walk`);
    }

    // ── Layer 4: Deep DOM Heuristics ──
    // On div-soup sites with few ARIA/semantic tags, the tree walk and
    // rescue pass may miss clickable elements that are only detectable
    // via computed style (cursor:pointer) or inline event handlers.
    // This pass fires ONLY when the snapshot is thin (<10 refs) to
    // avoid overhead and noise on well-tagged sites.
    const preHeuristicRefCount = __udNextRef - 1;

    if (preHeuristicRefCount < 10) {
      const heuristicHits = [];
      const HEURISTIC_CAP = 20;

      function probeHeuristic(doc) {
        const win = doc.defaultView || window;
        // Query generic containers that could be secretly interactive
        const candidates = doc.querySelectorAll('div, span, li, img, svg, td, label, a:not([href])');

        for (const el of candidates) {
          if (heuristicHits.length >= HEURISTIC_CAP) break;
          if (emittedElements.has(el)) continue;
          // Already caught by isInteractive — skip
          if (isInteractive(el)) continue;

          // Skip hidden/zero-size
          try {
            const style = win.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
          } catch { continue; }
          const rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          // Viewport gate: heuristic elements are uncertain, only show visible ones
          if (rect.bottom < 0 || rect.top > win.innerHeight) continue;
          if (rect.right < 0 || rect.left > win.innerWidth) continue;

          // ── Score heuristic signals ──
          let score = 0;
          const signals = [];

          // Medium-strong signal (+2): cursor:pointer alone is common on
          // non-interactive elements (tooltips, labels, decorative wrappers).
          // Needs at least one other signal to reach the score >= 4 threshold.
          try {
            const style = win.getComputedStyle(el);
            if (style.cursor === 'pointer') { score += 2; signals.push('pointer'); }
          } catch {}

          // Strong signals (+3 each)
          if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup') || el.hasAttribute('ontouchstart')) {
            score += 3; signals.push('onclick');
          }
          if (el.hasAttribute('data-action') || el.hasAttribute('data-click') || el.hasAttribute('data-command') || el.hasAttribute('data-handler')) {
            score += 3; signals.push('data-action');
          }

          // Medium signals (+2 each)
          if (el.hasAttribute('data-href') || el.hasAttribute('data-url') || el.hasAttribute('data-link') || el.hasAttribute('data-navigate')) {
            score += 2; signals.push('data-href');
          }
          if (el.hasAttribute('data-toggle') || el.hasAttribute('data-target') || el.hasAttribute('data-dismiss') || el.hasAttribute('data-bs-toggle')) {
            score += 2; signals.push('data-toggle');
          }
          try {
            const style = win.getComputedStyle(el);
            if (style.userSelect === 'none' || style.webkitUserSelect === 'none') {
              score += 2; signals.push('no-select');
            }
          } catch {}

          // Weak signals (+1 each)
          const cls = (el.className || '').toString().toLowerCase();
          const elId = (el.id || '').toLowerCase();
          if (/\b(btn|button|click|toggle|action|selectable|interactive|cta|trigger)\b/.test(cls + ' ' + elId)) {
            score += 1; signals.push('class-hint');
          }
          // Image inside a pointer container (card pattern)
          if (el.tagName.toLowerCase() === 'img' || el.querySelector('img')) {
            try {
              const pStyle = win.getComputedStyle(el.parentElement);
              if (pStyle.cursor === 'pointer') { score += 1; signals.push('img-in-pointer'); }
            } catch {}
          }

          // Require score >= 4 (pointer alone not enough; needs pointer + onclick,
          // pointer + data-action, or other strong combos)
          if (score < 4) continue;

          // Skip if inside an already-emitted interactive parent
          let insideEmitted = false;
          for (const emitted of emittedElements) {
            if (emitted !== el && emitted.contains(el)) { insideEmitted = true; break; }
          }
          if (insideEmitted) continue;

          // Track immediately for nested-element dedup within this pass
          emittedElements.add(el);
          heuristicHits.push({ el, score, signals });
        }
      }

      probeHeuristic(document);
      for (const iframeDoc of iframeDocs) {
        probeHeuristic(iframeDoc);
      }

      // Sort by score descending, emit top hits
      heuristicHits.sort((a, b) => b.score - a.score);

      if (heuristicHits.length > 0) {
        lines.push('');
        lines.push('[DEEP HEURISTICS] (detected via style/event signals, not ARIA)');

        for (const { el, score, signals } of heuristicHits) {
          const tag = el.tagName.toLowerCase();
          const name = getAccessibleName(el);
          const fingerprint = {
            role: 'heuristic', name, tag,
            type: '', id: el.id || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            placeholder: null,
            href: el.getAttribute('data-href') || el.getAttribute('data-url') || null
          };

          const ref = __udNextRef++;
          window.__udRefRegistry.set(ref, { element: el, fingerprint });
          emittedElements.add(el);

          const displayName = name ? ` "${name}"` : '';
          const signalStr = ` [${signals.join(',')}]`;
          lines.push(`  heuristic[${ref}]${displayName}${signalStr}`);
        }

        console.log(`[UD] Deep heuristics: found ${heuristicHits.length} elements via style/event signals`);
      }
    }

    const refCount = __udNextRef - 1;
    if (refCount > 200) {
      console.warn(`[UD] Semantic snapshot: ${refCount} refs. Consider viewport filtering.`);
    }

    return lines.join('\n');
  }

  /**
   * Resolve an ARIA ref to a live DOM element.
   * Uses the registry first, then falls back to fingerprint matching
   * against the current DOM in case React repainted.
   */
  function resolveRef(ref) {
    const entry = window.__udRefRegistry.get(ref);
    if (!entry) return null;

    // Fast path: element still in DOM and visible
    // Use ownerDocument for cross-iframe element support
    if (entry.element) {
      const ownerDoc = entry.element.ownerDocument || document;
      if (ownerDoc.contains(entry.element)) {
        return entry.element;
      }
    }

    // Slow path: fingerprint match against live DOM
    const fp = entry.fingerprint;
    if (!fp) return null;

    // Try by ID first (fastest)
    if (fp.id) {
      const byId = document.getElementById(fp.id);
      if (byId) return byId;
    }

    // Try by aria-label
    if (fp.ariaLabel) {
      const candidates = document.querySelectorAll(`[aria-label="${fp.ariaLabel.replace(/"/g, '\\"')}"]`);
      if (candidates.length === 1) return candidates[0];
      // If multiple, match by role too
      for (const c of candidates) {
        if (getElementRole(c) === fp.role) return c;
      }
    }

    // Try by role + name combo
    const roleSelector = fp.role ? `[role="${fp.role}"]` : null;
    if (roleSelector && fp.name) {
      const candidates = document.querySelectorAll(roleSelector);
      for (const c of candidates) {
        if (getAccessibleName(c) === fp.name) return c;
      }
    }

    // Try by placeholder
    if (fp.placeholder) {
      const el = document.querySelector(`[placeholder="${fp.placeholder.replace(/"/g, '\\"')}"]`);
      if (el) return el;
    }

    // Last resort: walk all interactive elements looking for name match
    // Search main doc + all same-origin iframes
    if (fp.name) {
      const docsToSearch = [document, ...getSameOriginIframeDocs()];
      const selector = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
      for (const searchDoc of docsToSearch) {
        const all = searchDoc.querySelectorAll(selector);
        for (const el of all) {
          if (getAccessibleName(el) === fp.name && getElementRole(el) === fp.role) return el;
        }
      }
    }

    return null;
  }

  function findElement(primarySelector, context = {}) {
    // Auto-extract context from selector string when not explicitly provided
    if (!context.ariaLabel && primarySelector) {
      const ariaMatch = primarySelector.match(/aria-label=['"]([^'"]+)['"]/);
      if (ariaMatch) context = { ...context, ariaLabel: ariaMatch[1] };
    }
    if (!context.text && primarySelector) {
      const textMatch = primarySelector.match(/(?:has-text|contains)\(['"]?([^)'"]+)['"]?\)/);
      if (textMatch) context = { ...context, text: textMatch[1] };
    }

    // Strategy 1: direct selector
    try {
      const direct = document.querySelector(primarySelector);
      if (direct) return direct;
    } catch {}

    // Strategy 2: by name
    if (context.name) {
      const byName = document.querySelector(`[name="${context.name}"]`);
      if (byName) return byName;
    }

    // Strategy 3: by aria-label (exact then partial)
    if (context.ariaLabel) {
      const exactAria = document.querySelector(`[aria-label="${context.ariaLabel}"]`);
      if (exactAria) return exactAria;
      const allAria = document.querySelectorAll('[aria-label]');
      for (const el of allAria) {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes(String(context.ariaLabel).toLowerCase())) return el;
      }
    }

    // Strategy 4: by placeholder (exact then partial)
    if (context.placeholder) {
      const exactPlaceholder = document.querySelector(`[placeholder="${context.placeholder}"]`);
      if (exactPlaceholder) return exactPlaceholder;
      const all = document.querySelectorAll('[placeholder]');
      for (const el of all) {
        if ((el.placeholder || '').toLowerCase().includes(String(context.placeholder).toLowerCase())) return el;
      }
    }

    // Strategy 5: by visible text for clickables
    if (context.text) {
      const clickables = document.querySelectorAll('button, a, [role="button"], [role="link"]');
      const target = String(context.text).toLowerCase().trim();
      for (const el of clickables) {
        if ((el.innerText || '').toLowerCase().trim() === target) return el;
      }
      for (const el of clickables) {
        if ((el.innerText || '').toLowerCase().includes(target)) return el;
      }
    }

    return null;
  }

  function recordSiteMemory(selector, type) {
    const hostname = window.location.hostname;
    const memoryKey = `siteMemory_${hostname}`;
    chrome.storage.local.get(memoryKey, (result) => {
      const existing = result[memoryKey] || {};
      existing[selector] = {
        type,
        lastVerified: Date.now(),
        successCount: (existing[selector]?.successCount || 0) + 1
      };
      chrome.storage.local.set({ [memoryKey]: existing });
    });
  }

  function evictSiteMemory(selector) {
    if (!selector) return;
    const hostname = window.location.hostname;
    const memoryKey = `siteMemory_${hostname}`;
    chrome.storage.local.get(memoryKey, (result) => {
      const existing = result[memoryKey] || {};
      if (!Object.prototype.hasOwnProperty.call(existing, selector)) return;
      delete existing[selector];
      chrome.storage.local.set({ [memoryKey]: existing });
    });
  }

  // ============================================================
  // TEACH CAPTURE — "Show Me" system
  // When activated, captures the user's next click or input
  // and reports back full element context for site memory.
  // ============================================================

  let teachCaptureActive = false;
  let teachOverlay = null;

  function generateUniqueSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // 1. ID
    if (el.id) {
      const sel = `#${CSS.escape(el.id)}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
    }

    // 2. aria-label alone
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const sel = `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
    }

    // 3. role + aria-label
    const role = el.getAttribute('role');
    if (role && aria) {
      const sel = `[role="${role}"][aria-label="${aria.replace(/"/g, '\\"')}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
    }

    // 4. name attribute
    const name = el.getAttribute('name');
    if (name) {
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}[name="${CSS.escape(name)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
    }

    // 5. data-testid
    for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-action']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
      }
    }

    // 6. Build parent > child path
    const path = [];
    let current = el;
    while (current && current !== document.body && path.length < 5) {
      let segment = current.tagName.toLowerCase();
      if (current.id) {
        segment = `#${CSS.escape(current.id)}`;
        path.unshift(segment);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          segment += `:nth-of-type(${index})`;
        }
      }
      path.unshift(segment);
      current = parent;
    }
    return path.join(' > ');
  }

  function captureElementContext(el) {
    const tag = el.tagName.toLowerCase();
    const isInput = (tag === 'input' || tag === 'textarea' || tag === 'select' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox');
    return {
      selector: generateUniqueSelector(el),
      tag,
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      role: el.getAttribute('role') || null,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      text: (el.innerText || '').trim().slice(0, 80) || null,
      href: el.href || null,
      type: el.type || null,
      className: el.className ? String(el.className).slice(0, 120) : null,
      actionType: isInput ? 'fill' : 'click',
      url: window.location.href,
      hostname: window.location.hostname,
      timestamp: Date.now()
    };
  }

  function showTeachOverlay() {
    if (teachOverlay) return;
    teachOverlay = document.createElement('div');
    teachOverlay.id = '__ud-teach-overlay';
    Object.assign(teachOverlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      height: '3px',
      background: '#3b82f6',
      zIndex: '2147483646',
      pointerEvents: 'none',
      boxShadow: '0 0 12px rgba(59, 130, 246, 0.6)',
      transition: 'opacity 0.3s'
    });
    document.body.appendChild(teachOverlay);

    // Also add a small label
    const label = document.createElement('div');
    label.id = '__ud-teach-label';
    label.textContent = '🎯 Presence is watching — click what I should click';
    Object.assign(label.style, {
      position: 'fixed',
      top: '6px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#3b82f6',
      color: '#fff',
      padding: '6px 16px',
      borderRadius: '20px',
      fontSize: '13px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      fontWeight: '600',
      zIndex: '2147483646',
      pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)'
    });
    document.body.appendChild(label);
  }

  function removeTeachOverlay() {
    const overlay = document.getElementById('__ud-teach-overlay');
    const label = document.getElementById('__ud-teach-label');
    if (overlay) overlay.remove();
    if (label) label.remove();
    teachOverlay = null;
  }

  function onTeachClick(e) {
    // Ignore clicks on the UD panel iframe itself
    if (e.target.id === '__ud-panel' || e.target.id === '__ud-teach-overlay' || e.target.id === '__ud-teach-label') return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const context = captureElementContext(e.target);
    console.log('[UD] Teach capture:', context);

    // Clean up
    deactivateTeachCapture();

    // Send result back to background
    safeSend({ type: 'TEACH_CAPTURE_RESULT', context });
  }

  function activateTeachCapture() {
    if (teachCaptureActive) return;
    teachCaptureActive = true;
    showTeachOverlay();
    // Use capture phase to intercept before any page handlers
    document.addEventListener('click', onTeachClick, true);
    console.log('[UD] Teach capture activated');
  }

  function deactivateTeachCapture() {
    teachCaptureActive = false;
    document.removeEventListener('click', onTeachClick, true);
    removeTeachOverlay();
    console.log('[UD] Teach capture deactivated');
  }

  // ============================================================
  // VIEWPORT GRID SCANNER (Layer 3 — Screenshot Fallback bridge)
  // When the semantic snapshot can't read a page (div-soup),
  // the AI uses a screenshot for perception. But actions still
  // need DOM refs. This scanner probes the viewport with
  // elementsFromPoint() to discover interactive elements that
  // have no semantic markup.
  // ============================================================

  function scanViewportGrid(options = {}) {
    const {
      gridCols = 10,       // horizontal probe points
      gridRows = 8,        // vertical probe points
      regions = null       // optional [{x, y, width, height}] to focus scan
    } = options;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const found = new Map(); // element → metadata (dedup by element identity)
    const scannedPoints = [];

    function probePoint(x, y) {
      // elementsFromPoint returns all elements at this coordinate,
      // from front to back. We want the topmost interactive one.
      const elements = document.elementsFromPoint(x, y);
      for (const el of elements) {
        if (found.has(el)) continue;
        // Skip the UD panel and its children
        if (el.id === '__ud-panel' || el.closest('#__ud-panel')) continue;
        // Skip body/html
        if (el === document.body || el === document.documentElement) continue;

        // Detect interactivity via computed style and attributes
        const win = el.ownerDocument?.defaultView || window;
        let style;
        try { style = win.getComputedStyle(el); } catch { continue; }

        const isSemanticInteractive = isInteractive(el);
        const hasPointerCursor = style.cursor === 'pointer';
        const hasTabindex = el.hasAttribute('tabindex') && el.tabIndex >= 0;
        const hasOnClick = el.hasAttribute('onclick');
        const hasDataAction = el.hasAttribute('data-action') || el.hasAttribute('data-click');

        // Strong signal: semantically interactive OR pointer cursor + some other signal
        const isLikelyInteractive = isSemanticInteractive
          || (hasPointerCursor && (hasTabindex || hasOnClick || hasDataAction))
          || (hasPointerCursor && el.children.length < 5); // small pointer-cursor container = button-like

        if (!isLikelyInteractive) continue;

        // Get useful identification info
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue; // too small to be real

        const role = getElementRole(el) || (hasPointerCursor ? 'button' : el.tagName.toLowerCase());
        const name = getAccessibleName(el);
        const tag = el.tagName.toLowerCase();

        // Register in the shared ref registry so the AI can act on it
        const fingerprint = {
          role, name, tag,
          type: (el.type || '').toLowerCase(),
          id: el.id || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          placeholder: el.placeholder || null,
          href: (tag === 'a' && el.href) ? el.href.slice(0, 120) : null
        };
        const ref = __udNextRef++;
        window.__udRefRegistry.set(ref, { element: el, fingerprint });

        found.set(el, {
          ref,
          role,
          name: name || null,
          tag,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          pointer: hasPointerCursor,
          source: isSemanticInteractive ? 'semantic' : 'heuristic'
        });

        break; // only take topmost interactive element per point
      }
    }

    if (regions && regions.length > 0) {
      // Scan specific regions of interest (from AI vision analysis)
      for (const region of regions) {
        const stepX = region.width / Math.max(gridCols, 1);
        const stepY = region.height / Math.max(gridRows, 1);
        for (let row = 0; row <= gridRows; row++) {
          for (let col = 0; col <= gridCols; col++) {
            const x = region.x + col * stepX;
            const y = region.y + row * stepY;
            if (x >= 0 && x < viewportW && y >= 0 && y < viewportH) {
              probePoint(x, y);
              scannedPoints.push({ x: Math.round(x), y: Math.round(y) });
            }
          }
        }
      }
    } else {
      // Full viewport grid scan
      const stepX = viewportW / (gridCols + 1);
      const stepY = viewportH / (gridRows + 1);
      for (let row = 1; row <= gridRows; row++) {
        for (let col = 1; col <= gridCols; col++) {
          const x = col * stepX;
          const y = row * stepY;
          probePoint(x, y);
          scannedPoints.push({ x: Math.round(x), y: Math.round(y) });
        }
      }
    }

    // Format results as snapshot-compatible lines
    const lines = [];
    lines.push('[GRID SCAN RESULTS] (interactive elements found by viewport probing)');
    const entries = Array.from(found.values());

    if (entries.length === 0) {
      lines.push('  No interactive elements found in scanned area.');
    } else {
      // Group by approximate vertical position for readability
      entries.sort((a, b) => a.rect.y - b.rect.y);
      for (const entry of entries) {
        const displayName = entry.name ? ` "${entry.name}"` : '';
        const posHint = ` @(${entry.rect.x},${entry.rect.y} ${entry.rect.width}x${entry.rect.height})`;
        const sourceTag = entry.source === 'heuristic' ? ' [pointer]' : '';
        lines.push(`  ${entry.role}[${entry.ref}]${displayName}${posHint}${sourceTag}`);
      }
    }

    return {
      text: lines.join('\n'),
      count: entries.length,
      points: scannedPoints.length,
      elements: entries
    };
  }

  // ============================================================
  // MESSAGE HANDLER
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_ACTION') {
      executeAction(message.action)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'UD_STATUS_UPDATE') {
      safeSend({
        type: 'STATUS_UPDATE',
        status: message.status,
        message: message.message
      }, (response) => {
        if (response?.error) {
          console.warn('[UD] STATUS_UPDATE relay failed:', response.error);
        }
      });
    }

    if (message.type === 'GET_CONTEXT') {
      sendResponse({
        url: window.location.href,
        title: document.title,
        body: pruneDOM()
      });
    }

    if (message.type === 'GET_ARIA_SNAPSHOT') {
      const snapshot = snapshotARIA();
      sendResponse({
        url: window.location.href,
        title: document.title,
        body: snapshot,
        refCount: __udNextRef - 1
      });
    }

    if (message.type === 'GET_SEMANTIC_SNAPSHOT') {
      const snapshot = snapshotSemantic();
      sendResponse({
        url: window.location.href,
        title: document.title,
        body: snapshot,
        refCount: __udNextRef - 1
      });
    }

    if (message.type === 'SCAN_VIEWPORT_GRID') {
      const result = scanViewportGrid({
        gridCols: message.gridCols || 10,
        gridRows: message.gridRows || 8,
        regions: message.regions || null
      });
      sendResponse(result);
    }

    if (message.type === 'RESOLVE_REF') {
      const el = resolveRef(message.ref);
      if (!el) {
        sendResponse({ success: false, error: `ref ${message.ref} not found` });
      } else {
        sendResponse({
          success: true,
          tag: el.tagName.toLowerCase(),
          role: getElementRole(el),
          name: getAccessibleName(el)
        });
      }
    }

    if (message.type === 'ACTIVATE_TEACH_CAPTURE') {
      activateTeachCapture();
      sendResponse({ success: true });
    }

    if (message.type === 'DEACTIVATE_TEACH_CAPTURE') {
      deactivateTeachCapture();
      sendResponse({ success: true });
    }
  });

  /**
   * Find the target element: prefers ref (ARIA snapshot) over selector (legacy).
   */
  function findTarget(action) {
    // New path: ref-based resolution
    if (action.ref != null) {
      const el = resolveRef(Number(action.ref));
      if (el) return el;
      // ref failed — fall through to selector if available
    }
    // Legacy path: selector + fallback chain
    if (action.selector) {
      return findElement(action.selector, {
        name: action.name,
        placeholder: action.placeholder,
        ariaLabel: action.ariaLabel,
        text: action.text
      });
    }
    return null;
  }

  async function executeAction(action) {
    switch (action.type) {
      case 'fill': {
        let el = findTarget(action);
        if (!el) {
          if (action.selector) evictSiteMemory(action.selector);
          const target = action.ref != null ? `ref ${action.ref}` : action.selector;
          return { success: false, error: `fill: target not found: ${target}` };
        }

        // If target is inside a display:none ancestor, try to expand it.
        // Gmail collapses the To input when focus leaves; clicking the
        // visible siblings/parent re-expands it.
        const hiddenAncestor = (function findHiddenAncestor(node) {
          let cur = node.parentElement;
          while (cur && cur !== document.body) {
            if (getComputedStyle(cur).display === 'none') return cur;
            cur = cur.parentElement;
          }
          return null;
        })(el);
        if (hiddenAncestor) {
          // Find nearest visible sibling or parent to click for expansion
          const expandTarget = hiddenAncestor.previousElementSibling
            || hiddenAncestor.nextElementSibling
            || hiddenAncestor.parentElement;
          if (expandTarget) {
            expandTarget.click();
            await new Promise(r => setTimeout(r, 500));
            // Re-resolve: the element ref may now point to a visible copy
            el = findTarget(action);
            if (!el) {
              return { success: false, error: `fill: target hidden and expand failed` };
            }
          }
        }

        // Contenteditable elements (Gmail compose, Google Docs, etc.)
        const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
          el.getAttribute('role') === 'textbox' ||
          el.isContentEditable;

        if (isContentEditable) {
          el.focus();
          // Clear existing content
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          // Use execCommand for maximum compatibility with rich editors
          // (dispatches all the internal events Gmail/Docs listen for)
          const inserted = document.execCommand('insertText', false, action.value);
          if (!inserted) {
            // Fallback: direct text injection
            el.textContent = action.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // Standard input/textarea
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, action.value);
          else el.value = action.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Auto-commit: combobox/autocomplete fields (e.g. Gmail To) need
        // Enter or Tab to confirm the value after filling.
        const elRole = el.getAttribute('role') || '';
        const isCombobox = elRole === 'combobox' || el.closest('[role="combobox"]');
        const isAutocomplete = el.getAttribute('aria-autocomplete');
        const isGmailTo = el.getAttribute('aria-label')?.toLowerCase().includes('to');
        if (isCombobox || isAutocomplete || isGmailTo) {
          // Short delay for autocomplete dropdown to populate
          await new Promise(r => setTimeout(r, 300));
          el.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true, cancelable: true
          }));
          el.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true
          }));
        }

        if (action.selector) recordSiteMemory(action.selector, action.type);
        return { success: true };
      }

      case 'click': {
        const el = findTarget(action);
        if (!el) {
          if (action.selector) evictSiteMemory(action.selector);
          const target = action.ref != null ? `ref ${action.ref}` : action.selector;
          return { success: false, error: `click: target not found: ${target}` };
        }

        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        if (action.selector) recordSiteMemory(action.selector, action.type);
        return { success: true };
      }

      case 'scroll': {
        const amount = action.amount || 500;
        const direction = action.direction === 'up' ? -1 : 1;
        if (action.selector) {
          const el = document.querySelector(action.selector);
          if (!el) return { success: false, error: `scroll: selector not found: ${action.selector}` };
          el.scrollBy(0, direction * amount);
        } else {
          window.scrollBy(0, direction * amount);
        }
        return { success: true };
      }

      case 'navigate': {
        if (!action.url) return { success: false, error: 'navigate: missing url' };
        window.location.href = action.url;
        return { success: true };
      }

      case 'read':
      case 'readDOM':
        return {
          success: true,
          url: window.location.href,
          title: document.title,
          body: snapshotSemantic()
        };

      case 'key': {
        const el = action.selector ? document.querySelector(action.selector) : document.activeElement;
        if (!el) return { success: false, error: `key: selector not found: ${action.selector}` };
        const key = action.value || '';
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key,
          code: key === 'Enter' ? 'Enter' : key,
          keyCode: key === 'Enter' ? 13 : 0,
          bubbles: true,
          cancelable: true
        }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        if (key === 'Enter' && el.form) {
          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }
}
