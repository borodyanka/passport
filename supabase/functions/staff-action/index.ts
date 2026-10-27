import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json, sendTelegram } from '../_shared/http.ts';
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'Потрібно увійти в систему.' }, 401);
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData, error: userError } = await userClient.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: 'Сесія недійсна. Увійдіть ще раз.' }, 401);
    const admin = createClient(url, serviceKey);
    const { data: staffRecord, error: staffError } = await admin.from('staff').select('user_id').eq('user_id', userData.user.id).maybeSingle();
    if (staffError || !staffRecord) return json({ error: 'Цей обліковий запис не має доступу працівника.' }, 403);
    const body = await req.json();
    const id = String(body.id || '');
    const action = String(body.action || '');
    const statusMap: Record<string, string> = { call: 'serving', complete: 'completed', cancel: 'cancelled' };
    const nextStatus = statusMap[action];
    if (!id || !nextStatus) return json({ error: 'Невідома дія.' }, 400);
    const { data: record, error: readError } = await admin.from('appointments').select('id,queue_number,visit_date,booking_type,appointment_time,service,telegram_chat_id,status').eq('id', id).maybeSingle();
    if (readError || !record) return json({ error: 'Запис не знайдено.' }, 404);
    if (action === 'call' && record.status !== 'waiting') return json({ error: 'Можна викликати лише запис зі статусом «Очікує».' }, 409);
    if (action === 'complete' && record.status !== 'serving') return json({ error: 'Завершити можна лише запис, який зараз на прийомі.' }, 409);
    if (action === 'cancel' && ['completed','cancelled'].includes(record.status)) return json({ error: 'Цей запис уже завершено або скасовано.' }, 409);
    const { error: updateError } = await admin.from('appointments').update({ status: nextStatus }).eq('id', id);
    if (updateError) throw updateError;
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (token && record.telegram_chat_id) {
      const when = record.booking_type === 'live' ? `Номер у живій черзі: № ${record.queue_number}` : `Час прийому: ${String(record.appointment_time || '').slice(0,5)}`;
      if (action === 'call') await sendTelegram(token, record.telegram_chat_id, `Ваша черга підходить. Будь ласка, підійдіть до працівника паспортного столу.\n№ ${record.queue_number}\n${when}\nПослуга: ${record.service}`);
      else if (action === 'complete') await sendTelegram(token, record.telegram_chat_id, `Ваш прийом завершено. Дякуємо за звернення до паспортного столу Бородянської селищної ради.`);
      else await sendTelegram(token, record.telegram_chat_id, `Ваш запис № ${record.queue_number} скасовано. За потреби створіть новий запис на сайті або зверніться до паспортного столу.`);
    }
    if (action === 'call' && record.booking_type === 'live' && token) {
      // Notify the next two waiting live-queue tickets that they should be ready; do not expose names to Telegram.
      const { data: nextItems } = await admin.from('appointments').select('id,queue_number,telegram_chat_id,telegram_reminded_at').eq('visit_date', record.visit_date).eq('booking_type','live').eq('status','waiting').gt('queue_number', record.queue_number).order('queue_number').limit(2);
      for (const item of (nextItems || [])) {
        if (item.telegram_chat_id && !item.telegram_reminded_at) {
          await sendTelegram(token, item.telegram_chat_id, `Будьте напоготові: ваша черга наближається.\nВаш номер: № ${item.queue_number}\nСтежте за статусом у публічній черзі.`);
          await admin.from('appointments').update({ telegram_reminded_at: new Date().toISOString() }).eq('id', item.id).is('telegram_reminded_at', null);
        }
      }
    }
    return json({ ok: true, status: nextStatus, message: action === 'call' ? 'Відвідувача викликано. Telegram-сповіщення надіслано, якщо акаунт прив’язаний.' : action === 'complete' ? 'Прийом завершено.' : 'Запис скасовано.' });
  } catch (e) {
    console.error('staff-action', e);
    return json({ error: 'Не вдалося змінити статус запису.' }, 500);
  }
});
