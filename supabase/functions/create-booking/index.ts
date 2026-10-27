import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json, cleanText, sendTelegram } from '../_shared/http.ts';
const allowedServices = ['ID-картка','Закордонний паспорт','Реєстрація місця проживання','Зняття з реєстрації місця проживання','Вклеювання фото','Довідки','Консультація'];
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json();
    const full_name = cleanText(body.full_name, 150);
    const phone = cleanText(body.phone, 30);
    const telegram_code = cleanText(body.telegram_code, 12).toUpperCase() || null;
    const telegram_username = cleanText(body.telegram_username, 64).replace(/^@/, '') || null;
    const service = cleanText(body.service, 100);
    const visit_date = cleanText(body.visit_date, 10);
    const booking_type = cleanText(body.booking_type, 20);
    const appointment_time = body.appointment_time ? cleanText(body.appointment_time, 5) : null;
    const notes = cleanText(body.notes, 300);
    if (full_name.length < 3 || phone.length < 7 || !allowedServices.includes(service) || !/^\d{4}-\d{2}-\d{2}$/.test(visit_date)) return json({ error: 'Перевірте ПІБ, телефон, послугу та дату.' }, 400);
    if (!['scheduled', 'live'].includes(booking_type)) return json({ error: 'Оберіть формат черги.' }, 400);
    if (booking_type === 'scheduled' && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(appointment_time || '')) return json({ error: 'Оберіть доступний час.' }, 400);
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await db.rpc('create_appointment', {
      p_full_name: full_name, p_phone: phone, p_telegram_code: telegram_code, p_telegram_username: telegram_username, p_service: service,
      p_visit_date: visit_date, p_booking_type: booking_type, p_appointment_time: appointment_time, p_notes: notes,
    });
    if (error) {
      const raw = error.message || '';
      const expected = ['ПІБ','телефон','послугу','минулу дату','робочі дні','час','Жива черга','Код Telegram','Код Telegram','недоступний','години прийому','формат запису'];
      return json({ error: expected.some(s => raw.includes(s)) ? raw : 'Не вдалося створити запис. Оновіть сторінку та спробуйте ще раз.' }, 400);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Booking RPC did not return a row');
    const timeLabel = row.booking_type === 'live' ? 'Жива черга (сьогодні)' : `Час прийому: ${row.appointment_time}`;
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const staffChatIds = (Deno.env.get('TELEGRAM_STAFF_CHAT_IDS') || '').split(',').map((x) => x.trim()).filter(Boolean);
    // Staff notifications intentionally omit name and phone; full details are available after login in the protected dashboard.
    let telegramNotified = false;
    if (botToken) {
      for (const chatId of staffChatIds) await sendTelegram(botToken, chatId, `Новий запис до паспортного столу\n№ ${row.queue_number} · ${row.visit_date}\n${timeLabel}\nПослуга: ${row.service}\nПерегляньте деталі в захищеному кабінеті працівника.`);
      if (row.telegram_chat_id) telegramNotified = await sendTelegram(botToken, row.telegram_chat_id, `Ваш запис до паспортного столу створено.\nНомер: № ${row.queue_number}\nДата: ${row.visit_date}\n${timeLabel}\nПослуга: ${row.service}\nЗбережіть цей номер. Якщо плани змінилися, зв’яжіться з паспортним столом.`);
    }
    return json({ id: row.id, queue_number: row.queue_number, visit_date: row.visit_date, booking_type: row.booking_type, appointment_time: row.appointment_time, service: row.service, telegram_linked: Boolean(row.telegram_chat_id), telegram_notified: telegramNotified });
  } catch (e) {
    console.error('create-booking', e);
    return json({ error: 'Внутрішня помилка під час створення запису.' }, 500);
  }
});
