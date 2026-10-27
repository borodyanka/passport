import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/http.ts';
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json();
    const date = String(body.visit_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Некоректна дата.' }, 400);
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await db.rpc('get_available_slots', { p_date: date });
    if (error) throw error;
    return json({ slots: (data || []).map((row: { slot_time: string }) => row.slot_time) });
  } catch (e) {
    console.error('available-slots', e);
    return json({ error: 'Не вдалося завантажити вільний час. Спробуйте ще раз.' }, 500);
  }
});
