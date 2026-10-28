import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload.record;

    // Перевіряємо: надсилаємо сповіщення лише якщо прийом вимкнено (is_working === false)
    if (record && record.is_working === false) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const targetDate = record.date;
      const reason = record.reason || "Технічні причини";

      // Отримуємо людей, записаних на цей день, які очікують прийому та мають прив'язаний Telegram
      const { data: appointments, error } = await supabase
        .from("appointments")
        .select("telegram_chat_id, queue_number, full_name, appointment_time, booking_type")
        .eq("visit_date", targetDate)
        .in("status", ["waiting", "serving"])
        .not("telegram_chat_id", "is", null);

      if (error) throw error;

      // Розсилаємо сповіщення кожному
      for (const item of appointments || []) {
        const timeText = item.booking_type === "live" ? "Жива черга" : `Час: ${item.appointment_time?.slice(0, 5)}`;
        const messageText = 
          `⚠️ <b>Шановний(а) ${item.full_name}!</b>\n\n` +
          `Повідомляємо, що прийом у паспортному столі на <b>${targetDate}</b> (${timeText}, талон №${item.queue_number}) <b>скасовано</b>.\n\n` +
          `📌 <b>Причина:</b> ${reason}\n\n` +
          `Просимо вибачення за незручності. Будь ласка, оберіть іншу дату для запису на сайті після відновлення роботи.`;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: item.telegram_chat_id,
            text: messageText,
            parse_mode: "HTML",
          }),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
