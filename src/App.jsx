import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { CalendarDays, Clock3, Bell, ShieldCheck, ListOrdered, ArrowRight, RefreshCw, Send, CalendarCheck, Users, Info, LogIn, LogOut, ExternalLink, AlertTriangle } from 'lucide-react';
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

function configMissing() { 
  return !supabase || !CREATE_URL || !SLOTS_URL || !STAFF_ACTION_URL; 
}

export default function App() {
  const [tab, setTab] = useState('book');
  const [mode, setMode] = useState('scheduled');
  const [visitDate, setVisitDate] = useState(kyivDate());
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [publicQueue, setPublicQueue] = useState([]);
  const [staffQueue, setStaffQueue] = useState([]);
  const [staffDate, setStaffDate] = useState(kyivDate());
  
  // Стан роботи системи на вибраний день
  const [dayStatus, setDayStatus] = useState({ isWorking: true, reason: '' });
  const [statusReasonInput, setStatusReasonInput] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);

  const [form, setForm] = useState({ 
    full_name: '', phone: '', telegram_username: '', telegram_code: '', 
    service: SERVICES[0], visit_date: kyivDate(), booking_type: 'scheduled', 
    appointment_time: '', notes: '' 
  });
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
    const response = await fetch(url, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }, 
      body: JSON.stringify(body) 
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* ignore */ }
    if (!response.ok) throw new Error(payload.error || 'Помилка серверної функції.');
    return payload;
  }, []);

  const loadDayStatus = useCallback(async (date) => {
    if (!supabase) return;
    const { data, error } = await supabase.from('system_status').select('is_working, reason').eq('date', date).single();
    if (data) {
      setDayStatus({ isWorking: data.is_working, reason: data.reason || '' });
      setStatusReasonInput(data.reason || '');
    } else {
      setDayStatus({ isWorking: true, reason: '' });
      setStatusReasonInput('');
    }
  }, []);

  const updateDayStatus = async (isWorking) => {
    if (!isWorking && !statusReasonInput.trim()) {
      setError('Вкажіть причину зупинки роботи (напр., "Не працює сервер").');
      return;
    }
    setError(''); setMessage(''); setStatusLoading(true);
    const { error: dbError } = await supabase.from('system_status').upsert({
      date: staffDate,
      is_working: isWorking,
      reason: isWorking ? null : statusReasonInput.trim(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'date' });
    
    setStatusLoading(false);
    if (dbError) {
      setError('Помилка оновлення статусу: ' + dbError.message);
    } else {
      setMessage(isWorking ? 'Прийом відновлено.' : 'Прийом зупинено. Сповіщення на сайті оновлено.');
      loadDayStatus(staffDate);
    }
  };

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

  useEffect(() => { 
    if (mode === 'scheduled') loadSlots(form.visit_date); 
    loadDayStatus(form.visit_date);
  }, [mode, form.visit_date, loadSlots, loadDayStatus]);
  
  useEffect(() => { if (!supabase) return undefined; supabase.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = supabase.auth.onAuthStateChange((_event, value) => setSession(value)); return () => data.subscription.unsubscribe(); }, []);
  useEffect(() => { loadPublicQueue(); const timer = setInterval(() => loadPublicQueue(), 20000); return () => clearInterval(timer); }, [loadPublicQueue]);
  
  useEffect(() => { 
    if (session && tab === 'staff') {
      loadStaffQueue();
      loadDayStatus(staffDate);
    }
  }, [session, tab, staffDate, loadStaffQueue, loadDayStatus]);

  async function submitBooking(event) {
    event.preventDefault(); setError(''); setMessage(''); setReceipt(null);
    if (!dayStatus.isWorking) return;
    if (configMissing()) { setError('Сайт ще не підключено до Supabase. Виконайте налаштування з README.md.'); return; }
    if (form.full_name.trim().length < 3 || form.phone.trim().length < 7) { setError('Вкажіть повне ПІБ та коректний номер телефону.'); return; }
    if (form.booking_type === 'scheduled' && !form.appointment_time) { setError('Оберіть вільний час прийому.'); return; }
    if (!form.telegram_code.trim()) { setError('Підключення Telegram обов’язкове. Введіть код прив’язки, отриманий від бота.'); return; }
    
    setBusy(true);
    try {
      const payload = await invoke(CREATE_URL, { 
        ...form, booking_type: mode, visit_date: form.visit_date, 
        appointment_time: mode === 'scheduled' ? form.appointment_time : null, 
        telegram_username: form.telegram_username.trim().replace(/^@/, '').slice(0, 64) || null, 
        telegram_code: form.telegram_code.trim().toUpperCase() || null 
      });
      setReceipt(payload);
      setMessage(payload.telegram_notified ? 'Запис створено. Telegram-підтвердження надіслано.' : payload.telegram_linked ? 'Запис створено, але Telegram-підтвердження не вдалося доставити. Перевірте налаштування бота.' : 'Запис створено. Для Telegram-сповіщень відкрийте бота, надішліть /start і введіть код у форму.');
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

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <img className="crest" src={`${basePath}gerb-borodianka.png`} alt={`Герб ${OFFICE.subtitle}`} />
          <div><span className="overline">{OFFICE.subtitle}</span><h1>{OFFICE.title}</h1></div>
        </div>
        <div className="online"><span /> Онлайн-запис</div>
      </header>

      <main>
        <section className="hero">
          <div>
            <div className="hero-kicker">ЗРУЧНО · ПРОЗОРО · У ЗРУЧНИЙ ЧАС</div>
            <h2>Запишіться на прийом<br />у кілька кроків</h2>
            <p>Оберіть послугу, дату та доступний час або скористайтеся живою чергою. Telegram допоможе отримати підтвердження та сповіщення.</p>
          </div>
          <div className="hero-art"><CalendarCheck size={48} /><span>1190</span></div>
        </section>

        <nav className="tabs" aria-label="Розділи">
          <button className={tab === 'book' ? 'selected' : ''} onClick={() => { setTab('book'); setError(''); }}>Записатися</button>
          <button className={tab === 'queue' ? 'selected' : ''} onClick={() => { setTab('queue'); setError(''); loadPublicQueue(); }}>Публічна черга</button>
          <button className={tab === 'staff' ? 'selected' : ''} onClick={() => { setTab('staff'); setError(''); }}>Кабінет працівника</button>
        </nav>

        {tab === 'book' && (
          <section className="panel">
            <div className="section-head">
              <div className="symbol"><CalendarDays /></div>
              <div><h3>Новий запис</h3><p>Оберіть формат прийому та заповніть поля</p></div>
            </div>

            {!dayStatus.isWorking && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: '1.25rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <AlertTriangle size={20} /> Запис на {formatDate(form.visit_date)} тимчасово призупинено
                </h4>
                <p style={{ margin: '0', color: '#991b1b' }}><strong>Причина:</strong> {dayStatus.reason}</p>
                <p style={{ margin: '0.5rem 0 0 0', color: '#7f1d1d', fontSize: '0.9rem' }}>Будь ласка, оберіть іншу дату або зачекайте на відновлення роботи системи.</p>
              </div>
            )}

            <div className="mode-switch">
              <button disabled={!dayStatus.isWorking} className={mode === 'scheduled' ? 'active' : ''} onClick={() => { setMode('scheduled'); updateForm('booking_type', 'scheduled'); }}>
                <CalendarCheck size={18} /> На конкретний час
              </button>
              <button disabled={!dayStatus.isWorking} className={mode === 'live' ? 'active' : ''} onClick={() => { setMode('live'); updateForm('booking_type', 'live'); updateForm('visit_date', kyivDate()); }}>
                <ListOrdered size={18} /> Жива черга сьогодні
              </button>
            </div>
            
            <form onSubmit={submitBooking}>
              <div className="form-grid">
                <label>ПІБ повністю *<input required disabled={!dayStatus.isWorking} autoComplete="name" maxLength="150" value={form.full_name} onChange={e => updateForm('full_name', e.target.value)} placeholder="Прізвище Ім’я По батькові" /></label>
                <label>Номер телефону *<input required disabled={!dayStatus.isWorking} type="tel" autoComplete="tel" maxLength="30" value={form.phone} onChange={e => updateForm('phone', e.target.value)} placeholder="+380…" /></label>

                <label>Послуга *
                  <select disabled={!dayStatus.isWorking} value={form.service} onChange={e => updateForm('service', e.target.value)}>
                    {SERVICES.map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <label>Дата прийому *
                  <input type="date" required min={kyivDate()} disabled={mode === 'live'} value={form.visit_date} onChange={e => updateForm('visit_date', e.target.value)} />
                  {mode === 'live' && <small>Для живої черги використовується поточна дата.</small>}
                </label>

                {mode === 'scheduled' ? (
                  <label className="slot-label">Вільний час *
                    <select required disabled={!dayStatus.isWorking || slotsLoading || slots.length === 0} value={form.appointment_time} onChange={e => updateForm('appointment_time', e.target.value)}>
                      <option value="">{!dayStatus.isWorking ? 'Прийом зупинено' : slotsLoading ? 'Завантажуємо години…' : slots.length ? 'Оберіть час' : 'Немає вільного часу'}</option>
                      {dayStatus.isWorking && slots.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <small>Слот резервується на сервері; одночасне бронювання одного часу не допускається.</small>
                  </label>
                ) : (<div></div>)}
                <label>Коментар до звернення (необов’язково)
                  <input disabled={!dayStatus.isWorking} maxLength="300" value={form.notes} onChange={e => updateForm('notes', e.target.value)} placeholder="Коротко уточніть запит" />
                </label>
              </div>

              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', padding: '1.25rem', borderRadius: '8px', margin: '1.5rem 0', opacity: dayStatus.isWorking ? 1 : 0.6 }}>
                <h4 style={{ margin: '0 0 0.75rem 0', color: '#0369a1', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem' }}>
                  <Bell size={20} /> Обов'язкове підключення сповіщень
                </h4>
                <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.95rem', color: '#0c4a6e', lineHeight: '1.5' }}>
                  Щоб ми могли надіслати вам номер черги та сповістити про зміну розкладу (напр., раптове відключення систем), <strong>необхідно підключити нашого Telegram-бота</strong>.<br/><br/>
                  1. Натисніть кнопку нижче, щоб відкрити бота.<br/>
                  2. Натисніть <strong>Розпочати (або /start)</strong> у боті.<br/>
                  3. Бот надішле вам одноразовий код — скопіюйте його у форму нижче разом із вашим Username.
                </p>
                {BOT_LINK && (
                  <a href={BOT_LINK} target="_blank" rel="noreferrer" style={{ pointerEvents: dayStatus.isWorking ? 'auto' : 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', background: '#0ea5e9', color: '#fff', padding: '0.75rem 1.5rem', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', width: '100%', boxSizing: 'border-box' }}>
                    <Send size={18} /> Відкрити Telegram-бота <ExternalLink size={16} />
                  </a>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <label className="full-width">Telegram username (необов’язково)
                  <input disabled={!dayStatus.isWorking} value={form.telegram_username} onChange={e => updateForm('telegram_username', e.target.value)} placeholder="@username" />
                  <small>Якщо знаєте свій нікнейм — вкажіть його, або залиште поле порожнім.</small>
                </label>
                <label className="full-width">Код прив’язки Telegram *
                  <input required disabled={!dayStatus.isWorking} autoCapitalize="characters" maxLength="12" value={form.telegram_code} onChange={e => updateForm('telegram_code', e.target.value.toUpperCase())} placeholder="Напр. K7M4P9Q2" />
                  <small>Введіть сюди код, який ви щойно отримали від бота.</small>
                </label>
              </div>

              <div className="privacy" style={{ marginTop: '1.25rem' }}>
                <ShieldCheck size={18} />
                <span>ПІБ, телефон і деталі запиту бачать лише авторизовані працівники. У відкритій черзі показуються тільки номер, час і статус. Не вводьте серію/номер паспорта чи інші зайві чутливі дані.</span>
              </div>

              {error && <div className="alert error" role="alert">{error}</div>}
              {message && <div className="alert success" role="status">{message}</div>}

              <button className="primary" type="submit" disabled={!dayStatus.isWorking || busy || (mode === 'scheduled' && !slots.length)}>
                {busy ? 'Створюємо запис…' : mode === 'live' ? 'Отримати номер живої черги' : 'Підтвердити запис'} <ArrowRight size={18} />
              </button>
            </form>
            
            {receipt && (
              <div className="receipt">
                <div className="receipt-icon"><CalendarCheck /></div>
                <div>
                  <strong>Запис створено</strong>
                  <div className="ticket-number">№ {receipt.queue_number}</div>
                  <p>{formatDate(receipt.visit_date)} · {receipt.booking_type === 'live' ? 'Жива черга' : (receipt.appointment_time || 'час не вказано')}</p>
                  <p>Послуга: {receipt.service}</p>
                  <small>Збережіть номер, щоб швидко знайти себе в публічній черзі.</small>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === 'queue' && (
          <section className="panel">
            <div className="section-head">
              <div className="symbol"><ListOrdered /></div>
              <div><h3>Публічна черга</h3><p>Без ПІБ, телефонів і персональних деталей</p></div>
              <button className="icon-button" onClick={() => loadPublicQueue()} aria-label="Оновити чергу"><RefreshCw size={17} /> Оновити</button>
            </div>
            <label className="date-field">Дата<input type="date" value={visitDate} onChange={e => { setVisitDate(e.target.value); loadPublicQueue(e.target.value); }} /></label>
            <div className="queue-list">
              {filteredQueue.length === 0 ? (
                <div className="empty"><ListOrdered size={27} /><p>На цю дату записів не знайдено.</p><small>Нова інформація автоматично оновлюється приблизно кожні 20 секунд.</small></div>
              ) : (
                filteredQueue.map(item => (
                  <div className="queue-row" key={`${item.visit_date}-${item.queue_number}`}>
                    <div className="queue-number">№ {item.queue_number}</div>
                    <div className="queue-main"><b>{displayTime(item)}</b><small>{item.booking_type === 'live' ? 'Жива черга' : 'Попередній запис'}</small></div>
                    <span className={`status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {tab === 'staff' && (
          <section className="panel">
            <div className="section-head">
              <div className="symbol"><ShieldCheck /></div>
              <div><h3>Кабінет працівника</h3><p>Авторизація та доступ лише для внесених у список працівників</p></div>
            </div>
            {!session ? (
              <form className="login-form" onSubmit={signIn}>
                <label>Службова електронна пошта<input required type="email" autoComplete="username" value={login.email} onChange={e => setLogin(old => ({ ...old, email: e.target.value }))} /></label>
                <label>Пароль<input required type="password" autoComplete="current-password" value={login.password} onChange={e => setLogin(old => ({ ...old, password: e.target.value }))} /></label>
                <button className="primary" type="submit"><LogIn size={17} /> Увійти</button>
                {error && <div className="alert error">{error}</div>}
              </form>
            ) : (
              <>
                <div className="staff-profile-card">
  <div className="staff-avatar">ЯО</div>
  <div className="staff-info">
    <div className="staff-name">Очеретяний Ярослав Романович</div>
    <div className="staff-role">
      <span className="staff-status-dot"></span>
      Адміністратор системи
    </div>
  </div>
</div>

                {/* БЛОК КЕРУВАННЯ СТАТУСОМ РОБОТИ ДЛЯ ПРАЦІВНИКА */}
                <div style={{ background: '#f8fafc', padding: '1.25rem', border: '1px solid #e2e8f0', borderRadius: '8px', marginBottom: '1.5rem' }}>
                  <h4 style={{ margin: '0 0 0.75rem 0', color: '#334155' }}>
                    Статус прийому на {formatDate(staffDate)}
                  </h4>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 300px' }}>
                      <input 
                        type="text" 
                        placeholder="Вкажіть причину, якщо зупиняєте прийом (напр., не працює система)" 
                        value={statusReasonInput} 
                        onChange={(e) => setStatusReasonInput(e.target.value)} 
                        style={{ width: '100%', marginBottom: 0 }}
                      />
                    </div>
                    {dayStatus.isWorking ? (
                      <button className="cancel-action" onClick={() => updateDayStatus(false)} disabled={statusLoading}>
                        Зупинити прийом
                      </button>
                    ) : (
                      <button className="primary" onClick={() => updateDayStatus(true)} disabled={statusLoading}>
                        Відновити прийом
                      </button>
                    )}
                  </div>
                  {!dayStatus.isWorking && (
                    <div style={{ marginTop: '0.75rem', color: '#b91c1c', fontSize: '0.9rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <AlertTriangle size={16} /> Прийом зупинено. Користувачі не можуть записатися.
                    </div>
                  )}
                </div>

                {error && <div className="alert error">{error}</div>}
                {message && <div className="alert success">{message}</div>}
                
                {staffLoading ? (
                  <div className="empty">Завантаження черги…</div>
                ) : staffQueue.length === 0 ? (
                  <div className="empty"><Users size={26} /><p>На цю дату немає записів.</p></div>
                ) : (
                  <div className="staff-list">
                    {staffQueue.map(item => (
                      <article className="staff-row" key={item.id}>
                        <div className="staff-details">
                          <div className="staff-title"><b>№ {item.queue_number} · {item.full_name}</b><span className={`status ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></div>
                          <p><strong>{item.service}</strong> · {item.booking_type === 'live' ? 'Жива черга' : `Час ${String(item.appointment_time || '').slice(0, 5)}`}</p>
                          <p>Телефон: <a href={`tel:${item.phone}`}>{item.phone}</a></p>
                          {item.telegram_username && <p>Telegram username: @{item.telegram_username}</p>}
                          {item.telegram_chat_id && <p className="telegram-linked"><Send size={13} /> Telegram прив’язано</p>}
                          {item.notes && <p>Коментар: {item.notes}</p>}
                          <small>Створено: {new Date(item.created_at).toLocaleString('uk-UA')}</small>
                        </div>
                        <div className="actions">
                          <button disabled={item.status !== 'waiting'} onClick={() => staffAction(item.id, 'call')}>Викликати</button>
                          <button disabled={item.status !== 'serving'} onClick={() => staffAction(item.id, 'complete')}>Завершити</button>
                          <button className="cancel-action" disabled={['completed', 'cancelled'].includes(item.status)} onClick={() => staffAction(item.id, 'cancel')}>Скасувати</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <section className="info-grid">
          <article className="info-card">
            <Clock3 />
            <h4>Графік роботи</h4>
            <p>{OFFICE.hours}</p>
            {OFFICE.daysOff && <small style={{ display: 'block', marginTop: '6px', color: '#64748b' }}>{OFFICE.daysOff}</small>}
          </article>
          <article className="info-card">
            <Bell />
            <h4>Сповіщення Telegram</h4>
            <p>Підтвердження запису, повідомлення працівнику про новий запис і повідомлення відвідувачу під час виклику.</p>
          </article>
        </section>

      </main>

      <footer>
        <span>© {OFFICE.subtitle} · {OFFICE.title}</span>
        <span>Розклад та вільні години перевіряються на сервері.</span>
      </footer>
    </div>
  );
}
