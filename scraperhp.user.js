// ==UserScript==
// @name         FB Mobile Ads Scraper (BASIC)
// @namespace    https://riko.local/fbmobile
// @version      2.6.1
// @description  v2: dua mode SEARCH & HOME. Di SEARCH: ambil link + klik CTA iklan (mancing). Di HOME: ambil link saja. Keyword dari TM_Config. Tab iklan diurus browser_scraper.js.
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
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // CHUNK 1 — KONSTANTA & UTIL
    // ============================================================

    const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxe3mCNLCDfmEEwHpi4EKEAVTrAyoAewPIakY4F3ZQ0qNVhr3PBWWOfx5vNWLQ76YQGKQ/exec';

    const TM_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
        ? GM_info.script.version : '2.6.1';

    const AKUN_FB_KEY     = 'fbm_akun_fb_v1';
    const AUTO_RESUME_KEY = 'fbm_auto_resume_v1';
    const PANEL_OPEN_KEY  = 'fbm_panel_open_v1';
    const HOME_KEY        = 'fbm_home_url_v1';
    // v2.0.0 — status mode, disimpan biar selamat lewat pindah halaman
    const MODE_KEY        = 'fbm_mode_v2';        // 'search' | 'home'
    const KW_LIST_KEY     = 'fbm_kw_list_v2';     // daftar keyword dari sheet
    const KW_IDX_KEY      = 'fbm_kw_idx_v2';      // keyword ke berapa
    const MODE_LINK_KEY   = 'fbm_mode_link_v2';   // link kekumpul di mode ini
    const KW_QUEUE_KEY    = 'fbm_kw_queue_v2';    // antrian keyword hasil kocokan
    const DONE_ATTR       = 'data-fbm-done';
    // v2.3.2: penanda buat browser_scraper.js. Dia di LUAR halaman, gak bisa
    // baca GM_getValue, tapi bisa baca atribut di <html>. Selama tanda ini
    // kosong, pengurus tab di CMD DIAM TOTAL — gak catat tab, gak rebut
    // fokus, gak tutup apa pun. Jadi waktu kamu masih setting Tampermonkey
    // atau login Surfshark, gak ada yang ganggu.
    const RUN_ATTR        = 'data-fbm-running';

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
    let statCta = 0;       // v2.0.0: berapa iklan yang berhasil diklik

    // v2.0.0 — mode
    let MODE = 'search';   // v2.1.0: START selalu mulai dari SEARCH
    let KEYWORDS = [];
    let KW_IDX = 0;
    let MODE_LINK = 0;
    let ANTRIAN = [];      // v2.2.0: antrian keyword yang sudah dikocok
    let cekConfigTerakhir = 0;   // v2.5.0: kapan config terakhir dicek

    // TIDAK ADA saringan sidik jari / nomor post di sisi browser.
    // SEMUA link dikirim ke sheet. Anti-dobel sepenuhnya urusan GAS.

    let logs = [];
    const MAX_LOG = 60;

    // ---------- util ----------
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ============================================================
    // v2.3.1 — KLIK YANG BENERAN JALAN DI TAMPERMONKEY
    //
    // Tampermonkey menjalankan userscript di KOTAK PASIR. `window` di dalam
    // sini bukan Window asli, cuma bungkusan. Akibatnya:
    //     new MouseEvent('click', { view: window })
    // ditolak browser dengan:
    //     "Failed to convert value to 'Window'"
    // Kliknya GAGAL TOTAL sebelum sempat kejadian.
    //
    // Di console tidak error karena console jalan di halaman langsung,
    // jadi window-nya asli. Itu sebabnya kelihatan jalan waktu diuji F12
    // tapi mati begitu dipasang di Tampermonkey.
    //
    // Perbaikan: pakai Window asli lewat unsafeWindow, dengan dua cadangan.
    // ============================================================
    function windowAsli() {
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow; } catch (e) {}
        return null;
    }

    function klikAsli(el) {
        if (!el) return false;
        const W = windowAsli();
        // 1. MouseEvent dengan Window ASLI — paling mirip klik jari
        if (W && W.MouseEvent) {
            try {
                el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, view: W }));
                return true;
            } catch (e) {}
        }
        // 2. klik bawaan elemen
        try { el.click(); return true; } catch (e) {}
        // 3. MouseEvent tanpa view (view memang boleh dikosongkan)
        try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
        } catch (e) {}
        return false;
    }
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

    // v2.3.2: pasang/cabut penanda "bot lagi jalan" di <html>
    function tandaiJalan() {
        try {
            const el = document.documentElement;
            if (!el) return;
            if (running && !paused) el.setAttribute(RUN_ATTR, '1');
            else el.removeAttribute(RUN_ATTR);
        } catch (e) {}
    }

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

    // v2.0.0: tarik daftar keyword dari TM_Config lewat GAS
    function ambilKeyword() {
        return apiCallWithRetry({
            method: 'POST',
            url: ENDPOINT_URL,
            data: JSON.stringify({ action: 'get_scraper_config' }),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            parse: function (txt) {
                const r = JSON.parse(txt);
                if (!r.ok || !r.config) return { ok: false, reason: 'config-kosong' };
                const kw = r.config.search_keywords || [];
                const bot = r.config.bot || null;   // v2.4.0: angka-angka dari sheet
                return { ok: true, keywords: kw, bot: bot };
            }
        }, 'Keyword');
    }

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

    // ============================================================
    // v2.0.0 — TOMBOL CTA IKLAN
    // F12 membuktikan: iklan FB mobile TIDAK punya <a href> sama sekali.
    // Tombolnya <div data-action-id> berisi teks biasa TANPA aria-label —
    // makanya pencarian lewat aria-label dulu selalu nihil.
    // Klik BIASA sudah bikin FB membuka tab baru sendiri; ctrl+klik justru
    // gagal (tidak ada <a>, halaman malah pindah).
    // ============================================================
    // ============================================================
    // v2.3.0 — SASARAN KLIK IKLAN (hasil uji F12, terbukti)
    //
    // Aturan yang menentukan:
    //   1. Sasaran HARUS di BAWAH ujung foto/video.
    //      Di atas foto isinya caption, nama pengiklan, judul —
    //      keklik di situ cuma manjangin caption / buka halaman post.
    //   2. "Lihat selengkapnya" DITOLAK — itu pemanjang caption.
    //   3. Angka ("55", "739", "1,8 rb") DITOLAK — itu tombol reaksi.
    //   4. Iklan kirim pesan TIDAK diklik sama sekali — dia gak buka tab
    //      baru, malah nyeret bot ke Messenger.
    // ============================================================
    const CTA_TEKS = /(pelajariselengkapnya|learnmore|belanjasekarang|shopnow|daftarsekarang|daftar|signup|pesansekarang|ordernow|booknow|unduh|download|install|pasang|bukatautan|beli|checkout|reservasi|gabung|coba|seerates|kunjungisitus|visitsite|mainkan|langganan|isiformulir)/;
    const CTA_PESAN = /(kirimpesan|sendmessage|message|pesan|whatsapp|kirimwa|hubungikami|hubungi|contactus|callnow|telepon|chat|inbox)/;
    const CAPTION_TEKS = /^(lihatselengkapnya|selengkapnya|seemore|showmore|lainnya)$/;
    const ANGKA_TEKS = /^[0-9.,rbjtkm ]*$/;

    function namaPengiklan(post) {
        try {
            const btns = post.querySelectorAll('div[role="button"][aria-label]');
            for (const b of btns) {
                const t = cleanLabel(b.getAttribute('aria-label'));
                if (/^Foto profil /i.test(t)) return normText(t.replace(/^Foto profil\s*/i, ''));
            }
        } catch (e) {}
        return '';
    }

    // ujung bawah foto/video — img/video dulu, blok besar cuma cadangan.
    // Cadangan HARUS tanpa teks, kalau tidak yang keukur malah blok post
    // (pernah kejadian: kebaca 617 padahal fotonya berakhir di 442).
    function ujungBawahFoto(post, mTop) {
        let bawah = 0;
        try {
            post.querySelectorAll('img,video,[data-mcomponent*="Image"],[data-mcomponent*="Video"]').forEach(m => {
                const r = m.getBoundingClientRect();
                if (r.width < 150 || r.height < 120) return;
                const b = r.bottom - mTop;
                if (b > bawah) bawah = b;
            });
        } catch (e) {}
        if (!bawah) {
            let kecil = null;
            try {
                post.querySelectorAll('[data-action-id]').forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width < 200 || r.height < 200 || r.width / r.height > 3) return;
                    if (cleanLabel(el.innerText).trim()) return;   // ada teks = bukan foto murni
                    if (!kecil || r.height < kecil.h) kecil = { h: r.height, b: r.bottom - mTop };
                });
            } catch (e) {}
            if (kecil) bawah = kecil.b;
        }
        return bawah;
    }

    // hasil: { el, teks, jenis } — jenis 'cta' | 'teks' | 'pesan' | null
    function pilihSasaranIklan(post, mTop) {
        const fotoBawah = ujungBawahFoto(post, mTop);
        const batas = fotoBawah ? (fotoBawah - 10) : -99999;
        let cta = null, teks = null, adaPesan = false;
        try {
            post.querySelectorAll('[data-action-id]').forEach(el => {
                const r = el.getBoundingClientRect();
                const t = cleanLabel(el.innerText).replace(/\s+/g, ' ').trim();
                const n = normText(t);
                const j = r.top - mTop;
                if (!t || r.width < 50 || r.height < 14) return;
                if (j < batas) return;                       // di atas foto
                if (CAPTION_TEKS.test(n)) return;            // pemanjang caption
                if (CTA_PESAN.test(n)) { adaPesan = true; return; }
                if (ANGKA_TEKS.test(t)) return;              // tombol reaksi
                if (r.height <= 70 && CTA_TEKS.test(n) && t.length <= 45) {
                    if (!cta || j < cta.jarak) cta = { el: el, teks: t, jarak: j, jenis: 'cta' };
                    return;
                }
                if (r.height > 200) return;
                if (r.height > 90 && r.width / r.height < 3) return;
                if (el.querySelector('img,video')) return;
                if (!teks || j < teks.jarak) teks = { el: el, teks: t, jarak: j, jenis: 'teks' };
            });
        } catch (e) {}
        if (cta) return cta;
        if (adaPesan) return { jenis: 'pesan' };
        return teks;
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

        // v2.3.0: URUTAN BARU — klik iklan DULU, baru komentar.
        //   jumpa iklan -> klik (tab baru, halaman tetap di FB)
        //   -> buka komentar -> ambil link -> Kembali -> lanjut scroll
        if (MODE === 'search') {
            const mTopKlik = marker ? marker.getBoundingClientRect().top : -99999;
            const utuh = await klikIklan(post, mTopKlik);
            if (shouldStop) return;
            if (!utuh) {
                // halaman sempat pindah — cari lagi iklan yang sama
                const adv = namaPengiklan(post);
                let ulang = null, mkUlang = null;
                for (const m of findSponsorMarkers()) {
                    const pp = findPostContainer(m);
                    if (pp && namaPengiklan(pp) === adv) { ulang = pp; mkUlang = m; break; }
                }
                if (!ulang) { addLog('Post: hilang sesudah klik iklan, lewati', 'warning'); statFail++; updateUI(); return; }
                post = ulang; marker = mkUlang;
                try { post.setAttribute(DONE_ATTR, '1'); } catch (e) {}
            }
            await sleep(500);
        }

        // v1.10.0: tombol paling dekat di bawah "Bersponsor".
        const btn = pickCommentButtonDekat(post, marker);
        if (!btn) { statFail++; addLog('Post: tombol comments tidak ketemu', 'warning'); updateUI(); return; }

        const label = cleanLabel(btn.getAttribute('aria-label'));
        // v1.4.0: scrollIntoView DICABUT — dia yang bikin layar loncat mendadak.
        // Tombol diklik apa adanya di posisi sekarang. Kalau tombolnya belum
        // kelihatan, post ini dilewat dulu (dicek di collectNewAdPosts).
        if (!(await interruptibleSleep(rand(SET.READ_MIN, SET.READ_MAX)))) return;

        const before = location.href;
        // v2.0.0: nama pengiklan dicatat SEBELUM pindah halaman, dipakai buat
        // nemuin lagi iklan yang sama sesudah tekan Kembali (DOM dibangun ulang
        // FB, jadi elemen lama sudah tidak dipakai).
        const advId = namaPengiklan(post);
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
            MODE_LINK++; simpanMode();
            try { post.style.outline = '3px solid #42b72a'; } catch (e) {}
            addLog('OK: baris #' + res.row, 'success');
            toast('OK #' + statSent);
        } else if ((res.ok && res.status === 'duplicate') || (!res.ok && res.reason === 'dedup')) {
            statDup++;
            MODE_LINK++; simpanMode();
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

    // ============================================================
    // v2.0.0 — MODE
    //   SEARCH : /search_results/?q={keyword} — ambil link + KLIK iklan (mancing)
    //   HOME   : feed biasa — ambil link saja, iklan TIDAK diklik
    // ============================================================
    function urlSearch(kw) {
        return location.protocol + '//' + location.hostname
             + '/search_results/?q=' + encodeURIComponent(kw);
    }
    function urlHome() {
        return location.protocol + '//' + location.hostname + '/';
    }

    function simpanMode() {
        try {
            GM_setValue(MODE_KEY, MODE);
            GM_setValue(KW_IDX_KEY, String(KW_IDX));
            GM_setValue(MODE_LINK_KEY, String(MODE_LINK));
            GM_setValue(KW_LIST_KEY, JSON.stringify(KEYWORDS));
            GM_setValue(KW_QUEUE_KEY, JSON.stringify(ANTRIAN));
        } catch (e) {}
    }
    function muatMode() {
        try {
            MODE = GM_getValue(MODE_KEY, 'search') || 'search';
            KW_IDX = parseInt(GM_getValue(KW_IDX_KEY, '0'), 10) || 0;
            MODE_LINK = parseInt(GM_getValue(MODE_LINK_KEY, '0'), 10) || 0;
            const raw = GM_getValue(KW_LIST_KEY, '');
            if (raw) { try { KEYWORDS = JSON.parse(raw) || []; } catch (e) { KEYWORDS = []; } }
            const q = GM_getValue(KW_QUEUE_KEY, '');
            if (q) { try { ANTRIAN = JSON.parse(q) || []; } catch (e) { ANTRIAN = []; } }
        } catch (e) {}
    }

    // pindah mode / keyword: simpan status -> nyalakan auto-resume -> pindah halaman
    //
    // v2.4.1: MODE_LINK cuma dinolin waktu GANTI MODE, BUKAN ganti keyword.
    // Dulu hitungan direset tiap ganti keyword, jadi:
    //     kw A dapat 4 -> reset 0
    //     kw B dapat 2 -> reset 0
    //     kw C dapat 3 -> reset 0
    // total 9 link tapi yang kecatat cuma 3 — batas 10 gak pernah kesentuh.
    // Sekarang ditotal lintas keyword: 4+2+3+1 = 10 -> pindah HOME.
    function pindah(modeBaru, kwIdxBaru, alasan) {
        const gantiMode = (modeBaru !== MODE);
        MODE = modeBaru;
        if (typeof kwIdxBaru === 'number') KW_IDX = kwIdxBaru;
        if (gantiMode) MODE_LINK = 0;
        statScroll = 0;
        const tujuan = (MODE === 'search' && KEYWORDS.length)
            ? urlSearch(KEYWORDS[KW_IDX % KEYWORDS.length])
            : urlHome();
        setHome(tujuan);
        simpanMode();
        addLog('PINDAH → ' + MODE.toUpperCase()
            + (MODE === 'search' && KEYWORDS.length ? ' "' + KEYWORDS[KW_IDX % KEYWORDS.length] + '"' : '')
            + ' (' + alasan + ')'
            + (gantiMode ? ' — hitungan link direset'
                         : ' — hitungan link jalan terus: ' + MODE_LINK), 'detect');
        try { GM_setValue(AUTO_RESUME_KEY, '1'); } catch (e) {}
        shouldStop = true;
        try {
            if (location.href === tujuan) location.reload();
            else location.href = tujuan;
        } catch (e) { location.href = tujuan; }
    }

    // ============================================================
    // v2.2.0 — KEYWORD ACAK (bukan urut)
    // Cara kocok kartu: semua keyword diacak urutannya, dipakai habis satu
    // per satu, baru dikocok ulang. Kocokan baru tidak pernah dimulai
    // dengan keyword yang barusan dipakai.
    // ============================================================
    function kocok(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }
    function kocokUlang(hindari) {
        if (KEYWORDS.length <= 1) return KEYWORDS.slice();
        let a = kocok(KEYWORDS);
        for (let c = 0; c < 8 && hindari && a[0] === hindari; c++) a = kocok(KEYWORDS);
        return a;
    }

    // v2.4.0: angka dari sheet dipasang ke SET.
    // Nama di sheet -> nama di SET. Kalau barisnya gak ada, angka bawaan dipakai.
    function terapkanConfigBot(bot) {
        if (!bot) return 0;
        const peta = {
            search_scroll_max: 'SEARCH_SCROLL_MAX',
            home_scroll_max:   'HOME_SCROLL_MAX',
            search_link_max:   'SEARCH_TO_HOME',
            home_link_max:     'HOME_TO_SEARCH',
            cta_tunggu_ms:     'CTA_WAIT_MS',
            scroll_jarak_min:  'SCROLL_MIN',
            scroll_jarak_max:  'SCROLL_MAX',
            jeda_iklan_min:    'BETWEEN_POSTS_MIN',
            jeda_iklan_max:    'BETWEEN_POSTS_MAX'
        };
        let n = 0;
        const berubah = [];
        for (const k in peta) {
            const v = parseInt(bot[k], 10);
            if (isNaN(v) || v <= 0) continue;
            const lama = SET[peta[k]];
            if (lama !== v) berubah.push(k + ' ' + lama + ' → ' + v);
            SET[peta[k]] = v;
            n++;
        }
        if (SET.SCROLL_MAX < SET.SCROLL_MIN) SET.SCROLL_MAX = SET.SCROLL_MIN;
        if (SET.BETWEEN_POSTS_MAX < SET.BETWEEN_POSTS_MIN) SET.BETWEEN_POSTS_MAX = SET.BETWEEN_POSTS_MIN;
        return { jumlah: n, berubah: berubah };
    }

    // ============================================================
    // v2.5.0 — CEK CONFIG BERKALA (60 detik)
    // Dulu config cuma ditarik waktu START / ganti keyword / ganti mode.
    // Kalau angka di sheet diubah pas bot lagi asik scroll, dia baru tau
    // nanti-nanti. Sekarang dicek sendiri tiap 60 detik.
    //
    // Catatan: GAS nyimpen config di ingatan sementara 60 detik juga,
    // jadi paling lambat sekitar 2 menit dari kamu ubah di sheet.
    // ============================================================
    async function cekConfigBerkala() {
        if (Date.now() - cekConfigTerakhir < SET.CEK_CONFIG_MS) return;
        cekConfigTerakhir = Date.now();
        let r;
        try { r = await ambilKeyword(); } catch (e) { return; }
        if (!r || !r.ok) return;

        if (r.bot) {
            const hasil = terapkanConfigBot(r.bot);
            if (hasil.berubah.length) {
                addLog('Config berubah: ' + hasil.berubah.join(', '), 'detect');
            }
        }
        // keyword ikut disegarkan — kalau kamu tambah di sheet, langsung kebaca
        if (r.keywords && r.keywords.length) {
            const lama = KEYWORDS.length;
            const beda = (lama !== r.keywords.length)
                || r.keywords.some((k, i) => KEYWORDS[i] !== k);
            if (beda) {
                KEYWORDS = r.keywords;
                ANTRIAN = ANTRIAN.filter(k => KEYWORDS.indexOf(k) !== -1);
                simpanMode();
                addLog('Keyword berubah: ' + lama + ' → ' + KEYWORDS.length + ' di sheet', 'detect');
            }
            // v2.6.0 — POIN 2: kalau tadi terpaksa HOME gara-gara keyword kosong,
            // begitu keyword kebaca, balik ke SEARCH. Jangan nyangkut di HOME.
            if (MODE === 'home' && lama === 0 && KEYWORDS.length > 0) {
                await keywordBerikutnya('keyword sudah kebaca, balik ke SEARCH');
                return;
            }
        }
    }

    // batas scroll kosong BEDA per mode
    function batasScrollKosong() {
        return (MODE === 'search') ? SET.SEARCH_SCROLL_MAX : SET.HOME_SCROLL_MAX;
    }

    // v2.1.1: SELALU tarik ulang dari sheet.
    async function tarikKeywordSegar(kenapa) {
        setPhase('tarik keyword');
        const lama = KEYWORDS.length;
        const r = await ambilKeyword();
        if (r.ok && r.bot) {
            const n = terapkanConfigBot(r.bot).jumlah;
            if (n) addLog('Config: ' + n + ' angka dipasang dari sheet — '
                + 'scroll kosong S/H ' + SET.SEARCH_SCROLL_MAX + '/' + SET.HOME_SCROLL_MAX
                + ', link S/H ' + SET.SEARCH_TO_HOME + '/' + SET.HOME_TO_SEARCH, 'success');
        }
        if (r.ok && r.keywords && r.keywords.length) {
            KEYWORDS = r.keywords;
            simpanMode();
            addLog('Keyword ' + kenapa + ': ' + KEYWORDS.length + ' dari sheet'
                + (lama && lama !== KEYWORDS.length ? ' (sebelumnya ' + lama + ')' : '')
                + ' — ' + KEYWORDS.slice(0, 6).join(', ') + (KEYWORDS.length > 6 ? ', ...' : ''), 'success');
            return true;
        }
        addLog('Keyword ' + kenapa + ': gagal/kosong, pakai simpanan lama (' + lama + ')', 'warning');
        return KEYWORDS.length > 0;
    }

    async function keywordBerikutnya(alasan) {
        const sekarang = KEYWORDS.length ? KEYWORDS[KW_IDX % KEYWORDS.length] : '';
        await tarikKeywordSegar('refresh');
        if (!KEYWORDS.length) { pindah('home', 0, 'tidak ada keyword'); return; }
        ANTRIAN = ANTRIAN.filter(k => KEYWORDS.indexOf(k) !== -1);
        if (!ANTRIAN.length) {
            ANTRIAN = kocokUlang(sekarang);
            addLog('Keyword: kocok ulang — ' + ANTRIAN.slice(0, 6).join(', ') + (ANTRIAN.length > 6 ? ', ...' : ''), 'detect');
        }
        const pilih = ANTRIAN.shift();
        const idx = KEYWORDS.indexOf(pilih);
        simpanMode();
        pindah('search', idx < 0 ? 0 : idx, alasan);
    }

    async function cekGantiMode() {
        if (MODE === 'search' && MODE_LINK >= SET.SEARCH_TO_HOME) {
            pindah('home', KW_IDX, MODE_LINK + ' link di search');
            return true;
        }
        if (MODE === 'home' && MODE_LINK >= SET.HOME_TO_SEARCH) {
            await keywordBerikutnya(MODE_LINK + ' link di home');
            return true;
        }
        return false;
    }

    // refresh halaman lalu lanjut sendiri (auto-resume)
    function refreshAndResume(reason) {
        addLog('Refresh: ' + reason, 'warning');
        try { GM_setValue(AUTO_RESUME_KEY, '1'); } catch (e) {}
        shouldStop = true;
        try {
            if (location.href === HOME_URL) location.reload();
            else location.href = HOME_URL;
        } catch (e) { location.href = HOME_URL; }
    }

    // ============================================================
    // v2.3.0 — KLIK IKLAN
    // Dijalankan SEBELUM tekan komentar, selagi DOM masih utuh.
    // Dulu dijalankan sesudah Kembali, jadi iklannya harus dicari ulang
    // lewat nama pengiklan — sering gagal karena FB bangun ulang halaman.
    // Cuma mode SEARCH. Di HOME iklan tidak pernah diklik.
    // ============================================================
    async function klikIklan(post, mTop) {
        const sasaran = pilihSasaranIklan(post, mTop);
        if (!sasaran) { addLog('Iklan: tidak ada bagian aman diklik, lewati', 'info'); return true; }
        if (sasaran.jenis === 'pesan') {
            addLog('Iklan: jenis kirim pesan — TIDAK diklik', 'info');
            return true;
        }

        const sebelum = location.href;
        try { sasaran.el.style.outline = '3px solid #00c2ff'; } catch (e) {}
        if (!klikAsli(sasaran.el)) {
            addLog('Iklan: klik GAGAL (semua cara ditolak)', 'error');
            return true;
        }
        addLog('Iklan: klik ' + (sasaran.jenis === 'cta' ? 'CTA' : 'teks')
            + ' "' + sasaran.teks.substring(0, 30) + '"', 'success');

        if (!(await interruptibleSleep(SET.CTA_WAIT_MS))) return false;

        if (location.href === sebelum) {
            statCta++;
            updateUI();
            return true;      // tab baru kebuka, halaman asal aman
        }
        addLog('Iklan: halaman malah pindah — tekan Kembali', 'warning');
        await backToFeed();
        return false;         // post lama sudah tidak berlaku
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

    // v2.1.0: balik ke awal — SEARCH, keyword pertama, hitungan mode nol.
    // Dipanggil saat STOP dan saat START manual. TIDAK dipanggil saat
    // auto-resume / pindah mode, biar bot lanjut di tempatnya.
    // START / STOP memang balik ke awal — di sini MODE_LINK sengaja dinolin.
    function resetMode() {
        MODE = 'search';
        MODE_LINK = 0;
        statScroll = 0;
        ANTRIAN = [];          // v2.2.0: antrian dikocok ulang saat START
        KW_IDX = 0;
        simpanMode();
    }

    async function mainLoop(isResume) {
        if (running) { addLog('Main: sudah jalan', 'warning'); return; }
        if (!getAkunFb()) { addLog('Main: Akun FB belum diisi', 'error'); return; }

        running = true; shouldStop = false; paused = false;

        muatMode();
        // v2.1.0: START manual selalu mulai dari SEARCH keyword pertama.
        // Auto-resume tidak direset — dia lanjut di mode & keyword terakhir.
        if (!isResume) {
            resetMode();
            addLog('Main: mulai dari SEARCH keyword pertama', 'info');
        }
        addLog('Main: START (' + getAkunFb() + ' - v' + TM_VERSION + ')', 'success');

        // v2.1.1: START manual SELALU tarik ulang dari sheet.
        // Auto-resume cuma narik kalau simpanannya kosong (biar cepat).
        cekConfigTerakhir = Date.now();
        if (!isResume) {
            await tarikKeywordSegar('START');
        } else if (!KEYWORDS.length) {
            await tarikKeywordSegar('resume');
        }
        // v2.6.0 — POIN 2: START WAJIB mulai dari SEARCH.
        // Dulu kalau tarikan keyword gagal sekali (GAS lemot / belum deploy),
        // bot langsung banting setir ke HOME dan gak pernah nyoba lagi sampai
        // ganti mode. Sekarang dicoba 3x dulu; kalau tetap kosong baru HOME,
        // dan pengecekan 60 detik nanti bakal narik dia balik ke SEARCH.
        if (!KEYWORDS.length && !isResume) {
            for (let coba = 2; coba <= 3 && !KEYWORDS.length; coba++) {
                addLog('Keyword kosong — coba tarik lagi (' + coba + '/3)', 'warning');
                if (!(await interruptibleSleep(2500))) { running = false; return; }
                await tarikKeywordSegar('START ulang ' + coba);
            }
        }
        if (!KEYWORDS.length) {
            MODE = 'home';
            addLog('Keyword tetap kosong sesudah 3x — jalan mode HOME dulu, '
                 + 'nanti balik SEARCH sendiri kalau keyword sudah kebaca', 'warning');
        } else if (!isResume) {
            // v2.2.0: START manual mulai dari keyword ACAK, bukan yang pertama
            ANTRIAN = kocokUlang('');
            const pilih = ANTRIAN.shift();
            KW_IDX = Math.max(0, KEYWORDS.indexOf(pilih));
            addLog('Keyword acak: "' + pilih + '" (antrian ' + (ANTRIAN.length + 1) + ')', 'detect');
        }
        simpanMode();

        // pastikan berada di halaman yang sesuai mode
        const tujuan = (MODE === 'search' && KEYWORDS.length)
            ? urlSearch(KEYWORDS[KW_IDX % KEYWORDS.length])
            : urlHome();
        if (sidikHalaman(location.href) !== sidikHalaman(tujuan)) {
            addLog('Pindah ke halaman ' + MODE.toUpperCase() + '...', 'info');
            setHome(tujuan);
            simpanMode();
            try { GM_setValue(AUTO_RESUME_KEY, '1'); } catch (e) {}
            running = false;
            location.href = tujuan;
            return;
        }
        setHome(location.href);
        addLog('MODE ' + MODE.toUpperCase()
            + (MODE === 'search' && KEYWORDS.length ? ' — keyword "' + KEYWORDS[KW_IDX % KEYWORDS.length] + '"' : '')
            + ' | link mode ini: ' + MODE_LINK, 'detect');
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
                        if (await cekGantiMode()) return;   // v2.0.0: sudah cukup, pindah
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

                // v2.5.0: cek config tiap 60 detik, gak nunggu ganti keyword
                await cekConfigBerkala();
                if (shouldStop) break;

                // v2.0.0: scroll kosong -> GANTI KEYWORD (search) / balik search (home).
                // v2.4.0: batasnya BEDA per mode, diatur dari sheet.
                if (statScroll >= batasScrollKosong()) {
                    if (MODE === 'search') await keywordBerikutnya(statScroll + 'x scroll kosong');
                    else if (KEYWORDS.length) await keywordBerikutnya(statScroll + 'x scroll kosong di home');
                    else refreshAndResume(statScroll + 'x scroll kosong');
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
                        // v2.0.0: mentok = hasil pencarian habis -> ganti keyword
                        if (KEYWORDS.length) await keywordBerikutnya('scroll mentok (hasil habis)');
                        else refreshAndResume('scroll mentok 6x');
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

    // v2.1.0: STOP = berhenti + BALIK KE AWAL.
    // Nyala lagi nanti mulai dari SEARCH keyword pertama.
    // Beda dengan PAUSE yang cuma menahan di tempat.
    function stopMainLoop() {
        shouldStop = true; paused = false;
        try { GM_setValue(AUTO_RESUME_KEY, ''); } catch (e) {}
        resetMode();
        // v2.1.1: simpanan keyword dibuang, jadi START berikutnya pasti
        // narik ulang dari sheet — nggak ada sisa daftar lama.
        KEYWORDS = [];
        try { GM_setValue(KW_LIST_KEY, ''); } catch (e) {}
        addLog('Main: STOP — direset ke SEARCH keyword pertama, keyword ditarik ulang saat START', 'warning');
        updateUI();
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
            if (g('fbm-scroll')) g('fbm-scroll').textContent = statScroll + '/' + batasScrollKosong();
            if (g('fbm-cta')) g('fbm-cta').textContent = statCta;
            const md = g('fbm-mode');
            if (md) {
                const batas = (MODE === 'search') ? SET.SEARCH_TO_HOME : SET.HOME_TO_SEARCH;
                const kw = (MODE === 'search' && KEYWORDS.length)
                    ? ' &middot; "' + escapeHTML(KEYWORDS[KW_IDX % KEYWORDS.length]) + '" (' + (KW_IDX % KEYWORDS.length + 1) + '/' + KEYWORDS.length + ')'
                    : '';
                md.innerHTML = '<b>' + MODE.toUpperCase() + '</b>' + kw
                    + ' &middot; link ' + MODE_LINK + '/' + batas
                    + (MODE === 'search' ? ' &middot; klik iklan AKTIF' : ' &middot; klik iklan MATI');
            }

            // pil kecil
            // v2.6.1 — POIN 1: angka pil = link dalam SATU MODE.
            // Dulu pakai statSent (jumlah kiriman sesi ini). statSent cuma ada
            // di ingatan, gak disimpan — tiap ganti keyword halaman dimuat ulang
            // dan angkanya balik 0, padahal modenya belum ganti.
            // MODE_LINK disimpan, jadi selamat lewat ganti keyword & refresh.
            if (g('fbm-pill-num')) g('fbm-pill-num').textContent = MODE_LINK;

            // v2.6.0 — POIN 1
            // Bagian tengah: START (segitiga) kalau idle, STOP (kotak) kalau jalan.
            // Bagian PAUSE cuma muncul kalau lagi jalan; ikonnya PAUSE (dua garis)
            // waktu berjalan, dan RESUME (segitiga) waktu ditahan.
            const ikonStop = g('fbm-icon-stop');
            const segStop = g('fbm-pill-stop');
            const segPlay = g('fbm-pill-play');
            const ikonPlay = g('fbm-icon-path');
            if (ikonStop && segStop) {
                ikonStop.setAttribute('d', running
                    ? 'M1.5 1.5 H9.5 V10.5 H1.5 Z'   // stop = kotak
                    : 'M1 1 L10 6 L1 11 Z');          // start = segitiga
                segStop.title = running ? 'stop & reset' : 'start';
            }
            if (segPlay && ikonPlay) {
                segPlay.style.display = running ? 'flex' : 'none';
                ikonPlay.setAttribute('d', paused
                    ? 'M1 1 L10 6 L1 11 Z'                        // resume
                    : 'M1.5 1 H4 V11 H1.5 Z M7 1 H9.5 V11 H7 Z'); // pause
                segPlay.title = paused ? 'resume' : 'pause';
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
            tandaiJalan();   // v2.3.2: penanda buat CMD
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
            + '#fbm-pill-stop{padding:6px 9px;border-left:1px solid rgba(255,255,255,.22);}'
            + '#fbm-pill-play{padding:6px 9px;border-left:1px solid rgba(255,255,255,.22);}'
            + '#fbm-pill-open{padding:6px 10px 6px 9px;border-left:1px solid rgba(255,255,255,.22);}'
            + '#fbm-body{pointer-events:auto;display:none;background:rgba(23,26,28,.88);border-radius:10px;padding:9px 11px;color:#fff;}'
            + '#fbm-wrap input{width:100%;background:rgba(255,255,255,.08);color:#fff;border:1px solid #444441;padding:5px 7px;border-radius:5px;font-size:11px;margin-bottom:5px;font-family:inherit;}'
            + '</style>'

            // v1.11.0: pil isinya 3 bagian —
            //   [jumlah kirim] [play/pause] [panah buka panel]
            // Dulu cuma titik + angka, dan buat pause harus buka panel dulu.
            // v2.6.0 — POIN 1
            //   belum jalan : [angka] [START] [panah]
            //   sudah jalan : [angka] [STOP] [PAUSE] [panah]
            //   STOP nempatin posisi START, PAUSE nongol di sebelahnya.
            + '<div id="fbm-pill">'
            + '<span class="seg" id="fbm-pill-num">0</span>'
            + '<span class="seg" id="fbm-pill-stop" title="start">'
            + '<svg width="11" height="12" viewBox="0 0 11 12" fill="#fff" aria-hidden="true">'
            + '<path id="fbm-icon-stop" d="M1 1 L10 6 L1 11 Z"/></svg></span>'
            + '<span class="seg" id="fbm-pill-play" title="pause" style="display:none;">'
            + '<svg width="11" height="12" viewBox="0 0 11 12" fill="#fff" aria-hidden="true">'
            + '<path id="fbm-icon-path" d="M1.5 1 H4 V11 H1.5 Z M7 1 H9.5 V11 H7 Z"/></svg></span>'
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
            + '<div><div id="fbm-cta" style="font-size:20px;font-weight:500;color:#85B7EB;line-height:1;">0</div><div style="font-size:10px;color:#B4B2A9;">iklan</div></div>'
            + '</div>'
            + '<div id="fbm-mode" style="font-size:10px;color:#9FE1CB;margin-bottom:8px;line-height:1.5;">-</div>'

            + '<div id="fbm-akun-box" style="margin-bottom:8px;">'
            + '<input id="fbm-akun-input" type="text" placeholder="nama anggota, contoh: FEE1">'
            + '<div style="display:flex;gap:6px;align-items:center;">'
            + '<button id="fbm-akun-save" style="' + btnCss + 'background:#0F6E56;">simpan</button>'
            + '<span id="fbm-akun-status" style="flex:1;font-size:10px;text-align:right;">-</span></div></div>'

            + '<button id="fbm-start" style="' + btnCss + 'width:100%;background:#0F6E56;margin-bottom:8px;">start</button>'
            + '<div id="fbm-row" style="display:none;gap:6px;margin-bottom:8px;">'
            + '<button id="fbm-stop" style="' + btnCss + 'background:#993C1D;">stop &amp; reset</button>'
            + '<button id="fbm-pause" style="' + btnCss + 'background:#854F0B;">pause</button></div>'

            + '<div style="display:flex;gap:6px;margin-bottom:8px;">'
            + '<button id="fbm-ganti" style="' + btnCss + 'background:#185FA5;">ganti keyword</button>'
            + '<button id="fbm-mode-tukar" style="' + btnCss + 'background:#5C4B8A;">tukar mode</button></div>'
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
        // v2.6.0 — bagian tengah: START kalau idle, STOP kalau jalan
        document.getElementById('fbm-pill-stop').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!running) {
                if (!getAkunFb()) {
                    setPanelOpen(true); applyPanelState(); updateUI();
                    alert('Nama Akun FB belum diisi!');
                    return;
                }
                mainLoop(false);   // START selalu mulai dari SEARCH
            } else {
                stopMainLoop();    // STOP = berhenti + reset
            }
            updateUI();
        });

        // v2.6.0 — PAUSE / RESUME. Tidak mereset apa pun.
        document.getElementById('fbm-pill-play').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!running) return;
            togglePause();
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
            mainLoop(false);   // v2.1.0: START manual = mulai dari SEARCH
        });
        document.getElementById('fbm-stop').addEventListener('click', () => stopMainLoop());
        document.getElementById('fbm-pause').addEventListener('click', () => togglePause());
        document.getElementById('fbm-ganti').addEventListener('click', async () => {
            // v2.1.1: tarik ulang dari sheet dulu, baru maju ke keyword berikutnya
            const b = document.getElementById('fbm-ganti');
            b.textContent = 'menarik...'; b.disabled = true;
            try { await keywordBerikutnya('diminta manual'); }
            catch (e) { addLog('Ganti keyword gagal: ' + e.message, 'error'); }
            b.textContent = 'ganti keyword'; b.disabled = false;
        });
        document.getElementById('fbm-mode-tukar').addEventListener('click', async () => {
            if (MODE === 'search') { pindah('home', KW_IDX, 'diminta manual'); return; }
            const b = document.getElementById('fbm-mode-tukar');
            b.textContent = 'menarik...'; b.disabled = true;
            await tarikKeywordSegar('tukar mode');
            b.textContent = 'tukar mode'; b.disabled = false;
            if (!KEYWORDS.length) { alert('Belum ada keyword di TM_Config'); return; }
            pindah('search', 0, 'diminta manual');
        });
        document.getElementById('fbm-reset').addEventListener('click', () => {
            statSent = 0; statDup = 0; statFail = 0; statScroll = 0; statTotalScroll = 0; statCta = 0;
            logs = [];
            document.querySelectorAll('[' + DONE_ATTR + ']').forEach(el => {
                el.removeAttribute(DONE_ATTR);
                try { el.style.outline = ''; } catch (e) {}
            });
            addLog('Hitungan direset', 'info');
            updateUI();
        });

        applyPanelState();
        // v2.3.2: FB sering bangun ulang halaman, penanda bisa kehapus —
        // dipasang ulang tiap 2 detik biar CMD gak salah baca.
        setInterval(() => { try { tandaiJalan(); } catch (e) {} }, 2000);
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
            muatMode();
            createPanel();
            const resume = GM_getValue(AUTO_RESUME_KEY, '');
            if (resume === '1') {
                GM_setValue(AUTO_RESUME_KEY, '');
                // v1.9.0: rumah dipulihkan, jadi habis refresh bot lanjut di
                // halaman yang sama (mis. hasil pencarian), bukan pindah feed.
                const rumah = GM_getValue(HOME_KEY, '');
                if (rumah) setHome(rumah);
                addLog('Auto-resume setelah muat ulang...', 'info');
                setTimeout(() => { if (!running && getAkunFb()) mainLoop(true); }, 6000);
            }
        } catch (e) { try { console.error('[FBM] boot: ' + e.message); } catch (err) {} }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
    else setTimeout(boot, 800);

})();
