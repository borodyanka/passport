import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json, sendTelegram } from '../_shared/http.ts';
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint8Array(8); crypto.getRandomValues(values);
  return Array.from(values, value => chars[value % chars.length]).join('');
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!expectedSecret || req.headers.get('x-telegram-bot-api-secret-token') !== expectedSecret) return json({ error: 'Forbidden' }, 403);
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return json({ error: 'Bot is not configured' }, 503);
  try {
    const update = await req.json();
    const message = update?.message;
    const text = String(message?.text || '').trim();
    const chatId = message?.chat?.id;
    if (!chatId || !text) return json({ ok: true });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    if (text === '/start' || text.startsWith('/start ')) {
      const code = makeCode();
      const username = message?.from?.username ? String(message.from.username).slice(0, 64) : null;
      const telegramUserId = message?.from?.id ? String(message.from.id) : null;
      const { error } = await db.from('telegram_link_codes').insert({ code, chat_id: String(chatId), telegram_user_id: telegramUserId, telegram_username: username, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
      if (error) throw error;
      await sendTelegram(token, String(chatId), `Вітаємо! Щоб отримувати повідомлення про запис, скопіюйте цей одноразовий код у форму на сайті паспортного столу:\n\n${code}\n\nКод діє 10 хвилин і може бути використаний лише один раз. Не передавайте його іншим людям.`);
    } else if (text === '/help') {
      await sendTelegram(token, String(chatId), 'Як підключити сповіщення:\n1. Надішліть /start.\n2. Скопіюйте одноразовий код з відповіді бота.\n3. Вставте його в поле «Код Telegram» на сайті під час запису.\nКод діє 10 хвилин і використовується один раз.');
    } else {
      await sendTelegram(token, String(chatId), 'Для прив’язки Telegram до запису надішліть /start. Для інструкції — /help.');
    }
    return json({ ok: true });
  } catch (e) {
    console.error('telegram-webhook', e);
    // Return 200 to avoid repeated delivery of malformed/unsupported updates; details remain in server logs.
    return json({ ok: true });
  }
});
