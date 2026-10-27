export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });
export function cleanText(value: unknown, max = 300): string {
  return String(value ?? '').trim().slice(0, max);
}
export async function sendTelegram(token: string, chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3800), disable_web_page_preview: true }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) console.error('Telegram sendMessage failed', payload.description || response.status);
  return Boolean(response.ok && payload.ok);
}
