// api/notify-telegram.js
// Vercel Serverless Function. Заявка к этому моменту уже сохранена
// в Supabase напрямую с фронтенда (публичным ключом, безопасно для браузера).
// Эта функция только шлёт уведомление в Telegram — единственное,
// для чего нужен секретный токен, поэтому вынесено на сервер.
//
// Переменные окружения (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   TELEGRAM_CHAT_ID   — id чата/канала, куда слать уведомления

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { name, contact, pet, message } = req.body || {};

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.warn('Telegram env vars not set — nothing to do');
      return res.status(200).json({ ok: true, skipped: true });
    }

    const cleanName = (name || '').toString().trim().slice(0, 200) || '—';
    const cleanContact = (contact || '').toString().trim().slice(0, 200) || '—';
    const cleanPet = (pet || '').toString().trim().slice(0, 100);
    const cleanMessage = (message || '').toString().trim().slice(0, 2000);

    const text =
      `🐾 Новая заявка с лендинга\n\n` +
      `Имя: ${cleanName}\n` +
      `Контакт: ${cleanContact}\n` +
      (cleanPet ? `Питомец: ${cleanPet}\n` : '') +
      (cleanMessage ? `Комментарий: ${cleanMessage}\n` : '');

    const tgResp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      }
    );

    if (!tgResp.ok) {
      const tgErr = await tgResp.text();
      console.error('Telegram notify failed:', tgResp.status, tgErr);
      return res.status(502).json({ ok: false, error: 'Telegram send failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-telegram unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error' });
  }
}
