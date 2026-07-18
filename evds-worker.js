/* ════════════════════════════════════════════════════════════════
   FİNANS MOTORU — Veri Worker v2 (Cloudflare Workers)
   EVDS (TCMB) + Yahoo Finance + TEFAS vekili — CORS köprüsü

   KURULUM (bir kez):
   1. dash.cloudflare.com → Workers & Pages → Create Worker
   2. Bu dosyanın tamamını yapıştır → Deploy
   3. Settings → Variables → Add: EVDS_KEY = <EVDS API anahtarın>
      (anahtar: evds2.tcmb.gov.tr → üye ol → profil → API Anahtarı)
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

async function evdsSeri(code, start, end, env) {
  if (!env.EVDS_KEY) throw new Error('EVDS_KEY tanımlı değil — Worker ayarlarından ekle');
  const url = 'https://evds2.tcmb.gov.tr/service/evds/series=' + code +
    '&startDate=' + evdsTarih(start) + '&endDate=' + evdsTarih(end) + '&type=json';
  const r = await fetch(url, { headers: { key: env.EVDS_KEY } });
  if (!r.ok) throw new Error('EVDS HTTP ' + r.status + (r.status === 403 ? ' — anahtar geçersiz olabilir' : ''));
  const d = await r.json();
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
        return json({ durum: 'çalışıyor', anahtar: !!env.EVDS_KEY, seriler: out });
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

      /* ── /tefas: fon fiyat geçmişi — 2. teslimat kullanacak (uç deneysel) ── */
      if (yol === '/tefas') {
        const fon = url.searchParams.get('fon');
        if (!fon) return json({ error: 'fon parametresi gerekli (ör. AAK)' }, 400);
        const trTarih = iso => { const [y, m, d] = iso.split('-'); return d + '.' + m + '.' + y; };
        const start = url.searchParams.get('start') ||
          new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
        const end = url.searchParams.get('end') || bugun;
        const body = new URLSearchParams({
          fontip: 'YAT', fonkod: fon.toUpperCase(),
          bastarih: trTarih(start), bittarih: trTarih(end)
        });
        const r = await fetch('https://www.tefas.gov.tr/api/DB/BindHistoryInfo', {
          method: 'POST', body,
          headers: {
            'User-Agent': 'Mozilla/5.0 (finans-motoru)',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://www.tefas.gov.tr',
            Referer: 'https://www.tefas.gov.tr/TarihselVeriler.aspx'
          }
        });
        if (!r.ok) throw new Error('TEFAS HTTP ' + r.status + ' — uç değişmiş olabilir');
        const d = await r.json();
        const rows = d.data || [];
        const points = rows.map(x =>
          [new Date(+x.TARIH).toISOString().slice(0, 10), parseFloat(x.FIYAT)])
          .filter(p => isFinite(p[1]))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1));
        return json({ fon: fon.toUpperCase(), points });
      }

      return json({
        durum: 'Finans Motoru Worker v2',
        uclar: ['/check', '/paket', '/seri?code=&start=', '/yahoo?symbol=', '/tefas?fon=']
      });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};
