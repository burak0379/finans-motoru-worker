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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
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

/* ── FM-27: /ai — Gemini üzerinden sentez yorumu ──
   Anahtar Cloudflare Secret'ta (GEMINI_KEY, aistudio.google.com'dan ücretsiz).
   Model GEMINI_MODEL env ile değiştirilebilir. Uç yalnız izinli Origin'lerden
   POST kabul eder — anahtar tarayıcıya asla inmez. */
const AI_IZINLI = ['burak0379.github.io', 'localhost', '127.0.0.1'];
const AI_SISTEM =
  'Sen temkinli, dürüst bir Türk finans analistisin. Kurallar: ' +
  '(1) YALNIZ sana verilen JSON verisindeki sayılardan konuş; dışarıdan bilgi, tahmin, şirket yorumu, verilmemiş rakam EKLEME. ' +
  '(2) Kişiye özel yatırım tavsiyesi verme; "al/sat" deme — veriler ne diyorsa onu aktar, çelişkileri sakla(ma)dan söyle. ' +
  '(3) 4-6 cümle, GÜNLÜK dille yaz — jargonu (bootstrap, medyan, kesit vb.) ya hiç kullanma ya bir kelimeyle açıkla; her kanalı en fazla bir cümleyle özetle, SON cümle tek bakışta genel durum olsun. Madde işareti kullanma. ' +
  '(4) Olasılıkları kesinlik gibi sunma; belirsizliği koru. ' +
  '(5) Veride null/eksik alan varsa o kanaldan söz ederken "veri yok" de, uydurma. ' +
  '(6) ÇIKTIN yalnızca akıcı Türkçe DÜZ YAZI tek paragraf olsun — JSON, süslü parantez, tırnaklı alan adı (ör. "_yuzde") ASLA yazma. ' +
  '(7) Parasal tutarları ve yüzdeleri DAİMA RAKAMLA yaz (örn. 1.250.000 TL, %42,5) — sayıları ASLA yazıyla ("otuz milyon") yazma.';

function geminiMetin(d){ /* yanıttan düz metin — saf, testte sınanır */
  const c = d && d.candidates && d.candidates[0];
  const parcalar = (c && c.content && c.content.parts) || [];
  const metin = parcalar.map(p => p.text || '').join('').trim();
  if(metin) return { metin };
  const engel = (d && d.promptFeedback && d.promptFeedback.blockReason) || (c && c.finishReason);
  return { hata: 'model metin döndürmedi' + (engel ? ' (' + engel + ')' : '') };
}

/* çıktı düz yazı mı yoksa veri yansıması mı? — saf, testte sınanır */
function aiYansimaMi(m){
  const s = String(m || '');
  return /"[a-zA-Z_]+"\s*:/.test(s) || /_yuzde/.test(s) || /^\s*[{\[]/.test(s) || s.length < 60;
}

/* ── Haber (v2.10): RSS'ten hisse başlıkları — anahtarsız, ücretsiz ── */
function rssMaddeler(xml, sinir){
  const maddeler = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  const coz = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  while((m = re.exec(xml)) && maddeler.length < (sinir || 15)){
    const b = m[1];
    const t = coz((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const d = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const kay = coz((b.match(/<(?:News:)?[Ss]ource[^>]*>([\s\S]*?)<\/(?:News:)?[Ss]ource>/) || [])[1]);
    if(!t) continue;
    let tarih = null; try{ const dd = new Date(d); if(!isNaN(dd)) tarih = dd.toISOString().slice(0, 10); }catch(e){}
    maddeler.push({ baslik: t, tarih, kaynak: kay || null });
  }
  return maddeler;
}
const HABER_CACHE = new Map(); // kod → {t, veri} (30 dk izolat önbelleği)

/* ── Groq (yedek sağlayıcı, v2.9): OpenAI uyumlu uç ── */
function groqMetin(d){
  const m = d && d.choices && d.choices[0] && d.choices[0].message;
  const metin = (m && m.content || '').trim();
  return metin ? { metin } : { hata: 'Groq metin döndürmedi' };
}
function groqModelSec(modeller){
  const adlar = (modeller || []).map(x => String(x.id || '')).filter(Boolean)
    .filter(n => !/whisper|tts|guard|vision|audio/i.test(n));
  if(!adlar.length) return null;
  const tercih = adlar.filter(n => /llama/i.test(n) && /versatile|70b/i.test(n)).sort().reverse()[0];
  return tercih || adlar.sort().reverse()[0];
}
let GROQ_MODEL_ON = null;
async function groqCalistir(env, sistem, kullanici){
  const uret = model => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.GROQ_KEY },
    body: JSON.stringify({ model,
      messages: [{ role: 'system', content: sistem }, { role: 'user', content: kullanici }],
      temperature: 0.4, max_tokens: 900 })
  });
  let model = env.GROQ_MODEL || GROQ_MODEL_ON || 'llama-3.3-70b-versatile';
  let r = await uret(model);
  if (r.status === 404 || r.status === 400) { /* model adı eskimiş olabilir → listeden seç */
    const lr = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': 'Bearer ' + env.GROQ_KEY } });
    if (lr.ok) {
      const ld = await lr.json();
      const yeniM = groqModelSec(ld.data);
      if (yeniM && yeniM !== model) { model = GROQ_MODEL_ON = yeniM; r = await uret(model); }
    }
  }
  const ham = await r.text();
  if (!r.ok) throw new Error('Groq HTTP ' + r.status + (r.status === 429 ? ' (kota)' : '') + ' · ' + ham.slice(0, 160).replace(/\s+/g, ' '));
  const s = groqMetin(JSON.parse(ham));
  if (s.hata) throw new Error(s.hata);
  return { metin: s.metin, model: 'groq:' + model };
}

/* model adları sık eskiyor (2.5-flash "no longer available" oldu) → Google'ın kendi
   listesinden güncel flash modelini keşfet; saf seçici testte sınanır */
let AI_MODEL = null; // izolat önbelleği
function geminiModelSec(modeller){
  const adaylar = (modeller || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(n => /flash/i.test(n) && !/lite|8b|tts|image|audio|live|exp|preview/i.test(n));
  if(!adaylar.length) return null;
  const sabitTakma = adaylar.find(n => /^gemini-flash-latest$/.test(n)) || adaylar.find(n => /flash-latest$/.test(n));
  if(sabitTakma) return sabitTakma;
  return adaylar.sort().reverse()[0]; // gemini-3... > gemini-2.5... sözlük sırasıyla
}
async function geminiCalistir(env, kullanici){
  const uret = async (model, dusunmesiz) => fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + env.GEMINI_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: AI_SISTEM }] },
      contents: [{ role: 'user', parts: [{ text: kullanici }] }],
      generationConfig: Object.assign(
        { temperature: 0.4, maxOutputTokens: 2000 },
        dusunmesiz ? {} : { thinkingConfig: { thinkingBudget: 0 } })
    })
  });
  let model = env.GEMINI_MODEL || AI_MODEL || 'gemini-flash-latest';
  let r = await uret(model, false);
  if (r.status === 400) r = await uret(model, true);
  if (r.status === 404) {
    model = AI_MODEL = await geminiModelBul(env.GEMINI_KEY);
    r = await uret(model, false);
    if (r.status === 400) r = await uret(model, true);
  }
  const ham = await r.text();
  if (!r.ok) throw new Error('Gemini HTTP ' + r.status + (r.status === 429 ? ' (günlük kota doldu)' : '') + ' · ' + ham.slice(0, 160).replace(/\s+/g, ' '));
  const s = geminiMetin(JSON.parse(ham));
  if (s.hata) throw new Error('Gemini: ' + s.hata);
  return { metin: s.metin, model };
}

async function geminiModelBul(key){
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key);
  if(!r.ok) throw new Error('model listesi alınamadı (HTTP ' + r.status + ')');
  const d = await r.json();
  const m = geminiModelSec(d.models);
  if(!m) throw new Error('listede uygun flash modeli yok');
  return m;
}


const SURUM = '2.12.1-coklu';

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const yol = url.pathname.replace(/\/+$/, '') || '/';
    const bugun = new Date().toISOString().slice(0, 10);

    try {
      /* ── /ai: sentez yorumu (v2.9 — sağlayıcı şelalesi: Gemini → Groq) ── */
      if (yol === '/ai') {
        if (req.method === 'GET')
          return json({ uc: '/ai', gemini: !!env.GEMINI_KEY, groq: !!env.GROQ_KEY,
            not: 'POST {baglam, gorev}; Gemini kota dolarsa GROQ_KEY tanımlıysa Groq devralır (console.groq.com, ücretsiz)' });
        const origin = req.headers.get('Origin') || '';
        if (origin && !AI_IZINLI.some(o => origin.includes(o)))
          return json({ error: 'bu kaynaktan /ai kullanımı kapalı' }, 403);
        if (!env.GEMINI_KEY && !env.GROQ_KEY)
          return json({ error: 'AI anahtarı yok — Cloudflare Secrets: GEMINI_KEY (aistudio.google.com) ve/veya GROQ_KEY (console.groq.com), ikisi de ücretsiz' }, 500);
        let govde;
        try { govde = await req.json(); } catch (e) { return json({ error: 'JSON gövde bekleniyor' }, 400); }
        const baglam = typeof govde.baglam === 'string' ? govde.baglam : JSON.stringify(govde.baglam || {});
        const gorev = String(govde.gorev || 'Bu verileri değerlendir.').slice(0, 500);
        if (baglam.length > 20000) return json({ error: 'bağlam çok büyük' }, 400);
        const kullanici = 'GÖREV: ' + gorev + '\n\nVERİ (JSON):\n' + baglam + '\n\nYANIT BİÇİMİ: yalnız düz yazı, tek paragraf. Veriyi geri yazma.';
        const sertKullanici = 'Aşağıdaki veriyi KOPYALAMADAN, tek paragraf akıcı Türkçe düz yazıyla yorumla. JSON yazmak YASAK.\n\n' + baglam;
        const hatalar = [];
        /* 1. basamak: Gemini */
        if (env.GEMINI_KEY) {
          try {
            let s = await geminiCalistir(env, kullanici);
            if (aiYansimaMi(s.metin)) s = await geminiCalistir(env, sertKullanici);
            if (!aiYansimaMi(s.metin)) return json({ metin: s.metin, model: s.model + ' · w' + SURUM });
            hatalar.push('Gemini: veriyi yansıttı');
          } catch (e) { hatalar.push(String(e.message || e)); }
        }
        /* 2. basamak: Groq */
        if (env.GROQ_KEY) {
          try {
            let s = await groqCalistir(env, AI_SISTEM, kullanici);
            if (aiYansimaMi(s.metin)) s = await groqCalistir(env, AI_SISTEM, sertKullanici);
            if (!aiYansimaMi(s.metin)) return json({ metin: s.metin, model: s.model + ' · w' + SURUM });
            hatalar.push('Groq: veriyi yansıttı');
          } catch (e) { hatalar.push(String(e.message || e)); }
        }
        return json({ error: hatalar.join(' — ') || 'sağlayıcı yok', ipucu: env.GROQ_KEY ? undefined :
          'Gemini kotası dolduysa: console.groq.com ücretsiz anahtar → Cloudflare GROQ_KEY Secret — worker kendiliğinden devreder' }, 502);
      }

      /* ── /haber: hisse haber başlıkları (v2.10) — kotasız kanal ── */
      if (yol === '/haber') {
        const kod = (url.searchParams.get('symbol') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (!kod) return json({ error: 'symbol gerekli (ör. /haber?symbol=THYAO)' }, 400);
        const c = HABER_CACHE.get(kod);
        if (c && Date.now() - c.t < 30*60*1000) return json(c.veri);
        const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'tr-TR,tr;q=0.9' };
        let maddeler = [], kaynakAdi = '', hatalar = [];
        /* 1. kaynak: Google News RSS — veri merkezi IP'lerinden bazen 429/403 döner */
        try{
          const q = encodeURIComponent('"' + kod + '" hisse');
          const r = await fetch('https://news.google.com/rss/search?q=' + q + '&hl=tr&gl=TR&ceid=TR:tr', { headers: UA });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          maddeler = rssMaddeler(await r.text(), 15);
          if (maddeler.length) kaynakAdi = 'genel arama A';
          else hatalar.push('A: başlık dönmedi');
        }catch(e){ hatalar.push('A: ' + (e.message || e)); }
        /* 2. kaynak (yedek): Bing News RSS — sunucu isteklerine daha hoşgörülü */
        if (!maddeler.length) {
          try{
            const r2 = await fetch('https://www.bing.com/news/search?q=' + encodeURIComponent(kod + ' hisse') +
              '&format=rss&setmkt=tr-TR&setlang=tr', { headers: UA });
            if (!r2.ok) throw new Error('HTTP ' + r2.status);
            maddeler = rssMaddeler(await r2.text(), 15);
            if (maddeler.length) kaynakAdi = 'genel arama B';
            else hatalar.push('B: başlık dönmedi');
          }catch(e){ hatalar.push('B: ' + (e.message || e)); }
        }
        if (!maddeler.length) return json({ error: 'haber kaynakları yanıt vermedi (' + hatalar.join(' · ') + ')' }, 502);
        /* v2.11: tazelik — yeniye sırala, son 60 günle sınırla; hepsi eskiyse dürüst notla en yenileri ver */
        maddeler.sort((a, b) => (b.tarih || '0') < (a.tarih || '0') ? -1 : 1);
        const esikT = new Date(Date.now() - 60*864e5).toISOString().slice(0, 10);
        const taze = maddeler.filter(m => m.tarih && m.tarih >= esikT);
        let notEk = '';
        if (taze.length) maddeler = taze;
        else { maddeler = maddeler.slice(0, 5); notEk = ' · son 60 günde başlık yok, en son bulunanlar'; }
        const veri = { kod, basliklar: maddeler, not: kaynakAdi + ' — başlık düzeyi' + notEk };
        HABER_CACHE.set(kod, { t: Date.now(), veri });
        return json(veri);
      }

      /* ── /yedek: bulut eşitleme (v2.12 — ÇOK KULLANICILI) ──
         Her parola kendi kasasını açar: KV anahtarı = SHA-256(parola).
         Parolanın kendisi hiçbir yerde SAKLANMAZ; özet geri çevrilemez.
         Farklı parola = farklı kasa → kimse kimseninkini göremez/ezemez. */
      if (yol === '/yedek') {
        if (!env.FM_KV)
          return json({ error: 'KV bağlı değil — kurulum: Cloudflare panel → Storage & Databases → KV → Create namespace (FM_DEPO) + wrangler yapılandırmasında FM_KV bağlaması' }, 500);
        const anahtar = req.headers.get('X-Sync-Key') || url.searchParams.get('k') || '';
        if (anahtar.length < 6) return json({ error: 'eşitleme parolası en az 6 karakter olmalı' }, 400);
        const ham = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fm-yedek:' + anahtar));
        const kimlik = [...new Uint8Array(ham)].map(b => b.toString(16).padStart(2, '0')).join('');
        const K = 'yedek:' + kimlik, M = 'yedekMeta:' + kimlik;
        if (req.method === 'PUT' || req.method === 'POST') {
          const govde = await req.text();
          if (!govde || govde.length < 2) return json({ error: 'boş yedek' }, 400);
          if (govde.length > 20*1024*1024) return json({ error: 'yedek çok büyük (20MB sınırı)' }, 400);
          await env.FM_KV.put(K, govde);
          const meta = { t: new Date().toISOString(), boyutKB: Math.round(govde.length/1024) };
          await env.FM_KV.put(M, JSON.stringify(meta));
          return json({ ok: true, ...meta });
        }
        if (url.searchParams.get('meta')) {
          const m = await env.FM_KV.get(M);
          return json(m ? JSON.parse(m) : { bos: true });
        }
        let v = await env.FM_KV.get(K);
        /* geçiş: v2.11'in tek kasası — eski SYNC_KEY sahibi ilk okuyuşta oradan devralır */
        if (v === null && env.SYNC_KEY && anahtar === env.SYNC_KEY) v = await env.FM_KV.get('yedek');
        if (v === null) return json({ error: 'bu parolanın kasası boş — önce dolu cihazdan ☁ Buluta Yedekle' }, 404);
        return new Response(v, { headers: CORS });
      }

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

      /* ── /tefaskesif: TEFAS sayfa kaynağından API yollarını keşfet (v2.7.1) ──
         BindHistoryInfo 404 dönünce eklendi: tarihsel veri sayfasının HTML/JS'i
         içinde geçen /api/... yolları ve POST alan adları dökülür — yeni kontratı
         buradan okuyup /tefas'ı düzeltiriz (EVDS keşfiyle aynı yöntem). */
      if (yol === '/tefaskesif') {
        const UA2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
        const adaylar = [
          'https://www.tefas.gov.tr/TarihselVeriler.aspx',
          'https://www.tefas.gov.tr/FonKarsilastirma.aspx',
          'https://www.fundturkey.com.tr/TarihselVeriler.aspx',
          'https://www.tefas.gov.tr/'
        ];
        const out = [];
        for (const adres of adaylar) {
          try {
            const r = await fetch(adres, { headers: { 'User-Agent': UA2 }, redirect: 'follow' });
            const g = await r.text();
            const apiler = [...new Set((g.match(/["'\(](\/?api\/[A-Za-z0-9_\/.\-]+)/g) || [])
              .map(s => s.replace(/^["'\(]/, '')))];
            const ajaxlar = [...new Set((g.match(/url\s*:\s*["'][^"']+["']/g) || []).map(s => s.slice(0, 120)))];
            const alanlar = [...new Set((g.match(/name=["'][a-zA-Z]{3,20}["']/g) || []).map(s => s.slice(6, -1)))].slice(0, 40);
            const scriptler = [...new Set((g.match(/src=["'][^"']*\.js[^"']*["']/g) || []).map(s => s.slice(5, -1)))].slice(0, 15);
            out.push({ adres, http: r.status, sonUrl: r.url, boyut: g.length,
              apiYollari: apiler, ajaxUrller: ajaxlar.slice(0, 15), formAlanlari: alanlar, scriptler });
          } catch (e) { out.push({ adres, hata: String(e.message || e) }); }
        }
        return json({ not: 'apiYollari + ajaxUrller yeni kontratın adayları; scriptler içinde de olabilir — /tefaskesif?js=<script-yolu> ile bir betiği tara', sayfalar: out });
      }
      /* betik içi tarama: /tefaskesif zaten yol eşleşti — js parametresi varsa üstteki yerine bunu çalıştır */
      if (yol === '/tefasjs') {
        const js = url.searchParams.get('js');
        if (!js) return json({ error: 'js parametresi gerekli (tam URL ya da /path.js)' }, 400);
        const tam = js.startsWith('http') ? js : 'https://www.tefas.gov.tr' + (js.startsWith('/') ? js : '/' + js);
        const r = await fetch(tam, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const g = await r.text();
        const apiler = [...new Set((g.match(/["'](\/?api\/[A-Za-z0-9_\/.\-]+)["']/g) || []).map(s => s.slice(1, -1)))];
        const urller = [...new Set((g.match(/url\s*:\s*["'][^"']+["']/g) || []).map(s => s.slice(0, 150)))];
        const datalar = [...new Set((g.match(/data\s*:\s*\{[^}]{0,300}\}/g) || []).map(s => s.slice(0, 300)))].slice(0, 10);
        return json({ js: tam, http: r.status, boyut: g.length, apiYollari: apiler, urller: urller.slice(0, 20), postGovdeleri: datalar });
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
        const evler = ['https://www.tefas.gov.tr', 'https://www.fundturkey.com.tr'];
        let ev = null; // çalışan ev sahibi (ilk dilimde bulunur)
        const m = new Map(); const hatalar = [];
        const dilimCek = async (host, d1, d2) => {
          const body = new URLSearchParams({
            fontip: tip, fonkod: fon.toUpperCase(),
            bastarih: trTarih(d1), bittarih: trTarih(d2)
          });
          const hdr = {
            'User-Agent': UA2,
            'X-Requested-With': 'XMLHttpRequest',
            Origin: host,
            Referer: host + '/TarihselVeriler.aspx'
          };
          if (cerez) hdr.Cookie = cerez;
          const r = await fetch(host + '/api/DB/BindHistoryInfo', { method: 'POST', body, headers: hdr });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return (await r.json()).data || [];
        };
        for (const [d1, d2] of dilimler) {
          try {
            let rows = null;
            if (!ev) { /* ilk dilim: ev sahiplerini sırayla dene */
              let sonH = null;
              for (const h of evler) {
                try { rows = await dilimCek(h, d1, d2); ev = h; break; }
                catch (e) { sonH = h.replace('https://www.', '') + ' ' + String(e.message || e); }
              }
              if (!ev) throw new Error(sonH || 'hiçbir ev sahibi yanıt vermedi');
            } else {
              rows = await dilimCek(ev, d1, d2);
            }
            for (const x of rows) {
              const t = new Date(+x.TARIH).toISOString().slice(0, 10);
              const v = parseFloat(x.FIYAT);
              if (isFinite(v)) m.set(t, v);
            }
          } catch (e) { hatalar.push(d1 + '→' + d2 + ': ' + String(e.message || e).slice(0, 70)); }
        }
        const points = [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
        if (!points.length)
          return json({ error: 'veri yok — kod doğru mu? (' + tip + ' tipi denendi' +
            (tip === 'YAT' ? '; emeklilik fonuysa &tip=EMK ekle' : '') +
            '). Uç 404 veriyorsa kontrat değişmiş demektir: /tefaskesif çıktısını getir',
            dilim: dilimler.length, hatalar: hatalar.slice(0, 3) }, 404);
        return json({ fon: fon.toUpperCase(), tip, ev, points, dilim: dilimler.length,
          hatalar: hatalar.length ? hatalar.slice(0, 3) : undefined });
      }

      return json({
        durum: 'Finans Motoru Worker', surum: SURUM,
        uclar: ['/ai', '/haber?symbol=', '/yedek', '/check', '/paket', '/seri?code=&start=', '/gruplar?kelime=', '/liste?grup=', '/yahoo?symbol=', '/tefas?fon=', '/tefaskesif', '/tefasjs?js=', '/temel?symbol=']
      });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};


