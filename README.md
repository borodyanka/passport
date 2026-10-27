# Електронна черга паспортного столу Бородянської селищної ради

Україномовний вебзастосунок: бронювання конкретного часу, жива черга на сьогодні, публічний статус без персональних даних, кабінет працівника та Telegram-повідомлення.

> **Статус:** повний стартовий код для розгортання, але перед обробкою реальних даних громадян потрібні тестування, погодження процесів ради, політики обробки персональних даних та security review. У цьому архіві немає вже розгорнутого сервера, бази або Telegram-бота — їх потрібно створити у своїх акаунтах.

## Архітектура

- **GitHub Pages** — роздає готовий статичний сайт. GitHub не запускає базу даних і не виконує Telegram webhook.
- **Supabase** — PostgreSQL, авторизація працівників та Edge Functions.
- **Telegram Bot API** — одноразовий код прив’язки, підтвердження запису, повідомлення працівникам та повідомлення під час виклику.

Офіційні довідки: [Supabase Edge Functions](https://supabase.com/docs/guides/functions), [секрети Supabase](https://supabase.com/docs/guides/functions/secrets), [деплой Edge Functions](https://supabase.com/docs/guides/functions/deploy), [Telegram Bot API webhook](https://core.telegram.org/bots/api#setwebhook).

## Що реалізовано

1. Відвідувач вибирає послугу, дату та доступний час (режим «На конкретний час») або бере квиток у живу чергу сьогодні.
2. Сервер повторно перевіряє доступність часу в Postgres; SQL-індекс не дає забронювати один час двічі.
3. Один слот резервується на **20 хвилин** — це консервативний крок у межах заданих 10–20 хвилин, щоб не створювати накладення прийомів.
4. Черга отримує послідовний номер на день. Публічна черга показує лише номер, час/формат і статус — не ПІБ, телефон, послугу, username чи коментар.
5. Працівник входить через Supabase Auth; повний список доступний лише користувачу, UUID якого є в таблиці `staff`.
6. Telegram-бот видає одноразовий код після `/start`; клієнт вставляє його у форму бронювання. Код діє 10 хвилин і використовується один раз. Telegram не дозволяє боту написати людині лише за username — потрібен chat ID, отриманий від самого бота.
7. Під час створення запису бот надсилає користувачу підтвердження та працівникам інформацію про новий запис **без ПІБ і телефону**. Коли працівник натисне «Викликати», відвідувач отримує повідомлення; для живої черги бот також сповіщає наступні до двох прив’язаних квитків, якщо вони ще не отримували нагадування.

## 1. Створіть Supabase-проєкт

1. Створіть проєкт на [Supabase](https://supabase.com/), збережіть пароль бази даних у безпечному місці.
2. У Dashboard → **SQL Editor** відкрийте `supabase/schema.sql`, скопіюйте весь SQL і виконайте його в новому проєкті. Для вже наявної бази спершу зробіть резервну копію й перевірте міграцію; скрипт призначений насамперед для нового проєкту.
3. У Dashboard → **Authentication → Users** створіть/запросіть обліковий запис працівника. Не використовуйте публічну самореєстрацію для працівників.
4. Скопіюйте UUID цього користувача. У SQL Editor виконайте, замінивши UUID та ім’я:

```sql
insert into public.staff(user_id, display_name)
values ('ВСТАВТЕ-UUID-КОРИСТУВАЧА', 'Працівник паспортного столу');
```

5. Вимкніть публічну самореєстрацію працівників у Supabase Auth (Authentication → Settings / Sign In), якщо вона не потрібна. Створюйте тільки індивідуальні облікові записи.
6. У Project Settings → API скопіюйте Project URL та **publishable key / anon key**. Для фронтенду потрібен лише публічний ключ. **Ніколи не використовуйте `service_role` у браузері, GitHub Pages або `VITE_*`.**

## 2. Підготуйте Telegram-бота

1. Відкрийте в Telegram офіційний **@BotFather**, виконайте `/newbot`, задайте назву та username. Збережіть bot token у менеджері паролів. Не додавайте токен у GitHub, репозиторій або фронтенд.
2. Створіть робочий чат/групу для сповіщень працівників. Додавайте лише уповноважених працівників; бот надсилатиме туди номер/дату/час/послугу без ПІБ і телефону.
3. Додайте бота до робочої групи та надішліть тестове повідомлення. Дізнайтесь `chat_id` безпечним способом через Bot API `getUpdates` до ввімкнення webhook, або через перевірений адміністраторський інструмент. У групах chat ID зазвичай від’ємний. Не публікуйте його у відкритому репозиторії.
4. Створіть сильний випадковий webhook secret (лише символи `A-Z`, `a-z`, `0-9`, `_`, `-`, наприклад за допомогою менеджера паролів). Не використовуйте токен бота як webhook secret.

## 3. Налаштуйте секрети Supabase

У корені репозиторію, на комп’ютері, створіть тимчасовий файл `supabase/functions/.env` (він у `.gitignore`):

```env
TELEGRAM_BOT_TOKEN=ВСТАВТЕ_ТОКЕН_БОТА
TELEGRAM_WEBHOOK_SECRET=ВСТАВТЕ_ВИПАДКОВИЙ_WEBHOOK_SECRET
TELEGRAM_STAFF_CHAT_IDS=-1001234567890,-123456789
```

Після `supabase link` нижче завантажте секрети на сервер:

```bash
supabase secrets set --env-file supabase/functions/.env --project-ref YOUR_PROJECT_REF
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`/publishable key і `SUPABASE_SERVICE_ROLE_KEY` зазвичай вже доступні в Edge Functions як змінні середовища Supabase. Якщо `SUPABASE_ANON_KEY` не доступний у вашому runtime, додайте цей ключ через Dashboard → Edge Function Secrets з назвою `SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` має бути встановлений Supabase автоматично; якщо ні — задайте його тільки у Supabase Secrets, ніколи у фронтенді. Після передавання секретів видаліть локальний `.env` або залиште його тільки на власному захищеному комп’ютері — не додавайте його в Git.

## 4. Розгорніть базу та Edge Functions

Встановіть Node.js (LTS) та [Supabase CLI](https://supabase.com/docs/guides/cli). У терміналі в каталозі цього проєкту виконайте:

```bash
npm install
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy create-booking --no-verify-jwt
supabase functions deploy available-slots --no-verify-jwt
supabase functions deploy staff-action --no-verify-jwt
supabase functions deploy telegram-webhook --no-verify-jwt
```

`--no-verify-jwt` потрібен, бо доступ до public функцій регулюється серверною перевіркою, а Telegram webhook перевіряє окремий `X-Telegram-Bot-Api-Secret-Token`. Функція `staff-action` сама перевіряє Supabase JWT і членство у таблиці `staff`. Не видаляйте ці перевірки.

Локальний перегляд:

```bash
cp .env.example .env.local
# Заповніть VITE_* змінні значеннями зі свого проєкту
npm run dev
```

## 5. Прив’яжіть Telegram webhook

Після деплою функції `telegram-webhook` її URL буде:

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-webhook`

Виконайте в терміналі (підставте токен і webhook secret; не зберігайте команду з реальним токеном у спільній історії терміналу):

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-webhook","secret_token":"YOUR_WEBHOOK_SECRET","allowed_updates":["message"],"drop_pending_updates":true}'
```

Telegram надсилатиме заголовок `X-Telegram-Bot-Api-Secret-Token`; функція відхилятиме запити без правильного секрету. Офіційний опис: [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook).

**Перевірка:** відкрийте бота, натисніть Start або надішліть `/start`. Бот має відповісти кодом; введіть його у форму запису. Код діє 10 хвилин і одноразовий. Якщо бот уже мав webhook, `getUpdates` більше не працюватиме, доки webhook не буде видалено.

## 6. Запустіть сайт на GitHub Pages

1. Створіть порожній GitHub-репозиторій, наприклад `borodianka-passport-queue`, і завантажте всі файли цього архіву в корінь репозиторію. Відправте в гілку `main`.
2. На GitHub відкрийте **Settings → Secrets and variables → Actions → Variables** та створіть такі **Repository variables** (це публічні значення, які потраплять у сайт):
   - `VITE_SUPABASE_URL` = `https://YOUR_PROJECT_REF.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = publishable/anon key із Supabase (не service role)
   - `VITE_CREATE_BOOKING_URL` = `https://YOUR_PROJECT_REF.supabase.co/functions/v1/create-booking`
   - `VITE_AVAILABLE_SLOTS_URL` = `https://YOUR_PROJECT_REF.supabase.co/functions/v1/available-slots`
   - `VITE_STAFF_ACTION_URL` = `https://YOUR_PROJECT_REF.supabase.co/functions/v1/staff-action`
   - `VITE_TELEGRAM_BOT_LINK` = `https://t.me/YOUR_BOT_USERNAME`
3. Settings → Pages → Build and deployment виберіть **GitHub Actions**.
4. Вкладка **Actions**: дочекайтеся завершення workflow `Build and deploy site to GitHub Pages`. Публічна адреса буде `https://YOUR_GITHUB_NAME.github.io/REPOSITORY_NAME/`.
5. Якщо змінили змінні Actions Variables, запустіть workflow повторно, бо `VITE_*` вбудовуються під час build.

Не створюйте `VITE_TELEGRAM_BOT_TOKEN`, `VITE_SERVICE_ROLE_KEY` або подібні змінні. Усе, що має префікс `VITE_`, доступне користувачам сайту.

## 7. Тестовий чеклист перед запуском

- [ ] Відвідувач може записатися на доступний час.
- [ ] Дві спроби одночасно забронювати один слот: успішною має бути лише одна.
- [ ] На суботу/неділю немає вільних слотів.
- [ ] Перерва 13:00–13:45 не пропонується; п’ятничні слоти закінчуються до 15:45.
- [ ] Жива черга дозволяється тільки сьогодні у робочі години.
- [ ] Публічна черга не показує ПІБ, телефон, username, послугу та коментар.
- [ ] Невнесений до `staff` користувач не бачить персональні дані, навіть якщо має акаунт Supabase.
- [ ] Telegram-код одноразовий, протермінований або повторно використаний код відхиляється.
- [ ] Працівник викликає запис — прив’язаний користувач отримує сповіщення; для живої черги перевіряються нагадування наступним номерам.
- [ ] У Telegram-групі немає зайвих учасників; повідомлення не містять ПІБ або телефону.

## Важливі обмеження та рекомендації

- У режимі «жива черга» люди отримують номер, але не фіксований час; працівник керує викликом вручну. Якщо в цей самий день є попередні записи, працівнику потрібно враховувати розклад під час виклику живої черги. Щоб операційно уникати конфліктів, варто затвердити правило пріоритетів та опублікувати його на сайті.
- Сповіщення про наближення черги відправляється, коли працівник викликає попередній квиток, наступним двом прив’язаним живим квиткам без уже відправленого нагадування. Це не прогноз часу очікування.
- Публічні функції можуть потребувати CAPTCHA/anti-abuse throttling перед офіційним запуском. Додайте моніторинг помилок та резервне копіювання.
- Перед збором реальних ПІБ/телефонів узгодьте з відповідальною особою ради мету й правову підставу обробки, текст повідомлення, доступи та строк видалення даних. Не використовуйте це як production-систему без відповідної перевірки.
