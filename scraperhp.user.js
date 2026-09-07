// ==UserScript==
// @name         FB Mobile Ads Scraper (BASIC)
// @namespace    https://riko.local/fbmobile
// @version      1.11.0
// @description  BASIC: scroll m.facebook, deteksi Bersponsor, klik comments, tangkap URL, rapikan jadi {id}/posts/{fbid}, kirim SEMUA ke sheet (dedup diserahkan ke GAS). Keluar komentar via tombol Kembali FB. Refresh cuma kalau 30x scroll berturut-turut TANPA tekan komentar.
// @author       Riko
// @match        *://m.facebook.com/*
// @match        *://www.facebook.com/*
// @match        *://web.facebook.com/*
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      googleusercontent.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // CHUNK 1 — KONSTANTA & UTIL
    // ============================================================

    const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxe3mCNLCDfmEEwHpi4EKEAVTrAyoAewPIakY4F3ZQ0qNVhr3PBWWOfx5vNWLQ76YQGKQ/exec';

    const TM_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
        ? GM_info.script.version : '1.11.0';

    const AKUN_FB_KEY     = 'fbm_akun_fb_v1';
    const AUTO_RESUME_KEY = 'fbm_auto_resume_v1';
    const PANEL_OPEN_KEY  = 'fbm_panel_open_v1';
    const HOME_KEY        = 'fbm_home_url_v1';
    const DONE_ATTR       = 'data-fbm-done';

    // dipakai GAS di action=submit — JANGAN diubah (GAS nol perubahan)
    const HARDCODED_KOMENTAR = '\u{1D64E}\u{1D64A}\u{1D648}\u{1D63D}\u{1D64A}\u{1D64F}\u{1D642}\u{1D63E}\u{1D640}\u{1D63F}';

    // v1.9.0: "rumah" TIDAK dipatok ke feed lagi.
    // Dulu rumah = m.facebook.com/ doang, jadi di halaman pencarian
    // (/search_results/?q=...) bot mikir dirinya nyasar lalu kabur balik
    // ke feed. Sekarang rumah = halaman apa pun yang lagi kebuka waktu
    // START ditekan. Feed, pencarian, grup, profil — bebas.
    let HOME_URL = location.href;

    function setHome(url) {
        HOME_URL = url || location.href;
        try { GM_setValue(HOME_KEY, HOME_URL); } catch (e) {}
    }

    const SET = {
        SCROLL_MIN: 500, SCROLL_MAX: 900,
        SCROLL_PAUSE_MIN: 1200, SCROLL_PAUSE_MAX: 2600,
        BETWEEN_POSTS_MIN: 1500, BETWEEN_POSTS_MAX: 3200,
        READ_MIN: 700, READ_MAX: 1600,
        URL_WAIT_MS: 10000, URL_POLL_MS: 150, URL_SETTLE_MS: 400,
        BACK_WAIT_MS: 3000, BACK_POLL_MS: 200,
        SCAN_AHEAD_PX: 0, SCAN_BEHIND_PX: 0,   // v1.4.0: cuma yang BENERAN di layar
        SCROLL_REFRESH_AT: 30,  // 30x scroll KOSONG berturut-turut -> hard refresh
        RESTORE_TOLERANCE_PX: 400,   // v1.5.0: selisih dianggap "balik ke atas"
        RESTORE_SETTLE_MS: 600,      // tunggu feed siap sebelum dipulihkan
        PASS_MARGIN_PX: 120          // geser sedikit lewat post yang sudah diproses
    };

    const API_RETRY_MAX = 3;
    const API_BACKOFF   = [3000, 6000, 12000];
    const API_TIMEOUT   = 30000;


    // ---------- state ----------
    let running = false;
    let paused = false;
    let shouldStop = false;
    let phase = 'idle';

    let statSent = 0;      // link baru masuk sheet
    let statDup = 0;       // ditolak GAS (sudah ada)
    let statFail = 0;      // gagal tangkap URL / tombol
    let statScroll = 0;    // scroll KOSONG berturut-turut (nol lagi tiap tekan komentar)
    let statTotalScroll = 0;

    // TIDAK ADA saringan sidik jari / nomor post di sisi browser.
    // SEMUA link dikirim ke sheet. Anti-dobel sepenuhnya urusan GAS.

    let logs = [];
    const MAX_LOG = 60;

    // ---------- util ----------
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

    // buang karakter icon private-use FB (contoh: ikon di "󰍹 176comments")
    function cleanLabel(s) {
        if (!s) return '';
        try { return String(s).replace(/[\uE000-\uF8FF]/g, '').replace(/[\u{F0000}-\u{FFFFD}]/gu, '').trim(); }
        catch (e) { return String(s).replace(/[\uE000-\uF8FF]/g, '').trim(); }
    }

    // teks -> huruf/angka polos, buat pencocokan
    function normText(s) {
        if (!s) return '';
        let t = String(s);
        try { t = t.normalize('NFKC'); } catch (e) {}
        t = t.replace(/[\u200b-\u200f\u2060-\u206f\ufeff\u00ad\u034f]/g, '');
        return t.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function escapeHTML(s) {
        if (!s) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function waitPause() {
        while (paused && !shouldStop) await sleep(400);
        return !shouldStop;
    }

    async function interruptibleSleep(ms) {
        const step = 120; let done = 0;
        while (done < ms) {
            if (shouldStop) return false;
            while (paused && !shouldStop) await sleep(400);
            if (shouldStop) return false;
            await sleep(Math.min(step, ms - done));
            done += step;
        }
        return true;
    }

    function addLog(msg, type) {
        type = type || 'info';
        const t = new Date().toLocaleTimeString('id-ID', { hour12: false });
        logs.unshift({ t: t, msg: msg, type: type });
        if (logs.length > MAX_LOG) logs.pop();
        try { console.log('[FBM ' + t + '] ' + msg); } catch (e) {}
        renderLog();
    }

    function setPhase(p) { phase = p; updateUI(); }

    // ============================================================
    // CHUNK 2 — KIRIM KE SHEET (GAS nol perubahan)
    // ============================================================

    function apiCallWithRetry(cfg, label) {
        return new Promise(async (resolveOuter) => {
            for (let attempt = 1; attempt <= API_RETRY_MAX; attempt++) {
                if (attempt > 1) {
                    const bo = API_BACKOFF[attempt - 2] || 12000;
                    addLog(label + ': retry ' + attempt + '/' + API_RETRY_MAX + ' (tunggu ' + (bo / 1000) + 's)', 'retry');
                    await sleep(bo);
                }
                const res = await new Promise((resolveAttempt) => {
                    try {
                        GM_xmlhttpRequest({
                            method: cfg.method,
                            url: cfg.url,
                            data: cfg.data,
                            headers: cfg.headers || {},
                            timeout: API_TIMEOUT,
                            onload: function (r) {
                                try { resolveAttempt({ okAttempt: true, result: cfg.parse(r.responseText) }); }
                                catch (e) { resolveAttempt({ okAttempt: false, reason: 'parse: ' + e.message }); }
                            },
                            onerror: function () { resolveAttempt({ okAttempt: false, reason: 'network' }); },
                            ontimeout: function () { resolveAttempt({ okAttempt: false, reason: 'timeout' }); }
                        });
                    } catch (e) { resolveAttempt({ okAttempt: false, reason: 'exception: ' + e.message }); }
                });
                if (res.okAttempt) return resolveOuter(res.result);
                if (attempt === API_RETRY_MAX) {
                    addLog(label + ': GAGAL total (' + res.reason + ')', 'error');
                    return resolveOuter({ ok: false, reason: res.reason });
                }
            }
        });
    }

    function getAkunFb() { return (GM_getValue(AKUN_FB_KEY, '') || '').trim(); }

    function submitToSheet(url) {
        const raw = getAkunFb();
        const akunWithVersion = raw ? (raw + ' - v' + TM_VERSION) : '';
        const payload = {
            action: 'submit',
            url: url,
            akun_fb: akunWithVersion,
            komentar: HARDCODED_KOMENTAR
        };
        return apiCallWithRetry({
            method: 'POST',
            url: ENDPOINT_URL,
            data: JSON.stringify(payload),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parse: function (txt) {
                const r = JSON.parse(txt);
                if (r.ok && r.status === 'new')        return { ok: true, status: 'new', row: r.row };
                if (r.ok && r.status === 'duplicate')  return { ok: true, status: 'duplicate', row: r.row };
                if (!r.ok && r.reason === 'dedup-active') return { ok: false, reason: 'dedup', row: r.existing_row };
                if (!r.ok && r.reason === 'dedup-viral')  return { ok: false, reason: 'dedup', row: r.existing_row };
                return { ok: false, reason: 'sheet-error', error: r.error || 'unknown' };
            }
        }, 'Sheet');
    }

    // ============================================================
    // CHUNK 3 — DETEKSI (F12 confirmed di m.facebook.com)
    // ============================================================

    // marker iklan: <span class="f5">Bersponsor</span>
    function isSponsorSpan(sp) {
        if (!sp || sp.children.length) return false;
        const n = normText(sp.textContent);
        return n === 'bersponsor' || n === 'sponsored' || n === 'disponsori';
    }

    function findSponsorMarkers() {
        let list = Array.from(document.querySelectorAll('span.f5')).filter(isSponsorSpan);
        if (list.length === 0) list = Array.from(document.querySelectorAll('span')).filter(isSponsorSpan);
        // v1.4.0: HANYA marker yang beneran kelihatan di layar.
        // Dulu ambil sampai 900px di bawah layar -> bot lompat ke iklan
        // yang belum kelihatan, layar keloncat-loncat.
        const vh = window.innerHeight;
        return list.filter(sp => {
            const r = sp.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            if (r.bottom < SET.SCAN_BEHIND_PX) return false;      // sudah lewat ke atas
            if (r.top > vh - SET.SCAN_AHEAD_PX) return false;     // belum masuk layar
            return true;
        });
    }

    // tombol yang BUKAN comments
    const BTN_BLOCK = /(menanggapi|react|reaksi|suka|like|share|bagikan|kirim|send|menu|lainnya|more|fotoprofil|profilephoto|tanggapan)/;

    // F12: urutan tombol = [reaksi] [like] [COMMENTS] [share]
    // label comments = "247comments" / "󰍹 176comments" — angka bebas, diabaikan
    function cocokComment(el) {
        const n = normText(cleanLabel(el.getAttribute('aria-label')));
        if (!n) return 0;
        const bare = n.replace(/[0-9]/g, '');
        if (bare === 'comments' || bare === 'comment' || bare === 'komentar' || bare === 'komentari') return 2;
        if (BTN_BLOCK.test(n)) return 0;
        if (n.indexOf('comment') >= 0 || n.indexOf('komentar') >= 0) return 1;
        return 0;
    }

    function pickCommentButton(scope) {
        if (!scope || !scope.querySelectorAll) return null;
        const btns = Array.from(scope.querySelectorAll('div[role="button"][aria-label]'));
        for (const b of btns) if (cocokComment(b) === 2) return b;   // pass 1: ketat
        for (const b of btns) if (cocokComment(b) === 1) return b;   // pass 2: longgar
        return null;
    }

    // v1.10.0: pilih tombol comments yang PALING DEKAT DI BAWAH marker
    // "Bersponsor", bukan yang pertama ketemu di container.
    //
    // Kenapa: di halaman story.php container yang ketemu bisa sebesar
    // 400x4308 dengan 31 tombol comments — "yang pertama" belum tentu
    // punya iklan yang bener. Di feed biasa container cuma 400x697 dan
    // isinya satu tombol, jadi hasilnya SAMA PERSIS kayak cara lama.
    //
    // Kalau gagal, jatuh balik ke pickCommentButton (cara lama).
    function pickCommentButtonDekat(scope, marker) {
        if (!scope || !marker) return pickCommentButton(scope);
        let mTop;
        try { mTop = marker.getBoundingClientRect().top; } catch (e) { return pickCommentButton(scope); }

        const btns = Array.from(scope.querySelectorAll('div[role="button"][aria-label]'));
        let terbaik = null, jarakTerbaik = Infinity, skorTerbaik = 0;

        for (const b of btns) {
            const skor = cocokComment(b);
            if (!skor) continue;
            let r;
            try { r = b.getBoundingClientRect(); } catch (e) { continue; }
            if (r.height === 0) continue;
            const jarak = r.top - mTop;
            if (jarak < 0) continue;                 // di ATAS marker -> punya post lain
            if (jarak > 2500) continue;              // kejauhan -> bukan punya iklan ini
            if (skor > skorTerbaik || (skor === skorTerbaik && jarak < jarakTerbaik)) {
                terbaik = b; jarakTerbaik = jarak; skorTerbaik = skor;
            }
        }
        return terbaik || pickCommentButton(scope);
    }

    // F12: container ketemu di 6 level ke atas dari marker
    function findPostContainer(marker) {
        let cur = marker;
        for (let i = 0; i < 20 && cur && cur !== document.body; i++) {
            if (pickCommentButton(cur)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }

    // ---------- URL ----------
    function isPostUrl(href) {
        if (!href || href.indexOf('facebook.com') < 0) return false;
        return /story\.php|permalink\.php|\/posts\/|\/reel\/|\/videos\/|\/watch\/|photo\.php|\/photo\//.test(href);
    }

    // v1.9.0: "di rumah" = di halaman yang dicatat waktu START, BUKAN
    // harus feed. Yang dibandingin cuma jalur + isi pencarian, ekor
    // sampah FB (fbclid, __cft__, dsb) diabaikan biar gak salah nilai.
    function sidikHalaman(href) {
        try {
            const u = new URL(href);
            const buang = ['fbclid', 'mibextid', '_rdr', 'ref', 'refid', 'sfnsn', 'idorvanity'];
            const p = new URLSearchParams();
            for (const [k, v] of u.searchParams) {
                if (buang.indexOf(k) >= 0) continue;
                if (k.indexOf('__cft__') === 0 || k.indexOf('__tn__') === 0) continue;
                p.append(k, v);
            }
            const q = p.toString();
            return u.hostname + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '');
        } catch (e) { return String(href); }
    }

    // v1.10.0: halaman post BOLEH jadi rumah.
    // Dulu ada larangan "kalau alamatnya story.php, itu bukan rumah" —
    // akibatnya kalau bot dijalanin DI halaman story.php, dia langsung
    // nganggap dirinya nyasar lalu tekan Kembali, gak pernah nyampe scan.
    // Sekarang yang nentuin cuma alamat persisnya, bukan bentuknya.
    // Habis klik komentar alamat tetap berubah, jadi tetap kedeteksi keluar.
    function isOnFeed() {
        try {
            return sidikHalaman(location.href) === sidikHalaman(HOME_URL);
        } catch (e) { return false; }
    }

    // rapikan URL jadi bentuk baku + ambil nomor post (kunci dedup)
    function shortenUrl(href) {
        try {
            const u = new URL(href, location.origin);
            const sf = u.searchParams.get('story_fbid');
            const id = u.searchParams.get('id');
            let m;

            if (sf && /^\d+$/.test(sf) && id && /^[A-Za-z0-9.]+$/.test(id))
                return { url: 'https://www.facebook.com/' + id + '/posts/' + sf, key: sf, baku: true };

            m = u.pathname.match(/^\/([^\/]+)\/posts\/(\d+)/);
            if (m) return { url: 'https://www.facebook.com/' + m[1] + '/posts/' + m[2], key: m[2], baku: true };

            m = u.pathname.match(/^\/reel\/(\d+)/);
            if (m) return { url: 'https://www.facebook.com/reel/' + m[1], key: m[1], baku: true };

            m = u.pathname.match(/^\/([^\/]+)\/videos\/(\d+)/);
            if (m) return { url: 'https://www.facebook.com/' + m[1] + '/videos/' + m[2], key: m[2], baku: true };

            const v = u.searchParams.get('v');
            if (v && /^\d+$/.test(v)) return { url: 'https://www.facebook.com/watch/?v=' + v, key: v, baku: true };

            const fbid = u.searchParams.get('fbid');
            if (fbid && /^\d+$/.test(fbid)) return { url: 'https://www.facebook.com/photo.php?fbid=' + fbid, key: fbid, baku: true };

            // tidak ada angka (mis. pfbid) -> kirim apa adanya, cuma dibersihin
            const keep = ['story_fbid', 'id', 'v', 'fbid'];
            const p = new URLSearchParams();
            for (const [k, val] of u.searchParams) if (keep.indexOf(k) >= 0) p.append(k, val);
            u.search = p.toString();
            u.hash = '';
            u.hostname = 'www.facebook.com';
            const out = u.toString();
            return { url: out, key: out, baku: false };
        } catch (e) { return null; }
    }

    // ============================================================
    // CHUNK 4 — PROSES POST & LOOP UTAMA
    // ============================================================

    // ============================================================
    // v1.2.0: KELUAR DARI HALAMAN KOMENTAR
    // Urutan: tombol "Kembali" FB  ->  history.back()  ->  hard refresh.
    //
    // Kenapa tombol FB duluan: dia punya FB sendiri, posisi scroll feed
    // kejaga. history.back() cuma perintah browser — FB gak tau, jadi feed
    // dibangun ulang dari paling atas dan bot muter di halaman atas terus.
    // ============================================================
    const BACK_LABELS = ['kembali', 'back'];

    function findBackButton() {
        try {
            const btns = document.querySelectorAll('div[role="button"][aria-label], a[role="button"][aria-label]');
            for (const b of btns) {
                const al = cleanLabel(b.getAttribute('aria-label')).toLowerCase().trim();
                if (BACK_LABELS.indexOf(al) === -1) continue;
                const r = b.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                return b;
            }
        } catch (e) {}
        return null;
    }

    async function waitBackToFeed(ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (isOnFeed()) return true;
            await sleep(SET.BACK_POLL_MS);
        }
        return isOnFeed();
    }

    async function backToFeed() {
        if (isOnFeed()) return true;

        // 1. tombol "Kembali" milik FB — posisi scroll feed kejaga
        const btn = findBackButton();
        if (btn) {
            try { btn.click(); addLog('Back: klik tombol Kembali', 'info'); }
            catch (e) { addLog('Back: klik Kembali error: ' + e.message, 'warning'); }
            if (await waitBackToFeed(SET.BACK_WAIT_MS)) return true;
            addLog('Back: sudah klik Kembali tapi belum balik feed', 'warning');
        } else {
            addLog('Back: tombol Kembali tidak ketemu', 'warning');
        }

        // 2. cadangan: history.back()
        try { history.back(); addLog('Back: cadangan history.back()', 'info'); } catch (e) {}
        if (await waitBackToFeed(SET.BACK_WAIT_MS)) return true;

        // 3. semua gagal -> hard refresh ke m.facebook.com
        refreshAndResume('gagal balik ke halaman awal');
        return false;
    }

    // v1.5.0: posisi feed dicatat SEBELUM klik komentar, dipaksa balik SESUDAH
    // kembali ke feed. Gak peduli penyebabnya apa — tombol Kembali gagal,
    // FB bangun ulang feed, atau refresh nyempil — posisinya tetap dipulihkan.
    let lastPostBottomAbs = 0;

    async function restoreScroll(savedY) {
        if (!savedY || savedY < SET.RESTORE_TOLERANCE_PX) return;
        await sleep(SET.RESTORE_SETTLE_MS);
        for (let i = 0; i < 3; i++) {
            const now = window.scrollY;
            if (Math.abs(now - savedY) <= SET.RESTORE_TOLERANCE_PX) return;
            addLog('Scroll: terlempar ke ' + Math.round(now) + ', pulihkan ke ' + Math.round(savedY), 'warning');
            try { window.scrollTo(0, savedY); } catch (e) {}
            await sleep(500);
        }
    }

    async function processPost(post, marker) {
        try { post.setAttribute(DONE_ATTR, '1'); } catch (e) {}

        // v1.10.0: tombol paling dekat di bawah "Bersponsor".
        // Di feed hasilnya sama persis kayak cara lama (container cuma
        // punya satu tombol). Bedanya kerasa di halaman story.php.
        const btn = pickCommentButtonDekat(post, marker);
        if (!btn) { statFail++; addLog('Post: tombol comments tidak ketemu', 'warning'); updateUI(); return; }

        const label = cleanLabel(btn.getAttribute('aria-label'));
        // v1.4.0: scrollIntoView DICABUT — dia yang bikin layar loncat mendadak.
        // Tombol diklik apa adanya di posisi sekarang. Kalau tombolnya belum
        // kelihatan, post ini dilewat dulu (dicek di collectNewAdPosts).
        if (!(await interruptibleSleep(rand(SET.READ_MIN, SET.READ_MAX)))) return;

        const before = location.href;
        // v1.5.0: catat posisi feed + ujung bawah post SEBELUM pindah halaman
        const savedY = window.scrollY;
        try { lastPostBottomAbs = window.scrollY + post.getBoundingClientRect().bottom; }
        catch (e) { lastPostBottomAbs = 0; }
        try { post.style.outline = '3px solid #ff4444'; } catch (e) {}
        try { btn.click(); } catch (e) { statFail++; addLog('Post: klik error: ' + e.message, 'error'); updateUI(); return; }
        // v1.3.0: tekan komentar = feed masih ada isinya -> counter scroll kosong NOL lagi.
        // Refresh cuma kejadian kalau 30x scroll berturut-turut gak nemu iklan sama sekali.
        statScroll = 0;
        updateUI();
        addLog('Klik "' + label + '"', 'info');

        // tunggu URL berubah jadi halaman post
        let captured = null;
        const t0 = Date.now();
        while (Date.now() - t0 < SET.URL_WAIT_MS) {
            if (shouldStop) break;
            const now = location.href;
            if (now !== before && isPostUrl(now)) {
                await sleep(SET.URL_SETTLE_MS);
                captured = isPostUrl(location.href) ? location.href : now;
                break;
            }
            await sleep(SET.URL_POLL_MS);
        }

        if (!captured) {
            statFail++;
            try { post.style.outline = '3px dashed #ffaa00'; } catch (e) {}
            addLog('Post: URL tidak berubah, lewati', 'warning');
            updateUI();
            await backToFeed();
            await restoreScroll(savedY);
            return;
        }

        const sh = shortenUrl(captured);
        if (!sh) {
            statFail++;
            addLog('Post: URL tidak bisa dibaca: ' + captured.slice(0, 60), 'warning');
            updateUI();
            await backToFeed();
            await restoreScroll(savedY);
            return;
        }

        if (!sh.baku) addLog('Post: URL TIDAK BAKU (tanpa angka) -> ' + sh.url.slice(0, 70), 'warning');

        setPhase('kirim');
        addLog('Kirim: ' + sh.url, 'info');
        const res = await submitToSheet(sh.url);

        if (res.ok && res.status === 'new') {
            statSent++;
            try { post.style.outline = '3px solid #42b72a'; } catch (e) {}
            addLog('OK: baris #' + res.row, 'success');
            toast('OK #' + statSent);
        } else if ((res.ok && res.status === 'duplicate') || (!res.ok && res.reason === 'dedup')) {
            statDup++;
            try { post.style.outline = '3px solid #ff77ff'; } catch (e) {}
            addLog('DUP: sudah ada di sheet (baris #' + (res.row || '?') + ')', 'info');
        } else {
            statFail++;
            try { post.style.outline = '3px dashed #ffaa00'; } catch (e) {}
            addLog('GAGAL kirim: ' + (res.error || res.reason || 'unknown'), 'error');
        }
        updateUI();
        await backToFeed();
        await restoreScroll(savedY);
    }

    // refresh halaman lalu lanjut sendiri (auto-resume)
    function refreshAndResume(reason) {
        addLog('Refresh: ' + reason, 'warning');
        try { GM_setValue(AUTO_RESUME_KEY, '1'); } catch (e) {}
        shouldStop = true;
        try {
            // v1.9.0: hard refresh mendarat di HALAMAN AWAL, bukan feed.
            // Kalau bot dijalanin di /search_results/?q=dewi11, refresh
            // balik ke situ juga — bukan diseret ke m.facebook.com.
            if (location.href === HOME_URL) location.reload();
            else location.href = HOME_URL;
        } catch (e) { location.href = HOME_URL; }
    }

    async function scrollStep() {
        const before = window.scrollY;
        const step = rand(SET.SCROLL_MIN, SET.SCROLL_MAX);
        try { window.scrollBy({ top: step, behavior: 'smooth' }); }
        catch (e) { window.scrollBy(0, step); }
        statScroll++; statTotalScroll++;
        const ok = await interruptibleSleep(rand(SET.SCROLL_PAUSE_MIN, SET.SCROLL_PAUSE_MAX));
        if (!ok) return false;
        return Math.abs(window.scrollY - before) > 50;
    }

    function collectNewAdPosts() {
        const markers = findSponsorMarkers();
        const out = [];
        const seenEl = [];
        for (const mk of markers) {
            const post = findPostContainer(mk);
            if (!post) continue;
            if (seenEl.indexOf(post) >= 0) continue;
            seenEl.push(post);
            if (post.getAttribute(DONE_ATTR) === '1') continue;
            // v1.10.0: marker dibawa serta, dipakai buat cari tombol terdekat
            out.push({ post: post, marker: mk });
        }
        return out;
    }

    async function mainLoop() {
        if (running) { addLog('Main: sudah jalan', 'warning'); return; }
        if (!getAkunFb()) { addLog('Main: Akun FB belum diisi', 'error'); return; }

        running = true; shouldStop = false; paused = false;

        // v1.10.0: halaman apa pun yang lagi kebuka jadi rumah — termasuk
        // story.php. Bot dijalanin di mana, di situ dia kerja.
        setHome(location.href);
        addLog('Main: START (' + getAkunFb() + ' - v' + TM_VERSION + ')', 'success');
        addLog('Rumah: ' + HOME_URL.substring(0, 90), 'info');
        updateUI();

        let stuck = 0;
        try {
            if (!isOnFeed()) await backToFeed();

            while (!shouldStop) {
                if (!(await waitPause())) break;

                if (!isOnFeed()) {
                    setPhase('balik rumah');
                    await backToFeed();
                    if (!(await interruptibleSleep(800))) break;
                    continue;
                }

                setPhase('scan');
                const posts = collectNewAdPosts();

                // v1.4.0: proses SATU iklan per putaran, lalu WAJIB scroll.
                //
                // Dulu di sini ada `continue` (scan ulang tanpa scroll). Tapi
                // tanda data-fbm-done HILANG tiap balik dari kolom komentar
                // (DOM feed dibangun ulang FB), jadi iklan yang barusan diklik
                // keitung baru lagi -> diklik lagi -> bot nyangkut di tempat,
                // scrollY mentok, kelihatan kayak "balik ke atas terus".
                //
                // Sekarang: klik 1 iklan -> scroll -> scan lagi. Bot pasti maju.
                if (posts.length > 0) {
                    addLog('Scan: ' + posts.length + ' iklan di layar', 'detect');
                    const p = posts[0].post;
                    const mk = posts[0].marker;
                    if (document.body.contains(p) && p.getAttribute(DONE_ATTR) !== '1') {
                        setPhase('proses');
                        await processPost(p, mk);
                        if (!(await interruptibleSleep(rand(SET.BETWEEN_POSTS_MIN, SET.BETWEEN_POSTS_MAX)))) break;

                        // v1.5.0: geser SECUKUPNYA — cuma sampai post yang barusan
                        // diproses lewat ke atas layar. Dulu langsung scroll
                        // 500-900px asal, jadi iklan kedua yang lagi di layar
                        // ikut kegeser lewat dan gak pernah kejaring.
                        if (lastPostBottomAbs > 0) {
                            const targetY = lastPostBottomAbs - SET.PASS_MARGIN_PX;
                            if (targetY > window.scrollY) {
                                try { window.scrollTo(0, targetY); } catch (e) {}
                                statScroll = 0;
                                addLog('Scroll: geser lewat post (ke ' + Math.round(targetY) + ')', 'info');
                                if (!(await interruptibleSleep(700))) break;
                            }
                            lastPostBottomAbs = 0;
                        }
                        continue;   // scan lagi — iklan lain di layar masih kejaring
                    }
                }

                setPhase('scroll');
                const moved = await scrollStep();
                updateUI();

                // pemicu utama: tiap 20x scroll -> refresh, lanjut sendiri
                if (statScroll >= SET.SCROLL_REFRESH_AT) {
                    refreshAndResume('sudah ' + statScroll + 'x scroll kosong (tanpa iklan)');
                    return;
                }

                if (!moved) {
                    stuck++;
                    addLog('Scroll: tidak gerak (' + stuck + 'x)', 'info');
                    if (stuck >= 3) {
                        try { window.scrollBy({ top: 2500, behavior: 'smooth' }); } catch (e) { window.scrollBy(0, 2500); }
                        if (!(await interruptibleSleep(2000))) break;
                    }
                    if (stuck >= 6) {
                        refreshAndResume('scroll mentok 6x');
                        return;
                    }
                } else stuck = 0;
            }
        } catch (e) {
            addLog('Main: error: ' + e.message, 'error');
        } finally {
            running = false; paused = false;
            setPhase('idle');
            addLog('Main: STOP — kirim=' + statSent + ' dup=' + statDup + ' gagal=' + statFail + ' scroll=' + statTotalScroll, 'info');
            updateUI();
        }
    }

    function stopMainLoop() {
        shouldStop = true; paused = false;
        try { GM_setValue(AUTO_RESUME_KEY, ''); } catch (e) {}
        addLog('Main: STOP diminta', 'info');
    }

    function togglePause() {
        if (!running) return;
        paused = !paused;
        addLog(paused ? 'Main: PAUSE' : 'Main: LANJUT', paused ? 'warning' : 'success');
        updateUI();
    }

    // ============================================================
    // CHUNK 5 — PANEL & BOOT (v1.6.0: pil kecil + panel bawah)
    // ============================================================

    function toast(msg) {
        try {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:70px;background:#0F6E56;color:#fff;padding:7px 14px;border-radius:20px;font-weight:500;font-size:12px;z-index:2147483647;pointer-events:none;';
            el.textContent = msg;
            document.body.appendChild(el);
            setTimeout(() => { try { el.remove(); } catch (e) {} }, 2000);
        } catch (e) {}
    }

    function isPanelOpen() { return GM_getValue(PANEL_OPEN_KEY, '') === '1'; }
    function setPanelOpen(v) { try { GM_setValue(PANEL_OPEN_KEY, v ? '1' : ''); } catch (e) {} }

    function renderLog() {
        try {
            const box = document.getElementById('fbm-log');
            if (!box) return;
            if (!logs.length) { box.innerHTML = '<div style="color:#5F5E5A;">(kosong)</div>'; return; }
            const col = { info: '#B4B2A9', success: '#5DCAA5', warning: '#EF9F27', error: '#F0997B', detect: '#85B7EB', retry: '#AFA9EC' };
            box.innerHTML = logs.slice(0, 6).map(m =>
                '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'
                + '<span style="color:#5F5E5A;">' + m.t + '</span> '
                + '<span style="color:' + (col[m.type] || '#D3D1C7') + ';">' + escapeHTML(m.msg) + '</span></div>'
            ).join('');
        } catch (e) {}
    }

    function updateUI() {
        try {
            const g = id => document.getElementById(id);
            if (g('fbm-sent')) g('fbm-sent').textContent = statSent;
            if (g('fbm-dup')) g('fbm-dup').textContent = statDup;
            if (g('fbm-fail')) g('fbm-fail').textContent = statFail;
            if (g('fbm-scroll')) g('fbm-scroll').textContent = statScroll + '/' + SET.SCROLL_REFRESH_AT;

            // pil kecil
            if (g('fbm-pill-num')) g('fbm-pill-num').textContent = statSent;

            // v1.11.0: ikon = AKSI kalau ditekan, bukan keadaan sekarang.
            //   lagi jalan  -> tampil PAUSE (dua garis)
            //   idle/pause  -> tampil PLAY (segitiga)
            const ikon = g('fbm-icon-path');
            if (ikon) {
                const lagiJalan = running && !paused;
                ikon.setAttribute('d', lagiJalan
                    ? 'M1.5 1 H4 V11 H1.5 Z M7 1 H9.5 V11 H7 Z'   // pause
                    : 'M1 1 L10 6 L1 11 Z');                       // play
            }
            const pil = g('fbm-pill');
            if (pil) {
                if (running && paused) pil.style.background = '#854F0B';   // pause
                else if (running) pil.style.background = '#0F6E56';        // jalan
                else pil.style.background = '#3A3A38';                     // idle
            }

            const st = g('fbm-status');
            if (st) {
                if (running && paused) { st.textContent = 'PAUSE'; st.style.color = '#EF9F27'; }
                else if (running) { st.textContent = phase; st.style.color = '#5DCAA5'; }
                else { st.textContent = 'idle'; st.style.color = '#B4B2A9'; }
            }

            const bStart = g('fbm-start'), bRow = g('fbm-row'), bPause = g('fbm-pause');
            if (bStart && bRow) {
                if (running) { bStart.style.display = 'none'; bRow.style.display = 'flex'; }
                else { bStart.style.display = 'block'; bRow.style.display = 'none'; }
            }
            if (bPause) {
                bPause.textContent = paused ? 'lanjut' : 'pause';
                bPause.style.background = paused ? '#185FA5' : '#854F0B';
            }
            const ak = g('fbm-akun-status');
            if (ak) {
                const v = getAkunFb();
                ak.innerHTML = v ? '<span style="color:#5DCAA5;">' + escapeHTML(v) + '</span>'
                                 : '<span style="color:#F0997B;">belum diisi</span>';
            }
            renderLog();
        } catch (e) {}
    }

    function applyPanelState() {
        const pill = document.getElementById('fbm-pill');
        const body = document.getElementById('fbm-body');
        if (!pill || !body) return;
        if (isPanelOpen()) { pill.style.display = 'none'; body.style.display = 'block'; }
        else { pill.style.display = 'flex'; body.style.display = 'none'; }
    }

    function createPanel() {
        const old = document.getElementById('fbm-wrap');
        if (old) old.remove();

        const btnCss = 'flex:1;text-align:center;font-size:12px;padding:7px 0;border-radius:6px;border:none;color:#fff;cursor:pointer;font-family:inherit;';

        const w = document.createElement('div');
        w.id = 'fbm-wrap';
        w.innerHTML = '<style>'
            + '#fbm-wrap{position:fixed!important;left:8px!important;right:8px!important;bottom:8px!important;z-index:2147483646!important;font-family:-apple-system,BlinkMacSystemFont,sans-serif!important;pointer-events:none;}'
            + '#fbm-wrap *{box-sizing:border-box;}'
            + '#fbm-pill{pointer-events:auto;display:flex;align-items:center;background:#0F6E56;color:#fff;border-radius:20px;width:max-content;overflow:hidden;}'
            + '#fbm-pill .seg{display:flex;align-items:center;justify-content:center;cursor:pointer;}'
            + '#fbm-pill .seg:active{background:rgba(0,0,0,.22);}'
            + '#fbm-pill-num{padding:6px 10px 6px 12px;font-size:13px;font-weight:500;min-width:26px;}'
            + '#fbm-pill-play{padding:6px 9px;border-left:1px solid rgba(255,255,255,.22);}'
            + '#fbm-pill-open{padding:6px 10px 6px 9px;border-left:1px solid rgba(255,255,255,.22);}'
            + '#fbm-body{pointer-events:auto;display:none;background:rgba(23,26,28,.88);border-radius:10px;padding:9px 11px;color:#fff;}'
            + '#fbm-wrap input{width:100%;background:rgba(255,255,255,.08);color:#fff;border:1px solid #444441;padding:5px 7px;border-radius:5px;font-size:11px;margin-bottom:5px;font-family:inherit;}'
            + '</style>'

            // v1.11.0: pil isinya 3 bagian —
            //   [jumlah kirim] [play/pause] [panah buka panel]
            // Dulu cuma titik + angka, dan buat pause harus buka panel dulu.
            + '<div id="fbm-pill">'
            + '<span class="seg" id="fbm-pill-num">0</span>'
            + '<span class="seg" id="fbm-pill-play" title="start / pause">'
            + '<svg id="fbm-pill-icon" width="11" height="12" viewBox="0 0 11 12" fill="#fff" aria-hidden="true">'
            + '<path id="fbm-icon-path" d="M1 1 L10 6 L1 11 Z"/></svg></span>'
            + '<span class="seg" id="fbm-pill-open" title="buka panel">'
            + '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M2 6.8 L5.5 3.3 L9 6.8"/></svg></span>'
            + '</div>'

            + '<div id="fbm-body">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">'
            + '<span style="font-size:12px;font-weight:500;color:#9FE1CB;">FB Scraper v' + TM_VERSION + ' &middot; <span id="fbm-status" style="color:#B4B2A9;">idle</span></span>'
            + '<span id="fbm-close" style="font-size:16px;color:#B4B2A9;cursor:pointer;line-height:1;padding:0 4px;">&#9662;</span></div>'

            + '<div style="display:flex;gap:14px;align-items:baseline;margin-bottom:9px;">'
            + '<div><div id="fbm-sent" style="font-size:20px;font-weight:500;color:#5DCAA5;line-height:1;">0</div><div style="font-size:10px;color:#B4B2A9;">kirim</div></div>'
            + '<div><div id="fbm-dup" style="font-size:20px;font-weight:500;color:#ED93B1;line-height:1;">0</div><div style="font-size:10px;color:#B4B2A9;">dedup</div></div>'
            + '<div><div id="fbm-fail" style="font-size:20px;font-weight:500;color:#F0997B;line-height:1;">0</div><div style="font-size:10px;color:#B4B2A9;">gagal</div></div>'
            + '<div><div id="fbm-scroll" style="font-size:20px;font-weight:500;color:#B4B2A9;line-height:1;">0/30</div><div style="font-size:10px;color:#B4B2A9;">kosong</div></div>'
            + '</div>'

            + '<div id="fbm-akun-box" style="margin-bottom:8px;">'
            + '<input id="fbm-akun-input" type="text" placeholder="nama anggota, contoh: FEE1">'
            + '<div style="display:flex;gap:6px;align-items:center;">'
            + '<button id="fbm-akun-save" style="' + btnCss + 'background:#0F6E56;">simpan</button>'
            + '<span id="fbm-akun-status" style="flex:1;font-size:10px;text-align:right;">-</span></div></div>'

            + '<button id="fbm-start" style="' + btnCss + 'width:100%;background:#0F6E56;margin-bottom:8px;">start</button>'
            + '<div id="fbm-row" style="display:none;gap:6px;margin-bottom:8px;">'
            + '<button id="fbm-stop" style="' + btnCss + 'background:#993C1D;">stop</button>'
            + '<button id="fbm-pause" style="' + btnCss + 'background:#854F0B;">pause</button></div>'

            + '<div style="display:flex;gap:6px;margin-bottom:8px;">'
            + '<button id="fbm-reset" style="' + btnCss + 'background:#444441;">reset hitungan</button></div>'

            + '<div id="fbm-log" style="font-size:10px;font-family:monospace;color:#B4B2A9;line-height:1.6;"></div>'
            + '</div>';

        document.body.appendChild(w);

        // panah -> buka panel
        document.getElementById('fbm-pill-open').addEventListener('click', (e) => {
            e.stopPropagation();
            setPanelOpen(true); applyPanelState(); updateUI();
        });
        // angka -> buka panel juga (sasaran gede, gampang dipencet)
        document.getElementById('fbm-pill-num').addEventListener('click', (e) => {
            e.stopPropagation();
            setPanelOpen(true); applyPanelState(); updateUI();
        });
        // play/pause langsung dari pil, gak perlu buka panel
        document.getElementById('fbm-pill-play').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!running) {
                if (!getAkunFb()) {
                    setPanelOpen(true); applyPanelState(); updateUI();
                    alert('Nama Akun FB belum diisi!');
                    return;
                }
                mainLoop();
            } else {
                togglePause();
            }
            updateUI();
        });
        document.getElementById('fbm-close').addEventListener('click', () => { setPanelOpen(false); applyPanelState(); });

        const inp = document.getElementById('fbm-akun-input');
        inp.value = GM_getValue(AKUN_FB_KEY, '');
        document.getElementById('fbm-akun-save').addEventListener('click', () => {
            GM_setValue(AKUN_FB_KEY, inp.value.trim());
            addLog('Akun FB disimpan: ' + inp.value.trim(), 'success');
            updateUI();
        });

        document.getElementById('fbm-start').addEventListener('click', () => {
            if (running) return;
            if (!getAkunFb()) { alert('Nama Akun FB belum diisi!'); return; }
            setPanelOpen(false); applyPanelState();
            mainLoop();
        });
        document.getElementById('fbm-stop').addEventListener('click', () => stopMainLoop());
        document.getElementById('fbm-pause').addEventListener('click', () => togglePause());
        document.getElementById('fbm-reset').addEventListener('click', () => {
            statSent = 0; statDup = 0; statFail = 0; statScroll = 0; statTotalScroll = 0;
            logs = [];
            document.querySelectorAll('[' + DONE_ATTR + ']').forEach(el => {
                el.removeAttribute(DONE_ATTR);
                try { el.style.outline = ''; } catch (e) {}
            });
            addLog('Hitungan direset', 'info');
            updateUI();
        });

        applyPanelState();
        setInterval(() => { try { updateUI(); } catch (e) {} }, 15000);
        updateUI();
        addLog('Siap. Isi Akun FB lalu start.', 'success');
    }

    // ---------- BOOT ----------
    // v1.8.0: m.facebook.com DAN www.facebook.com diperlakukan sama.
    // Redirect balik ke m DICABUT — FB sekarang memaksa www, jadi
    // maksa balik cuma bikin muter refresh tanpa henti.
    function boot() {
        try {
            const host = location.hostname;
            if (host !== 'm.facebook.com' && host !== 'www.facebook.com' && host !== 'web.facebook.com') return;
            createPanel();
            const resume = GM_getValue(AUTO_RESUME_KEY, '');
            if (resume === '1') {
                GM_setValue(AUTO_RESUME_KEY, '');
                // v1.9.0: rumah dipulihkan, jadi habis refresh bot lanjut di
                // halaman yang sama (mis. hasil pencarian), bukan pindah feed.
                const rumah = GM_getValue(HOME_KEY, '');
                if (rumah) setHome(rumah);
                addLog('Auto-resume setelah muat ulang...', 'info');
                setTimeout(() => { if (!running && getAkunFb()) mainLoop(); }, 6000);
            }
        } catch (e) { try { console.error('[FBM] boot: ' + e.message); } catch (err) {} }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
    else setTimeout(boot, 800);

})();
