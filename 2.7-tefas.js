/* ════════════════════════════════════════════════════════════════
   FİNANS MOTORU — Veri Worker v2.6 (Cloudflare Workers)
   EVDS (TCMB) + Yahoo Finance + TEFAS vekili — CORS köprüsü

   KURULUM (bir kez):
   1. dash.cloudflare.com → Workers & Pages → Create Worker
   2. Bu dosyanın tamamını yapıştır → Deploy
   3. Settings → Variables → Add: EVDS_KEY = <EVDS API anahtarın>
      (anahtar: evds3.tcmb.gov.tr → üye ol → profil → API Anahtarı)
   4. Worker adresini (https://....workers.dev) uygulamadaki
      "EVDS Worker adresi" alanına yapıştır.
   5. Tarayıcıda <worker-adresi>/check aç — her serinin durumunu görürsün.

   ESKİ WORKER'DAN GEÇİŞ: /paket ucu korundu; eski SERIES kodlarında
   düzeltmen varsa aşağıdaki SERIES tablosuna taşı.

   UÇLAR:
   /check                → tüm SERIES kodlarını EVDS'de sınar
   /paket                → son değerler (usd, eur, tufe, polFaiz, mevFaiz)
   /seri?code=X&start=YYYY-MM-DD[&end=...]  → tam seri {points:[[tarih,değer]]}
   /yahoo?symbol=THYAO.IS&range=5y&interval=1d → OHLC kapanışları (2. teslimat)
   /tefas?fon=AAK&start=YYYY-MM-DD&end=...     → fon fiyat geçmişi (2. teslimat)
   /temel?symbol=THYAO.IS → F/K, PD/DD, ROE, marj, borç, temettü (FM-21)
   ════════════════════════════════════════════════════════════════ */

/* ── /paket için son-değer serileri ──
   Kod yanlış çıkarsa: EVDS'de seriyi bul, kodu burada değiştir, /check ile sına. */
const SERIES = {
  usd:     { code: 'TP.DK.USD.A.YTL', note: 'USD alış (TCMB)' },
  eur:     { code: 'TP.DK.EUR.A.YTL', note: 'EUR alış (TCMB)' },
  tufe:    { code: 'TP.FE.OKTG01',    note: 'TÜFE endeksi → yıllık % hesaplanır', yoy: true },
  polFaiz: { code: 'TP.APIFON4',      note: 'TCMB ort. fonlama maliyeti — 1 hafta repo istersen kodu değiştir' },
  mevFaiz: { code: 'TP.TRY.MT02',     note: 'TL mevduat ağırlıklı ort. faiz (3 aya kadar) — DOĞRULA' }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });

/* EVDS tarihi GG-AA-YYYY ister; yanıtı YYYY-MM-DD'ye çeviririz */
const evdsTarih = iso => { const [y, m, d] = iso.split('-'); return d + '-' + m + '-' + y; };
const isoTarih = t => {
  // EVDS "Tarih" alanı: "01-06-2026", "2026-6" (aylık) veya "2026" (yıllık) gelebilir
  const s = String(t).trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d, m, y] = s.split('-'); return y + '-' + m + '-' + d; }
  if (/^\d{4}-\d{1,2}$/.test(s)) { const [y, m] = s.split('-'); return y + '-' + String(m).padStart(2, '0') + '-01'; }
  if (/^\d{4}$/.test(s)) return s + '-12-31';
  return s;
};

async function evdsGet(pathQuery, env) {
  if (!env.EVDS_KEY) throw new Error('EVDS_KEY tanımlı değil — Worker ayarlarından ekle');
  const r = await fetch('https://evds3.tcmb.gov.tr/igmevdsms-dis/' + pathQuery, {
    headers: {
      key: env.EVDS_KEY,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'tr-TR,tr;q=0.9'
    }
  });
  const govde = await r.text();
  if (!r.ok) throw new Error('EVDS HTTP ' + r.status + ' · ' + govde.slice(0, 120).replace(/\s+/g, ' '));
  try { return JSON.parse(govde); }
  catch (e) { throw new Error('EVDS JSON dönmedi · ' + govde.slice(0, 120).replace(/\s+/g, ' ')); }
}

async function evdsSeri(code, start, end, env) {
  if (!env.EVDS_KEY) throw new Error('EVDS_KEY tanımlı değil — Worker ayarlarından ekle');
  /* EVDS3 kontratı: path-stili URL (igmevdsms-dis), anahtar SADECE 'key' başlığında —
     URL'ye key eklemek ya da klasik query-string kullanmak 403/404 verir */
  const url = 'https://evds3.tcmb.gov.tr/igmevdsms-dis/series=' + code +
    '&startDate=' + evdsTarih(start) + '&endDate=' + evdsTarih(end) + '&type=json';
  const r = await fetch(url, {
    headers: {
      key: env.EVDS_KEY,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'tr-TR,tr;q=0.9'
    }
  });
  const govde = await r.text();
  if (!r.ok) throw new Error('EVDS HTTP ' + r.status + (r.status === 403 ? ' — anahtar geçersiz olabilir' : '') +
    ' · yanıt: ' + govde.slice(0, 160).replace(/\s+/g, ' '));
  let d;
  try { d = JSON.parse(govde); }
  catch (e) {
    /* EVDS JSON yerine sayfa döndü — teşhis için ilk satırları göster */
    throw new Error('EVDS JSON dönmedi · yanıt başı: ' + govde.slice(0, 200).replace(/\s+/g, ' '));
  }
  const items = d.items || [];
  const alan = code.replace(/[.\-]/g, '_'); // TP.FE.OKTG01 → TP_FE_OKTG01
  const points = [];
  for (const it of items) {
    const v = parseFloat(it[alan]);
    if (isFinite(v)) points.push([isoTarih(it.Tarih), v]);
  }
  points.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return points;
}

/* endeks → yıllık % (12 ay önceki aynı aya göre) */
function yillikYuzde(points) {
  const m = new Map(points);
  const out = [];
  for (const [d, v] of points) {
    const onceki = m.get(String(+d.slice(0, 4) - 1) + d.slice(4));
    if (onceki > 0) out.push([d, +((v / onceki - 1) * 100).toFixed(2)]);
  }
  return out;
}

/* ── FM-21: Yahoo quoteSummary temel veri ──
   Yahoo 2023'ten beri quoteSummary için çerez+crumb ister; ikisini de
   Worker alır (tarayıcıdan alınamaz — CORS). Crumb izolat ömrünce önbellekte. */
let YCRUMB = null; // {cookie, crumb, t}

async function yahooCrumb() {
  if (YCRUMB && Date.now() - YCRUMB.t < 30 * 60000) return YCRUMB;
  const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };
  /* 1) çerez: fc.yahoo.com her istekte A3 çerezi bırakır (404 dönmesi normal) */
  const r1 = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') || '').split(',').map(s => s.split(';')[0].trim())
    .filter(s => /=/.test(s)).join('; ');
  if (!cookie) throw new Error('Yahoo çerezi alınamadı');
  /* 2) crumb */
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb',
    { headers: Object.assign({}, UA, { Cookie: cookie, Accept: 'text/plain' }) });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 30 || crumb.includes('<'))
    throw new Error('Yahoo crumb alınamadı (HTTP ' + r2.status + ')');
  YCRUMB = { cookie, crumb, t: Date.now() };
  return YCRUMB;
}

/* quoteSummary yanıtından düz alan sözlüğü — saf fonksiyon, testte sınanır.
   Yahoo değerleri {raw, fmt} sarmalında gelir; raw alınır. Oranlar %'ye çevrilir. */
function temelAlanlar(qs) {
  const g = (mod, alan) => {
    const m = qs && qs[mod];
    if (!m) return null;
    const v = m[alan];
    if (v === null || v === undefined) return null;
    const raw = (typeof v === 'object') ? v.raw : v;
    return isFinite(raw) ? +raw : null;
  };
  const yzd = v => v === null ? null : +(v * 100).toFixed(2);
  const ap = qs && qs.assetProfile, pr = qs && qs.price;
  const fk1 = g('summaryDetail', 'trailingPE');
  const ifk = g('summaryDetail', 'forwardPE');
  return {
    fk:        fk1,
    ileriFk:   ifk !== null ? ifk : g('defaultKeyStatistics', 'forwardPE'),
    pddd:      g('defaultKeyStatistics', 'priceToBook'),
    roe:       yzd(g('financialData', 'returnOnEquity')),
    netMarj:   yzd(g('financialData', 'profitMargins')),
    borcOz:    g('financialData', 'debtToEquity'),            // Yahoo bunu zaten % ölçeğinde verir
    temettu:   yzd(g('summaryDetail', 'dividendYield')),
    piyasaDeger: (() => { const a = g('summaryDetail', 'marketCap'); return a !== null ? a : g('price', 'marketCap'); })(),
    hbk:       g('defaultKeyStatistics', 'trailingEps'),
    sektor:    (ap && ap.sector) || null,
    endustri:  (ap && ap.industry) || null,
    adi:       (pr && (pr.longName || pr.shortName)) || null,
    paraBirimi:(pr && pr.currency) || null
  };
}

const SURUM = '2.7-tefas';

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const yol = url.pathname.replace(/\/+$/, '') || '/';
    const bugun = new Date().toISOString().slice(0, 10);

    try {
      /* ── sağlık + kod doğrulama ── */
      if (yol === '/check') {
        const start = new Date(); start.setFullYear(start.getFullYear() - 2);
        const out = {};
        for (const [ad, s] of Object.entries(SERIES)) {
          try {
            const p = await evdsSeri(s.code, start.toISOString().slice(0, 10), bugun, env);
            out[ad] = p.length
              ? { ok: true, code: s.code, adet: p.length, son: p[p.length - 1] }
              : { ok: false, code: s.code, hata: 'seri boş — kod yanlış olabilir' };
          } catch (e) { out[ad] = { ok: false, code: s.code, hata: String(e.message || e) }; }
        }
        return json({ durum: 'çalışıyor', surum: SURUM, anahtar: !!env.EVDS_KEY, seriler: out });
      }

      /* ── /paket: uygulamadaki hızlı son-değer çekimi (eski uçla uyumlu) ── */
      if (yol === '/paket') {
        const start = new Date(); start.setFullYear(start.getFullYear() - 3);
        const data = {}, errors = {};
        for (const [ad, s] of Object.entries(SERIES)) {
          try {
            let p = await evdsSeri(s.code, start.toISOString().slice(0, 10), bugun, env);
            if (s.yoy) p = yillikYuzde(p);
            if (!p.length) throw new Error('boş seri');
            const [tarih, deger] = p[p.length - 1];
            data[ad] = { value: +(+deger).toFixed(4), date: tarih, note: s.note };
          } catch (e) { errors[ad] = String(e.message || e); }
        }
        return json({ data, errors });
      }

      /* ── /seri: tam geçmiş — uygulamanın ambarı bunu kullanır ── */
      if (yol === '/seri') {
        const code = url.searchParams.get('code');
        if (!code) return json({ error: 'code parametresi gerekli' }, 400);
        const start = url.searchParams.get('start') || '2005-01-01';
        const end = url.searchParams.get('end') || bugun;
        const points = await evdsSeri(code, start, end, env);
        return json({ code, points });
      }

      /* ── /gruplar: veri gruplarını anahtar kelimeyle ara (seri kodu keşfi) ── */
      if (yol === '/gruplar') {
        const kelime = (url.searchParams.get('kelime') || '').toLocaleLowerCase('tr');
        const d = await evdsGet('datagroups/mode=0&type=json', env);
        const liste = (Array.isArray(d) ? d : (d.items || []))
          .map(g => ({ kod: g.DATAGROUP_CODE, ad: g.DATAGROUP_NAME }))
          .filter(g => g.kod && (!kelime || String(g.ad || '').toLocaleLowerCase('tr').includes(kelime)));
        return json({ kelime, adet: liste.length, gruplar: liste.slice(0, 80),
          not: 'Grubu seç → /liste?grup=GRUP_KODU ile serileri gör' });
      }

      /* ── /liste: bir gruptaki serileri kodlarıyla döker ── */
      if (yol === '/liste') {
        const grup = url.searchParams.get('grup');
        if (!grup) return json({ error: 'grup parametresi gerekli (ör. /liste?grup=bie_dkdovytl)' }, 400);
        const d = await evdsGet('serieList/type=json&code=' + encodeURIComponent(grup), env);
        const liste = (Array.isArray(d) ? d : (d.items || []))
          .map(x => ({ kod: x.SERIE_CODE, ad: x.SERIE_NAME, baslangic: x.START_DATE }))
          .filter(x => x.kod);
        return json({ grup, adet: liste.length, seriler: liste });
      }

      /* ── /yahoo: tek hisse OHLC (BIST: KOD.IS) — 2. teslimat kullanacak ── */
      if (yol === '/yahoo') {
        const sym = url.searchParams.get('symbol');
        if (!sym) return json({ error: 'symbol parametresi gerekli (ör. THYAO.IS)' }, 400);
        const range = url.searchParams.get('range') || '5y';
        const interval = url.searchParams.get('interval') || '1d';
        const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' +
          encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval,
          { headers: { 'User-Agent': 'Mozilla/5.0 (finans-motoru)' } });
        if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
        const d = await r.json();
        const res = d.chart && d.chart.result && d.chart.result[0];
        if (!res) return json({ error: (d.chart && d.chart.error && d.chart.error.description) || 'sonuç yok' }, 502);
        const kapanis = res.indicators.quote[0].close || [];
        const points = (res.timestamp || []).map((ts, i) =>
          [new Date(ts * 1000).toISOString().slice(0, 10), kapanis[i]])
          .filter(p => isFinite(p[1]));
        return json({ symbol: sym, currency: res.meta && res.meta.currency, points });
      }

      /* ── /temel: tek hissenin temel oranları (FM-21) — Yahoo quoteSummary ── */
      if (yol === '/temel') {
        const sym = url.searchParams.get('symbol');
        if (!sym) return json({ error: 'symbol parametresi gerekli (ör. THYAO.IS)' }, 400);
        const moduller = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
        let d = null, sonHata = null;
        for (let deneme = 0; deneme < 2; deneme++) {
          try {
            const c = await yahooCrumb();
            const r = await fetch('https://query2.finance.yahoo.com/v10/finance/quoteSummary/' +
              encodeURIComponent(sym) + '?modules=' + moduller + '&crumb=' + encodeURIComponent(c.crumb),
              { headers: { Cookie: c.cookie, 'User-Agent': 'Mozilla/5.0 (finans-motoru)' } });
            if (r.status === 401 || r.status === 403) {
              YCRUMB = null; sonHata = 'Yahoo HTTP ' + r.status + ' (crumb yenilendi)'; continue;
            }
            if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
            d = await r.json(); break;
          } catch (e) { sonHata = String(e.message || e); YCRUMB = null; }
        }
        if (!d) return json({ error: 'temel veri alınamadı · ' + sonHata }, 502);
        const res = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
        if (!res) return json({ error: (d.quoteSummary && d.quoteSummary.error && d.quoteSummary.error.description) || 'sonuç yok — sembol doğru mu?' }, 404);
        return json({ symbol: sym, tarih: bugun, alanlar: temelAlanlar(res) });
      }

      /* ── /tefas: fon fiyat geçmişi (v2.7'de sağlamlaştırıldı) ──
         TEFAS uzun aralığı tek istekte vermez (~3 ay sınırı) → 60 günlük
         dilimlerle çekilip birleştirilir; önce oturum çerezi alınır.
         &tip=EMK ile emeklilik fonları da sorgulanabilir (varsayılan YAT). */
      if (yol === '/tefas') {
        const fon = url.searchParams.get('fon');
        if (!fon) return json({ error: 'fon parametresi gerekli (ör. AAK)' }, 400);
        const tip = (url.searchParams.get('tip') || 'YAT').toUpperCase() === 'EMK' ? 'EMK' : 'YAT';
        const trTarih = iso => { const [y, m, d] = iso.split('-'); return d + '.' + m + '.' + y; };
        const start = url.searchParams.get('start') ||
          new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
        const end = url.searchParams.get('end') || bugun;
        const UA2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
        /* oturum çerezi — TEFAS bazen çerezsiz POST'u boş/403 döndürür */
        let cerez = '';
        try {
          const r0 = await fetch('https://www.tefas.gov.tr/TarihselVeriler.aspx', { headers: { 'User-Agent': UA2 } });
          cerez = (r0.headers.get('set-cookie') || '').split(',').map(s => s.split(';')[0].trim())
            .filter(s => /=/.test(s)).join('; ');
        } catch (e) { /* çerezsiz de dene */ }
        /* 60 günlük dilimler */
        const dilimler = [];
        let a = new Date(start + 'T00:00:00Z');
        const son = new Date(end + 'T00:00:00Z');
        while (a <= son) {
          const b = new Date(Math.min(a.getTime() + 59 * 864e5, son.getTime()));
          dilimler.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]);
          a = new Date(b.getTime() + 864e5);
        }
        if (dilimler.length > 45) return json({ error: 'aralık çok uzun (' + dilimler.length + ' dilim) — start tarihini yakınlaştır' }, 400);
        const m = new Map(); const hatalar = [];
        for (const [d1, d2] of dilimler) {
          try {
            const body = new URLSearchParams({
              fontip: tip, fonkod: fon.toUpperCase(),
              bastarih: trTarih(d1), bittarih: trTarih(d2)
            });
            const hdr = {
              'User-Agent': UA2,
              'X-Requested-With': 'XMLHttpRequest',
              Origin: 'https://www.tefas.gov.tr',
              Referer: 'https://www.tefas.gov.tr/TarihselVeriler.aspx'
            };
            if (cerez) hdr.Cookie = cerez;
            const r = await fetch('https://www.tefas.gov.tr/api/DB/BindHistoryInfo', { method: 'POST', body, headers: hdr });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();
            for (const x of (d.data || [])) {
              const t = new Date(+x.TARIH).toISOString().slice(0, 10);
              const v = parseFloat(x.FIYAT);
              if (isFinite(v)) m.set(t, v);
            }
          } catch (e) { hatalar.push(d1 + '→' + d2 + ': ' + String(e.message || e).slice(0, 60)); }
        }
        const points = [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
        if (!points.length)
          return json({ error: 'veri yok — kod doğru mu? (' + tip + ' tipi denendi' +
            (tip === 'YAT' ? '; emeklilik fonuysa &tip=EMK ekle' : '') + ')',
            dilim: dilimler.length, hatalar: hatalar.slice(0, 3) }, 404);
        return json({ fon: fon.toUpperCase(), tip, points, dilim: dilimler.length,
          hatalar: hatalar.length ? hatalar.slice(0, 3) : undefined });
      }

      return json({
        durum: 'Finans Motoru Worker', surum: SURUM,
        uclar: ['/check', '/paket', '/seri?code=&start=', '/gruplar?kelime=', '/liste?grup=', '/yahoo?symbol=', '/tefas?fon=', '/temel?symbol=']
      });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};


