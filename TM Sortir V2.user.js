// ==UserScript==
// @name         FB Inbox Scraper
// @namespace    https://riko.local/fbscraper
// @version      74.0.0
// @description  v74.0.0 - BASIS v73.7.0, DUA HAL YANG BERUBAH: (1) scanCommentRank diganti cekKomenKita — bukan hitung rank buat gerbang SMM, tapi cuma cek ADA komen kita apa NGGAK. Ada = postingan udah digarap, linknya dibuang. Bersih = kirim ke sheet Inbox. (2) SEMUA panggilan API SMM dibuang: submitOrderToSMM, trySingleSmmOrder, buildActiveAccounts, submitToViralHistory, updateSheetStatus, updateCommentRank. Sortir (dedup + acak + bagi rata ke Dono/Sumbu) dikerjain trigger GAS di sheet Inbox. Sisanya — auto-reload, recovery, watchdog, CTA, extractUrl, closeCommentModal — SAMA PERSIS v73.7.0.
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

    // ── SATU ENDPOINT: sheet Inbox ──
    // Sheet Pipeline lama DIBUANG TOTAL. Semua narik & kirim ke sini:
    //   ambilKonfig → keyword dono/sumbu
    //   tambahLink  → kirim link bersih
    const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbwVBUK88d5QfBFvueWmj2SmcO9g7VQGZWJcPadx0l91DubC1YtxRvy65Wyo50wbG-dQ/exec';
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
            console.error('[FB Inbox Scraper] navigateToFeedRecover called outside mainScript scope: ' + reason);
        } catch (e) {}
    }

    let globalErrorCount = 0;
    function scheduleGlobalErrorReload(reason) {
        try {
            globalErrorCount++;
            console.warn('[FB Inbox Scraper] WOULD REFRESH (global-error, disabled): ' + reason + ' (total: ' + globalErrorCount + ')');
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
                console.warn('[FB Inbox Scraper] REFRESH AKTIF: ' + reason);
                addLog('REFRESH: ' + reason, 'error');
                GM_setValue(NEED_RELOAD_AFTER_NAV_KEY, '1');
                GM_setValue(AUTO_RESUME_KEY, '1');
                window.location.href = FEED_URL_V16;
            } else {
                console.error('[FB Inbox Scraper] WOULD REFRESH (disabled): ' + reason);
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
        skip_keywords: [],
        scraper: { min_comment_inbox: 0, min_comment_viral: 1000, include_reels: true, smm_inbox_quantity: 10 },
        loaded: false, last_fetch_ts: 0, last_fetch_status: 'not-fetched'
    };

    const CONFIG_REQUEST_TIMEOUT_MS = 20000;

    // ── TARIK CONFIG DARI SHEET INBOX ──
    // Dulu narik get_scraper_config dari sheet Pipeline: komentar, skip_keywords,
    // exclude_advertisers, smm_panels, min_comment_viral, include_reels…
    // Semua itu buat pipeline SMM yang udah dibuang.
    //
    // Sekarang cuma SATU hal: keyword dono & sumbu dari sheet Inbox.
    function fetchConfigOnce() {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'POST', url: ENDPOINT_URL,
                    data: JSON.stringify({ action: 'ambilKonfig' }),
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    timeout: CONFIG_REQUEST_TIMEOUT_MS,
                    onload: function (response) {
                        try {
                            const r = JSON.parse(response.responseText);
                            if (r && r.ok && Array.isArray(r.keyword) && r.keyword.length) {
                                resolve({ ok: true, keyword: r.keyword, version: r.version });
                            } else {
                                resolve({ ok: false, reason: 'keyword-kosong',
                                          error: 'Config sheet Inbox: Keyword 1 / Keyword 2 belum diisi' });
                            }
                        } catch (e) { resolve({ ok: false, reason: 'parse-error', error: e.message }); }
                    },
                    onerror:   function () { resolve({ ok: false, reason: 'network' }); },
                    ontimeout: function () { resolve({ ok: false, reason: 'timeout' }); }
                });
            } catch (e) { resolve({ ok: false, reason: 'exception', error: e.message }); }
        });
    }

    async function fetchConfigWithRetry() {
        let attempt = 0;
        while (true) {
            attempt++;
            const result = await fetchConfigOnce();
            if (result.ok) {
                RUNTIME_CONFIG.skip_keywords = result.keyword;
                RUNTIME_CONFIG.loaded = true;
                RUNTIME_CONFIG.last_fetch_ts = Date.now();
                RUNTIME_CONFIG.last_fetch_status = 'ok';
                addLog('Config: keyword [' + result.keyword.join(', ') + ']', 'success');
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
                    RUNTIME_CONFIG.skip_keywords = result.keyword;
                    RUNTIME_CONFIG.last_fetch_ts = Date.now();
                    RUNTIME_CONFIG.last_fetch_status = 'ok';
                    addLog('Config: refresh [' + result.keyword.join(', ') + ']', 'info');
                    updateUI();
                }
            } catch (e) {}
        }
    }

    async function forceRefreshConfig() {
        addLog('Config: force refresh requested...', 'info');
        const result = await fetchConfigOnce();
        if (result.ok) {
            RUNTIME_CONFIG.skip_keywords = result.keyword;
            RUNTIME_CONFIG.last_fetch_ts = Date.now();
            RUNTIME_CONFIG.last_fetch_status = 'ok-force';
            addLog('Config: refresh paksa [' + result.keyword.join(', ') + ']', 'success');
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
    let gagalCount = 0;      // EXTRACT-FAIL + ragu (gak diambil, gak dibuang)
    let skippedDuplicate = 0;
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

    // ════════════════════════════════════════════════════════
    // kirimInbox — PENGGANTI submitToSheet
    // ════════════════════════════════════════════════════════
    //
    // Dulu kirim ke sheet Pipeline dengan payload gede: akun_fb, komentar
    // hardcode, dual_write, comment_rank. Semua itu buat pipeline SMM
    // yang udah dibuang.
    //
    // Sekarang cuma satu hal: kirim URL-nya ke sheet Inbox. Sortir
    // (dedup + acak + bagi rata) dikerjain trigger GAS di sana, bukan di
    // sini.
    function kirimInbox(url) {
        const payload = { action: 'tambahLink', links: [url] };
        addLog('Inbox: POST ' + url.substring(0, 58) + '...', 'info');
        return apiCallWithRetry({
            method: 'POST', url: ENDPOINT_URL, data: JSON.stringify(payload),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parseResponse: function (responseText) {
                const r = JSON.parse(responseText);
                if (r.ok && r.masuk > 0)  { addLog('Inbox: MASUK', 'success'); return { ok: true, baru: true }; }
                if (r.ok && r.tolak > 0)  { addLog('Inbox: udah ada (kembar)', 'info'); return { ok: true, baru: false }; }
                if (r.ok)                 { return { ok: true, baru: false }; }
                addLog('Inbox: error ' + (r.error || 'unknown'), 'warning');
                return { ok: false, reason: 'inbox-error', error: r.error };
            }
        }, 'Inbox.tambahLink');
    }


    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async function interruptibleSleep(ms) { const step = 100; let elapsed = 0; while (elapsed < ms) { if (shouldStop) return false; while (isPaused && !shouldStop) { markActivity(); await sleep(500); } if (shouldStop) return false; await sleep(Math.min(step, ms - elapsed)); elapsed += step; } return true; }
    function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // ============================================================
    // v73.4.0: NORMALIZER — semua variasi font komentar → ascii polos.
    // Cukup tulis skip_keyword polos di TM_Config (mis: 'sumbu').
    // ============================================================
    const FB_NORM_EXTRA_MAP = {
        '\u1D00':'a','\u0299':'b','\u1D04':'c','\u1D05':'d','\u1D07':'e','\uA730':'f','\u0262':'g','\u029C':'h','\u026A':'i','\u1D0A':'j',
        '\u1D0B':'k','\u029F':'l','\u1D0D':'m','\u0274':'n','\u1D0F':'o','\u1D18':'p','\u01EB':'q','\u0280':'r','\uA731':'s','\u1D1B':'t',
        '\u1D1C':'u','\u1D20':'v','\u1D21':'w','\u028F':'y','\u1D22':'z','\u0281':'r',
        '\uD83C\uDD70':'a','\uD83C\uDD71':'b','\uD83C\uDD72':'c','\uD83C\uDD73':'d','\uD83C\uDD74':'e','\uD83C\uDD75':'f','\uD83C\uDD76':'g','\uD83C\uDD77':'h','\uD83C\uDD78':'i','\uD83C\uDD79':'j',
        '\uD83C\uDD7A':'k','\uD83C\uDD7B':'l','\uD83C\uDD7C':'m','\uD83C\uDD7D':'n','\uD83C\uDD7E':'o','\uD83C\uDD7F':'p','\uD83C\uDD80':'q','\uD83C\uDD81':'r','\uD83C\uDD82':'s','\uD83C\uDD83':'t',
        '\uD83C\uDD84':'u','\uD83C\uDD85':'v','\uD83C\uDD86':'w','\uD83C\uDD87':'x','\uD83C\uDD88':'y','\uD83C\uDD89':'z',
        '\uD83C\uDDE6':'a','\uD83C\uDDE7':'b','\uD83C\uDDE8':'c','\uD83C\uDDE9':'d','\uD83C\uDDEA':'e','\uD83C\uDDEB':'f','\uD83C\uDDEC':'g','\uD83C\uDDED':'h','\uD83C\uDDEE':'i','\uD83C\uDDEF':'j',
        '\uD83C\uDDF0':'k','\uD83C\uDDF1':'l','\uD83C\uDDF2':'m','\uD83C\uDDF3':'n','\uD83C\uDDF4':'o','\uD83C\uDDF5':'p','\uD83C\uDDF6':'q','\uD83C\uDDF7':'r','\uD83C\uDDF8':'s','\uD83C\uDDF9':'t',
        '\uD83C\uDDFA':'u','\uD83C\uDDFB':'v','\uD83C\uDDFC':'w','\uD83C\uDDFD':'x','\uD83C\uDDFE':'y','\uD83C\uDDFF':'z',
        '\u0430':'a','\u0435':'e','\u043E':'o','\u0440':'p','\u0441':'c','\u0443':'y','\u0445':'x','\u0455':'s','\u0456':'i','\u0458':'j','\u043C':'m','\u0442':'t','\u0432':'b','\u043D':'h','\u043A':'k',
        '\u0410':'a','\u0415':'e','\u041E':'o','\u0420':'p','\u0421':'c','\u0423':'y','\u0425':'x','\u041C':'m','\u0422':'t','\u0412':'b','\u041D':'h','\u041A':'k',
        '\u03B1':'a','\u03BF':'o','\u03C1':'p','\u03B5':'e','\u03B9':'i','\u03BA':'k','\u03BD':'v','\u03C4':'t','\u03C5':'u','\u03C7':'x','\u03B3':'y','\u03C3':'o','\u03BC':'u',
        '\u0391':'a','\u0392':'b','\u0395':'e','\u0396':'z','\u0397':'h','\u0399':'i','\u039A':'k','\u039C':'m','\u039D':'n','\u039F':'o','\u03A1':'p','\u03A4':'t','\u03A5':'y','\u03A7':'x',
        '\u01C0':'l','\u0251':'a','\u0261':'g','\u0269':'i','\u027F':'r','\u0285':'l','\u03F2':'c','\u03F3':'j','\u0475':'v','\u0501':'d','\u051B':'q','\u051D':'w',
        '\u0138':'k','\u017F':'s','\u0282':'s','\u0288':'t','\u0256':'d','\u0253':'b','\u0188':'c','\u0257':'d','\u0260':'g','\u0266':'h','\u026D':'l','\u0271':'m','\u0273':'n','\u01A5':'p','\u02A0':'q','\u028B':'v','\u01B4':'y','\u0225':'z',
        '\uFF10':'0','\uFF11':'1','\uFF12':'2','\uFF13':'3','\uFF14':'4','\uFF15':'5','\uFF16':'6','\uFF17':'7','\uFF18':'8','\uFF19':'9',
        '\u00BA':'o','\u2070':'0','\u2080':'0'
    };

    function normalizeText(input) {
        if (!input) return '';
        let s = String(input);
        try { s = s.normalize('NFKC'); } catch (e) {}
        let out = '';
        for (const ch of s) out += (FB_NORM_EXTRA_MAP[ch] !== undefined) ? FB_NORM_EXTRA_MAP[ch] : ch;
        s = out;
        try { s = s.normalize('NFD').replace(/[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u20d0-\u20f0]/g, ''); } catch (e) {}
        s = s.replace(/[\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\u00ad]/g, '');
        s = s.replace(/[\udb40-\udb43][\udc00-\udfff]/g, '');
        s = s.toLowerCase();
        s = s.replace(/[^a-z0-9]/g, '');
        return s;
    }

    // ============================================================
    // v73.4.0: SCAN COMMENT RANK
    // 5x PageDown scan semua komentar UTAMA di DOM (visible/off-screen).
    // Tiap skip_keyword (normalized) dicari di rank berapa.
    // Return: { found, rankString, minRank, mainCount }
    //   rankString: 'sumbu rank 10' | 'sumbu rank 10 | dono rank 5' | ''
    //   minRank: rank terkecil dari keyword mana pun (0 = ga ketemu) → gate SMM
    // ============================================================
    const RANK_PAGEDOWN_COUNT = 5;
    const RANK_WAIT_AFTER_SCROLL_MS = 1800;

    function rankFindScroller(dialog) {
        if (!dialog) return null;
        const cands = [dialog];
        try { dialog.querySelectorAll('div').forEach(d => cands.push(d)); } catch (e) {}
        let best = null, bestH = 0;
        for (const el of cands) {
            if (el.scrollHeight - el.clientHeight <= 50) continue;
            let ov = '';
            try { const cs = getComputedStyle(el); ov = cs.overflowY + cs.overflow; } catch (e) {}
            if (!/auto|scroll/.test(ov)) continue;
            if (el.clientHeight > bestH) { best = el; bestH = el.clientHeight; }
        }
        return best;
    }

    async function rankPageDown(scroller) {
        const before = scroller ? scroller.scrollTop : window.scrollY;
        const target = scroller || document.body;
        try { if (target.focus) target.focus(); } catch (e) {}
        try {
            const evt = new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', keyCode: 34, which: 34, bubbles: true, cancelable: true });
            target.dispatchEvent(evt); document.dispatchEvent(evt);
        } catch (e) {}
        await sleep(150);
        if (scroller) { if (scroller.scrollTop === before) scroller.scrollTop = before + Math.max(300, scroller.clientHeight - 80); }
        else { try { window.scrollBy(0, window.innerHeight - 80); } catch (e) {} }
        const after = scroller ? scroller.scrollTop : window.scrollY;
        return Math.abs(after - before) > 5;
    }

    function rankScanMainComments(dialog) {
        const scope = dialog || document;
        const all = Array.from(scope.querySelectorAll('[role="article"]')).filter(a => {
            const al = a.getAttribute('aria-label') || '';
            if (!al.startsWith('Komentar oleh') && !al.startsWith('Comment by')) return false;
            if (a.offsetParent === null && a.getBoundingClientRect().height === 0) return false;
            return true;
        });
        const mains = [];
        for (const a of all) {
            let isReply = false, p = a.parentElement, d = 0;
            while (p && d < 40) { if (p.getAttribute && p.getAttribute('role') === 'article') { isReply = true; break; } p = p.parentElement; d++; }
            if (isReply) continue;
            mains.push((a.innerText || a.textContent || ''));
        }
        return mains;
    }

    // ════════════════════════════════════════════════════════
    // cekKomenKita — PENGGANTI scanCommentRank
    // ════════════════════════════════════════════════════════
    //
    // INI SATU-SATUNYA yang berubah dari TM lama. Dulu: hitung komentar
    // kita ada di RANK berapa, buat gerbang order SMM. Sekarang: cuma
    // mau tau ADA apa NGGAK — kalau ada, postingannya udah digarap,
    // linknya gak usah diambil.
    //
    // ── ALURNYA (persis hasil debug F12 yang udah kebukti) ──
    //   RELEVAN — baca yang keliatan, TANPA scroll
    //      ketemu?  → STOP, gak usah ke Terbaru
    //   lompat ke ANCHOR
    //   cari ULANG anchornya          ← WAJIB. Sesudah scrollIntoView, FB
    //                                   render ulang — elemen yang tadi
    //                                   dipegang jadi basi, diklik gak ngefek
    //   tekan "Paling relevan"        → dropdown kebuka
    //   tekan "Terbaru"
    //   page down 5×                  → STOP begitu ketemu
    //
    // Balikin { ada, dimana, jumlahRelevan, jumlahTerbaru }
    async function cekKomenKita() {
        const skipKeywords = getSkipKeywords();
        if (skipKeywords.length === 0) {
            addLog('CekKomen: skip_keywords KOSONG — gak bisa nyaring', 'warning');
            return { ada: false, dimana: '', jumlahRelevan: 0, jumlahTerbaru: 0, noKeyword: true };
        }
        const kwNorm = skipKeywords.map(k => ({ raw: (k || '').toString().trim(), norm: normalizeText(k) }))
                                   .filter(k => k.norm.length > 0);
        if (kwNorm.length === 0) return { ada: false, dimana: '', jumlahRelevan: 0, jumlahTerbaru: 0, noKeyword: true };

        const dialogs = getVisibleDialogs();
        const dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
        if (!dialog) {
            addLog('CekKomen: dialog gak kebuka', 'warning');
            return { ada: false, dimana: '', jumlahRelevan: 0, jumlahTerbaru: 0, noDialog: true };
        }

        // ── baca komentar + cek keyword ──
        // Balasan dibuang dulu (role=article bersarang). Kalau gak, komentar
        // ORANG bisa keliatan "punya kita" cuma gara-gara ada yang bales
        // pakai kata kunci.
        function bacaKomen() {
            const mains = rankScanMainComments(dialog);
            const kena = [];
            for (let i = 0; i < mains.length; i++) {
                const n = normalizeText(mains[i]);
                for (const kw of kwNorm) {
                    if (n.includes(kw.norm)) { kena.push({ pos: i + 1, kw: kw.raw, teks: mains[i].slice(0, 60) }); break; }
                }
            }
            return { total: mains.length, kena: kena };
        }

        // ── 1. RELEVAN — tanpa scroll ──
        const relevan = bacaKomen();
        addLog('CekKomen: RELEVAN ' + relevan.total + ' komen · ' + relevan.kena.length + ' punya kita', 'info');

        if (relevan.kena.length) {
            const k = relevan.kena[0];
            addLog('CekKomen: KETEMU di Relevan rank ' + k.pos + ' [' + k.kw + '] — Terbaru gak usah dicek', 'skip');
            return { ada: true, dimana: 'Relevan rank ' + k.pos, kw: k.kw,
                     jumlahRelevan: relevan.total, jumlahTerbaru: 0 };
        }

        // ── 2. LOMPAT KE ANCHOR ──
        let anchor = cariAnchorSortir(dialog);
        if (!anchor) {
            addLog('CekKomen: anchor sortir GAK KETEMU — postingan tanpa tombol urutan', 'warning');
            return { ada: false, dimana: '', jumlahRelevan: relevan.total, jumlahTerbaru: 0, noAnchor: true };
        }
        try { anchor.scrollIntoView({ block: 'center' }); } catch (e) {}
        await sleep(1200);

        // >>> CARI ULANG <<<
        // Sesudah scrollIntoView, FB RENDER ULANG area komentar. Elemen
        // yang tadi dipegang jadi BASI — diklik gak ngefek, dropdown gak
        // nongol. Ini yang bikin percobaan sebelumnya gagal.
        anchor = cariAnchorSortir(dialog);
        if (!anchor) {
            addLog('CekKomen: anchor ILANG sesudah digulung (FB render ulang)', 'warning');
            return { ada: false, dimana: '', jumlahRelevan: relevan.total, jumlahTerbaru: 0, noAnchor: true };
        }

        const teksAnchor = (anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        addLog('CekKomen: anchor "' + teksAnchor.slice(0, 24) + '"', 'info');

        // ── 3. PINDAH KE TERBARU ──
        const nA = normalizeText(teksAnchor);
        let pindah = nA.includes('terbaru') || nA.includes('newest');

        if (pindah) {
            addLog('CekKomen: udah di Terbaru', 'info');
        } else {
            // klik ASLI dulu — FB nunggu klik beneran buat buka dropdown
            const sasaran = indukKlikSortir(anchor);
            try { sasaran.click(); } catch (e) { klikSortir(sasaran); }
            await sleep(2500);

            let menu = getMenuSortir();
            if (!menu.ada) { klikSortir(sasaran); await sleep(1500); menu = getMenuSortir(); }

            if (!menu.ada) {
                addLog('CekKomen: dropdown sortir GAK NONGOL sesudah 2× cara klik', 'warning');
                return { ada: false, dimana: '', jumlahRelevan: relevan.total, jumlahTerbaru: 0, gagalTerbaru: true };
            }

            const item = cariItemTerbaru(menu.el);
            if (!item) {
                const isi = Array.from(menu.el.querySelectorAll('span, div[role="menuitem"]'))
                    .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
                    .filter(t => t && t.length < 26);
                addLog('CekKomen: "Terbaru" gak ada di menu: ' + Array.from(new Set(isi)).slice(0, 6).join(' · '), 'warning');
                return { ada: false, dimana: '', jumlahRelevan: relevan.total, jumlahTerbaru: 0, gagalTerbaru: true };
            }

            const sasaranItem = indukKlikSortir(item);
            try { sasaranItem.click(); } catch (e) { klikSortir(sasaranItem); }
            addLog('CekKomen: tekan "Terbaru"', 'info');
            await sleep(4000);
            pindah = true;
        }

        // ── 4. PAGE DOWN, STOP begitu ketemu ──
        const scroller = rankFindScroller(dialog);
        addLog('CekKomen: scroller ' + (scroller ? scroller.clientHeight + 'px dari ' + scroller.scrollHeight + 'px' : 'GAK ADA → window'), 'info');

        for (let i = 1; i <= RANK_PAGEDOWN_COUNT; i++) {
            if (shouldStop) break;
            const sblm = rankScanMainComments(dialog).length;
            const gerak = await rankPageDown(scroller);
            await sleep(RANK_WAIT_AFTER_SCROLL_MS);

            const cek = bacaKomen();
            addLog('CekKomen: PgDn ' + i + '/' + RANK_PAGEDOWN_COUNT + (gerak ? '' : ' (gak gerak)') +
                   ' · ' + sblm + ' → ' + cek.total + ' komen', 'info');

            if (cek.kena.length) {
                const k = cek.kena[0];
                addLog('CekKomen: KETEMU di Terbaru rank ' + k.pos + ' [' + k.kw + '] PgDn ke-' + i + ' — STOP', 'skip');
                return { ada: true, dimana: 'Terbaru rank ' + k.pos + ' (PgDn ' + i + ')', kw: k.kw,
                         jumlahRelevan: relevan.total, jumlahTerbaru: cek.total };
            }
            if (!gerak && i >= 2) { addLog('CekKomen: mentok bawah', 'info'); break; }
        }

        const akhir = bacaKomen();
        addLog('CekKomen: TERBARU ' + akhir.total + ' komen · ' + akhir.kena.length + ' punya kita', 'info');

        if (akhir.kena.length) {
            const k = akhir.kena[0];
            return { ada: true, dimana: 'Terbaru rank ' + k.pos, kw: k.kw,
                     jumlahRelevan: relevan.total, jumlahTerbaru: akhir.total };
        }
        return { ada: false, dimana: '', jumlahRelevan: relevan.total, jumlahTerbaru: akhir.total };
    }

    // ── alat bantu sortir ──
    // Dipisah biar cekKomenKita gampang dibaca.

    const T_ANCHOR_SORTIR  = ['Paling relevan','Most relevant','Semua komentar','All comments','Terbaru','Newest','Terlama','Oldest'];
    const T_ITEM_TERBARU   = ['Terbaru','Newest','Newest first'];

    function nampakSortir(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        try {
            const g = getComputedStyle(el);
            if (g.display === 'none' || g.visibility === 'hidden') return false;
            if (parseFloat(g.opacity) < 0.1) return false;
        } catch (e) {}
        return true;
    }

    const nSortir = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

    function cariAnchorSortir(ruang) {
        const s = ruang || document;
        const kandidat = Array.from(s.querySelectorAll(
            '[role="button"], [role="menuitem"], [role="tab"], a[role="link"], span[role="button"], [tabindex="0"]'
        )).filter(nampakSortir);

        for (const t of T_ANCHOR_SORTIR) {
            const tn = nSortir(t); if (!tn) continue;
            for (const el of kandidat) {
                if (nSortir(el.getAttribute('aria-label')) === tn || nSortir(el.innerText) === tn) return el;
            }
        }
        for (const t of T_ANCHOR_SORTIR) {
            const tn = nSortir(t); if (!tn) continue;
            for (const el of kandidat) {
                const a = nSortir(el.getAttribute('aria-label'));
                const b = nSortir(el.innerText);
                if ((a.includes(tn) && a.length <= tn.length + 20) ||
                    (b.includes(tn) && b.length <= tn.length + 20)) return el;
            }
        }
        return null;
    }

    function getMenuSortir() {
        const m = Array.from(document.querySelectorAll('div[role="menu"], div[role="listbox"]')).filter(nampakSortir);
        if (m.length) return { ada: true, el: m[m.length - 1] };
        const d = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(nampakSortir);
        return { ada: false, el: d.length ? d[d.length - 1] : document };
    }

    // Item dropdown FB kadang cuma <span dir="auto">Terbaru</span> — gak
    // ada role, gak ada aria-label. Jadi disapu dari SEMUA elemen, ambil
    // yang paling dalam biar gak kena wadah raksasa.
    function cariItemTerbaru(ruang) {
        const s = ruang || document;
        const kandidat = Array.from(s.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"], [tabindex="0"]')).filter(nampakSortir);
        for (const t of T_ITEM_TERBARU) {
            const tn = nSortir(t); if (!tn) continue;
            for (const el of kandidat) {
                if (nSortir(el.getAttribute('aria-label')) === tn || nSortir(el.innerText) === tn) return el;
            }
        }
        const semua = Array.from(s.querySelectorAll('span, div, a, li')).filter(nampakSortir);
        for (const t of T_ITEM_TERBARU) {
            const tn = nSortir(t); if (!tn) continue;
            for (const el of semua) {
                if (nSortir(el.innerText) !== tn) continue;
                const anakSama = Array.from(el.querySelectorAll('span, div, a'))
                    .some(a => nampakSortir(a) && nSortir(a.innerText) === tn);
                if (anakSama) continue;
                return el;
            }
        }
        return null;
    }

    function indukKlikSortir(el) {
        let n = el;
        for (let i = 0; i < 8 && n; i++) {
            const role = n.getAttribute && n.getAttribute('role');
            const tab = n.getAttribute && n.getAttribute('tabindex');
            if (['button','menuitem','menuitemradio','option','link'].indexOf(role) !== -1 || tab === '0') return n;
            n = n.parentElement;
        }
        return el;
    }

    // cadangan kalau .click() asli gak ngefek
    function klikSortir(el) {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(j => {
            const Ev = j.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
            try { el.dispatchEvent(new Ev(j, o)); } catch (e) {}
        });
    }

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

    function renderLogPanel() { try { const logBox = document.getElementById('fbs-log-box'); if (!logBox) return; if (logMessages.length === 0) { logBox.innerHTML = '<div style="color:#666;font-size:9px;text-align:center;padding:8px;">(no events)</div>'; return; } const colors = { 'SCROLL': '#b0b3b8', 'CAPTURE LINK': '#1877f2', 'SUCCESS POST': '#42b72a', 'LINK DEDUP': '#ff77ff', 'RANK FOUND': '#9c27b0', 'RANK SKIP': '#ff6b35', 'NOT FOUND': '#ffaa00', 'DAILY RESET 00:00 WIB': '#00d0d0', 'SCRAPER STARTED': '#42b72a', 'VIRAL SAVED': '#ff6b35', 'VIRAL DUP': '#ff77ff', 'SKIP REEL': '#888888', 'SMM RETRY': '#9c27b0', 'SMM ALL FAIL': '#e41e3f' }; const icons = { 'SCROLL': '\uD83D\uDCDC', 'CAPTURE LINK': '\uD83D\uDD17', 'SUCCESS POST': '\u2705', 'LINK DEDUP': '\uD83D\uDD01', 'RANK FOUND': '\uD83C\uDFAF', 'RANK SKIP': '\u26D4', 'NOT FOUND': '\u274C', 'DAILY RESET 00:00 WIB': '\uD83D\uDD04', 'SCRAPER STARTED': '\uD83D\uDE80', 'VIRAL SAVED': '\uD83D\uDD25', 'VIRAL DUP': '\uD83D\uDD01', 'SKIP REEL': '\uD83C\uDFAC', 'SMM RETRY': '\uD83D\uDD04', 'SMM ALL FAIL': '\uD83D\uDED1' }; const html = logMessages.slice(0, 10).map(m => { const color = colors[m.eventType] || '#e4e6eb'; const icon = icons[m.eventType] || '\u2022'; return '<div style="display:flex;justify-content:space-between;font-size:9px;padding:2px 4px;border-bottom:1px solid #2d2f33;"><span style="color:' + color + ';">' + icon + ' ' + m.eventType + '</span><span style="color:#666;">' + m.time + '</span></div>'; }).join(''); logBox.innerHTML = html; } catch (e) {} }

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
    function findDecodedBersponsorMarkers() { const found = []; const candidates = document.querySelectorAll('span[dir="auto"], a[role="link"] span, span[aria-labelledby]'); for (const el of candidates) { const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; if (rect.width > 250 || rect.height > 35) continue; const allSpans = el.querySelectorAll('span'); if (allSpans.length < 3) continue; const charSpans = []; for (const sp of allSpans) { if (sp.children.length > 0) continue; const t = sp.textContent || ''; if (t.length === 0 || t.length > 3) continue; const sr = sp.getBoundingClientRect(); if (sr.width === 0 || sr.height === 0) continue; if (sr.left < rect.left - 5 || sr.right > rect.right + 5) continue; if (sr.top < rect.top - 5 || sr.bottom > rect.bottom + 5) continue; try { const cs = window.getComputedStyle(sp); if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') continue; } catch (e) {} charSpans.push({ text: t, x: sr.left, y: sr.top }); } if (charSpans.length < 5) continue; charSpans.sort((a, b) => Math.abs(a.y - b.y) > 5 ? a.y - b.y : a.x - b.x); const decoded = charSpans.map(c => c.text).join(''); let lower = decoded.toLowerCase(); try { lower = lower.normalize('NFKD'); } catch (e) {} /* v73.6.0: FB nyelipin U+034F (combining grapheme joiner) di belakang TIAP huruf -> tanpa dibuang, includes('bersponsor') selamanya false */ lower = lower.replace(/[\u0300-\u036f\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\u00ad]/g, '').replace(/\s/g, ''); if (lower.includes('bersponsor') || lower.includes('sponsored')) { if (isInsideComplementary(el)) continue; found.push(el); } } return found; }
    // ============================================================
    // v73.5.0: JALUR UTAMA BARU — aria-labelledby lookup.
    // FB sekarang naruh teks "Bersponsor" BERSIH di <span id="_r_xxx_"> yg
    // display:none, dan diportal KELUAR container post (depth 3 dari body).
    // Elemen yg keliatan di layar cuma decoy (isinya karakter acak +
    // newline), jadi decode geometrik findDecodedBersponsorMarkers() GAGAL.
    // Tapi elemen visible itu punya aria-labelledby="_r_xxx_" yg nunjuk
    // lurus ke teks bersih → lookup by id = 100% tembus & jauh lebih stabil.
    // ============================================================
    function findAriaLabelledbySponsorMarkers() {
        const found = [];
        const candidates = document.querySelectorAll('[aria-labelledby]');
        for (const el of candidates) {
            const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
            let isSponsor = false;
            for (const id of ids) {
                if (!id) continue;
                let ref = null;
                try { ref = document.getElementById(id); } catch (e) { continue; }
                if (!ref) continue;
                const refText = (ref.textContent || '').trim().toLowerCase().replace(/\s/g, '');
                if (refText === 'bersponsor' || refText === 'sponsored' || refText === 'disponsori') { isSponsor = true; break; }
            }
            if (!isSponsor) continue;
            // elemen VISIBLE + ukuran label (bukan container gede yg kebetulan ke-label)
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.width > 300 || rect.height > 40) continue;
            try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; if (parseFloat(style.opacity) < 0.1) continue; } catch (e) { continue; }
            if (isInsideComplementary(el)) continue;
            found.push(el);
        }
        return found;
    }

    // v73.5.0: 3 jalur berurutan + dedup Set.
    //   1) aria-labelledby  → cara FB SEKARANG
    //   2) exact innerText  → cara lama (DIPERTAHANKAN, fallback)
    //   3) decode geometrik → cara lama (DIPERTAHANKAN, fallback)
    // Kalau FB balik ke cara lama, jalur 2/3 tetap nangkep = zero regression.
        // ============================================================
    // ============================================================
    // v73.7.0: FILTER TEKS CTA
    // "Kirim Pesan" / "Send Message" = CTA fanspage + iklan click-to-message.
    // Bukan target scraping, jadi dibuang total (gak jadi marker, dan hasCTA
    // ikut nolak biar gate extractOnePost gak kelolosan lewat jalur label).
    // Tambah kata di array ini kalau nanti ketemu varian lain.
    // ============================================================
    const CTA_BLOCK_KEYWORDS = ['kirim', 'send'];

    // FB nyelipin U+034F (combining grapheme joiner) di belakang TIAP huruf.
    // Akibatnya "Daftar sekarang" (15 huruf) kebaca jadi 30 char, dan
    // perbandingan teks apa pun bakal meleset. Ini dibuang dulu sebelum dicek.
    function bersihkanTeksCTA(t) {
        if (!t) return '';
        let str = String(t);
        try { str = str.normalize('NFKD'); } catch (e) {}
        str = str.replace(/[\u0300-\u036f\u200b-\u200f\u2060-\u206f\ufe00-\ufe0f\ufeff\u00ad]/g, '');
        return str.replace(/\s+/g, ' ').trim();
    }

    function isCtaDiblokir(teks) {
        const low = bersihkanTeksCTA(teks).toLowerCase();
        if (!low) return false;
        for (const kw of CTA_BLOCK_KEYWORDS) { if (low.includes(kw)) return true; }
        return false;
    }

    // v73.6.0: ANCHOR UTAMA BARU — data-ad-rendering-role="cta".
    // Alasan: hasCTA() udah jadi GATE WAJIB di extractOnePost (no CTA = skip),
    // jadi nyari label "Bersponsor" duluan itu kerja dua kali buat hasil sama.
    // Terbukti di feed: cta=1 vs comment_button=3 → CTA cuma nempel di IKLAN.
    // Jauh lebih stabil daripada ngejar label yg tiap render diobfuscate ulang.
    // ============================================================
    function findCtaAdMarkers() {
        const found = [];
        const candidates = document.querySelectorAll('[data-ad-rendering-role*="cta" i]');
        for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; if (parseFloat(style.opacity) < 0.1) continue; } catch (e) { continue; }
            if (isInsideComplementary(el)) continue;
            // v73.7.0: CTA "Kirim Pesan"/"Send Message" gak dianggap iklan
            if (isCtaDiblokir(getCleanCTAText(el))) continue;
            found.push(el);
        }
        return found;
    }

    // v73.6.0: 4 jalur berurutan + dedup Set.
    //   1) CTA ad-rendering-role → anchor UTAMA (cara paling stabil)
    //   2) aria-labelledby       → label bersih di span hidden (v73.5.0)
    //   3) exact innerText       → cara lama (fallback)
    //   4) decode geometrik      → cara lama (fallback, udah difix U+034F)
    // Semua jalur lama DIPERTAHANKAN = zero regression. findAllMarkers()
    // dedup by container, jadi 1 post ketangkep 2 jalur tetap kehitung 1.
    function findBersponsorMarkers() {
        const found = []; const seen = new Set();
        let nCta = 0, nAria = 0, nExact = 0, nDecoded = 0;
        const ctas = findCtaAdMarkers();
        for (const el of ctas) { if (seen.has(el)) continue; found.push(el); seen.add(el); nCta++; }
        const aria = findAriaLabelledbySponsorMarkers();
        for (const el of aria) { if (seen.has(el)) continue; found.push(el); seen.add(el); nAria++; }
        const candidates = document.querySelectorAll('span, a');
        for (const el of candidates) { if (seen.has(el)) continue; if (el.children.length > 50) continue; const text = (el.innerText || '').trim().toLowerCase().replace(/\s/g, ''); if (text !== 'bersponsor' && text !== 'sponsored' && text !== 'disponsori') continue; const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; if (parseFloat(style.opacity) < 0.1) continue; } catch (e) { continue; } if (isInsideComplementary(el)) continue; found.push(el); seen.add(el); nExact++; }
        const decoded = findDecodedBersponsorMarkers();
        for (const el of decoded) { if (seen.has(el)) continue; found.push(el); seen.add(el); nDecoded++; }
        if (found.length > 0) addLog('Marker: ' + found.length + ' (cta=' + nCta + ' aria=' + nAria + ' exact=' + nExact + ' decoded=' + nDecoded + ')', 'info');
        return found;
    }
    function findPostContainerFromMarker(marker) { if (!marker) return null; if (isInsideComplementary(marker)) return null; let el = marker; const levels = []; for (let i = 0; i < 40 && el && el !== document.body; i++) { levels.push(el); el = el.parentElement; } function isPostSized(el) { const r = el.getBoundingClientRect(); return r.width >= 400 && r.width <= 900 && r.height >= 200 && r.height <= 2500; } for (const lvl of levels) { if (lvl.getAttribute && lvl.getAttribute('role') === 'article' && isPostSized(lvl)) return lvl; } for (const lvl of levels) { const pl = lvl.getAttribute && lvl.getAttribute('data-pagelet'); if (pl && pl.includes('FeedUnit') && isPostSized(lvl)) return lvl; } /* v73.5.0: tier baru — FB udah copot role="article" & data-pagelet FeedUnit dari post feed, jadi 2 tier di atas sering mental. data-ad-rendering-role="comment_button" masih konsisten ada di tiap post. */ for (const lvl of levels) { if (!lvl.querySelector || !isPostSized(lvl)) continue; if (lvl.querySelector('[data-ad-rendering-role="comment_button"]')) return lvl; } for (const lvl of levels) { if (!lvl.querySelector || !isPostSized(lvl)) continue; const buttons = lvl.querySelectorAll('div[role="button"][aria-label]'); let hasInteractive = false; for (const btn of buttons) { const al = (btn.getAttribute('aria-label') || '').toLowerCase(); if (al.includes('bagikan') || al.includes('berbagi') || al.includes('share') || al === 'komentar' || al === 'comment' || al.startsWith('beri komentar') || al === 'suka' || al === 'beri reaksi' || al === 'like') { hasInteractive = true; break; } } if (hasInteractive) return lvl; } for (const lvl of levels) { if (lvl.querySelector && isPostSized(lvl) && lvl.querySelector('[data-ad-rendering-role*="cta" i]')) return lvl; } return null; }
    function decodeObfuscatedText(containerEl) { if (!containerEl) return ''; const containerRect = containerEl.getBoundingClientRect(); if (containerRect.width === 0 || containerRect.height === 0) return ''; const allSpans = containerEl.querySelectorAll('span'); const charSpans = []; for (const sp of allSpans) { if (sp.children.length > 0) continue; const text = sp.textContent || ''; if (text.length === 0 || text.length > 3) continue; const r = sp.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; const T = 5; if (r.left < containerRect.left - T || r.right > containerRect.right + T || r.top < containerRect.top - T || r.bottom > containerRect.bottom + T) continue; try { const cs = window.getComputedStyle(sp); if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') continue; const fs = parseFloat(cs.fontSize); if (!isNaN(fs) && fs < 1) continue; } catch (e) {} charSpans.push({ text, x: r.left, y: r.top, width: r.width }); } if (charSpans.length === 0) return ''; charSpans.sort((a, b) => { const dy = a.y - b.y; return Math.abs(dy) > 5 ? dy : a.x - b.x; }); return charSpans.map(c => c.text).join(''); }
    function getCleanCTAText(ctaEl) { return bersihkanTeksCTA(getCleanCTATextRaw(ctaEl)); }

    function getCleanCTATextRaw(ctaEl) { if (!ctaEl) return ''; try { const decoded = decodeObfuscatedText(ctaEl).trim(); if (decoded && decoded.length >= 2 && decoded.length <= 60) { const letterCount = (decoded.match(/[a-zA-Z]/g) || []).length; if (letterCount >= 2) return decoded; } } catch (e) {} const labelled = ctaEl.querySelectorAll('[aria-labelledby]'); for (const el of labelled) { const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/); for (const id of ids) { if (!id || !id.startsWith('_')) continue; const ref = document.getElementById(id); if (!ref) continue; const text = (ref.textContent || '').trim(); if (text) return text; } } const links = ctaEl.querySelectorAll('a[aria-label], [role="link"][aria-label]'); for (const a of links) { const al = (a.getAttribute('aria-label') || '').trim(); if (al) return al; } if (ctaEl.hasAttribute && ctaEl.hasAttribute('aria-label')) { const al = (ctaEl.getAttribute('aria-label') || '').trim(); if (al) return al; } let cur = ctaEl.parentElement; let depth = 0; while (cur && depth < 5) { if (cur.hasAttribute && cur.hasAttribute('aria-label')) { const al = (cur.getAttribute('aria-label') || '').trim(); if (al) return al; } cur = cur.parentElement; depth++; } return (ctaEl.innerText || ctaEl.textContent || '').trim(); }
    function extractAdvertiserFromPost(post) { if (!post) return 'Unknown'; try { const h = post.querySelector('h3 a strong, h4 a strong, h3 strong, h4 strong, h3 a span, h4 a span, h3 a, h4 a'); if (h) { const t = (h.innerText || '').trim(); if (t && t.length > 1 && t.length < 80) return t; } } catch (e) {} return 'Unknown'; }
    function hasCTA(post) { if (!post) return { found: false }; const ctaElements = post.querySelectorAll('[data-ad-rendering-role]'); for (const el of ctaElements) { if (!post.contains(el)) continue; const role = (el.getAttribute('data-ad-rendering-role') || '').toLowerCase(); if (role.includes('cta')) { try { const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') continue; } catch (e) {} const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; const text = getCleanCTAText(el); /* v73.7.0: CTA kirim/send = fanspage / click-to-message, bukan target */ if (isCtaDiblokir(text)) continue; return { found: true, text: text || '(CTA)', role: role, element: el }; } } return { found: false }; }
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
    // v73.4.0: extractUrlWithRetry — buka komentar, capture URL, lalu
    // CEK KOMEN KITA (Relevan → Terbaru + 5× PageDown). Balikin ke pemanggil.
    // GATE SMM diputuskan di extractOnePost, BUKAN di sini (beda dari v73.3.0
    // yang skip di sini). Di sini kita cuma capture URL + rank, ga skip apa2.
    // ============================================================
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
                    const firstValidUrl = currentUrl;
                    await sleep(300);
                    const reReadUrl = window.location.href;
                    if (isValidPostUrl(reReadUrl)) {
                        capturedUrl = reReadUrl;
                    } else {
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
            let cekKomen = { ada: false, dimana: '', jumlahRelevan: 0, jumlahTerbaru: 0 };
            if (capturedUrl) {
                addLog('Extract: tunggu modal fully loaded (max 30s)...', 'info');
                const readyResult = await waitForCommentSectionReady();
                if (readyResult.belumAda) {
                    addLog('Extract: "Belum ada komentar" detected, lanjut (no rank scan needed)', 'info');
                }
                commentCount = readyResult.count || 0;
                addLog('Extract: comment count = ' + commentCount + ' (source: ' + readyResult.reason + ')', 'info');

                // CEK KOMEN KITA — cuma kalau ada komentar & ada keyword.
                // Kalau komentarnya NOL, jelas bersih — gak usah dicek.
                if (commentCount > 0) {
                    const skipKeywords = getSkipKeywords();
                    if (skipKeywords.length === 0) {
                        addLog('Extract: keyword kosong, gak bisa nyaring (count=' + commentCount + ')', 'warning');
                        cekKomen = { ada: false, noKeyword: true, jumlahRelevan: 0, jumlahTerbaru: 0 };
                    } else {
                        addLog('Extract: tunggu ' + (ARTICLE_SCAN_WAIT_MS/1000) + 's biar komentar kerender...', 'info');
                        await sleep(ARTICLE_SCAN_WAIT_MS);
                        cekKomen = await cekKomenKita();
                    }
                } else {
                    addLog('Extract: nol komentar → jelas bersih', 'info');
                    cekKomen = { ada: false, jumlahRelevan: 0, jumlahTerbaru: 0 };
                }
            }
            await closeCommentModal(); await sleep(randDelay(1000, 2000));
            if (capturedUrl) {
                if (capturedUrl === lastExtractedUrl) { addLog('Extract: same URL as previous post, retry...', 'warning'); continue; }
                const finalUrl = cleanUrl(capturedUrl);
                if (!urlHasIdentifier(finalUrl)) {
                    addLog('Extract: REJECT URL tanpa identifier valid: ' + finalUrl + ' (retry)', 'warning');
                    continue;
                }
                addLog('Extract: captured = ' + capturedUrl.substring(0, 66) + ' | komen=' + commentCount +
                       (cekKomen.ada ? ' | ⛔ ADA KOMEN KITA (' + cekKomen.dimana + ')' : ' | ✅ bersih'), 'success');
                lastExtractedUrl = capturedUrl;
                return {
                    url: finalUrl,
                    commentCount: commentCount,
                    cekKomen: cekKomen
                };
            }
        }
        logEvent('NOT FOUND');
        addLog('Extract: FAILED setelah ' + MAX_ATTEMPTS + ' attempts untuk "' + advertiser + '"', 'error');
        await closeCommentModal();
        return null;
    }

    // ============================================================
    // v73.4.0: extractOnePost — GATE SMM baru (urutan cek dari atas):
    //   1. DEDUP (dedup-active)  → NO call comment, update rank di existing_row
    //   2. NEW + minRank 1 / 2   → NO call comment, rank ditulis di row baru (via submit)
    //   3. NEW + rank >=3 / not found → CALL comment + rank ditulis
    // ============================================================
    async function extractOnePost(marker) {
        const post = findPostContainerFromMarker(marker);
        if (!post) { addLog('Post: container tidak ketemu dari marker', 'warning'); return { success: false }; }
        if (post.getAttribute('data-fb-extracted') === '1') return { success: false };
        if (!isInMainFeed(post)) { addLog('Post: skip - bukan di main feed', 'info'); post.setAttribute('data-fb-extracted', '1'); return { success: false }; }
        const visPercent = getViewportVisibilityPercent(post);
        if (visPercent < SETTINGS.MIN_VIEWPORT_VISIBILITY_PERCENT) { const rect = post.getBoundingClientRect(); if (rect.height < 50 || rect.width < 100) return { success: false }; addLog('Post: visibility ' + Math.round(visPercent) + '%, scroll into view...', 'info'); await scrollPostIntoView(post); if (!isPostVisibleEnough(post)) { addLog('Post: masih ga cukup visible setelah scroll, skip', 'info'); return { success: false }; } }
        // exclude_advertisers DIBUANG — gak ada di Config sheet Inbox.
        const advertiserCheck = extractAdvertiserFromPost(post);
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

        // ════════════════════════════════════════════════════════
        // KEPUTUSAN — INI SATU-SATUNYA YANG BERUBAH DARI TM LAMA
        // ════════════════════════════════════════════════════════
        //
        // Dulu: submit sheet → cek rank → order SMM → dual-write Viral.
        // Sekarang: cek ada komen kita apa nggak → ambil / buang. Titik.
        //
        //   ada komen kita  → ⛔ BUANG (postingan udah digarap)
        //   bersih          → ✅ kirim ke Inbox
        //   ragu            → ⚠️ DILEWAT (gak diambil, gak dibuang)
        //
        // Sortir (dedup + acak + bagi rata ke Dono/Sumbu) dikerjain
        // trigger GAS di sheet Inbox, bukan di sini.
        let terkirim = false;

        if (!extractResult) {
            gagalCount++;
            post.style.outline = '3px dashed #ffaa00';
            addLog('Post: EXTRACT-FAIL "' + advertiser + '"', 'warning');
        } else {
            const cleanedUrl = extractResult.url;
            const commentCount = extractResult.commentCount || 0;
            const cek = extractResult.cekKomen || { ada: false };

            addLog('Post: URL = ' + cleanedUrl.substring(0, 66) + ' | komen=' + commentCount, 'info');

            if (cek.ada) {
                // ── UDAH DIGARAP ──
                skippedDuplicate++;
                post.style.outline = '3px solid #ff77ff';
                logEvent('SKIP ADA KOMEN');
                addLog('Post: ⛔ SKIP "' + advertiser + '" — komen kita di ' + cek.dimana +
                       (cek.kw ? ' [' + cek.kw + ']' : ''), 'skip');
                updateUI();

            } else if (cek.noKeyword || cek.noDialog || cek.noAnchor || cek.gagalTerbaru) {
                // ── RAGU = JANGAN AMBIL ──
                // Gak bisa mastiin bersih. Mending kelewat daripada masukin
                // link yang sebenernya udah digarap.
                //
                // KECUALI: Relevan kebaca dan isinya bersih. Itu udah cukup
                // jadi bukti walau Terbaru gak kecek.
                const adaBukti = (cek.jumlahRelevan || 0) > 0;
                if (adaBukti) {
                    const r = await kirimInbox(cleanedUrl);
                    if (r.ok && r.baru) {
                        collectedLinks.push({ url: cleanedUrl, advertiser: advertiser, cta: cta.text,
                                              timestamp: new Date().toISOString(), comment_count: commentCount });
                        saveLinks();
                        post.style.outline = '3px solid #42b72a';
                        logEvent('SUCCESS POST');
                        addLog('Post: ✅ KIRIM "' + advertiser + '" (Relevan ' + cek.jumlahRelevan +
                               ' bersih, Terbaru gak kecek)', 'success');
                        flashNotification('OK ' + advertiser);
                        linksSinceLastDelay++; terkirim = true;
                    } else if (r.ok) {
                        skippedDuplicate++;
                        post.style.outline = '3px solid #ff77ff';
                        addLog('Post: udah ada di Inbox "' + advertiser + '"', 'info');
                    } else {
                        post.style.outline = '3px dashed #ffaa00';
                        addLog('Post: INBOX-ERROR "' + advertiser + '"', 'warning');
                    }
                } else {
                    gagalCount++;
                    post.style.outline = '3px dashed #ffaa00';
                    addLog('Post: ⚠️ RAGU "' + advertiser + '" — gak ada bukti bersih, DILEWAT', 'warning');
                }
                updateUI();

            } else {
                // ── BERSIH → KIRIM ──
                addLog('Post: ✅ BERSIH — Relevan ' + cek.jumlahRelevan + ' · Terbaru ' +
                       cek.jumlahTerbaru + ' komen, nol punya kita', 'success');

                const r = await kirimInbox(cleanedUrl);
                if (r.ok && r.baru) {
                    collectedLinks.push({ url: cleanedUrl, advertiser: advertiser, cta: cta.text,
                                          timestamp: new Date().toISOString(), comment_count: commentCount });
                    saveLinks();
                    post.style.outline = '3px solid #42b72a';
                    logEvent('SUCCESS POST');
                    addLog('Post: ✅ KIRIM #' + collectedLinks.length + ' "' + advertiser + '"', 'success');
                    flashNotification('OK ' + advertiser);
                    linksSinceLastDelay++; terkirim = true;
                } else if (r.ok) {
                    skippedDuplicate++;
                    post.style.outline = '3px solid #ff77ff';
                    logEvent('LINK DEDUP');
                    addLog('Post: udah ada di Inbox "' + advertiser + '"', 'info');
                } else {
                    post.style.outline = '3px dashed #ffaa00';
                    addLog('Post: INBOX-ERROR "' + advertiser + '"', 'warning');
                }
                updateUI();
            }
        }
        return { success: terkirim };
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
        } finally { stopWatchdog(); if (isDialogOpen()) await closeDialogForce(); mainLoopRunning = false; isPaused = false; setPhase('idle', 'Stopped'); addLog('Main: berhenti — kirim=' + collectedLinks.length + ' skipKomen=' + skippedDuplicate + ' noCTA=' + skippedNoCTA + ' gagal=' + gagalCount, 'info'); }
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
        + '<div class="fbs-header" id="fbs-header"><span class="fbs-title">FB Inbox Scraper</span><button class="fbs-mini-btn" id="fbs-minimize">_</button></div>'
        + '<div class="fbs-body">'
        + '<div class="fbs-saved-box"><div class="fbs-saved-num" id="fbs-stat-count">0</div><div class="fbs-saved-label">LINK TERKIRIM</div></div>'
        + '<div class="fbs-stats-row"><div class="fbs-stat-cell"><div class="num" id="fbs-stat-skipkomen" style="color:#ff77ff;">0</div><div class="lbl">Skip: ada komen</div></div><div class="fbs-stat-cell"><div class="num" id="fbs-stat-nocta" style="color:#888;">0</div><div class="lbl">Skip: no CTA</div></div></div>'
        + '<div class="fbs-stats-row"><div class="fbs-stat-cell"><div class="num" id="fbs-stat-gagal" style="color:#ffaa00;">0</div><div class="lbl">Gagal / ragu</div></div><div class="fbs-stat-cell"><div class="num" id="fbs-stat-scroll" style="color:#b0b3b8;">0</div><div class="lbl">Gulung</div></div></div>'
        + '<div id="fbs-mode-box" style="background:#1c1e21;border:1px solid #3a3b3c;border-radius:6px;padding:6px 8px;margin-bottom:8px;text-align:center;font-size:10px;"><div id="fbs-mode-status" style="color:#42b72a;font-weight:700;">FEED idle</div></div>'
        + '<div id="fbs-config-box" style="background:#0d1f3a;border:1px solid #1877f2;border-radius:6px;padding:8px;margin-bottom:8px;font-size:10px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-weight:700;color:#1877f2;">CONFIG (Inbox)</span><button id="fbs-config-refresh" style="background:#1877f2;color:white;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:700;font-size:10px;">Refresh</button></div><div id="fbs-config-status" style="color:#b0b3b8;font-size:9px;line-height:1.5;">Loading...</div></div>'
        + '<button class="fbs-btn fbs-btn-start" id="fbs-btn-toggle" disabled>WAITING CONFIG...</button>'
        + '<div class="fbs-row" id="fbs-btn-row-pause-stop" style="display:none;margin-bottom:6px;"><button class="fbs-btn fbs-btn-stop" id="fbs-btn-stop">STOP</button><button class="fbs-btn fbs-btn-pause" id="fbs-btn-pause">PAUSE</button></div>'
        + '<button class="fbs-btn fbs-btn-clear" id="fbs-btn-clear">Clear Semua</button>'
        + '<div style="margin-top:10px;border-top:1px solid #3a3b3c;padding-top:8px;"><div style="font-size:11px;color:#b0b3b8;font-weight:700;margin-bottom:4px;">LOGS (30min rolling)</div><div id="fbs-log-box" style="background:#0a0b0c;border:1px solid #2d2f33;border-radius:4px;padding:4px;max-height:160px;overflow-y:auto;font-family:monospace;"><div style="color:#666;font-size:9px;text-align:center;padding:8px;">(no events)</div></div></div>'
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
            // Syaratnya cuma keyword — akun FB & daftar komentar itu
            // urusan SMM yang udah dibuang.
            if (getSkipKeywords().length === 0) {
                alert('Keyword belum kebaca dari sheet Inbox.\n\nCek Config: Keyword 1 & Keyword 2.');
                return;
            }
            mainLoop();
        });
        document.getElementById('fbs-btn-stop').addEventListener('click', () => { if (!mainLoopRunning) return; stopMainLoop(); });
        document.getElementById('fbs-btn-pause').addEventListener('click', () => togglePause());
        document.getElementById('fbs-btn-clear').addEventListener('click', () => {
            if (confirm('Hapus ' + collectedLinks.length + ' link?')) {
                clearLinks(); logMessages = []; detectedCount = 0; scrollAttempts = 0; skippedNoCTA = 0; skippedDuplicate = 0; gagalCount = 0; linksSinceLastDelay = 0; retryCount = 0; errorRecoveryCount = 0; lastExtractedUrl = null;
                document.querySelectorAll('[data-fb-extracted], [data-fb-processing]').forEach(el => { el.removeAttribute('data-fb-extracted'); el.removeAttribute('data-fb-processing'); el.style.outline = ''; });
                addLog('UI: cleared all stats + markers', 'info'); updateUI();
            }
        });
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
            const skipKomen = document.getElementById('fbs-stat-skipkomen');
            const noCta     = document.getElementById('fbs-stat-nocta');
            const gagal     = document.getElementById('fbs-stat-gagal');
            const gulung    = document.getElementById('fbs-stat-scroll');
            if (skipKomen) skipKomen.textContent = skippedDuplicate;
            if (noCta)     noCta.textContent = skippedNoCTA;
            if (gagal)     gagal.textContent = gagalCount;
            if (gulung)    gulung.textContent = scrollAttempts;
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
                const ts = RUNTIME_CONFIG.last_fetch_ts ? new Date(RUNTIME_CONFIG.last_fetch_ts).toLocaleTimeString('id-ID', { hour12: false }) : '-';
                configStatus.innerHTML = 'Keyword: <b>' + RUNTIME_CONFIG.skip_keywords.join(', ') + '</b><br>'
                    + 'Ditarik: ' + ts + ' (' + RUNTIME_CONFIG.last_fetch_status + ')';
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

    function scheduleDailyReset() {
        function getNextMidnightWIB() {
            const now = Date.now();
            const WIB_OFFSET_MS = 7 * 3600000;
            const DAY_MS = 86400000;
            const wibNowMs = now + WIB_OFFSET_MS;
            const msSinceMidnightWIB = wibNowMs % DAY_MS;
            let msToNext = DAY_MS - msSinceMidnightWIB;
            if (msToNext < 60000) msToNext = DAY_MS;
            return msToNext;
        }
        function doReset() {
            detectedCount = 0; scrollAttempts = 0; skippedNoCTA = 0; skippedDuplicate = 0; gagalCount = 0; linksSinceLastDelay = 0; retryCount = 0; errorRecoveryCount = 0;
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

    createPanel();

    } // end mainScript

})(); // end IIFE
