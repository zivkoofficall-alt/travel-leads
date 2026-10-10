export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    const src = (req.headers.origin || req.headers.referer || '').toString();
    let host = '';
    try {
        host = new URL(src).hostname;
    }
    catch (e) {
        host = '';
    }
    const allowedHost = host === 'waylen.travel' || host === 'www.waylen.travel' ||
        /^waylen-travel[a-z0-9-]*\.vercel\.app$/.test(host);
    if (!allowedHost) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const ip = ((req.headers['x-forwarded-for'] || '').toString().split(',')[0] || 'unknown').trim();
    const now = Date.now();
    globalThis.__notifyHits = globalThis.__notifyHits || new Map();
    const hits = (globalThis.__notifyHits.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= 3) {
        return res.status(429).json({ ok: false, error: 'Too many requests' });
    }
    hits.push(now);
    globalThis.__notifyHits.set(ip, hits);
    if (globalThis.__notifyHits.size > 500)
        globalThis.__notifyHits.clear();
    try {
        const { name, contact_telegram, contact_phone, pet, message } = req.body || {};
        const nm = (name || '').toString().trim();
        if (nm.length < 2 || (!(contact_phone || '').toString().trim() && !(contact_telegram || '').toString().trim())) {
            return res.status(400).json({ ok: false, error: 'Invalid lead' });
        }
        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.warn('Telegram env vars not set — nothing to do');
            return res.status(200).json({ ok: true, skipped: true });
        }
        const cleanName = (name || '').toString().trim().slice(0, 200) || '—';
        const cleanTelegram = (contact_telegram || '').toString().trim().slice(0, 100);
        const cleanPhone = (contact_phone || '').toString().trim().slice(0, 40);
        const cleanPet = (pet || '').toString().trim().slice(0, 100);
        const cleanMessage = (message || '').toString().trim().slice(0, 2000);
        const text = `Новая заявка с лендинга\n\n` +
            `Имя: ${cleanName}\n` +
            (cleanPhone ? `Телефон: ${cleanPhone}\n` : '') +
            (cleanTelegram ? `Telegram: ${cleanTelegram}\n` : '') +
            (cleanPet ? `Питомец: ${cleanPet}\n` : '') +
            (cleanMessage ? `Комментарий: ${cleanMessage}\n` : '');
        const tgResp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
        });
        if (!tgResp.ok) {
            const tgErr = await tgResp.text();
            console.error('Telegram notify failed:', tgResp.status, tgErr);
            return res.status(502).json({ ok: false, error: 'Telegram send failed' });
        }
        return res.status(200).json({ ok: true });
    }
    catch (err) {
        console.error('notify-telegram unexpected error:', err);
        return res.status(500).json({ ok: false, error: 'Unexpected server error' });
    }
}
