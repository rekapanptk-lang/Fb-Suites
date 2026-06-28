// ==UserScript==
// @name         FB Sponsored Ads Link Scraper
// @namespace    https://riko.local/fbscraper
// @version      73.2.0
// @description  v73.2.0 - SMM multi-service retry per akun: kalau service A gagal, try service B di akun yang sama; "Saldo tidak cukup" / "API Key salah" → fallback ke akun lain. v73.1.0 = filter min_comment_inbox/belumAda/timeout-no-count DIHAPUS + SMM order ambil urut #1-N. v73.0.0 = SMM order quantity logic. v72.39.x = simplified keyword check + permalink.php hardening.
// @author       Riko
// @match        *://*.facebook.com/*
// @match        *://*.messenger.com/*
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      googleusercontent.com
// @connect      api.all-uneed.com
// @connect      pusatpanelsmm.com
// @connect      buzzerpanel.id
// @connect      web.facebook.com
// @connect      www.facebook.com
// @connect      m.facebook.com
// @connect      facebook.com
// @connect      *
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxe3mCNLCDfmEEwHpi4EKEAVTrAyoAewPIakY4F3ZQ0qNVhr3PBWWOfx5vNWLQ76YQGKQ/exec';
    const CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const CONFIG_INITIAL_FETCH_RETRY_MS = [5000, 10000, 20000, 30000, 60000];

    const TM_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '?.?.?';

    const hostname = window.location.hostname || '';
    const isFacebookTab = /(^|\.)facebook\.com$/i.test(hostname) ||
                         /(^|\.)messenger\.com$/i.test(hostname) ||
                         hostname.endsWith('fbcdn.net');
    if (!isFacebookTab) return;

    const realWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    realWindow.__fbLastClipboardUrl = null;
    realWindow.__fbClipboardTimestamp = 0;

    try {
        if (realWindow.navigator.clipboard && realWindow.navigator.clipboard.writeText) {
            const orig = realWindow.navigator.clipboard.writeText.bind(realWindow.navigator.clipboard);
            realWindow.navigator.clipboard.writeText = function(text) {
                try {
                    if (text && typeof text === 'string' && text.startsWith('http')) {
                        realWindow.__fbLastClipboardUrl = text;
                        realWindow.__fbClipboardTimestamp = Date.now();
                    }
                } catch (e) {}
                return orig(text);
            };
        }
        const origExec = document.execCommand.bind(document);
        document.execCommand = function(cmd, ...args) {
            if (cmd === 'copy') {
                try {
                    const sel = window.getSelection();
                    const text = sel ? sel.toString() : '';
                    if (text && text.startsWith('http')) {
                        realWindow.__fbLastClipboardUrl = text;
                        realWindow.__fbClipboardTimestamp = Date.now();
                    }
                } catch (e) {}
            }
            return origExec(cmd, ...args);
        };
        document.addEventListener('copy', (e) => {
            try {
                const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
                if (text && text.startsWith('http')) {
                    realWindow.__fbLastClipboardUrl = text;
                    realWindow.__fbClipboardTimestamp = Date.now();
                }
            } catch (e) {}
        }, true);
    } catch (e) {}

    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else setTimeout(fn, 100);
    }
    onReady(() => { mainScript(); });

    const FEED_URL_V16 = 'https://www.facebook.com/';
    const NEED_RELOAD_AFTER_NAV_KEY = 'fb_scraper_need_reload_after_nav_v72_31';
    const RELOAD_AFTER_NAV_DELAY_MS = 4000;

    function navigateToFeedRecover(reason) {
        try {
            console.error('[FB Scraper v73.2.0] navigateToFeedRecover called outside mainScript scope: ' + reason);
        } catch (e) {}
    }

    let globalErrorCount = 0;
    function scheduleGlobalErrorReload(reason) {
        try {
            globalErrorCount++;
            console.warn('[FB Scraper v73.2.0] WOULD REFRESH (global-error, disabled): ' + reason + ' (total: ' + globalErrorCount + ')');
        } catch (e) {}
    }

    window.addEventListener('error', function(e) {
        const msg = (e && e.message) || (e && e.error && e.error.message) || 'unknown';
        if (/Script error|ResizeObserver|Loading chunk/i.test(msg)) return;
        scheduleGlobalErrorReload('window.error: ' + msg);
    });
    window.addEventListener('unhandledrejection', function(e) {
        const reason = (e && e.reason && e.reason.message) || (e && e.reason) || 'unknown';
        scheduleGlobalErrorReload('unhandledrejection: ' + reason);
    });

    function mainScript() {

    const STORAGE_KEY = 'fb_sponsored_links_v69';
    const AUTO_RESUME_KEY = 'fb_scraper_auto_resume_v69';
    const AKUN_FB_KEY = 'fb_scraper_akun_fb_v69';
    const PANEL_ZOOM_KEY = 'fb_scraper_panel_zoom_v69';
    const V72_29_FLUSH_KEY = 'fb_scraper_v72_29_flushed';

    const SMM_PROVIDERS = {
        'all-uneed': { label: 'All U Need', api_url: 'https://api.all-uneed.com/api/v2/order', requiredFields: ['api_id', 'api_key'] },
        'ppi': { label: 'Pusat Panel SMM', api_url: 'https://pusatpanelsmm.com/api/json.php', requiredFields: ['api_key', 'secret_key'] },
        'bp': { label: 'BuzzerPanel', api_url: 'https://buzzerpanel.id/api/json.php', requiredFields: ['api_key', 'secret_key'] }
    };

    const SMM_RR_GLOBAL_COUNTER_KEY = 'fb_scraper_smm_rr_global_counter_v72_29';
    const COMMENT_MODAL_READINESS_POLL_MS = 500;
    const PANEL_ZOOM_MIN = 0.5;
    const PANEL_ZOOM_MAX = 2.5;
    const PANEL_ZOOM_STEP = 0.1;
    const FEED_URL = 'https://www.facebook.com/';
    const HEARTBEAT_KEY = 'fb_scraper_heartbeat_v69';
    const HEARTBEAT_TIMEOUT_MS = 180 * 1000;
    const WORKER_PING_INTERVAL_MS = 5000;
    const PAGE_FULL_LOAD_WAIT_MS = 8000;

    // v72.39.0: Delay tunggu articles muncul di dialog setelah modal ready
    const ARTICLE_SCAN_WAIT_MS = 3000;

    function navigateToFeedRecover(reason) {
        try {
            const allowRefresh = (
                reason === 'scroll-stuck' ||
                reason === 'fb-error-visible' ||
                reason === 'fb-error-after-scroll'
            );
            if (allowRefresh) {
                console.warn('[FB Scraper v73.2.0] REFRESH AKTIF: ' + reason);
                addLog('REFRESH: ' + reason, 'error');
                GM_setValue(NEED_RELOAD_AFTER_NAV_KEY, '1');
                GM_setValue(AUTO_RESUME_KEY, '1');
                window.location.href = FEED_URL_V16;
            } else {
                console.error('[FB Scraper v73.2.0] WOULD REFRESH (disabled): ' + reason);
                addLog('WOULD REFRESH: ' + reason + ' (disabled, lanjut scroll)', 'error');
            }
        } catch (e) {}
    }

    flushOldStorageIfNeeded();

    function flushOldStorageIfNeeded() {
        try {
            if (GM_getValue(V72_29_FLUSH_KEY, false)) return;
            const keysToFlush = [
                'fb_scraper_endpoint_url_v69', 'fb_scraper_api_key_v69',
                'fb_scraper_exclude_keywords_v69', 'fb_scraper_skip_keywords_v69',
                'fb_scraper_comments_v69', 'fb_scraper_smm_panels_v72_8',
                'fb_scraper_smm_panels_v69', 'fb_scraper_smm_rr_global_counter_v72_8',
                'fb_scraper_v72_10_ppi_defaults_migrated', 'fb_scraper_v69_defaults_seeded'
            ];
            for (const k of keysToFlush) {
                try { GM_setValue(k, ''); } catch (e) {}
            }
            GM_setValue(V72_29_FLUSH_KEY, true);
        } catch (e) {}
    }

    let RUNTIME_CONFIG = {
        komentar: [], skip_keywords: [], exclude_advertisers: [], smm_panels: [],
        scraper: { min_comment_inbox: 0, min_comment_viral: 1000, include_reels: true, smm_inbox_quantity: 10 },
        loaded: false, last_fetch_ts: 0, last_fetch_status: 'not-fetched'
    };

    const CONFIG_REQUEST_TIMEOUT_MS = 20000;

    function fetchConfigOnce() {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET', url: ENDPOINT_URL + '?action=get_scraper_config',
                    timeout: CONFIG_REQUEST_TIMEOUT_MS,
                    onload: function(response) {
                        try {
                            const parsed = JSON.parse(response.responseText);
                            if (parsed && parsed.ok && parsed.config) resolve({ ok: true, config: parsed.config, version: parsed.version });
                            else resolve({ ok: false, reason: 'invalid-response', error: parsed.error || 'unknown' });
                        } catch (e) { resolve({ ok: false, reason: 'parse-error', error: e.message }); }
                    },
                    onerror: function() { resolve({ ok: false, reason: 'network' }); },
                    ontimeout: function() { resolve({ ok: false, reason: 'timeout' }); }
                });
            } catch (e) { resolve({ ok: false, reason: 'exception', error: e.message }); }
        });
    }

    function parseScraperConfig(config) {
        const scraper = { min_comment_inbox: 0, min_comment_viral: 1000, include_reels: true, smm_inbox_quantity: 10 };
        if (config && typeof config.scraper === 'object') {
            const s = config.scraper;
            if (typeof s.min_comment_inbox === 'number' && s.min_comment_inbox >= 0) scraper.min_comment_inbox = s.min_comment_inbox;
            if (typeof s.min_comment_viral === 'number' && s.min_comment_viral >= 0) scraper.min_comment_viral = s.min_comment_viral;
            if (typeof s.include_reels === 'boolean') scraper.include_reels = s.include_reels;
            // v73.0.0: smm_inbox_quantity untuk single-write (inbox only) order quantity
            if (typeof s.smm_inbox_quantity === 'number' && s.smm_inbox_quantity >= 1) scraper.smm_inbox_quantity = s.smm_inbox_quantity;
        }
        return scraper;
    }

    function applyConfigToRuntime(config) {
        RUNTIME_CONFIG.komentar = Array.isArray(config.komentar) ? config.komentar : [];
        RUNTIME_CONFIG.skip_keywords = Array.isArray(config.skip_keywords) ? config.skip_keywords : [];
        RUNTIME_CONFIG.exclude_advertisers = Array.isArray(config.exclude_advertisers) ? config.exclude_advertisers : [];
        RUNTIME_CONFIG.smm_panels = Array.isArray(config.smm_panels) ? config.smm_panels : [];
        RUNTIME_CONFIG.scraper = parseScraperConfig(config);
    }

    async function fetchConfigWithRetry() {
        let attempt = 0;
        while (true) {
            attempt++;
            const result = await fetchConfigOnce();
            if (result.ok) {
                applyConfigToRuntime(result.config);
                RUNTIME_CONFIG.loaded = true;
                RUNTIME_CONFIG.last_fetch_ts = Date.now();
                RUNTIME_CONFIG.last_fetch_status = 'ok';
                const commentPanels = RUNTIME_CONFIG.smm_panels.filter(p => p.function === 'comment').length;
                const likePanels = RUNTIME_CONFIG.smm_panels.filter(p => p.function === 'like').length;
                addLog('Config: loaded v' + (result.version || '?') + ' (komentar=' + RUNTIME_CONFIG.komentar.length + ', skip_kw=' + RUNTIME_CONFIG.skip_keywords.length + ', exclude=' + RUNTIME_CONFIG.exclude_advertisers.length + ', smm=' + RUNTIME_CONFIG.smm_panels.length + ' [comment=' + commentPanels + ', like=' + likePanels + '])', 'success');
                addLog('Config: scraper: min_viral=' + RUNTIME_CONFIG.scraper.min_comment_viral + ' reels=' + RUNTIME_CONFIG.scraper.include_reels, 'info');
                updateUI();
                return true;
            }
            const backoffIdx = Math.min(attempt - 1, CONFIG_INITIAL_FETCH_RETRY_MS.length - 1);
            const backoffMs = CONFIG_INITIAL_FETCH_RETRY_MS[backoffIdx];
            RUNTIME_CONFIG.last_fetch_status = 'retry-' + attempt + '-' + result.reason;
            addLog('Config: fetch failed (attempt ' + attempt + ', reason=' + result.reason + '), retry in ' + (backoffMs/1000) + 's...', 'warning');
            updateUI();
            await sleep(backoffMs);
        }
    }

    async function startPeriodicConfigRefresh() {
        while (true) {
            await sleep(CONFIG_REFRESH_INTERVAL_MS);
            try {
                const result = await fetchConfigOnce();
                if (result.ok) {
                    applyConfigToRuntime(result.config);
                    RUNTIME_CONFIG.last_fetch_ts = Date.now();
                    RUNTIME_CONFIG.last_fetch_status = 'ok';
                    addLog('Config: refreshed (min_viral=' + RUNTIME_CONFIG.scraper.min_comment_viral + ' reels=' + RUNTIME_CONFIG.scraper.include_reels + ')', 'info');
                    updateUI();
                }
            } catch (e) {}
        }
    }

    async function forceRefreshConfig() {
        addLog('Config: force refresh requested...', 'info');
        const result = await fetchConfigOnce();
        if (result.ok) {
            applyConfigToRuntime(result.config);
            RUNTIME_CONFIG.last_fetch_ts = Date.now();
            RUNTIME_CONFIG.last_fetch_status = 'ok-force';
            addLog('Config: force refreshed (min_viral=' + RUNTIME_CONFIG.scraper.min_comment_viral + ' reels=' + RUNTIME_CONFIG.scraper.include_reels + ')', 'success');
            updateUI();
            return true;
        }
        return false;
    }

    let collectedLinks = loadLinks();
    let mainLoopRunning = false;
    let shouldStop = false;
    let isPaused = false;
    let currentPhase = 'idle';
    let scrollAttempts = 0;
    let detectedCount = 0;
    let skippedNoCTA = 0;
    let skippedExcluded = 0;
    let skippedKeyword = 0;
    let skippedDuplicate = 0;
    let skippedReels = 0;
    let viralSavedCount = 0;
    let viralDupCount = 0;
    let linksSinceLastDelay = 0;
    let retryCount = 0;
    let errorRecoveryCount = 0;
    let logMessages = [];
    const MAX_LOG = 80;
    let lastExtractedUrl = null;
    let lastActivityTimestamp = Date.now();
    let watchdogIntervalId = null;
    const WATCHDOG_TIMEOUT_MS = 180000;
    const WATCHDOG_CHECK_INTERVAL_MS = 30000;

    function markActivity() { lastActivityTimestamp = Date.now(); }
    async function waitWhilePaused() { while (isPaused && !shouldStop) { markActivity(); await sleep(500); } return !shouldStop; }

    function startWatchdog() {
        if (watchdogIntervalId) return;
        lastActivityTimestamp = Date.now();
        watchdogIntervalId = setInterval(() => {
            try { if (!mainLoopRunning) return; if (isPaused) { markActivity(); return; }
                const elapsed = Date.now() - lastActivityTimestamp;
                if (elapsed > WATCHDOG_TIMEOUT_MS) { addLog('WOULD REFRESH: watchdog-no-activity ' + Math.floor(elapsed/1000) + 's (disabled)', 'error'); markActivity(); }
            } catch (e) {}
        }, WATCHDOG_CHECK_INTERVAL_MS);
    }
    function stopWatchdog() { if (watchdogIntervalId) { clearInterval(watchdogIntervalId); watchdogIntervalId = null; } }

    function loadLinks() { try { return JSON.parse(GM_getValue(STORAGE_KEY, '[]')) || []; } catch (e) { return []; } }
    function saveLinks() { try { GM_setValue(STORAGE_KEY, JSON.stringify(collectedLinks)); } catch (e) {} }
    function clearLinks() { collectedLinks = []; saveLinks(); updateUI(); }

    const API_RETRY_MAX_ATTEMPTS = 3;
    const API_RETRY_BACKOFF_MS = [3000, 6000, 12000];
    const API_REQUEST_TIMEOUT_MS = 30000;

    function apiCallWithRetry(requestConfig, logLabel) {
        return new Promise(async (resolveOuter) => {
            for (let attempt = 1; attempt <= API_RETRY_MAX_ATTEMPTS; attempt++) {
                if (attempt > 1) { const backoff = API_RETRY_BACKOFF_MS[attempt - 2] || 12000; addLog(logLabel + ': retry ' + attempt + '/' + API_RETRY_MAX_ATTEMPTS + ' setelah backoff ' + (backoff/1000) + 's...', 'retry'); await sleep(backoff); }
                const attemptResult = await new Promise((resolveAttempt) => {
                    try {
                        GM_xmlhttpRequest({ method: requestConfig.method, url: requestConfig.url, data: requestConfig.data, headers: requestConfig.headers || {}, timeout: API_REQUEST_TIMEOUT_MS,
                            onload: function(response) { try { const parsed = requestConfig.parseResponse(response.responseText); resolveAttempt({ attemptOk: true, result: parsed }); } catch (e) { addLog(logLabel + ': parse error (attempt ' + attempt + '): ' + e.message, 'warning'); resolveAttempt({ attemptOk: false, reason: 'parse-error', error: e.message }); } },
                            onerror: function() { addLog(logLabel + ': network error (attempt ' + attempt + ')', 'warning'); resolveAttempt({ attemptOk: false, reason: 'network' }); },
                            ontimeout: function() { addLog(logLabel + ': timeout ' + (API_REQUEST_TIMEOUT_MS/1000) + 's (attempt ' + attempt + ')', 'warning'); resolveAttempt({ attemptOk: false, reason: 'timeout' }); }
                        });
                    } catch (e) { addLog(logLabel + ': exception (attempt ' + attempt + '): ' + e.message, 'warning'); resolveAttempt({ attemptOk: false, reason: 'exception', error: e.message }); }
                });
                if (attemptResult.attemptOk) return resolveOuter(attemptResult.result);
                if (attempt === API_RETRY_MAX_ATTEMPTS) { addLog(logLabel + ': FAILED setelah ' + API_RETRY_MAX_ATTEMPTS + ' attempts (final reason: ' + attemptResult.reason + ')', 'error'); return resolveOuter({ ok: false, reason: attemptResult.reason, retried: true }); }
            }
        });
    }

    function submitToSheet(data, dualWrite) {
        const HARDCODED_KOMENTAR = '\u{1D64E}\u{1D64A}\u{1D648}\u{1D63D}\u{1D64A}\u{1D64F}\u{1D642}\u{1D63E}\u{1D640}\u{1D63F}';
        const rawAkun = (GM_getValue(AKUN_FB_KEY, '') || '').trim();
        const akunWithVersion = rawAkun ? (rawAkun + ' - v' + TM_VERSION) : '';
        const payload = { action: 'submit', url: data.url, akun_fb: akunWithVersion, komentar: HARDCODED_KOMENTAR };
        if (dualWrite === true) payload.dual_write = true;
        addLog('Sheet: POST submit url=' + data.url.substring(0, 60) + '...' + (dualWrite ? ' [DUAL-WRITE]' : ''), 'info');
        return apiCallWithRetry({ method: 'POST', url: ENDPOINT_URL, data: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parseResponse: function(responseText) {
                const result = JSON.parse(responseText);
                if (result.ok) { if (result.status === 'new') addLog('Sheet: NEW row #' + result.row + (result.dual_write ? ' [DUAL-WRITE]' : ''), 'success'); else if (result.status === 'duplicate') addLog('Sheet: DUPLICATE row #' + result.row, 'info'); return { ok: true, status: result.status, row: result.row }; }
                else if (result.reason === 'dedup-active') { addLog('Sheet: DEDUP-ACTIVE (existing row #' + result.existing_row + ')', 'info'); return { ok: false, reason: 'dedup-active', existing_row: result.existing_row }; }
                else if (result.reason === 'dedup-viral') { addLog('Sheet: DEDUP-VIRAL (URL already in Viral_History row #' + result.existing_row + ')', 'info'); return { ok: false, reason: 'dedup-viral', existing_row: result.existing_row, existing_status: result.existing_status }; }
                else { addLog('Sheet: error: ' + (result.error || 'unknown'), 'warning'); return { ok: false, reason: 'sheet-error', error: result.error }; }
            }
        }, 'Sheet.submit');
    }

    function submitToViralHistory(url, commentCount, dualWrite) {
        const payload = { action: 'submit_viral', url: url, comment_count: commentCount };
        if (dualWrite === true) payload.dual_write = true;
        addLog('Viral: POST submit_viral url=' + url.substring(0, 60) + '... count=' + commentCount + (dualWrite ? ' [DUAL-WRITE]' : ''), 'info');
        return apiCallWithRetry({ method: 'POST', url: ENDPOINT_URL, data: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parseResponse: function(responseText) {
                const result = JSON.parse(responseText);
                if (result.ok && result.status === 'new') { let msg = 'Viral: NEW row #' + result.row; if (result.migrated_inbox_row) msg += ' (migrated Inbox row #' + result.migrated_inbox_row + ')'; if (result.dual_write) msg += ' [DUAL-WRITE]'; addLog(msg, 'success'); return { ok: true, status: 'new', row: result.row, migrated_inbox_row: result.migrated_inbox_row }; }
                else if (!result.ok && result.reason === 'duplicate') { addLog('Viral: DUPLICATE (existing row #' + result.existing_row + ')', 'info'); return { ok: false, reason: 'duplicate', existing_row: result.existing_row, existing_status: result.existing_status }; }
                else { addLog('Viral: error: ' + (result.error || 'unknown'), 'warning'); return { ok: false, reason: 'viral-error', error: result.error }; }
            }
        }, 'Viral.submit');
    }

    function updateSheetStatus(row, status, orderId, note, smmPanel) {
        const payload = { action: 'update_status', row: row, status: status };
        if (orderId) payload.order_id = orderId; if (note) payload.note = note; if (smmPanel) payload.smm_panel = smmPanel;
        addLog('Sheet: POST update_status row=' + row + ' status=' + status, 'info');
        return apiCallWithRetry({ method: 'POST', url: ENDPOINT_URL, data: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parseResponse: function(responseText) { const result = JSON.parse(responseText); if (result.ok) { addLog('Sheet: Status updated row #' + row + ' > ' + status, 'info'); return { ok: true }; } else { addLog('Sheet: update failed: ' + (result.error || 'unknown'), 'warning'); return { ok: false, error: result.error }; } }
        }, 'Sheet.update');
    }

    function getCommentsList() { return RUNTIME_CONFIG.komentar.slice(); }

    // v73.2.0: Build accounts grouped by panel (not flat combos)
    // Returns: [{ panel, services: [id1, id2, ...], label_prefix }, ...]
    // Order of accounts preserved from RUNTIME_CONFIG.smm_panels.
    // Order of services within account preserved (#1,#2,#3,... for fallback order).
    function buildActiveAccounts() {
        const accounts = [];
        for (const panel of RUNTIME_CONFIG.smm_panels) {
            if (!panel.enabled || !panel.label) continue;
            if (panel.function !== 'comment') continue;
            const providerCfg = SMM_PROVIDERS[panel.provider];
            if (!providerCfg) continue;
            let valid = true;
            for (const field of providerCfg.requiredFields) if (!panel[field]) { valid = false; break; }
            if (!valid) continue;
            if (!Array.isArray(panel.services)) continue;
            const services = [];
            for (const svc of panel.services) {
                if (!svc.enabled || !svc.id) continue;
                services.push(svc.id);
            }
            if (services.length === 0) continue;
            accounts.push({ panel: panel, services: services, label_prefix: panel.label });
        }
        return accounts;
    }

    // v73.2.0: Pick 1 account by round-robin (counter-based)
    // Counter advance handled SEPARATELY after order complete (see submitOrderToSMM)
    function getSmmAccountByIndex(index) {
        const accounts = buildActiveAccounts();
        if (accounts.length === 0) return null;
        const idx = ((index % accounts.length) + accounts.length) % accounts.length;
        return Object.assign({}, accounts[idx], { account_index: idx, total_accounts: accounts.length });
    }

    function getCurrentSmmCounter() {
        let counter = parseInt(GM_getValue(SMM_RR_GLOBAL_COUNTER_KEY, '0'), 10);
        if (isNaN(counter) || counter < 0) counter = 0;
        return counter;
    }

    function advanceSmmCounter(by) {
        try {
            const cur = getCurrentSmmCounter();
            GM_setValue(SMM_RR_GLOBAL_COUNTER_KEY, String(cur + (by || 1)));
        } catch (e) {}
    }

    // v73.2.0: Detect "saldo habis" / "API key salah" error → skip whole account
    // Sumber error message: BuzzerPanel docs (PPI/AUN belum lengkap)
    function isAccountLevelError(errorMsg) {
        if (!errorMsg) return false;
        const lower = errorMsg.toString().toLowerCase();
        return lower.includes('saldo tidak cukup')
            || lower.includes('insufficient balance')
            || lower.includes('insufficient')
            || lower.includes('api key salah')
            || lower.includes('invalid api')
            || lower.includes('api key invalid');
    }

    // v73.2.0: Helper — try ONE service order, return result
    // Tidak handle retry logic, hanya 1 attempt (apiCallWithRetry handle network retry internally)
    async function trySingleSmmOrder(account, serviceId, targetUrl, comments, modeLabel) {
        const panel = account.panel;
        const provider = panel.provider;
        const providerCfg = SMM_PROVIDERS[provider];
        const smmLabel = account.label_prefix + ' ' + serviceId;
        if (!providerCfg) return { ok: false, error: 'unknown-provider', smm_panel: smmLabel };

        let payload, requestBody, contentType;
        if (provider === 'all-uneed') {
            payload = { api_id: panel.api_id, api_key: panel.api_key, service: serviceId, target: targetUrl, quantity: comments.length, comments: comments.join('\n') };
            requestBody = JSON.stringify(payload); contentType = 'application/json';
        } else if (provider === 'ppi') {
            payload = { api_key: panel.api_key, secret_key: panel.secret_key, action: 'order', service: serviceId, data: targetUrl, quantity: comments.length, komen: comments.join('\n') };
            const formParts = []; for (const [k, v] of Object.entries(payload)) formParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
            requestBody = formParts.join('&'); contentType = 'application/x-www-form-urlencoded';
        } else if (provider === 'bp') {
            payload = { api_key: panel.api_key, secret_key: panel.secret_key, action: 'order', service: serviceId, data: targetUrl, quantity: comments.length, komen: comments.join('\n') };
            requestBody = JSON.stringify(payload); contentType = 'application/json';
        } else {
            return { ok: false, error: 'unsupported-provider', smm_panel: smmLabel };
        }

        const result = await apiCallWithRetry({
            method: 'POST', url: providerCfg.api_url, data: requestBody, headers: { 'Content-Type': contentType },
            parseResponse: function(responseText) {
                const parsed = JSON.parse(responseText); let isSuccess = false, orderId = null, errorMsg = '';
                if (provider === 'all-uneed') { isSuccess = parsed.response === true; orderId = parsed.data && parsed.data.id; errorMsg = (parsed.data && parsed.data.msg) || 'unknown'; }
                else if (provider === 'ppi' || provider === 'bp') { isSuccess = parsed.status === true; orderId = parsed.data && parsed.data.id; errorMsg = (parsed.data && parsed.data.msg) || 'unknown'; }
                if (isSuccess && orderId) {
                    return { ok: true, order_id: orderId, price: parsed.data && parsed.data.price, smm_panel: smmLabel };
                } else {
                    return { ok: false, error: errorMsg, smm_panel: smmLabel };
                }
            }
        }, 'SMM.order(' + smmLabel + ')');
        if (!result.smm_panel) result.smm_panel = smmLabel;
        return result;
    }

    // v73.2.0: Multi-service retry per akun + fallback antar akun
    // Flow:
    //   1. Pick account by round-robin (counter advance HANYA setelah seluruh order selesai)
    //   2. Try setiap service di akun itu (urut, dengan 500ms delay antar attempt)
    //   3. Kalau "Saldo tidak cukup" / "API Key salah" → skip semua service di akun ini, fallback ke akun lain
    //   4. Kalau semua service akun habis (non-account-level error) → fallback ke akun lain (counter +1)
    //   5. Loop sampai sukses atau semua akun habis dicoba
    async function submitOrderToSMM(targetUrl, isViralCandidate) {
        const allComments = getCommentsList();
        if (allComments.length < 5) { addLog('SMM: comments < 5, skip order', 'warning'); return { ok: false, reason: 'comments-insufficient' }; }

        // v73.1.0: Pilih quantity berdasarkan mode (single-write vs dual-write)
        let comments, modeLabel;
        if (isViralCandidate === true) {
            comments = allComments;
            modeLabel = 'VIRAL ALL=' + comments.length;
        } else {
            const targetQty = RUNTIME_CONFIG.scraper.smm_inbox_quantity || 10;
            const useQty = Math.min(targetQty, allComments.length);
            comments = allComments.slice(0, useQty);
            modeLabel = 'INBOX ' + useQty + '/' + allComments.length;
        }

        const accounts = buildActiveAccounts();
        if (accounts.length === 0) { addLog('SMM: no active accounts (comment panels)', 'warning'); return { ok: false, error: 'no-active-accounts' }; }

        const startCounter = getCurrentSmmCounter();
        const failureReport = []; // untuk note kalau semua gagal: [{account, services: [{id, msg}], skipped_reason?}, ...]
        let accountsTried = 0;
        let counterAdvancedBy = 0; // berapa counter advance setelah semua selesai

        // Loop accounts max sebanyak total accounts (try semua)
        for (let attempt = 0; attempt < accounts.length; attempt++) {
            const account = getSmmAccountByIndex(startCounter + attempt);
            if (!account) break;
            accountsTried++;

            const accountFailures = []; // services yang gagal di akun ini
            let accountSkipReason = null; // 'saldo' / 'apikey' kalau account-level error
            let successResult = null;

            addLog('SMM: round-robin pick ' + account.label_prefix + ' (account ' + (account.account_index + 1) + '/' + account.total_accounts + ', try-attempt ' + (attempt + 1) + ')', 'info');

            // Loop services di account ini
            for (let svcIdx = 0; svcIdx < account.services.length; svcIdx++) {
                const serviceId = account.services[svcIdx];
                const smmLabel = account.label_prefix + ' ' + serviceId;
                addLog('SMM: try ' + smmLabel + ' (' + (svcIdx + 1) + '/' + account.services.length + ') [' + modeLabel + ']: POST ordering...', 'info');

                const result = await trySingleSmmOrder(account, serviceId, targetUrl, comments, modeLabel);

                if (result.ok) {
                    addLog('SMM: ' + smmLabel + ' Order #' + result.order_id + ' [' + modeLabel + '] ✓', 'success');
                    successResult = result;
                    // Note enrichment: kalau ada gagal sebelumnya, sebutkan
                    if (accountFailures.length > 0) {
                        const failedIds = accountFailures.map(f => f.id).join(',');
                        successResult.retry_note = 'Retry: ' + failedIds + ' failed @ ' + account.label_prefix;
                        logEvent('SMM RETRY');
                    } else if (failureReport.length > 0) {
                        // Sukses tapi setelah fallback dari akun lain
                        const failedAccountsStr = failureReport.map(r => r.account + (r.skipped_reason ? '(' + r.skipped_reason + ')' : '')).join(', ');
                        successResult.retry_note = failedAccountsStr + ' → ' + account.label_prefix + ' OK';
                        logEvent('SMM RETRY');
                    }
                    break; // exit service loop
                }

                addLog('SMM: ' + smmLabel + ' failed: ' + (result.error || 'unknown'), 'error');
                accountFailures.push({ id: serviceId, msg: result.error || 'unknown' });

                // Check account-level error → skip semua service di akun ini
                if (isAccountLevelError(result.error)) {
                    const isApiKey = (result.error || '').toLowerCase().includes('api key');
                    accountSkipReason = isApiKey ? 'API Key salah' : 'saldo habis';
                    addLog('SMM: ' + account.label_prefix + ' → ' + accountSkipReason + ' detected, SKIP all services in this account', 'warning');
                    break; // exit service loop, fallback ke akun lain
                }

                // Delay 500ms antar service attempt (anti race + ga bombardir API)
                if (svcIdx < account.services.length - 1) {
                    await sleep(500);
                }
            }

            // Counter advance +1 per akun yang dicoba (fair distribution antar akun)
            counterAdvancedBy++;

            if (successResult) {
                // Final counter advance
                advanceSmmCounter(counterAdvancedBy);
                return successResult;
            }

            // Akun ini gagal, record ke failureReport
            failureReport.push({
                account: account.label_prefix,
                services: accountFailures,
                skipped_reason: accountSkipReason
            });

            // Delay 500ms sebelum coba akun berikutnya
            if (attempt < accounts.length - 1) {
                await sleep(500);
            }
        }

        // Semua akun habis dicoba, semua gagal
        advanceSmmCounter(counterAdvancedBy);
        logEvent('SMM ALL FAIL');

        // Build error note: "All failed: IRFAN(saldo habis), JOVIE(66996:Layanan tidak tersedia)"
        const errorParts = failureReport.map(r => {
            if (r.skipped_reason) return r.account + '(' + r.skipped_reason + ')';
            const svcDetails = r.services.map(s => s.id + ':' + s.msg).join('|');
            return r.account + '(' + svcDetails + ')';
        });
        const fullErrorMsg = 'All failed: ' + errorParts.join(', ');
        addLog('SMM: ALL ATTEMPTS FAILED — ' + fullErrorMsg, 'error');

        return {
            ok: false,
            error: fullErrorMsg,
            smm_panel: '', // empty karena ga ada yang sukses
            all_failed: true,
            accounts_tried: accountsTried,
            total_accounts: accounts.length
        };
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async function interruptibleSleep(ms) { const step = 100; let elapsed = 0; while (elapsed < ms) { if (shouldStop) return false; while (isPaused && !shouldStop) { markActivity(); await sleep(500); } if (shouldStop) return false; await sleep(Math.min(step, ms - elapsed)); elapsed += step; } return true; }
    function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    const SETTINGS = { SCROLL_STEP_MIN_PX: 800, SCROLL_STEP_MAX_PX: 1500, SCROLL_PAUSE_MIN_MS: 1200, SCROLL_PAUSE_MAX_MS: 2800, READ_BEFORE_LIKE_MIN_MS: 1500, READ_BEFORE_LIKE_MAX_MS: 3000, BETWEEN_POSTS_MIN_MS: 1800, BETWEEN_POSTS_MAX_MS: 3500, MAX_PASSES: 2, LIKE_WAIT_MS: 500, MIN_VIEWPORT_VISIBILITY_PERCENT: 60, SCROLL_TO_POST_MS: 1200, SCROLL_OFFSET_FROM_TOP: 120, CONTENT_WAIT_MS: 800 };
    function randMs(minKey, maxKey) { return rand(SETTINGS[minKey], SETTINGS[maxKey]); }
    function getViewportVisibilityPercent(el) { if (!el) return 0; const rect = el.getBoundingClientRect(); const vh = window.innerHeight; if (rect.height === 0) return 0; const visibleTop = Math.max(0, rect.top); const visibleBottom = Math.min(vh, rect.bottom); const visibleHeight = Math.max(0, visibleBottom - visibleTop); const denominator = Math.min(rect.height, vh); if (denominator === 0) return 0; return (visibleHeight / denominator) * 100; }
    function isPostVisibleEnough(post) { return getViewportVisibilityPercent(post) >= SETTINGS.MIN_VIEWPORT_VISIBILITY_PERCENT; }
    async function scrollPostIntoView(post) { if (!post) return false; try { const rect = post.getBoundingClientRect(); const targetY = window.scrollY + rect.top - SETTINGS.SCROLL_OFFSET_FROM_TOP; window.scrollTo({ top: targetY, behavior: 'smooth' }); } catch (e) { try { post.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e2) {} } await interruptibleSleep(SETTINGS.SCROLL_TO_POST_MS); return true; }
    async function naturalScrollStep() { const beforeY = window.scrollY; const stepPx = rand(SETTINGS.SCROLL_STEP_MIN_PX, SETTINGS.SCROLL_STEP_MAX_PX); try { window.scrollBy({ top: stepPx, behavior: 'smooth' }); } catch (e) { window.scrollBy(0, stepPx); } logEvent('SCROLL'); const pauseMs = randMs('SCROLL_PAUSE_MIN_MS', 'SCROLL_PAUSE_MAX_MS'); const ok = await interruptibleSleep(pauseMs); if (!ok) return false; return Math.abs(window.scrollY - beforeY) > 50; }

    const LOG_RETENTION_MS = 30 * 60 * 1000;
    function addLog(msg, type) { type = type || 'info'; const time = new Date().toLocaleTimeString('id-ID', { hour12: false }); console.log('[FB Scraper ' + time + '] [' + type + '] ' + msg); markActivity(); }
    function logEvent(eventType) { const now = Date.now(); const time = new Date().toLocaleTimeString('id-ID', { hour12: false }); logMessages.unshift({ time, ts: now, eventType }); const cutoff = now - LOG_RETENTION_MS; while (logMessages.length > 0 && logMessages[logMessages.length - 1].ts < cutoff) logMessages.pop(); if (logMessages.length > MAX_LOG) logMessages.pop(); console.log('[FB Scraper ' + time + '] [event] ' + eventType); renderLogPanel(); markActivity(); }
    function pruneOldLogs() { const cutoff = Date.now() - LOG_RETENTION_MS; const before = logMessages.length; while (logMessages.length > 0 && logMessages[logMessages.length - 1].ts < cutoff) logMessages.pop(); if (logMessages.length !== before) renderLogPanel(); }
    setInterval(pruneOldLogs, 60000);

    function renderLogPanel() { try { const logBox = document.getElementById('fbs-log-box'); if (!logBox) return; if (logMessages.length === 0) { logBox.innerHTML = '<div style="color:#666;font-size:9px;text-align:center;padding:8px;">(no events)</div>'; return; } const colors = { 'SCROLL': '#b0b3b8', 'CAPTURE LINK': '#1877f2', 'SUCCESS POST': '#42b72a', 'LINK DEDUP': '#ff77ff', 'SKIP TOP2 KW': '#9c27b0', 'NOT FOUND': '#ffaa00', 'DAILY RESET 00:00 WIB': '#00d0d0', 'SCRAPER STARTED': '#42b72a', 'VIRAL SAVED': '#ff6b35', 'VIRAL DUP': '#ff77ff', 'SKIP REEL': '#888888', 'SMM RETRY': '#9c27b0', 'SMM ALL FAIL': '#e41e3f' }; const icons = { 'SCROLL': '\uD83D\uDCDC', 'CAPTURE LINK': '\uD83D\uDD17', 'SUCCESS POST': '\u2705', 'LINK DEDUP': '\uD83D\uDD01', 'SKIP TOP2 KW': '\u26D4', 'NOT FOUND': '\u274C', 'DAILY RESET 00:00 WIB': '\uD83D\uDD04', 'SCRAPER STARTED': '\uD83D\uDE80', 'VIRAL SAVED': '\uD83D\uDD25', 'VIRAL DUP': '\uD83D\uDD01', 'SKIP REEL': '\uD83C\uDFAC', 'SMM RETRY': '\uD83D\uDD04', 'SMM ALL FAIL': '\uD83D\uDED1' }; const html = logMessages.slice(0, 10).map(m => { const color = colors[m.eventType] || '#e4e6eb'; const icon = icons[m.eventType] || '\u2022'; return '<div style="display:flex;justify-content:space-between;font-size:9px;padding:2px 4px;border-bottom:1px solid #2d2f33;"><span style="color:' + color + ';">' + icon + ' ' + m.eventType + '</span><span style="color:#666;">' + m.time + '</span></div>'; }).join(''); logBox.innerHTML = html; } catch (e) {} }

    function setPhase(phase, msg) { currentPhase = phase; if (msg) addLog('PHASE > ' + phase + ': ' + msg, 'phase'); updateUI(); }
    function isFBErrorVisible() { const candidates = document.querySelectorAll('span, div[role="button"], a[role="button"], button'); for (const el of candidates) { if (el.children.length > 3) continue; const text = (el.innerText || el.textContent || '').trim().toLowerCase(); if (text === 'memuat halaman' || text === 'reload page' || text === 'muat ulang' || text === 'coba lagi' || text === 'try again' || text === 'reload') { const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; if (parseFloat(style.opacity) < 0.1) continue; } catch (e) {} return true; } } return false; }
    function isInsideComplementary(el) { let cur = el; let depth = 0; while (cur && cur !== document.body && depth < 50) { const r = cur.getBoundingClientRect(); if (r.width >= 400 && r.width <= 900 && r.height >= 200) return false; if (cur.getAttribute && cur.getAttribute('role') === 'complementary') return true; if (cur.getAttribute && cur.getAttribute('role') === 'article') return false; cur = cur.parentElement; depth++; } return false; }

    function isInMainFeed(post) {
        if (!post) return false;
        let el = post;
        for (let i = 0; i < 30 && el && el !== document.body; i++) {
            if (el.getAttribute) { const role = el.getAttribute('role'); if (role === 'complementary') return false;
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase(); if (ariaLabel === 'kontak' || ariaLabel === 'contacts') return false; }
            el = el.parentElement;
        }
        el = post;
        for (let i = 0; i < 30 && el && el !== document.body; i++) {
            if (el.getAttribute) { const pagelet = el.getAttribute('data-pagelet') || ''; if (pagelet.includes('FeedUnit') || pagelet.includes('MainFeed')) return true; }
            el = el.parentElement;
        }
        const rect = post.getBoundingClientRect(); if (rect.width < 400) return false; return true;
    }

    function findAllMarkers() { const found = []; const seenPosts = new Set(); const bersponsorMarkers = findBersponsorMarkers(); for (const marker of bersponsorMarkers) { const post = findPostContainerFromMarker(marker); if (!post) continue; if (seenPosts.has(post)) continue; seenPosts.add(post); found.push(marker); } return found; }
    function findDecodedBersponsorMarkers() { const found = []; const candidates = document.querySelectorAll('span[dir="auto"], a[role="link"] span, span[aria-labelledby]'); for (const el of candidates) { const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; if (rect.width > 250 || rect.height > 35) continue; const allSpans = el.querySelectorAll('span'); if (allSpans.length < 3) continue; const charSpans = []; for (const sp of allSpans) { if (sp.children.length > 0) continue; const t = sp.textContent || ''; if (t.length === 0 || t.length > 3) continue; const sr = sp.getBoundingClientRect(); if (sr.width === 0 || sr.height === 0) continue; if (sr.left < rect.left - 5 || sr.right > rect.right + 5) continue; if (sr.top < rect.top - 5 || sr.bottom > rect.bottom + 5) continue; try { const cs = window.getComputedStyle(sp); if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') continue; } catch (e) {} charSpans.push({ text: t, x: sr.left, y: sr.top }); } if (charSpans.length < 5) continue; charSpans.sort((a, b) => Math.abs(a.y - b.y) > 5 ? a.y - b.y : a.x - b.x); const decoded = charSpans.map(c => c.text).join(''); const lower = decoded.toLowerCase().replace(/\s/g, ''); if (lower.includes('bersponsor') || lower.includes('sponsored')) { if (isInsideComplementary(el)) continue; found.push(el); } } return found; }
    function findBersponsorMarkers() { const found = []; const seen = new Set(); const candidates = document.querySelectorAll('span, a'); for (const el of candidates) { if (el.children.length > 50) continue; const text = (el.innerText || '').trim().toLowerCase().replace(/\s/g, ''); if (text !== 'bersponsor' && text !== 'sponsored' && text !== 'disponsori') continue; const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; if (parseFloat(style.opacity) < 0.1) continue; } catch (e) { continue; } if (isInsideComplementary(el)) continue; found.push(el); seen.add(el); } const decoded = findDecodedBersponsorMarkers(); for (const el of decoded) { if (seen.has(el)) continue; found.push(el); seen.add(el); } return found; }
    function findPostContainerFromMarker(marker) { if (!marker) return null; if (isInsideComplementary(marker)) return null; let el = marker; const levels = []; for (let i = 0; i < 40 && el && el !== document.body; i++) { levels.push(el); el = el.parentElement; } function isPostSized(el) { const r = el.getBoundingClientRect(); return r.width >= 400 && r.width <= 900 && r.height >= 200 && r.height <= 2500; } for (const lvl of levels) { if (lvl.getAttribute && lvl.getAttribute('role') === 'article' && isPostSized(lvl)) return lvl; } for (const lvl of levels) { const pl = lvl.getAttribute && lvl.getAttribute('data-pagelet'); if (pl && pl.includes('FeedUnit') && isPostSized(lvl)) return lvl; } for (const lvl of levels) { if (!lvl.querySelector || !isPostSized(lvl)) continue; const buttons = lvl.querySelectorAll('div[role="button"][aria-label]'); let hasInteractive = false; for (const btn of buttons) { const al = (btn.getAttribute('aria-label') || '').toLowerCase(); if (al.includes('bagikan') || al.includes('berbagi') || al.includes('share') || al === 'komentar' || al === 'comment' || al.startsWith('beri komentar') || al === 'suka' || al === 'beri reaksi' || al === 'like') { hasInteractive = true; break; } } if (hasInteractive) return lvl; } for (const lvl of levels) { if (lvl.querySelector && isPostSized(lvl) && lvl.querySelector('[data-ad-rendering-role*="cta" i]')) return lvl; } return null; }
    function decodeObfuscatedText(containerEl) { if (!containerEl) return ''; const containerRect = containerEl.getBoundingClientRect(); if (containerRect.width === 0 || containerRect.height === 0) return ''; const allSpans = containerEl.querySelectorAll('span'); const charSpans = []; for (const sp of allSpans) { if (sp.children.length > 0) continue; const text = sp.textContent || ''; if (text.length === 0 || text.length > 3) continue; const r = sp.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; const T = 5; if (r.left < containerRect.left - T || r.right > containerRect.right + T || r.top < containerRect.top - T || r.bottom > containerRect.bottom + T) continue; try { const cs = window.getComputedStyle(sp); if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') continue; const fs = parseFloat(cs.fontSize); if (!isNaN(fs) && fs < 1) continue; } catch (e) {} charSpans.push({ text, x: r.left, y: r.top, width: r.width }); } if (charSpans.length === 0) return ''; charSpans.sort((a, b) => { const dy = a.y - b.y; return Math.abs(dy) > 5 ? dy : a.x - b.x; }); return charSpans.map(c => c.text).join(''); }
    function getCleanCTAText(ctaEl) { if (!ctaEl) return ''; try { const decoded = decodeObfuscatedText(ctaEl).trim(); if (decoded && decoded.length >= 2 && decoded.length <= 60) { const letterCount = (decoded.match(/[a-zA-Z]/g) || []).length; if (letterCount >= 2) return decoded; } } catch (e) {} const labelled = ctaEl.querySelectorAll('[aria-labelledby]'); for (const el of labelled) { const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/); for (const id of ids) { if (!id || !id.startsWith('_')) continue; const ref = document.getElementById(id); if (!ref) continue; const text = (ref.textContent || '').trim(); if (text) return text; } } const links = ctaEl.querySelectorAll('a[aria-label], [role="link"][aria-label]'); for (const a of links) { const al = (a.getAttribute('aria-label') || '').trim(); if (al) return al; } if (ctaEl.hasAttribute && ctaEl.hasAttribute('aria-label')) { const al = (ctaEl.getAttribute('aria-label') || '').trim(); if (al) return al; } let cur = ctaEl.parentElement; let depth = 0; while (cur && depth < 5) { if (cur.hasAttribute && cur.hasAttribute('aria-label')) { const al = (cur.getAttribute('aria-label') || '').trim(); if (al) return al; } cur = cur.parentElement; depth++; } return (ctaEl.innerText || ctaEl.textContent || '').trim(); }
    function getExcludeKeywords() { return RUNTIME_CONFIG.exclude_advertisers.map(k => k.toLowerCase().trim()).filter(k => k.length > 0); }
    function isAdvertiserExcluded(advertiser) { if (!advertiser) return false; const keywords = getExcludeKeywords(); if (keywords.length === 0) return false; const advLower = advertiser.toLowerCase(); for (const kw of keywords) if (advLower.includes(kw)) return { excluded: true, keyword: kw }; return { excluded: false }; }
    function extractAdvertiserFromPost(post) { if (!post) return 'Unknown'; try { const h = post.querySelector('h3 a strong, h4 a strong, h3 strong, h4 strong, h3 a span, h4 a span, h3 a, h4 a'); if (h) { const t = (h.innerText || '').trim(); if (t && t.length > 1 && t.length < 80) return t; } } catch (e) {} return 'Unknown'; }
    function hasCTA(post) { if (!post) return { found: false }; const ctaElements = post.querySelectorAll('[data-ad-rendering-role]'); for (const el of ctaElements) { if (!post.contains(el)) continue; const role = (el.getAttribute('data-ad-rendering-role') || '').toLowerCase(); if (role.includes('cta')) { try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; } catch (e) {} const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; const text = getCleanCTAText(el); return { found: true, text: text || '(CTA)', role: role, element: el }; } } return { found: false }; }
    function findCommentButtonInPost(post) { if (!post) return null; const adComment = post.querySelector('[data-ad-rendering-role="comment_button"]'); if (adComment) { const directRect = adComment.getBoundingClientRect(); if (directRect.width > 0 && directRect.height > 0) { if (adComment.getAttribute('role') === 'button' || adComment.onclick || adComment.tagName === 'BUTTON' || adComment.tagName === 'A') return adComment; let parent = adComment.parentElement; let depth = 0; while (parent && parent !== post && depth < 8) { if (parent.getAttribute && parent.getAttribute('role') === 'button') { const pRect = parent.getBoundingClientRect(); if (pRect.width > 0 && pRect.height > 0) return parent; } parent = parent.parentElement; depth++; } return adComment; } } const buttons = post.querySelectorAll('div[role="button"][aria-label]'); for (const btn of buttons) { if (!post.contains(btn)) continue; const al = (btn.getAttribute('aria-label') || '').toLowerCase(); if (!al) continue; if (al.includes('react') || al.includes('suka') || al.includes('reaksi')) continue; if (al.includes('bagikan') || al.includes('berbagi') || al.includes('share')) continue; if (al.includes('menu') || al.includes('bersponsor')) continue; const isComment = al === 'komentar' || al === 'comment' || al.startsWith('beri komentar') || al.startsWith('write a comment') || al === 'leave a comment' || al.startsWith('comment on ') || al.startsWith('komentari ') || al === 'komentari'; if (!isComment) continue; const rect = btn.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; return btn; } const fallbackButtons = post.querySelectorAll('div[role="button"]'); for (const btn of fallbackButtons) { if (!post.contains(btn)) continue; if (btn.querySelector('[data-ad-rendering-role="comment_button"]')) { const rect = btn.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0) return btn; } } for (const btn of fallbackButtons) { if (!post.contains(btn)) continue; const spans = btn.querySelectorAll('span'); for (const sp of spans) { const txt = (sp.textContent || '').trim().toLowerCase(); if (txt === 'komentari' || txt === 'komentar' || txt === 'comment') { const al = (btn.getAttribute('aria-label') || '').toLowerCase(); if (al.includes('react') || al.includes('suka') || al.includes('reaksi') || al.includes('bagikan') || al.includes('share')) continue; const rect = btn.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; return btn; } } } return null; }

    function getVisibleDialogs() { const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')); return dialogs.filter(d => { const rect = d.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }); }
    function isDialogOpen() { return getVisibleDialogs().length > 0; }

    function parseCommentCount(text) { if (!text || typeof text !== 'string') return 0; let s = text.replace(/\u00a0/g, ' ').toLowerCase().trim(); s = s.replace(/^(lihat|view|see)\s+/i, ''); s = s.replace(/\s*(komentar|comments?|kommentar)\s*$/i, '').trim(); let multiplier = 1; let matched = false; let m = s.match(/^([\d.,]+)\s*(rb|ribu|k)\s*$/i); if (m) { s = m[1]; multiplier = 1000; matched = true; } if (!matched) { m = s.match(/^([\d.,]+)\s*(jt|juta|m)\s*$/i); if (m) { s = m[1]; multiplier = 1000000; matched = true; } } if (!matched) { m = s.match(/([\d.,]+)/); if (m) s = m[1]; } if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, ''); else if (s.includes(',')) { const parts = s.split(','); if (multiplier > 1 || (parts[1] && parts[1].length <= 2)) s = s.replace(',', '.'); else s = s.replace(/,/g, ''); } const num = parseFloat(s); if (isNaN(num)) return 0; return Math.round(num * multiplier); }

    function extractCommentCountMethodC(scope) { const results = []; const candidates = scope.querySelectorAll('span, div, a'); for (const el of candidates) { if (el.children.length > 2) continue; const text = (el.innerText || el.textContent || '').trim(); if (!text || text.length > 30) continue; const lower = text.toLowerCase(); if (!lower.includes('komentar') && !lower.includes('comment')) continue; if (lower.includes('beri komentar') || lower.includes('write a comment')) continue; if (lower.includes('komentari')) continue; if (lower.includes('balas') || lower.includes('reply')) continue; if (lower.includes('lihat') || lower.includes('view')) continue; if (lower.includes('lainnya') || lower.includes('more')) continue; if (lower.includes('belum ada')) continue; if (lower.includes('smm:')) continue; if (!/\d/.test(text)) continue; if (/^[\d.,\s]+\s*(rb|ribu|k|jt|juta|m)?\s*(komentar|comments?)$/i.test(text)) results.push(text); } const parsed = results.map(parseCommentCount).filter(n => n > 0); if (parsed.length > 0) return Math.max(...parsed); return 0; }
    function extractCommentCountMethodD(scope) { const numPattern = /^[\d.,]+\s*(rb|ribu|k|jt|juta|m)?$/i; const divs = scope.querySelectorAll('div'); for (const div of divs) { const text = (div.innerText || '').trim(); const lines = text.split('\n').map(l => l.trim()).filter(l => l); if (lines.length < 2 || lines.length > 4) continue; const allNums = lines.every(l => numPattern.test(l)); if (!allNums) continue; const rect = div.getBoundingClientRect(); if (rect.width < 100 || rect.height < 10 || rect.height > 80) continue; const spans = []; div.querySelectorAll('span, div').forEach(sp => { if (sp.children.length > 0) return; const t = (sp.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim(); if (!numPattern.test(t)) return; const sr = sp.getBoundingClientRect(); if (sr.width === 0 || sr.height === 0) return; spans.push({ text: t, x: sr.left }); }); const deduped = []; const seenKeys = new Set(); for (const s of spans) { const key = s.text + '|' + Math.round(s.x); if (seenKeys.has(key)) continue; seenKeys.add(key); deduped.push(s); } if (deduped.length < 2) continue; deduped.sort((a, b) => a.x - b.x); const commentText = deduped[1].text; const parsed = parseCommentCount(commentText); if (parsed > 0) { addLog('CommentCount: Method D social bar [' + deduped.map(d => d.text).join(', ') + '] comment=' + commentText + ' (' + parsed + ')', 'info'); return parsed; } } return 0; }
    function extractCommentCountMethodB(scope) { const results = []; const labelElements = scope.querySelectorAll('[aria-label]'); labelElements.forEach(el => { const label = el.getAttribute('aria-label'); if (!label) return; const lower = label.toLowerCase(); if (!/komentar|comment/i.test(lower)) return; if (!/\d/.test(label)) return; if (/balas|reply/i.test(lower)) return; if (/beri komentar|write a comment|leave a comment/i.test(lower)) return; if (/komentar oleh|comment by/i.test(lower)) return; if (/komentari/i.test(lower)) return; if (label.length > 50) return; results.push(label); }); const parsed = results.map(parseCommentCount).filter(n => n > 0); if (parsed.length > 0) return Math.max(...parsed); return 0; }
    function extractCommentCount(scope) { if (!scope) scope = document.body; try { const countC = extractCommentCountMethodC(scope); if (countC > 0) { addLog('CommentCount: Method C → ' + countC, 'info'); return countC; } const countD = extractCommentCountMethodD(scope); if (countD > 0) { return countD; } const countB = extractCommentCountMethodB(scope); if (countB > 0) { addLog('CommentCount: Method B → ' + countB, 'info'); return countB; } addLog('CommentCount: no count found (C=0, D=0, B=0)', 'warning'); return 0; } catch (e) { addLog('CommentCount: exception: ' + e.message, 'error'); return 0; } }
    function hasCommentTextInScope(scope) { if (!scope) return false; try { const text = (scope.innerText || scope.textContent || '').toLowerCase(); return text.includes('komentar') || text.includes('comment'); } catch (e) { return false; } }
    function checkBelumAdaKomentar() { const dialogs = getVisibleDialogs(); const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null; if (!scope) return false; const text = (scope.textContent || '').toLowerCase(); return text.includes('belum ada komentar') || text.includes('no comments yet') || text.includes('jadilah yang pertama'); }

    async function waitForCommentSectionReady() { const MODAL_TIMEOUT_MS = 30000; const startTime = Date.now(); let lastCount = 0; while (Date.now() - startTime < MODAL_TIMEOUT_MS) { if (shouldStop) return { ready: false, count: 0, reason: 'stopped' }; if (checkBelumAdaKomentar()) { const elapsed = ((Date.now() - startTime) / 1000).toFixed(1); addLog('Modal: "Belum ada komentar" detected in ' + elapsed + 's', 'info'); return { ready: true, count: 0, reason: 'no-comments', belumAda: true }; } const dialogs = getVisibleDialogs(); const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null; if (!scope) { await sleep(COMMENT_MODAL_READINESS_POLL_MS); continue; } const hasCommentText = hasCommentTextInScope(scope); if (!hasCommentText) { await sleep(COMMENT_MODAL_READINESS_POLL_MS); continue; } const count = extractCommentCount(scope); if (count > 0) { const elapsed = ((Date.now() - startTime) / 1000).toFixed(1); addLog('Modal: ready (dialog) in ' + elapsed + 's, count=' + count, 'info'); return { ready: true, count: count, reason: 'count-extracted-dialog' }; } lastCount = count; await sleep(COMMENT_MODAL_READINESS_POLL_MS); } const elapsed = ((Date.now() - startTime) / 1000).toFixed(1); addLog('Modal: timeout ' + elapsed + 's, count=' + lastCount, 'warning'); return { ready: false, count: lastCount, reason: 'timeout' }; }

    async function pressEscape() { const evt = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }); document.body.dispatchEvent(evt); document.dispatchEvent(evt); document.documentElement.dispatchEvent(evt); await sleep(200); }
    async function closeDialogForce() { for (let i = 0; i < 5; i++) { if (!isDialogOpen()) return true; await pressEscape(); await sleep(400); } const dialogs = getVisibleDialogs(); for (const dialog of dialogs) { const closeBtns = dialog.querySelectorAll('div[aria-label="Close" i], div[aria-label="Tutup" i], div[role="button"][aria-label*="Close" i], div[role="button"][aria-label*="Tutup" i]'); for (const btn of closeBtns) { const rect = btn.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0) { try { btn.click(); } catch (e) {} await sleep(400); } } } await pressEscape(); await sleep(500); return !isDialogOpen(); }
    function cleanUrl(url) { try { const u = new URL(url, window.location.origin); const keep = ['story_fbid', 'id', 'v', 'fbid', 'set', 'idorvanity', 'multi_permalinks']; const params = new URLSearchParams(); for (const [k, v] of u.searchParams) if (keep.includes(k)) params.append(k, v); u.search = params.toString(); u.hash = ''; if (u.hostname === 'web.facebook.com' || u.hostname === 'm.facebook.com') u.hostname = 'www.facebook.com'; return u.toString(); } catch (e) { return url; } }
    function isValidPostUrl(url) { if (!url || !url.includes('facebook.com')) return false; try { const u = new URL(url); if (u.pathname === '/' || u.pathname === '') return false; if (u.pathname === '/permalink.php' && !u.searchParams.has('story_fbid') && !u.searchParams.has('fbid')) return false; } catch (e) { return false; } return true; }
    function urlHasIdentifier(cleanedUrl) { if (!cleanedUrl) return false; try { const u = new URL(cleanedUrl); if (u.pathname === '/' || u.pathname === '') return false; if (u.pathname === '/permalink.php' && !u.searchParams.has('story_fbid') && !u.searchParams.has('fbid')) return false; } catch (e) { return false; } return (cleanedUrl.includes('story_fbid=') || cleanedUrl.includes('fbid=') || cleanedUrl.includes('/posts/') || /\/reel\/[^\/?]+/.test(cleanedUrl) || /\/permalink\.php\?/.test(cleanedUrl) || /\/videos\/[^\/?]+/.test(cleanedUrl) || /\/photo\/[^\/?]+/.test(cleanedUrl)); }
    async function closeCommentModal() { const MAX_ATTEMPTS = 6; const RETRY_INTERVAL_MS = 800; for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) { const closeBtn = findCloseButton(); if (!closeBtn) { if (!isDialogOpen() && !isValidPostUrl(window.location.href)) return true; await sleep(RETRY_INTERVAL_MS); continue; } try { closeBtn.click(); } catch (e) {} await sleep(RETRY_INTERVAL_MS); if (!isDialogOpen() && !isValidPostUrl(window.location.href)) return true; } return false; }
    function findCloseButton() { const selectors = ['div[role="button"][aria-label="Tutup"]', 'div[role="button"][aria-label="Close"]', 'div[aria-label="Tutup"][role="button"]', 'div[aria-label="Close"][role="button"]']; for (const sel of selectors) { const buttons = document.querySelectorAll(sel); for (const btn of buttons) { const rect = btn.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; try { const cs = window.getComputedStyle(btn); if (cs.display === 'none' || cs.visibility === 'hidden') continue; if (parseFloat(cs.opacity) < 0.5) continue; } catch (e) {} return btn; } } return null; }
    function extractUrlFromOpenDialog() { const dialogs = getVisibleDialogs(); if (dialogs.length === 0) return null; const dialog = dialogs[dialogs.length - 1]; const commentLinks = dialog.querySelectorAll('a[href*="comment_id="]'); for (const link of commentLinks) { const href = link.href || ''; if (href.includes('/share/')) continue; const cleaned = cleanUrl(href); if (urlHasIdentifier(cleaned)) return cleaned; } const directLinks = dialog.querySelectorAll('a[href]'); for (const link of directLinks) { const href = link.href || ''; if (!href || !isValidPostUrl(href) || href.includes('/share/')) continue; try { const u = new URL(href, window.location.origin); if (u.pathname === '/' || u.pathname === '') continue; } catch (e) { continue; } const cleaned = cleanUrl(href); if (urlHasIdentifier(cleaned)) return cleaned; } return null; }

    function getSkipKeywords() { return RUNTIME_CONFIG.skip_keywords.slice(); }

    // ============================================================
    // v72.39.0: SIMPLIFIED KEYWORD CHECK — cek 2 komentar teratas
    // Port dari targeting.js STEP 6 (article aria-label scan)
    // ============================================================
    function checkTop2CommentsForKeyword() {
        const skipKeywords = getSkipKeywords();
        if (skipKeywords.length === 0) {
            return { found: false, matchedKeyword: null, rank: null, details: 'no skip_keywords configured' };
        }

        const dialogs = getVisibleDialogs();
        const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document;

        // Query articles dengan aria-label komentar (sama dengan targeting.js)
        const articles = Array.from(scope.querySelectorAll('[role="article"]'))
            .filter(a => {
                const al = a.getAttribute('aria-label') || '';
                return al.startsWith('Komentar oleh') || al.startsWith('Comment by');
            })
            .filter(a => {
                const r = a.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });

        if (articles.length === 0) {
            addLog('Top2Check: no comment articles found in dialog', 'info');
            return { found: false, matchedKeyword: null, rank: null, details: 'no articles (0)' };
        }

        addLog('Top2Check: found ' + articles.length + ' comment articles, checking top 2', 'info');

        const top2 = articles.slice(0, 2);
        for (let i = 0; i < top2.length; i++) {
            const art = top2[i];
            const text = (art.textContent || '').toLowerCase();
            const al = art.getAttribute('aria-label') || '';
            const commenter = al.replace(/^Komentar oleh\s+/, '').replace(/^Comment by\s+/, '').substring(0, 40);

            for (const kw of skipKeywords) {
                if (text.includes(kw.toLowerCase())) {
                    addLog('Top2Check: MATCH rank #' + (i + 1) + ' by "' + commenter + '" keyword="' + kw + '"', 'skip');
                    return {
                        found: true,
                        matchedKeyword: kw,
                        rank: i + 1,
                        details: 'rank #' + (i + 1) + ' by "' + commenter + '"'
                    };
                }
            }
            addLog('Top2Check: rank #' + (i + 1) + ' by "' + commenter + '" — clean', 'info');
        }

        return { found: false, matchedKeyword: null, rank: null, details: 'top 2 clean (' + articles.length + ' total articles)' };
    }

    async function extractUrlWithRetry(post, advertiser) {
        const MAX_ATTEMPTS = 3; const URL_WAIT_MS = 4000; const URL_POLL_INTERVAL = 100;
        let commentCount = 0;
        function randDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (shouldStop) return null;
            if (attempt > 1) { retryCount++; addLog('Extract: Retry ' + attempt + '/' + MAX_ATTEMPTS + ' untuk "' + advertiser + '"', 'retry'); updateUI(); await interruptibleSleep(2000); if (shouldStop) return null; }
            if (isDialogOpen()) { addLog('Extract: dialog masih open, force close dulu...', 'info'); await closeDialogForce(); await sleep(500); }
            const commentBtn = findCommentButtonInPost(post);
            if (!commentBtn) { addLog('Extract: Comment button not found', 'warning'); continue; }
            const urlBefore = window.location.href;
            try { commentBtn.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
            await sleep(randDelay(400, 700));
            try { commentBtn.click(); logEvent('CAPTURE LINK'); addLog('Extract: comment button clicked', 'info'); } catch (e) { addLog('Extract: click err: ' + e.message, 'warning'); continue; }
            const startTime = Date.now(); let capturedUrl = null;
            while (Date.now() - startTime < URL_WAIT_MS) {
                if (shouldStop) { await closeCommentModal(); return null; }
                const currentUrl = window.location.href;
                if (currentUrl !== urlBefore && isValidPostUrl(currentUrl)) {
                    // Simpan URL pertama yang valid (sebelum FB SPA rewrite)
                    const firstValidUrl = currentUrl;
                    await sleep(300);
                    const reReadUrl = window.location.href;
                    // Validasi ulang setelah sleep — FB SPA kadang rewrite balik ke permalink.php kosong
                    if (isValidPostUrl(reReadUrl)) {
                        // Re-read masih valid, pakai versi terbaru (lebih lengkap)
                        capturedUrl = reReadUrl;
                    } else {
                        // Re-read invalid (FB SPA rewrite) — fallback ke URL pertama yang valid
                        addLog('Extract: FB SPA rewrite ke URL invalid setelah 300ms, fallback ke URL pertama', 'warning');
                        capturedUrl = firstValidUrl;
                    }
                    break;
                }
                await sleep(URL_POLL_INTERVAL);
            }
            if (capturedUrl) { addLog('Extract: URL via navigation: ' + capturedUrl.substring(0, 70), 'info'); }
            else if (isDialogOpen()) { addLog('Extract: URL ga changed, scan DOM dari dialog...', 'info'); capturedUrl = extractUrlFromOpenDialog(); if (capturedUrl) addLog('Extract: URL via DOM scan: ' + capturedUrl.substring(0, 70), 'success'); else addLog('Extract: DOM scan tidak ketemu URL', 'warning'); }
            commentCount = 0;
            if (capturedUrl) {
                addLog('Extract: tunggu modal fully loaded (max 30s)...', 'info');
                const readyResult = await waitForCommentSectionReady();
                // v73.1.0: Filter belumAda DIHAPUS — post tanpa komentar tetap lolos
                // v73.1.0: Filter timeout-no-count DIHAPUS — post timeout tetap lolos
                // v73.1.0: Filter min_comment_inbox DIHAPUS — semua count lolos
                if (readyResult.belumAda) {
                    addLog('Extract: "Belum ada komentar" detected, lanjut SAVE (no top2 check needed)', 'info');
                }
                commentCount = readyResult.count || 0;
                addLog('Extract: comment count = ' + commentCount + ' (source: ' + readyResult.reason + ')', 'info');

                // v72.39.0: SIMPLIFIED KEYWORD CHECK — cek top 2 komentar
                // v73.1.0: kalau count=0 (belum ada komentar / timeout) skip top2 check (no comments to check anyway)
                if (commentCount > 0) {
                    const skipKeywords = getSkipKeywords();
                    if (skipKeywords.length === 0) {
                        addLog('Extract: skip keywords empty, langsung SAVE URL (count=' + commentCount + ')', 'info');
                    } else {
                        // Tunggu articles muncul di dialog
                        addLog('Extract: tunggu ' + (ARTICLE_SCAN_WAIT_MS/1000) + 's untuk articles load...', 'info');
                        await sleep(ARTICLE_SCAN_WAIT_MS);

                        // Cek top 2 komentar saja
                        addLog('Extract: check top 2 comments untuk ' + skipKeywords.length + ' skip keyword(s)...', 'info');
                        const top2Result = checkTop2CommentsForKeyword();

                        if (top2Result.found) {
                            skippedKeyword++;
                            logEvent('SKIP TOP2 KW');
                            addLog('Extract: SKIP keyword "' + top2Result.matchedKeyword + '" di ' + top2Result.details + ' (count=' + commentCount + ')', 'skip');
                            await closeCommentModal();
                            await sleep(randDelay(1000, 2000));
                            return { skipped: true, reason: 'keyword-found-top2', matchedKeyword: top2Result.matchedKeyword, commentCount: commentCount };
                        }

                        addLog('Extract: top 2 clean (' + top2Result.details + '), lanjut SAVE (count=' + commentCount + ')', 'info');
                    }
                }
            }
            await closeCommentModal(); await sleep(randDelay(1000, 2000));
            if (capturedUrl) {
                if (capturedUrl === lastExtractedUrl) { addLog('Extract: same URL as previous post, retry...', 'warning'); continue; }
                const finalUrl = cleanUrl(capturedUrl);
                // FINAL GATE: pastikan URL punya identifier valid sebelum submit
                // Cegah URL sampah seperti https://www.facebook.com/permalink.php (tanpa story_fbid/fbid)
                if (!urlHasIdentifier(finalUrl)) {
                    addLog('Extract: REJECT URL tanpa identifier valid: ' + finalUrl + ' (retry)', 'warning');
                    continue;
                }
                addLog('Extract: captured = ' + capturedUrl.substring(0, 70) + ' | count=' + commentCount, 'success');
                lastExtractedUrl = capturedUrl;
                return { url: finalUrl, commentCount: commentCount };
            }
        }
        logEvent('NOT FOUND');
        addLog('Extract: FAILED setelah ' + MAX_ATTEMPTS + ' attempts untuk "' + advertiser + '"', 'error');
        await closeCommentModal();
        return null;
    }

    async function extractOnePost(marker) {
        const post = findPostContainerFromMarker(marker);
        if (!post) { addLog('Post: container tidak ketemu dari marker', 'warning'); return { success: false }; }
        if (post.getAttribute('data-fb-extracted') === '1') return { success: false };
        if (!isInMainFeed(post)) { addLog('Post: skip - bukan di main feed', 'info'); post.setAttribute('data-fb-extracted', '1'); return { success: false }; }
        const visPercent = getViewportVisibilityPercent(post);
        if (visPercent < SETTINGS.MIN_VIEWPORT_VISIBILITY_PERCENT) { const rect = post.getBoundingClientRect(); if (rect.height < 50 || rect.width < 100) return { success: false }; addLog('Post: visibility ' + Math.round(visPercent) + '%, scroll into view...', 'info'); await scrollPostIntoView(post); if (!isPostVisibleEnough(post)) { addLog('Post: masih ga cukup visible setelah scroll, skip', 'info'); return { success: false }; } }
        const advertiserCheck = extractAdvertiserFromPost(post);
        const excludeResult = isAdvertiserExcluded(advertiserCheck);
        if (excludeResult.excluded) { skippedExcluded++; addLog('Post: EXCLUDED "' + advertiserCheck + '" (keyword: "' + excludeResult.keyword + '")', 'skip'); post.setAttribute('data-fb-extracted', '1'); post.style.outline = '2px dotted #ff6b6b'; updateUI(); return { success: false }; }
        const cta = hasCTA(post);
        if (!cta.found) { skippedNoCTA++; addLog('Post: SKIP "' + advertiserCheck + '" - no CTA', 'skip'); post.setAttribute('data-fb-extracted', '1'); post.style.outline = '2px dotted #555'; updateUI(); return { success: false }; }
        const commentBtnPreCheck = findCommentButtonInPost(post);
        if (!commentBtnPreCheck) { skippedNoCTA++; addLog('Post: SKIP "' + advertiserCheck + '" - no comment button', 'skip'); post.setAttribute('data-fb-extracted', '1'); post.style.outline = '2px dotted #888'; updateUI(); return { success: false }; }
        post.setAttribute('data-fb-processing', '1'); post.style.outline = '3px solid #ff4444';
        let advertiser = advertiserCheck;
        if (advertiser === 'Unknown') { try { const h = post.querySelector('h3 a strong, h4 a strong, h3 strong, h4 strong, h3 a span, h4 a span, h3 a, h4 a'); if (h) { const t = (h.innerText || '').trim(); if (t && t.length > 1 && t.length < 80) advertiser = t; } } catch (e) {} }
        detectedCount++; addLog('Post: DETECTED #' + detectedCount + ' "' + advertiser + '" (CTA: "' + cta.text + '")', 'detect'); updateUI();
        const readPauseMs = randMs('READ_BEFORE_LIKE_MIN_MS', 'READ_BEFORE_LIKE_MAX_MS');
        addLog('Post: simulate read ' + readPauseMs + 'ms...', 'info');
        const ok = await interruptibleSleep(readPauseMs);
        if (!ok) { post.removeAttribute('data-fb-processing'); return { success: false }; }
        setPhase('extracting', 'Processing ' + advertiser);
        const extractResult = await extractUrlWithRetry(post, advertiser);
        post.setAttribute('data-fb-extracted', '1'); post.removeAttribute('data-fb-processing');

        let shouldOrderSmm = false; let routedToViral = false;

        if (extractResult && typeof extractResult === 'object' && extractResult.skipped) {
            post.style.outline = '3px solid #9c27b0';
            addLog('Post: SKIPPED (keyword: ' + extractResult.matchedKeyword + ', count=' + (extractResult.commentCount || 0) + ', reason=' + extractResult.reason + ') "' + advertiser + '"', 'info'); updateUI();
        } else if (!extractResult) { post.style.outline = '3px dashed #ffaa00'; addLog('Post: EXTRACT-FAIL "' + advertiser + '"', 'warning');
        } else {
            const cleanedUrl = extractResult.url; const commentCount = extractResult.commentCount || 0; const isReel = cleanedUrl.indexOf('/reel/') !== -1;
            if (isReel && !RUNTIME_CONFIG.scraper.include_reels) { skippedReels++; post.style.outline = '2px dotted #888'; logEvent('SKIP REEL'); addLog('Post: SKIP REEL (include_reels=false) "' + advertiser + '"', 'info'); updateUI(); return { success: false }; }
            const minCommentViral = RUNTIME_CONFIG.scraper.min_comment_viral;
            const isViralCandidate = commentCount >= minCommentViral;
            addLog('Post: URL final = ' + cleanedUrl.substring(0, 70) + ' | count=' + commentCount + (isReel ? ' | type=REEL' : '') + (isViralCandidate ? ' | type=VIRAL (>=' + minCommentViral + ')' : ''), 'info');
            if (isReel && commentCount >= minCommentViral) addLog('Post: REEL viral-count detected (count=' + commentCount + ') tapi REEL > force INBOX-only route', 'info');
            if (commentCount === 0) addLog('Post: commentCount=0 > INBOX only', 'warning');
            else if (isReel) addLog('Post: REEL > INBOX only (count=' + commentCount + ')', 'info');
            else if (isViralCandidate) addLog('Post: VIRAL DUAL-WRITE (count=' + commentCount + ' >= ' + minCommentViral + ') > INBOX+SMM lalu Viral_History', 'success');
            else addLog('Post: INBOX route (count=' + commentCount + ' < ' + minCommentViral + ')', 'info');

            const sheetResult = await submitToSheet({ url: cleanedUrl }, isViralCandidate);
            if (sheetResult.ok && sheetResult.status === 'new') {
                collectedLinks.push({ url: cleanedUrl, advertiser: advertiser, cta: cta.text, timestamp: new Date().toISOString(), row: sheetResult.row, comment_count: commentCount });
                saveLinks(); post.style.outline = '3px solid #42b72a'; logEvent('SUCCESS POST');
                addLog('Post: SAVED #' + collectedLinks.length + ' "' + advertiser + '"', 'success'); flashNotification('OK ' + advertiser); linksSinceLastDelay++; shouldOrderSmm = true; updateUI();
            } else if (sheetResult.ok && sheetResult.status === 'duplicate') { skippedDuplicate++; post.style.outline = '3px solid #ff77ff'; logEvent('LINK DEDUP'); addLog('Post: DUPLICATE (row #' + sheetResult.row + ') "' + advertiser + '"', 'info'); updateUI();
            } else if (!sheetResult.ok && sheetResult.reason === 'dedup-active') { skippedDuplicate++; post.style.outline = '3px solid #ff77ff'; logEvent('LINK DEDUP'); addLog('Post: DEDUP-ACTIVE (row #' + sheetResult.existing_row + ') "' + advertiser + '"', 'info'); updateUI();
            } else if (!sheetResult.ok && sheetResult.reason === 'dedup-viral') { skippedDuplicate++; post.style.outline = '3px solid #ff6b35'; logEvent('VIRAL DUP'); addLog('Post: DEDUP-VIRAL (URL existing di Viral_History row #' + sheetResult.existing_row + ') "' + advertiser + '"', 'info'); updateUI();
            } else { post.style.outline = '3px dashed #ffaa00'; addLog('Post: SHEET-ERROR (' + (sheetResult.reason || 'unknown') + ') "' + advertiser + '"', 'warning'); }

            if (shouldOrderSmm) {
                const comments = getCommentsList();
                if (comments.length < 5) { addLog('SMM: comments < 5, skip order', 'warning'); }
                else {
                    await sleep(800);
                    const orderResult = await submitOrderToSMM(cleanedUrl, isViralCandidate);
                    if (orderResult.ok) {
                        // v73.2.0: kalau ada retry_note (sukses setelah fallback), kirim ke sheet kolom Note
                        const noteForSheet = orderResult.retry_note || '';
                        await updateSheetStatus(sheetResult.row, 'Proses', orderResult.order_id, noteForSheet, orderResult.smm_panel);
                        addLog('Order: "' + advertiser + '" #' + orderResult.order_id + ' (' + orderResult.smm_panel + ')' + (orderResult.retry_note ? ' [' + orderResult.retry_note + ']' : ''), 'success');
                    } else {
                        await updateSheetStatus(sheetResult.row, 'Gagal', '', orderResult.error || 'unknown', orderResult.smm_panel);
                        addLog('Order: "' + advertiser + '" failed: ' + orderResult.error, 'error');
                    }
                }
            }

            if (isViralCandidate && sheetResult.ok && sheetResult.status === 'new') {
                await sleep(500); addLog('Post: STEP 3 - DUAL-WRITE submit Viral_History...', 'info');
                const viralResult = await submitToViralHistory(cleanedUrl, commentCount, true);
                if (viralResult.ok && viralResult.status === 'new') { viralSavedCount++; routedToViral = true; post.style.outline = '3px solid #ff6b35'; logEvent('VIRAL SAVED'); addLog('Post: VIRAL SAVED #' + viralSavedCount + ' "' + advertiser + '" (Viral row #' + viralResult.row + ')', 'success'); flashNotification('VIRAL ' + advertiser); updateUI();
                } else if (!viralResult.ok && viralResult.reason === 'duplicate') { viralDupCount++; logEvent('VIRAL DUP'); addLog('Post: VIRAL DUP (existing Viral row #' + viralResult.existing_row + ')', 'info'); updateUI();
                } else { addLog('Post: VIRAL DUAL-WRITE failed: ' + (viralResult.error || viralResult.reason) + ' "' + advertiser + '"', 'warning'); }
            } else if (isViralCandidate) { addLog('Post: SKIP Viral dual-write (Inbox not NEW, status: ' + (sheetResult.status || sheetResult.reason) + ')', 'info'); }
        }
        return { success: shouldOrderSmm || routedToViral };
    }

    async function scanAndExtractAll() {
        setPhase('scanning', 'Scanning markers'); let totalExtracted = 0; let pass = 0;
        while (pass < SETTINGS.MAX_PASSES) { pass++; if (shouldStop) return totalExtracted; if (!(await waitWhilePaused())) return totalExtracted;
            const markers = findAllMarkers(); const unprocessedPosts = new Map(); const offScreenSkipped = [];
            for (const marker of markers) { const post = findPostContainerFromMarker(marker); if (!post) continue; if (post.getAttribute('data-fb-extracted') === '1') continue; if (post.getAttribute('data-fb-processing') === '1') continue; if (unprocessedPosts.has(post)) continue; const rect = post.getBoundingClientRect(); const vh = window.innerHeight; const markerRect = marker.getBoundingClientRect(); const markerVisible = markerRect.bottom > 0 && markerRect.top < vh && markerRect.width > 0; const postPartlyVisible = rect.bottom > 50 && rect.top < vh - 50; if (!markerVisible && !postPartlyVisible) { const distanceBelow = rect.top - vh; const distanceAbove = -rect.bottom; if (distanceBelow > vh * 0.3 || distanceAbove > vh * 0.3) { offScreenSkipped.push(post); continue; } } unprocessedPosts.set(post, marker); }
            if (unprocessedPosts.size === 0) { if (pass === 1) { if (offScreenSkipped.length > 0) addLog('Scan: ' + offScreenSkipped.length + ' CTA off-screen (skip pass)', 'info'); else addLog('Scan: no sponsored markers found', 'info'); } break; }
            addLog('Scan: Pass ' + pass + ' > ' + unprocessedPosts.size + ' candidate(s)', 'detect');
            for (const [post, marker] of unprocessedPosts) { if (shouldStop) return totalExtracted; if (!(await waitWhilePaused())) return totalExtracted; if (isDialogOpen()) { addLog('Scan: dialog open - force close before processing', 'warning'); await closeDialogForce(); await sleep(1000); } const result = await extractOnePost(marker); if (result.success) totalExtracted++; const pauseMs = randMs('BETWEEN_POSTS_MIN_MS', 'BETWEEN_POSTS_MAX_MS'); addLog('Scan: pause ' + pauseMs + 'ms before next post', 'info'); const ok2 = await interruptibleSleep(pauseMs); if (!ok2) return totalExtracted; }
        }
        return totalExtracted;
    }

    async function mainLoop() {
        if (mainLoopRunning) { addLog('Main: already running, ignore start', 'warning'); return; }
        if (!RUNTIME_CONFIG.loaded) { addLog('Main: config not loaded yet, cannot start', 'error'); return; }
        mainLoopRunning = true; shouldStop = false; isPaused = false; lastExtractedUrl = null;
        try { const navigated = await ensureOnFeedPage(); if (navigated) { mainLoopRunning = false; return; } await waitPageFullyLoaded(); addLog('Main: FEED loop active (min_viral=' + RUNTIME_CONFIG.scraper.min_comment_viral + ' reels=' + RUNTIME_CONFIG.scraper.include_reels + ')', 'success'); } catch (e) { addLog('Main: FEED ensure error: ' + e.message, 'warning'); }
        startWatchdog(); startHeartbeatWatchdog(); startWebWorkerHeartbeat(); updateUI();
        let stuckCount = 0;
        try {
            while (!shouldStop) { incrementHeartbeat(); if (!(await waitWhilePaused())) break;
                if (isFBErrorVisible()) { errorRecoveryCount++; addLog('Main: FB error page detected - navigate FEED', 'warning'); if (isDialogOpen()) await closeDialogForce(); await sleep(500); navigateToFeedRecover('fb-error-visible'); return; }
                if (isDialogOpen()) { addLog('Main: dialog open - close first', 'info'); await closeCommentModal(); await sleep(500); if (isDialogOpen()) { errorRecoveryCount++; addLog('Main: dialog stuck - force close, lanjut loop', 'warning'); await closeDialogForce(); await sleep(1000); if (isDialogOpen()) { navigateToFeedRecover('modal-stuck'); } } }
                await scanAndExtractAll(); if (shouldStop) break;
                setPhase('scrolling', 'Scrolling (' + (scrollAttempts + 1) + ')'); scrollAttempts++; updateUI();
                const moved = await naturalScrollStep();
                if (!moved) { stuckCount++; addLog('Main: scroll didnt move (stuck count = ' + stuckCount + ')', 'info'); if (stuckCount >= 3) { addLog('Main: scroll stuck 3x, big jump', 'warning'); try { window.scrollBy({ top: 2500, behavior: 'smooth' }); } catch (e) { window.scrollBy(0, 2500); } await interruptibleSleep(2000); if (stuckCount >= 4) { addLog('Main: end of feed - navigate FEED', 'warning'); errorRecoveryCount++; try { if (isDialogOpen()) await closeDialogForce(); } catch (e) {} await sleep(2000); navigateToFeedRecover('scroll-stuck'); return; } } } else stuckCount = 0;
                if (isFBErrorVisible()) { errorRecoveryCount++; addLog('Main: FB error post-scroll - navigate FEED', 'warning'); if (isDialogOpen()) await closeDialogForce(); await sleep(500); navigateToFeedRecover('fb-error-after-scroll'); return; }
                setPhase('waiting', 'Waiting content load'); await interruptibleSleep(SETTINGS.CONTENT_WAIT_MS);
            }
        } catch (e) { addLog('Main: loop exception: ' + e.message + ' > tutup modal, lanjut', 'error'); errorRecoveryCount++; try { if (isDialogOpen()) await closeDialogForce(); } catch (err) {} addLog('WOULD REFRESH: loop-exception (disabled, scraper stopped)', 'error');
        } finally { stopWatchdog(); if (isDialogOpen()) await closeDialogForce(); mainLoopRunning = false; isPaused = false; setPhase('idle', 'Stopped'); addLog('Main: stopped, stats: detected=' + detectedCount + ' inbox=' + collectedLinks.length + ' viral=' + viralSavedCount + ' dup=' + skippedDuplicate + ' skip-kw=' + skippedKeyword + ' skip-reel=' + skippedReels, 'info'); }
    }

    function stopMainLoop() { shouldStop = true; isPaused = false; stopWatchdog(); GM_setValue(AUTO_RESUME_KEY, ''); addLog('Main: STOP requested', 'info'); }
    function togglePause() { if (!mainLoopRunning) { addLog('Main: not running, cannot pause', 'warning'); return; } isPaused = !isPaused; if (isPaused) addLog('Main: PAUSED (state preserved)', 'warning'); else { addLog('Main: RESUMED', 'success'); markActivity(); } updateUI(); }
    function escapeHTML(str) { if (!str) return ''; return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    function createPanel() {
        const existing = document.getElementById('fb-scraper-panel'); if (existing) existing.remove();
        const panel = document.createElement('div'); panel.id = 'fb-scraper-panel';
        panel.innerHTML = '<style>'
        + '#fb-scraper-panel { position: fixed !important; top: 80px !important; right: 15px !important; width: 280px !important; background: #1c1e21 !important; color: #e4e6eb !important; font-family: -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 13px !important; border-radius: 10px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; z-index: 2147483647 !important; border: 1px solid #3a3b3c !important; max-height: calc(100vh - 100px) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; }'
        + '#fb-scraper-panel.minimized { width: 160px !important; max-height: none !important; }'
        + '#fb-scraper-panel .fbs-header { background: linear-gradient(135deg, #42b72a, #2d8a1c); padding: 10px 12px; cursor: move; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }'
        + '#fb-scraper-panel .fbs-title { font-weight: 700; color: white; font-size: 13px; }'
        + '#fb-scraper-panel .fbs-mini-btn { background: rgba(255,255,255,0.2); border: none; color: white; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; }'
        + '#fb-scraper-panel .fbs-body { padding: 12px; overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-height: 0; }'
        + '#fb-scraper-panel.minimized .fbs-body { display: none; }'
        + '#fb-scraper-panel .fbs-saved-box { text-align: center; padding: 14px 10px; background: #2d2f33; border-radius: 8px; margin-bottom: 10px; }'
        + '#fb-scraper-panel .fbs-saved-num { font-size: 32px; font-weight: 700; color: #42b72a; line-height: 1; }'
        + '#fb-scraper-panel .fbs-saved-label { font-size: 10px; color: #b0b3b8; margin-top: 4px; text-transform: uppercase; }'
        + '#fb-scraper-panel .fbs-stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; font-size: 9px; text-align: center; }'
        + '#fb-scraper-panel .fbs-stat-cell { background: #141618; padding: 4px; border-radius: 4px; }'
        + '#fb-scraper-panel .fbs-stat-cell .num { font-weight: 700; font-size: 12px; color: #42b72a; }'
        + '#fb-scraper-panel .fbs-stat-cell .lbl { color: #b0b3b8; font-size: 8px; }'
        + '#fb-scraper-panel .fbs-btn { width: 100%; padding: 10px; border: none; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 13px; margin-bottom: 6px; }'
        + '#fb-scraper-panel .fbs-btn-start { background: #42b72a; color: white; }'
        + '#fb-scraper-panel .fbs-btn-start:disabled { background: #555; cursor: not-allowed; opacity: 0.6; }'
        + '#fb-scraper-panel .fbs-btn-stop { background: #e41e3f; color: white; }'
        + '#fb-scraper-panel .fbs-btn-pause { background: #ffaa00; color: black; }'
        + '#fb-scraper-panel .fbs-btn-play { background: #1877f2; color: white; }'
        + '#fb-scraper-panel .fbs-btn-clear { background: #3a3b3c; color: #b0b3b8; font-size: 11px; }'
        + '#fb-scraper-panel .fbs-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }'
        + '#fb-scraper-panel .fbs-row .fbs-btn { margin-bottom: 0; }'
        + '#fb-scraper-panel .fbs-toast { position: fixed; bottom: 20px; right: 20px; background: #42b72a; color: white; padding: 10px 16px; border-radius: 6px; font-weight: 600; z-index: 2147483647; }'
        + '</style>'
        + '<div class="fbs-header" id="fbs-header"><span class="fbs-title">FB Scraper v73.2.0</span><button class="fbs-mini-btn" id="fbs-minimize">_</button></div>'
        + '<div class="fbs-body">'
        + '<div class="fbs-saved-box"><div class="fbs-saved-num" id="fbs-stat-count">0</div><div class="fbs-saved-label">Link Inbox Tersimpan</div></div>'
        + '<div class="fbs-stats-row"><div class="fbs-stat-cell"><div class="num" id="fbs-stat-detected" style="color:#42b72a;">0</div><div class="lbl">Detected</div></div><div class="fbs-stat-cell"><div class="num" id="fbs-stat-dup" style="color:#ff77ff;">0</div><div class="lbl">Inbox Dup</div></div></div>'
        + '<div class="fbs-stats-row"><div class="fbs-stat-cell"><div class="num" id="fbs-stat-viral-saved" style="color:#ff6b35;">0</div><div class="lbl">Viral Saved</div></div><div class="fbs-stat-cell"><div class="num" id="fbs-stat-viral-dup" style="color:#ff77ff;">0</div><div class="lbl">Viral Dup</div></div></div>'
        + '<div class="fbs-stats-row"><div class="fbs-stat-cell"><div class="num" id="fbs-stat-skip-kw" style="color:#9c27b0;">0</div><div class="lbl">Skip KW</div></div><div class="fbs-stat-cell"><div class="num" id="fbs-stat-skip-reel" style="color:#888;">0</div><div class="lbl">Skip Reel</div></div></div>'
        + '<div id="fbs-mode-box" style="background:#1c1e21;border:1px solid #3a3b3c;border-radius:6px;padding:6px 8px;margin-bottom:8px;text-align:center;font-size:10px;"><div id="fbs-mode-status" style="color:#42b72a;font-weight:700;">FEED idle</div></div>'
        + '<div id="fbs-config-box" style="background:#0d1f3a;border:1px solid #1877f2;border-radius:6px;padding:8px;margin-bottom:8px;font-size:10px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-weight:700;color:#1877f2;">CONFIG (sheet)</span><button id="fbs-config-refresh" style="background:#1877f2;color:white;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:700;font-size:10px;">Refresh</button></div><div id="fbs-config-status" style="color:#b0b3b8;font-size:9px;line-height:1.5;">Loading...</div></div>'
        + '<button class="fbs-btn fbs-btn-start" id="fbs-btn-toggle" disabled>WAITING CONFIG...</button>'
        + '<div class="fbs-row" id="fbs-btn-row-pause-stop" style="display:none;margin-bottom:6px;"><button class="fbs-btn fbs-btn-stop" id="fbs-btn-stop">STOP</button><button class="fbs-btn fbs-btn-pause" id="fbs-btn-pause">PAUSE</button></div>'
        + '<button class="fbs-btn fbs-btn-clear" id="fbs-btn-clear">Clear Semua</button>'
        + '<div style="margin-top:10px;border-top:1px solid #3a3b3c;padding-top:8px;"><div style="font-size:11px;color:#b0b3b8;font-weight:700;margin-bottom:4px;">LOGS (30min rolling)</div><div id="fbs-log-box" style="background:#0a0b0c;border:1px solid #2d2f33;border-radius:4px;padding:4px;max-height:160px;overflow-y:auto;font-family:monospace;"><div style="color:#666;font-size:9px;text-align:center;padding:8px;">(no events)</div></div></div>'
        + '<div style="margin-top:10px;border-top:1px solid #3a3b3c;padding-top:8px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:11px;color:#b0b3b8;font-weight:700;">AKUN FB</span><button id="fbs-btn-akunfb-toggle" style="background:#3a3b3c;color:#b0b3b8;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:700;font-size:10px;">Edit</button></div><div id="fbs-akunfb-status" style="font-size:10px;color:#666;text-align:center;padding:4px;">Loading...</div><div id="fbs-akunfb-config" style="display:none;margin-top:6px;"><input id="fbs-akunfb-input" type="text" placeholder="Nama akun FB" style="width:100%;background:#141618;color:#e4e6eb;border:1px solid #3a3b3c;padding:5px 7px;border-radius:4px;font-size:10px;box-sizing:border-box;margin-bottom:4px;"><button id="fbs-akunfb-save" style="background:#42b72a;color:white;border:none;padding:5px;border-radius:4px;cursor:pointer;font-weight:700;font-size:10px;width:100%;">Save</button></div></div>'
        + '</div>';
        document.body.appendChild(panel);
        wirePanelEvents(panel);
        makeDraggable(panel, document.getElementById('fbs-header'));
        applyPanelZoom();
        attachPanelZoomHandler(panel);
        setInterval(() => { try { updateUI(); } catch (e) {} }, 30000);
        updateUI();
        logEvent('SCRAPER STARTED');
        fetchConfigWithRetry().then(() => { startPeriodicConfigRefresh(); });
        try {
            const shouldResume = GM_getValue(AUTO_RESUME_KEY, '');
            if (shouldResume === '1') GM_setValue(AUTO_RESUME_KEY, '');
            const tryResume = () => {
                if (mainLoopRunning) return;
                if (!RUNTIME_CONFIG.loaded) { setTimeout(tryResume, 3000); return; }
                const akunFb = (GM_getValue(AKUN_FB_KEY, '') || '').trim();
                if (!akunFb) { setTimeout(tryResume, 5000); return; }
                if (RUNTIME_CONFIG.komentar.length < 5) { setTimeout(tryResume, 5000); return; }
                try { mainLoop(); } catch (e) {}
                setTimeout(() => { if (!mainLoopRunning) tryResume(); }, 5000);
            };
            setTimeout(tryResume, 8000);
        } catch (e) {}
    }

    function wirePanelEvents(panel) {
        document.getElementById('fbs-minimize').addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('minimized'); });
        document.getElementById('fbs-config-refresh').addEventListener('click', async () => { await forceRefreshConfig(); });
        document.getElementById('fbs-btn-toggle').addEventListener('click', () => {
            if (mainLoopRunning) return;
            if (!RUNTIME_CONFIG.loaded) { alert('Config belum loaded.'); return; }
            const akunFb = (GM_getValue(AKUN_FB_KEY, '') || '').trim();
            if (!akunFb) { alert('Nama Akun FB belum diisi!'); return; }
            const commentsList = getCommentsList();
            if (commentsList.length < 5) { alert('Komentar di sheet kurang dari 5!'); return; }
            mainLoop();
        });
        document.getElementById('fbs-btn-stop').addEventListener('click', () => { if (!mainLoopRunning) return; stopMainLoop(); });
        document.getElementById('fbs-btn-pause').addEventListener('click', () => togglePause());
        document.getElementById('fbs-btn-clear').addEventListener('click', () => {
            if (confirm('Hapus ' + collectedLinks.length + ' link?')) {
                clearLinks(); logMessages = []; detectedCount = 0; scrollAttempts = 0; skippedNoCTA = 0; skippedExcluded = 0; skippedKeyword = 0; skippedDuplicate = 0; skippedReels = 0; viralSavedCount = 0; viralDupCount = 0; linksSinceLastDelay = 0; retryCount = 0; errorRecoveryCount = 0; lastExtractedUrl = null;
                document.querySelectorAll('[data-fb-extracted], [data-fb-processing]').forEach(el => { el.removeAttribute('data-fb-extracted'); el.removeAttribute('data-fb-processing'); el.style.outline = ''; });
                addLog('UI: cleared all stats + markers', 'info'); updateUI();
            }
        });
        const akunfbInput = document.getElementById('fbs-akunfb-input');
        const akunfbStatus = document.getElementById('fbs-akunfb-status');
        akunfbInput.value = GM_getValue(AKUN_FB_KEY, '');
        function updateAkunFbStatus() { const value = (GM_getValue(AKUN_FB_KEY, '') || '').trim(); if (!value) akunfbStatus.innerHTML = '<span style="color:#ff6b6b;">Belum diisi</span>'; else akunfbStatus.innerHTML = '<span style="color:#42b72a;">OK ' + escapeHTML(value) + '</span>'; }
        updateAkunFbStatus();
        document.getElementById('fbs-btn-akunfb-toggle').addEventListener('click', () => { const cfg = document.getElementById('fbs-akunfb-config'); cfg.style.display = (cfg.style.display === 'none') ? 'block' : 'none'; });
        document.getElementById('fbs-akunfb-save').addEventListener('click', () => { GM_setValue(AKUN_FB_KEY, akunfbInput.value.trim()); updateAkunFbStatus(); addLog('UI: Akun FB saved', 'success'); document.getElementById('fbs-akunfb-config').style.display = 'none'; });
    }

    function getCurrentPanelZoom() { const stored = parseFloat(GM_getValue(PANEL_ZOOM_KEY, '1')); if (isNaN(stored) || stored < PANEL_ZOOM_MIN || stored > PANEL_ZOOM_MAX) return 1; return stored; }
    function applyPanelZoom() { const panel = document.getElementById('fb-scraper-panel'); if (!panel) return; const zoom = getCurrentPanelZoom(); panel.style.transformOrigin = 'top right'; panel.style.transform = 'scale(' + zoom + ')'; }
    function attachPanelZoomHandler(panel) { panel.addEventListener('wheel', function(e) { if (!e.ctrlKey) return; e.preventDefault(); e.stopPropagation(); let zoom = getCurrentPanelZoom(); if (e.deltaY < 0) zoom = Math.min(PANEL_ZOOM_MAX, zoom + PANEL_ZOOM_STEP); else if (e.deltaY > 0) zoom = Math.max(PANEL_ZOOM_MIN, zoom - PANEL_ZOOM_STEP); zoom = Math.round(zoom * 10) / 10; try { GM_setValue(PANEL_ZOOM_KEY, String(zoom)); } catch (err) {} applyPanelZoom(); }, { passive: false }); }

    let lastHeartbeatValue = 0; let lastHeartbeatTime = Date.now(); let heartbeatWatchdogId = null;
    function incrementHeartbeat() { try { const current = parseInt(GM_getValue(HEARTBEAT_KEY, '0')) || 0; GM_setValue(HEARTBEAT_KEY, String(current + 1)); lastHeartbeatValue = current + 1; lastHeartbeatTime = Date.now(); } catch (e) {} }
    function startHeartbeatWatchdog() { if (heartbeatWatchdogId) return; incrementHeartbeat(); heartbeatWatchdogId = setInterval(() => { try { if (!mainLoopRunning) return; if (isPaused) { incrementHeartbeat(); return; } const current = parseInt(GM_getValue(HEARTBEAT_KEY, '0')) || 0; if (current === lastHeartbeatValue) { const elapsed = Date.now() - lastHeartbeatTime; if (elapsed > HEARTBEAT_TIMEOUT_MS) { addLog('WOULD REFRESH: heartbeat-frozen ' + Math.floor(elapsed/1000) + 's (disabled)', 'error'); incrementHeartbeat(); } } else { lastHeartbeatValue = current; lastHeartbeatTime = Date.now(); } } catch (e) {} }, 30000); }
    let webWorkerInstance = null;
    function startWebWorkerHeartbeat() { if (webWorkerInstance) return; try { const workerCode = 'setInterval(() => { self.postMessage({type:"ping"}); }, ' + WORKER_PING_INTERVAL_MS + ');'; const blob = new Blob([workerCode], { type: 'application/javascript' }); webWorkerInstance = new Worker(URL.createObjectURL(blob)); webWorkerInstance.onmessage = function(e) { if (e.data && e.data.type === 'ping') incrementHeartbeat(); }; } catch (err) {} }

    function isOnFeedPage() { const here = window.location.href; if (here.indexOf('/search/') !== -1) return false; if (here.indexOf('/permalink.php') !== -1) return false; if (here.indexOf('/posts/') !== -1) return false; if (here.indexOf('/reel/') !== -1) return false; if (here.indexOf('/photo') !== -1) return false; if (here.indexOf('/video') !== -1) return false; if (here.indexOf('/groups/') !== -1) return false; if (here.indexOf('/marketplace/') !== -1) return false; if (here.indexOf('/watch/') !== -1) return false; return true; }
    async function waitPageFullyLoaded() { const readyDeadline = Date.now() + 15000; while (document.readyState !== 'complete' && Date.now() < readyDeadline) { await sleep(200); if (shouldStop) return; } await sleep(PAGE_FULL_LOAD_WAIT_MS); }
    async function ensureOnFeedPage() { if (isOnFeedPage()) return false; addLog('Nav: bukan di FEED page, redirect...', 'info'); GM_setValue(AUTO_RESUME_KEY, '1'); try { if (isDialogOpen()) await closeDialogForce(); } catch (e) {} await sleep(500); window.location.href = FEED_URL; return true; }
    function makeDraggable(element, handle) { let drag = false, sx, sy, sl, st; handle.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; drag = true; sx = e.clientX; sy = e.clientY; const r = element.getBoundingClientRect(); sl = r.left; st = r.top; e.preventDefault(); }); document.addEventListener('mousemove', e => { if (!drag) return; element.style.left = (sl + e.clientX - sx) + 'px'; element.style.top = (st + e.clientY - sy) + 'px'; element.style.right = 'auto'; }); document.addEventListener('mouseup', () => { drag = false; }); }

    function updateUI() {
        try {
            const c = document.getElementById('fbs-stat-count');
            const btnStart = document.getElementById('fbs-btn-toggle');
            const btnRow = document.getElementById('fbs-btn-row-pause-stop');
            const btnPause = document.getElementById('fbs-btn-pause');
            if (c) c.textContent = collectedLinks.length;
            const detected = document.getElementById('fbs-stat-detected');
            const dup = document.getElementById('fbs-stat-dup');
            if (detected) detected.textContent = detectedCount;
            if (dup) dup.textContent = skippedDuplicate;
            const viralSaved = document.getElementById('fbs-stat-viral-saved');
            const viralDup = document.getElementById('fbs-stat-viral-dup');
            if (viralSaved) viralSaved.textContent = viralSavedCount;
            if (viralDup) viralDup.textContent = viralDupCount;
            const skipKw = document.getElementById('fbs-stat-skip-kw');
            const skipReel = document.getElementById('fbs-stat-skip-reel');
            if (skipKw) skipKw.textContent = skippedKeyword;
            if (skipReel) skipReel.textContent = skippedReels;
            const modeStatus = document.getElementById('fbs-mode-status');
            if (modeStatus) {
                if (!RUNTIME_CONFIG.loaded) { modeStatus.textContent = 'CONFIG loading...'; modeStatus.style.color = '#ffaa00'; }
                else if (mainLoopRunning && isPaused) { modeStatus.textContent = 'FEED PAUSED'; modeStatus.style.color = '#ffaa00'; }
                else if (mainLoopRunning) { modeStatus.textContent = 'FEED ACTIVE — ' + currentPhase; modeStatus.style.color = '#42b72a'; }
                else { modeStatus.textContent = 'FEED idle'; modeStatus.style.color = '#b0b3b8'; }
            }
            if (btnStart) {
                if (!RUNTIME_CONFIG.loaded) { btnStart.disabled = true; btnStart.textContent = 'WAITING CONFIG...'; btnStart.className = 'fbs-btn fbs-btn-start'; }
                else if (mainLoopRunning) { btnStart.style.display = 'none'; if (btnRow) btnRow.style.display = 'grid'; }
                else { btnStart.style.display = 'block'; btnStart.disabled = false; btnStart.textContent = 'START SCRAPING'; btnStart.className = 'fbs-btn fbs-btn-start'; if (btnRow) btnRow.style.display = 'none'; }
            }
            if (btnPause) {
                if (isPaused) { btnPause.textContent = 'RESUME'; btnPause.className = 'fbs-btn fbs-btn-play'; }
                else { btnPause.textContent = 'PAUSE'; btnPause.className = 'fbs-btn fbs-btn-pause'; }
            }
            const configStatus = document.getElementById('fbs-config-status');
            if (configStatus && RUNTIME_CONFIG.loaded) {
                const commentPanels = RUNTIME_CONFIG.smm_panels.filter(p => p.function === 'comment' && p.enabled).length;
                const likePanels = RUNTIME_CONFIG.smm_panels.filter(p => p.function === 'like' && p.enabled).length;
                // v73.2.0: tampilin jumlah akun aktif + total service combinations
                const activeAccounts = buildActiveAccounts();
                const totalServices = activeAccounts.reduce((sum, a) => sum + a.services.length, 0);
                const ts = RUNTIME_CONFIG.last_fetch_ts ? new Date(RUNTIME_CONFIG.last_fetch_ts).toLocaleTimeString('id-ID', { hour12: false }) : '-';
                configStatus.innerHTML = 'Komentar: <b>' + RUNTIME_CONFIG.komentar.length + '</b> | Skip KW: <b>' + RUNTIME_CONFIG.skip_keywords.length + '</b><br>'
                    + 'Exclude: <b>' + RUNTIME_CONFIG.exclude_advertisers.length + '</b> | SMM: <b>' + RUNTIME_CONFIG.smm_panels.length + '</b> (comment=' + commentPanels + ' like=' + likePanels + ')<br>'
                    + 'Active: <b>' + activeAccounts.length + '</b> akun, <b>' + totalServices + '</b> services | Reels: <b>' + (RUNTIME_CONFIG.scraper.include_reels ? 'ON' : 'OFF') + '</b><br>'
                    + 'Min viral: <b>' + RUNTIME_CONFIG.scraper.min_comment_viral + '</b> | Inbox Qty: <b>' + RUNTIME_CONFIG.scraper.smm_inbox_quantity + '</b><br>'
                    + 'Last fetch: ' + ts + ' (' + RUNTIME_CONFIG.last_fetch_status + ')';
            }
            renderLogPanel();
        } catch (e) {}
    }

    function flashNotification(msg) {
        try {
            const toast = document.createElement('div');
            toast.className = 'fbs-toast';
            toast.textContent = msg;
            document.body.appendChild(toast);
            setTimeout(() => { try { toast.remove(); } catch (e) {} }, 3000);
        } catch (e) {}
    }

    // Daily reset at 00:00 WIB
    function scheduleDailyReset() {
        function getNextMidnightWIB() {
            // Hitung 00:00 WIB berikutnya dengan cara sederhana dan aman
            const now = Date.now();
            const WIB_OFFSET_MS = 7 * 3600000; // UTC+7
            const DAY_MS = 86400000;
            // Waktu WIB sekarang dalam ms sejak epoch
            const wibNowMs = now + WIB_OFFSET_MS;
            // Ms yang sudah lewat sejak midnight WIB hari ini
            const msSinceMidnightWIB = wibNowMs % DAY_MS;
            // Ms sampai midnight WIB berikutnya
            let msToNext = DAY_MS - msSinceMidnightWIB;
            // Safety guard: kalau < 60 detik (edge case tepat di midnight), set 24 jam
            if (msToNext < 60000) msToNext = DAY_MS;
            return msToNext;
        }
        function doReset() {
            detectedCount = 0; scrollAttempts = 0; skippedNoCTA = 0; skippedExcluded = 0; skippedKeyword = 0; skippedDuplicate = 0; skippedReels = 0; viralSavedCount = 0; viralDupCount = 0; linksSinceLastDelay = 0; retryCount = 0; errorRecoveryCount = 0;
            logMessages = [];
            logEvent('DAILY RESET 00:00 WIB');
            addLog('Daily reset: all counters cleared', 'success');
            updateUI();
            setTimeout(doReset, getNextMidnightWIB());
        }
        setTimeout(doReset, getNextMidnightWIB());
    }
    scheduleDailyReset();

    function checkAndReloadAfterNavigation() {
        try {
            const needReload = GM_getValue(NEED_RELOAD_AFTER_NAV_KEY, '');
            if (needReload === '1') {
                GM_setValue(NEED_RELOAD_AFTER_NAV_KEY, '');
                setTimeout(() => {
                    addLog('Nav: post-navigate reload triggered', 'info');
                    window.location.reload();
                }, RELOAD_AFTER_NAV_DELAY_MS);
            }
        } catch (e) {}
    }
    checkAndReloadAfterNavigation();

    // Init panel
    createPanel();

    } // end mainScript

})(); // end IIFE
