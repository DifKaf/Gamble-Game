# Frontend integration plan

Текущий HTML лежит в `index.html` как legacy-версия. Backend уже готов. Чтобы полностью перейти на production:

1. Добавь в HTML перед основным script:
```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

2. Реальный баланс не хранить в localStorage. Использовать API:
- `POST /auth/telegram` — вход через Telegram
- `GET /me` — получить пользователя и баланс
- `POST /games/:gameCode/bet` — ставка
- `GET /wallet/transactions` — история

3. Минимальный API-клиент:
```js
const API_URL = 'http://localhost:4000';
let authToken = localStorage.getItem('gg_token');
let mainBalance = 0;

async function apiRequest(path, options = {}) {
  const res = await fetch(API_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

async function bootBackendAuth() {
  let auth;
  if (window.Telegram?.WebApp?.initData) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
    auth = await apiRequest('/auth/telegram', {
      method: 'POST',
      body: JSON.stringify({ initData: window.Telegram.WebApp.initData })
    });
  } else {
    auth = await apiRequest('/auth/dev', {
      method: 'POST',
      body: JSON.stringify({ telegramId: 123456 })
    });
  }
  authToken = auth.token;
  localStorage.setItem('gg_token', authToken);
  mainBalance = auth.user.balance;
  renderServerBalance();
}

function renderServerBalance() {
  const full = Math.round(mainBalance).toLocaleString('ru-RU') + ' GC';
  const plain = Math.round(mainBalance).toLocaleString('ru-RU');
  ['heroBalance','walletBalance','profileBalance'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = full;
  });
  const top = document.getElementById('balanceValue');
  if (top) top.textContent = plain;
}

async function serverBet(gameCode, betAmount, payload = {}) {
  const data = await apiRequest('/games/' + gameCode + '/bet', {
    method: 'POST',
    body: JSON.stringify({
      betAmount,
      requestId: crypto.randomUUID?.() || String(Date.now()) + Math.random(),
      payload
    })
  });
  mainBalance = data.balance;
  renderServerBalance();
  return data.result;
}
```

4. Далее в каждой игре заменить локальные `balance -= bet`, `balance += win`, `Math.random()` на `await serverBet(...)`.

5. Drunkard Gate сейчас подключён как MVP endpoint. Полную визуальную механику каскадов нужно переносить отдельным этапом: сервер возвращает grid/cascades, frontend только анимирует.
