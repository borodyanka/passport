import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { CalendarDays, Clock3, Bell, ShieldCheck, ListOrdered, ArrowRight, RefreshCw, Send, CalendarCheck, Users, Info, LogIn, LogOut, ExternalLink } from 'lucide-react';
import { SERVICES, OFFICE, STATUS_LABELS } from './config.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const CREATE_URL = import.meta.env.VITE_CREATE_BOOKING_URL;
const SLOTS_URL = import.meta.env.VITE_AVAILABLE_SLOTS_URL;
const STAFF_ACTION_URL = import.meta.env.VITE_STAFF_ACTION_URL;
const BOT_LINK = import.meta.env.VITE_TELEGRAM_BOT_LINK || '';

function kyivDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('uk-UA', { dateStyle: 'long', timeZone: 'Europe/Kyiv' }).format(new Date(`${value}T12:00:00`));
}
function configMissing() { return !supabase || !CREATE_URL || !SLOTS_URL || !STAFF_ACTION_URL; }

export default function App() {
  const [tab, setTab] = useState('book');
  const [mode, setMode] = useState('scheduled');
  const [visitDate, setVisitDate] = useState(kyivDate());
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [publicQueue, setPublicQueue] = useState([]);
  const [staffQueue, setStaffQueue] = useState([]);
  const [staffDate, setStaffDate] = useState(kyivDate());
  const [form, setForm] = useState({ full_name: '', phone: '', telegram_username: '', telegram_code: '', service: SERVICES[0], visit_date: kyivDate(), booking_type: 'scheduled', appointment_time: '', notes: '' });
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [session, setSession] = useState(null);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [staffLoading, setStaffLoading] = useState(false);

  const basePath = import.meta.env.BASE_URL;
  const updateForm = (key, value) => setForm(old => ({ ...old, [key]: value }));

  const invoke = useCallback(async (url, body, token = SUPABASE_KEY) => {
    if (!url) throw new Error('Не налаштовано адресу серверної функції. Перевірте README.md.');
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    let payload = {};
    try { payload = await response.json(); } catch { /* server error can return non-JSON */ }
    if (!response.ok) throw new Error(payload.error || 'Помилка серверної функції.');
    return payload;
  }, []);

  const loadSlots = useCallback(async (date) => {
    if (!SLOTS_URL) { setSlots([]); return; }
    setSlotsLoading(true);
    try {
      const result = await invoke(SLOTS_URL, { visit_date: date });
      setSlots(result.slots || []);
      setForm(old => ({ ...old, appointment_time: (result.slots || []).includes(old.appointment_time) ? old.appointment_time : (result.slots || [])[0] || '' }));
    } catch (e) { setSlots([]); setError(e.message); }
    finally { setSlotsLoading(false); }
  }, [invoke]);

  const loadPublicQueue = useCallback(async (date = visitDate) => {
    if (!supabase) return;
    const { data, error: queryError } = await supabase.from('public_queue').select('queue_number,visit_date,status,booking_type,appointment_time,created_at').eq('visit_date', date).order('queue_number', { ascending: true });
    if (queryError) setError(queryError.message); else setPublicQueue(data || []);
  }, [visitDate]);

  const loadStaffQueue = useCallback(async (date = staffDate) => {
    if (!supabase) return;
    setStaffLoading(true);
    const { data, error: queryError } = await supabase.from('appointments').select('id,queue_number,full_name,phone,telegram_username,service,visit_date,booking_type,appointment_time,notes,status,created_at,telegram_chat_id').eq('visit_date', date).order('queue_number', { ascending: true });
    if (queryError) setError(queryError.message); else setStaffQueue(data || []);
    setStaffLoading(false);
  }, [staffDate]);

  useEffect(() => { if (mode === 'scheduled') loadSlots(form.visit_date); }, [mode, form.visit_date, loadSlots]);
  useEffect(() => { if (!supabase) return undefined; supabase.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = supabase.auth.onAuthStateChange((_event, value) => setSession(value)); return () => data.subscription.unsubscribe(); }, []);
  useEffect(() => { loadPublicQueue(); const timer = setInterval(() => loadPublicQueue(), 20000); return () => clearInterval(timer); }, [loadPublicQueue]);
  useEffect(() => { if (session && tab === 'staff') loadStaffQueue(); }, [session, tab, staffDate, loadStaffQueue]);

  async function submitBooking(event) {
    event.preventDefault(); setError(''); setMessage(''); setReceipt(null);
    if (configMissing()) { setError('Сайт ще не підключено до Supabase. Виконайте налаштування з README.md.'); return; }
    if (form.full_name.trim().length < 3 || form.phone.trim().length < 7) { setError('Вкажіть повне ПІБ та коректний номер телефону.'); return; }
    if (form.booking_type === 'scheduled' && !form.appointment_time) { setError('Оберіть вільний час прийому.'); return; }
    setBusy(true);
    try {
      const payload = await invoke(CREATE_URL, { ...form, booking_type: mode, visit_date: form.visit_date, appointment_time: mode === 'scheduled' ? form.appointment_time : null, telegram_username: form.telegram_username.trim().replace(/^@/, '').slice(0, 64) || null, telegram_code: form.telegram_code.trim().toUpperCase() || null });
      setReceipt(payload);
      setMessage(payload.telegram_notified ? 'Запис створено. Telegram-підтвердження надіслано.' : payload.telegram_linked ? 'Запис створено, але Telegram-підтвердження не вдалося доставити. Перевірте налаштування бота.' : 'Запис створено. Для Telegram-сповіщень відкрийте бота, надішліть /start і введіть код у форму під час наступного запису.');
      await loadPublicQueue(form.visit_date);
      if (mode === 'live') setForm(old => ({ ...old, full_name: '', phone: '', telegram_username: '', telegram_code: '', notes: '' }));
    } catch (e) { setError(e.message || 'Не вдалося створити запис.'); }
    finally { setBusy(false); }
  }

  async function signIn(event) {
    event.preventDefault(); setError('');
    if (!supabase) { setError('Supabase не налаштовано.'); return; }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: login.email, password: login.password });
    if (signInError) setError('Не вдалося увійти. Перевірте службову пошту та пароль.');
  }

  async function staffAction(id, action) {
    setError(''); setMessage('');
    if (!session?.access_token) { setError('Сесія завершилася. Увійдіть ще раз.'); return; }
    try {
      const result = await invoke(STAFF_ACTION_URL, { id, action }, session.access_token);
      setMessage(result.message || 'Статус оновлено.');
      await Promise.all([loadStaffQueue(staffDate), loadPublicQueue(staffDate)]);
    } catch (e) { setError(e.message); }
  }

  const filteredQueue = useMemo(() => publicQueue.filter(item => item.status !== 'cancelled'), [publicQueue]);
  const displayTime = (item) => item.booking_type === 'live' ? 'Жива черга' : (item.appointment_time ? item.appointment_time.slice(0, 5) : 'Час не вказано');

  return <div className="page">
    <header className="header">
      <div className="brand"><img className="crest" src={`${basePath}gerb-borodianka.png`} alt="Герб Бородянської селищної ради"/><div><span className="overline">БОРОДЯНСЬКА СЕЛИЩНА РАДА</span><h1>Електронна черга</h1><p>Паспортний стіл</p></div></div>
      <div className="online"><span/> Онлайн-запис</div>
    </header>
    <main>
      <section className="hero"><div><div className="hero-kicker">ЗРУЧНО · ПРОЗОРО · У ЗРУЧНИЙ ЧАС</div><h2>Запишіться на прийом<br/>у кілька кроків</h2><p>Оберіть послугу, дату та доступний час або скористайтеся живою чергою. Telegram допоможе отримати підтвердження та сповіщення.</p></div><div className="hero-art"><CalendarCheck size={48}/><span>1190</span></div></section>
      <nav className="tabs" aria-label="Розділи"><button className={tab === 'book' ? 'selected' : ''} onClick={() => { setTab('book'); setError(''); }}>Записатися</button><button className={tab === 'queue' ? 'selected' : ''} onClick={() => { setTab('queue'); setError(''); loadPublicQueue(); }}>Публічна черга</button><button className={tab === 'staff' ? 'selected' : ''} onClick={() => { setTab('staff'); setError(''); }}>Кабінет працівника</button></nav>

      {tab === 'book' && <section className="panel">
        <div className="section-head"><div className="symbol"><CalendarDays/></div><div><h3>Новий запис</h3><p>Оберіть формат прийому та заповніть поля</p></div></div>
        <div className="mode-switch"><button className={mode === 'scheduled' ? 'active' : ''} onClick={() => { setMode('scheduled'); updateForm('booking_type', 'scheduled'); }}> <CalendarCheck size={18}/> На конкретний час</button><button className={mode === 'live' ? 'active' : ''} onClick={() => { setMode('live'); updateForm('booking_type', 'live'); updateForm('visit_date', kyivDate()); }}> <ListOrdered size={18}/> Жива черга сьогодні</button></div>
        <form onSubmit={submitBooking}>
          <div className="form-grid">
            <label>ПІБ повністю *<input required autoComplete="name" maxLength="150" value={form.full_name} onChange={e => updateForm('full_name', e.target.value)} placeholder="Прізвище Ім’я По батькові"/></label>
            <label>Номер телефону *<input required type="tel" autoComplete="tel" maxLength="30" value={form.phone} onChange={e => updateForm('phone', e.target.value)} placeholder="+380…"/></label>
            <label>Послуга *<select value={form.service} onChange={e => updateForm('service', e.target.value)}>{SERVICES.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
            <label>Дата прийому *<input type="date" required min={kyivDate()} disabled={mode === 'live'} value={form.visit_date} onChange={e => updateForm('visit_date', e.target.value)}/>{mode === 'live' && <small>Для живої черги використовується поточна дата.</small>}</label>
            {mode === 'scheduled' && <label className="slot-label">Вільний час *<select required disabled={slotsLoading || slots.length === 0} value={form.appointment_time} onChange={e => updateForm('appointment_time', e.target.value)}><option value="">{slotsLoading ? 'Завантажуємо вільні години…' : slots.length ? 'Оберіть час' : 'Немає вільного часу'}</option>{slots.map(t => <option key={t} value={t}>{t}</option>)}</select><small>Слот резервується на сервері; одночасне бронювання одного часу не допускається.</small></label>}
            <label>Telegram username (необов’язково)<input value={form.telegram_username} onChange={e => updateForm('telegram_username', e.target.value)} placeholder="@username"/><small>Username корисний для працівника, але сам по собі не дозволяє боту написати вам.</small></label>
            <label>Код прив’язки Telegram (необов’язково)<input autoCapitalize="characters" maxLength="12" value={form.telegram_code} onChange={e => updateForm('telegram_code', e.target.value.toUpperCase())} placeholder="Напр. K7M4P9Q2"/><small>Відкрийте бота й надішліть /start. Введіть одноразовий код, який бот надішле у відповідь.</small></label>
            <label className="full-width">Коментар до звернення (необов’язково)<input maxLength="300" value={form.notes} onChange={e => updateForm('notes', e.target.value)} placeholder="Коротко уточніть запит, без номерів документів"/></label>
          </div>
          {BOT_LINK && <a className="bot-link" href={BOT_LINK} target="_blank" rel="noreferrer"><Send size={16}/> Відкрити Telegram-бота <ExternalLink size={14}/></a>}
          <div className="privacy"><ShieldCheck size={18}/><span>ПІБ, телефон і деталі запиту бачать лише авторизовані працівники. У відкритій черзі показуються тільки номер, час і статус. Не вводьте серію/номер паспорта чи інші зайві чутливі дані.</span></div>
          {error && <div className="alert error" role="alert">{error}</div>}{message && <div className="alert success" role="status">{message}</div>}
          <button className="primary" type="submit" disabled={busy || (mode === 'scheduled' && !slots.length)}>{busy ? 'Створюємо запис…' : mode === 'live' ? 'Отримати номер живої черги' : 'Підтвердити запис'} <ArrowRight size={18}/></button>
        </form>
        {receipt && <div className="receipt"><div className="receipt-icon"><CalendarCheck/></div><div><strong>Запис створено</strong><div className="ticket-number">№ {receipt.queue_number}</div><p>{formatDate(receipt.visit_date)} · {receipt.booking_type === 'live' ? 'Жива черга' : (receipt.appointment_time || 'час не вказано')}</p><p>Послуга: {receipt.service}</p><small>Збережіть номер, щоб швидко знайти себе в публічній черзі.</small></div></div>}
      </section>}

      {tab === 'queue' && <section className="panel"><div className="section-head"><div className="symbol"><ListOrdered/></div><div><h3>Публічна черга</h3><p>Без ПІБ, телефонів і персональних деталей</p></div><button className="icon-button" onClick={() => loadPublicQueue()} aria-label="Оновити чергу"><RefreshCw size={17}/> Оновити</button></div><label className="date-field">Дата<input type="date" value={visitDate} onChange={e => {setVisitDate(e.target.value);loadPublicQueue(e.target.value);}}/></label><div className="queue-list">{filteredQueue.length === 0 ? <div className="empty"><ListOrdered size={27}/><p>На цю дату записів не знайдено.</p><small>Нова інформація автоматично оновлюється приблизно кожні 20 секунд.</small></div> : filteredQueue.map(item => <div className="queue-row" key={`${item.visit_date}-${item.queue_number}`}><div className="queue-number">№ {item.queue_number}</div><div className="queue-main"><b>{displayTime(item)}</b><small>{item.booking_type === 'live' ? 'Жива черга' : 'Попередній запис'}</small></div><span className={`status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></div>)}</div></section>}

      {tab === 'staff' && <section className="panel"><div className="section-head"><div className="symbol"><ShieldCheck/></div><div><h3>Кабінет працівника</h3><p>Авторизація та доступ лише для внесених у список працівників</p></div></div>
        {!session ? <form className="login-form" onSubmit={signIn}><label>Службова електронна пошта<input required type="email" autoComplete="username" value={login.email} onChange={e => setLogin(old => ({...old,email:e.target.value}))}/></label><label>Пароль<input required type="password" autoComplete="current-password" value={login.password} onChange={e => setLogin(old => ({...old,password:e.target.value}))}/></label><button className="primary" type="submit"><LogIn size={17}/> Увійти</button>{error && <div className="alert error">{error}</div>}</form> : <>
          <div className="staff-tools"><span>Ви увійшли як працівник</span><label>Дата<input type="date" value={staffDate} onChange={e => setStaffDate(e.target.value)}/></label><button className="icon-button" onClick={() => loadStaffQueue()}><RefreshCw size={16}/> Оновити</button><button className="quiet-button" onClick={() => supabase.auth.signOut()}><LogOut size={16}/> Вийти</button></div>
          {error && <div className="alert error">{error}</div>}{message && <div className="alert success">{message}</div>}
          {staffLoading ? <div className="empty">Завантаження черги…</div> : staffQueue.length === 0 ? <div className="empty"><Users size={26}/><p>На цю дату немає записів.</p></div> : <div className="staff-list">{staffQueue.map(item => <article className="staff-row" key={item.id}><div className="staff-details"><div className="staff-title"><b>№ {item.queue_number} · {item.full_name}</b><span className={`status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></div><p><strong>{item.service}</strong> · {item.booking_type === 'live' ? 'Жива черга' : `Час ${String(item.appointment_time || '').slice(0,5)}`}</p><p>Телефон: <a href={`tel:${item.phone}`}>{item.phone}</a></p>{item.telegram_username && <p>Telegram username: @{item.telegram_username}</p>}{item.telegram_chat_id && <p className="telegram-linked"><Send size={13}/> Telegram прив’язано</p>}{item.notes && <p>Коментар: {item.notes}</p>}<small>Створено: {new Date(item.created_at).toLocaleString('uk-UA')}</small></div><div className="actions"><button disabled={item.status !== 'waiting'} onClick={() => staffAction(item.id, 'call')}>Викликати</button><button disabled={item.status !== 'serving'} onClick={() => staffAction(item.id, 'complete')}>Завершити</button><button className="cancel-action" disabled={['completed','cancelled'].includes(item.status)} onClick={() => staffAction(item.id, 'cancel')}>Скасувати</button></div></article>)}</div>}
          <div className="staff-note"><ShieldCheck size={16}/> Не надсилайте ПІБ і телефони в публічні чати. Доступ до панелі надавайте лише уповноваженим працівникам.</div>
        </>}
      </section>}

      <section className="info-grid"><article className="info-card"><Clock3/><h4>Графік роботи</h4><p>Пн–Чт: 08:00–13:00 та 13:45–17:00<br/>Пт: 08:00–13:00 та 13:45–15:45<br/>Обід: 13:00–13:45</p></article><article className="info-card"><Bell/><h4>Сповіщення Telegram</h4><p>Підтвердження запису, повідомлення працівнику про новий запис і повідомлення відвідувачу під час виклику. Для зв’язку спочатку запустіть бота.</p></article></section>
      <section className="data-notice"><Info size={17}/><p><strong>Повідомлення про дані.</strong> Перед офіційним запуском рада має затвердити текст повідомлення про обробку персональних даних, визначити строк зберігання та відповідальну особу. Це стартовий програмний шаблон, який необхідно перевірити перед використанням із реальними даними громадян.</p></section>
    </main>
    <footer><span>© Бородянська селищна рада · Електронна черга</span><span>Розклад та вільні години перевіряються на сервері.</span></footer>
  </div>;
}
