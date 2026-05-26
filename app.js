// === КОНФИГ ===
const SUPABASE_URL = 'https://sohronolnipgtvjycfcz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fBP0vhadJASnTV91WTOuBQ_Bwfm6AEz';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// === STATE ===
let currentUser = null;
let map = null;
let markers = [];
let pendingLatLng = null;
let selectedRating = 0;
let editingPoopId = null;
let addingMode = false;
let selectedProcess = null;
let allPoops = [];

// Форматы процесса (можно дополнять)
const PROCESS_TYPES = [
  '🧈 Как по маслу',
  '💥 Разрывные',
  '💪 Крепыши',
  '🚢 Непотопляйка',
  '👻 Призрак (чистенько)',
  '🪨 Камень',
  '🌊 Жидкий формат',
  '🔁 Вторая попытка',
  '⚡ Турбо',
  '🐢 Долгая эпопея',
  '🚫 Не получилось',
  '🚨 Ложная тревога',
];

// === HELPERS ===
function $(id) { return document.getElementById(id); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

function toast(message, type = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast ' + type;
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function showError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// === АВТОРИЗАЦИЯ ===
async function checkAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    currentUser = session.user;
    await enterApp();
  } else {
    show('auth-screen');
    hide('app-screen');
  }
}

$('show-signup').addEventListener('click', () => {
  hide('signin-form');
  show('signup-form');
});

$('show-signin').addEventListener('click', () => {
  hide('signup-form');
  show('signin-form');
});

$('signup-btn').addEventListener('click', async () => {
  const username = $('signup-username').value.trim();
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;

  if (!username || username.length < 3) return showError('Никнейм минимум 3 символа');
  if (!email) return showError('Введите email');
  if (password.length < 6) return showError('Пароль минимум 6 символов');

  $('signup-btn').disabled = true;
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { username } }
  });
  $('signup-btn').disabled = false;

  if (error) return showError(error.message);
  if (data.user && !data.session) {
    toast('Проверь почту для подтверждения', 'success');
  } else if (data.session) {
    currentUser = data.user;
    await enterApp();
  }
});

$('signin-btn').addEventListener('click', async () => {
  const email = $('signin-email').value.trim();
  const password = $('signin-password').value;

  if (!email || !password) return showError('Заполни email и пароль');

  $('signin-btn').disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  $('signin-btn').disabled = false;

  if (error) return showError(error.message);
  currentUser = data.user;
  await enterApp();
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  if (map) { map.remove(); map = null; }
  markers = [];
  location.reload();
});

async function enterApp() {
  hide('auth-screen');
  show('app-screen');
  initMap();
  await loadPoops();
}

// === КАРТА ===
function initMap() {
  if (map) return;

  map = L.map('map').setView([55.7558, 37.6173], 11); // дефолт — Москва

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
    detectRetina: true
  }).addTo(map);

  // Клик по карте в режиме добавления — ставим точную метку
  map.on('click', (e) => {
    if (!addingMode) return;
    pendingLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
    setAddingMode(false);
    openAddModal();
  });

  // Попробуем получить геолокацию пользователя — крупный план улиц
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 16);
      },
      () => { /* отказано - оставляем дефолт */ }
    );
  }
}

function setAddingMode(on) {
  addingMode = on;
  const c = $('map');
  if (c) c.classList.toggle('adding', on);
}

$('add-poop-btn').addEventListener('click', () => {
  if (addingMode) {
    setAddingMode(false);
    toast('Отменено');
    return;
  }
  setAddingMode(true);
  toast('Нажми на карту, где поставить метку 💩');
});

function openAddModal() {
  // дата = сейчас
  const now = new Date();
  const tz = now.getTimezoneOffset() * 60000;
  const localISO = new Date(now - tz).toISOString().slice(0, 16);
  $('poop-date').value = localISO;

  $('poop-place').value = '';
  $('poop-note').value = '';
  selectedRating = 0;
  updateRatingUI();
  selectedProcess = null;
  renderProcessChips();

  $('location-info').textContent =
    `📍 ${pendingLatLng.lat.toFixed(5)}, ${pendingLatLng.lng.toFixed(5)}`;

  show('add-modal');
}

function renderProcessChips() {
  const container = $('poop-process');
  container.innerHTML = '';
  PROCESS_TYPES.forEach(type => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (type === selectedProcess ? ' selected' : '');
    chip.textContent = type;
    chip.addEventListener('click', () => {
      // повторный клик снимает выбор
      selectedProcess = (selectedProcess === type) ? null : type;
      renderProcessChips();
    });
    container.appendChild(chip);
  });
}

$('modal-cancel').addEventListener('click', () => hide('add-modal'));

$('modal-save').addEventListener('click', async () => {
  const place = $('poop-place').value.trim();
  const note = $('poop-note').value.trim();
  const dateStr = $('poop-date').value;

  if (!dateStr) return toast('Укажи дату', 'error');

  const poopedAt = new Date(dateStr).toISOString();

  $('modal-save').disabled = true;
  const { error } = await sb.from('poops').insert({
    user_id: currentUser.id,
    latitude: pendingLatLng.lat,
    longitude: pendingLatLng.lng,
    place_name: place || null,
    note: note || null,
    rating: selectedRating || null,
    process_type: selectedProcess || null,
    pooped_at: poopedAt
  });
  $('modal-save').disabled = false;

  if (error) {
    toast('Ошибка: ' + error.message, 'error');
    return;
  }

  hide('add-modal');
  await loadPoops();
  announceNearby(pendingLatLng);
});

// Рейтинг
$('poop-rating').addEventListener('click', (e) => {
  if (e.target.dataset.rating) {
    selectedRating = parseInt(e.target.dataset.rating);
    updateRatingUI();
  }
});

function updateRatingUI() {
  document.querySelectorAll('#poop-rating span').forEach(s => {
    const r = parseInt(s.dataset.rating);
    s.classList.toggle('selected', r <= selectedRating);
  });
}

// === БЛИЗКИЕ МЕТКИ ДРУЗЕЙ ===
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pluralFriends(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'друг';
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'друга';
  return 'друзей';
}

function announceNearby(latlng) {
  const RADIUS = 300; // метров
  const near = allPoops.filter(p =>
    p.user_id !== currentUser.id &&
    distanceMeters(latlng.lat, latlng.lng, p.latitude, p.longitude) <= RADIUS
  );
  if (near.length === 0) {
    toast('Сохранено 💩 · тут ты первопроходец! 🚩', 'success');
    return;
  }
  const friends = new Set(near.map(p => p.user_id)).size;
  const rated = near.filter(p => p.rating);
  const avg = rated.length
    ? (rated.reduce((a, p) => a + p.rating, 0) / rated.length).toFixed(1)
    : null;
  const verb = friends === 1 ? 'отметился' : 'отметились';
  let msg = `Сохранено 💩 · рядом ${verb} ${friends} ${pluralFriends(friends)}`;
  if (avg) msg += `, оценка места ${avg}⭐`;
  toast(msg, 'success');
}

// === ЗАГРУЗКА МЕТОК ===
async function loadPoops() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  const { data: poops, error } = await sb
    .from('poops')
    .select('*')
    .order('pooped_at', { ascending: false });

  if (error) {
    toast('Ошибка загрузки: ' + error.message, 'error');
    return;
  }

  allPoops = poops;

  // Получим профили владельцев
  const userIds = [...new Set(poops.map(p => p.user_id))];
  let profilesMap = {};
  if (userIds.length > 0) {
    const { data: profiles } = await sb
      .from('profiles')
      .select('id, username')
      .in('id', userIds);
    if (profiles) profilesMap = Object.fromEntries(profiles.map(p => [p.id, p.username]));
  }

  poops.forEach(poop => {
    const isOwn = poop.user_id === currentUser.id;
    const icon = L.divIcon({
      html: `<div class="poop-marker">${isOwn ? '💩' : '🟤'}</div>`,
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([poop.latitude, poop.longitude], { icon })
      .addTo(map)
      .on('click', () => showPoopDetails(poop, profilesMap[poop.user_id] || 'неизвестно', isOwn));

    markers.push(marker);
  });

  await renderStats(poops.filter(p => p.user_id === currentUser.id));
}

function showPoopDetails(poop, username, isOwn) {
  $('view-title').textContent = '💩 ' + (isOwn ? 'Твоя метка' : 'Метка друга');
  $('view-place').textContent = poop.place_name ? '📍 ' + poop.place_name : '';
  $('view-user').textContent = '@' + username;
  $('view-date').textContent = '📅 ' + new Date(poop.pooped_at).toLocaleString('ru-RU');
  $('view-rating-display').textContent = poop.rating ? '🚽 ' + '⭐'.repeat(poop.rating) : '';
  $('view-process').textContent = poop.process_type || '';
  $('view-note').textContent = poop.note || '';

  editingPoopId = isOwn ? poop.id : null;
  $('view-delete').classList.toggle('hidden', !isOwn);

  show('view-modal');
}

$('view-close').addEventListener('click', () => hide('view-modal'));

$('view-delete').addEventListener('click', async () => {
  if (!editingPoopId) return;
  if (!confirm('Удалить метку?')) return;

  const { error } = await sb.from('poops').delete().eq('id', editingPoopId);
  if (error) return toast('Ошибка: ' + error.message, 'error');

  hide('view-modal');
  toast('Удалено', 'success');
  await loadPoops();
});

// === ВКЛАДКИ ===
$('tab-map').addEventListener('click', () => switchTab('map'));
$('tab-friends').addEventListener('click', () => switchTab('friends'));
$('tab-stats').addEventListener('click', () => switchTab('stats'));

function switchTab(name) {
  ['map', 'friends', 'stats'].forEach(t => {
    $('tab-' + t).classList.toggle('active', t === name);
    $(t + '-view').classList.toggle('hidden', t !== name);
  });
  if (name === 'map' && map) {
    setTimeout(() => map.invalidateSize(), 100);
  }
  if (name === 'friends') loadFriends();
  if (name === 'stats') renderStats();
}

// === ДРУЗЬЯ ===
$('friend-search-btn').addEventListener('click', searchFriends);
$('friend-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchFriends();
});

async function searchFriends() {
  const query = $('friend-search').value.trim();
  if (!query) return;

  const { data, error } = await sb
    .from('profiles')
    .select('id, username')
    .ilike('username', '%' + query + '%')
    .neq('id', currentUser.id)
    .limit(20);

  const container = $('search-results');
  container.innerHTML = '';

  if (error) {
    container.innerHTML = `<p class="empty">Ошибка: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = '<p class="empty">Никого не найдено</p>';
    return;
  }

  // Проверим существующие связи
  const { data: existing } = await sb
    .from('friendships')
    .select('*')
    .or(`requester_id.eq.${currentUser.id},addressee_id.eq.${currentUser.id}`);

  data.forEach(user => {
    const friendship = existing?.find(f =>
      f.requester_id === user.id || f.addressee_id === user.id
    );

    const card = document.createElement('div');
    card.className = 'user-card';

    let statusBtn = '';
    if (!friendship) {
      statusBtn = `<button onclick="sendRequest('${user.id}')">+ Добавить</button>`;
    } else if (friendship.status === 'accepted') {
      statusBtn = `<span class="muted">Уже друзья</span>`;
    } else if (friendship.requester_id === currentUser.id) {
      statusBtn = `<span class="muted">Запрос отправлен</span>`;
    } else {
      statusBtn = `<button onclick="acceptRequest('${friendship.id}')">Принять</button>`;
    }

    card.innerHTML = `<div class="username">@${user.username}</div><div>${statusBtn}</div>`;
    container.appendChild(card);
  });
}

window.sendRequest = async function(userId) {
  const { error } = await sb.from('friendships').insert({
    requester_id: currentUser.id,
    addressee_id: userId,
    status: 'pending'
  });
  if (error) return toast('Ошибка: ' + error.message, 'error');
  toast('Запрос отправлен', 'success');
  searchFriends();
  loadFriends();
};

window.acceptRequest = async function(friendshipId) {
  const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
  if (error) return toast('Ошибка: ' + error.message, 'error');
  toast('Теперь вы друзья 🎉', 'success');
  loadFriends();
  loadPoops();
};

window.removeFriend = async function(friendshipId) {
  if (!confirm('Удалить из друзей?')) return;
  const { error } = await sb.from('friendships').delete().eq('id', friendshipId);
  if (error) return toast('Ошибка: ' + error.message, 'error');
  toast('Удалено', 'success');
  loadFriends();
  loadPoops();
};

async function loadFriends() {
  // Заявки
  const { data: pending } = await sb
    .from('friendships')
    .select('*')
    .eq('addressee_id', currentUser.id)
    .eq('status', 'pending');

  const pendingContainer = $('pending-requests');
  pendingContainer.innerHTML = '';

  if (!pending || pending.length === 0) {
    pendingContainer.innerHTML = '<p class="empty">Заявок нет</p>';
  } else {
    const reqIds = pending.map(p => p.requester_id);
    const { data: profs } = await sb.from('profiles').select('id, username').in('id', reqIds);
    const profMap = Object.fromEntries((profs || []).map(p => [p.id, p.username]));

    pending.forEach(p => {
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = `
        <div class="username">@${profMap[p.requester_id] || '?'}</div>
        <div>
          <button onclick="acceptRequest('${p.id}')">Принять</button>
          <button class="danger" onclick="removeFriend('${p.id}')">Отклонить</button>
        </div>
      `;
      pendingContainer.appendChild(card);
    });
  }

  // Друзья
  const { data: friends } = await sb
    .from('friendships')
    .select('*')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${currentUser.id},addressee_id.eq.${currentUser.id}`);

  const friendsContainer = $('friends-list');
  friendsContainer.innerHTML = '';

  if (!friends || friends.length === 0) {
    friendsContainer.innerHTML = '<p class="empty">Пока никого. Найди друзей выше!</p>';
    return;
  }

  const otherIds = friends.map(f =>
    f.requester_id === currentUser.id ? f.addressee_id : f.requester_id
  );
  const { data: profs } = await sb.from('profiles').select('id, username').in('id', otherIds);
  const profMap = Object.fromEntries((profs || []).map(p => [p.id, p.username]));

  friends.forEach(f => {
    const otherId = f.requester_id === currentUser.id ? f.addressee_id : f.requester_id;
    const card = document.createElement('div');
    card.className = 'user-card';
    card.innerHTML = `
      <div class="username">@${profMap[otherId] || '?'}</div>
      <div><button class="danger" onclick="removeFriend('${f.id}')">Удалить</button></div>
    `;
    friendsContainer.appendChild(card);
  });
}

// === СТАТИСТИКА ===
async function renderStats(myPoopsArg) {
  let myPoops = myPoopsArg;
  if (!myPoops) {
    const { data } = await sb.from('poops').select('*').eq('user_id', currentUser.id);
    myPoops = data || [];
  }

  const total = myPoops.length;
  const avgRating = myPoops.filter(p => p.rating).length > 0
    ? (myPoops.filter(p => p.rating).reduce((a, p) => a + p.rating, 0) /
       myPoops.filter(p => p.rating).length).toFixed(1)
    : '—';

  const uniqueDays = new Set(myPoops.map(p => p.pooped_at.slice(0,10))).size;
  const last = myPoops.length > 0
    ? new Date(Math.max(...myPoops.map(p => new Date(p.pooped_at)))).toLocaleString('ru-RU')
    : '—';

  const processCounts = {};
  myPoops.forEach(p => {
    if (p.process_type) processCounts[p.process_type] = (processCounts[p.process_type] || 0) + 1;
  });
  const topProcess = Object.keys(processCounts)
    .sort((a, b) => processCounts[b] - processCounts[a])[0] || '—';

  $('stats-content').innerHTML = `
    <div class="stat-card">
      <div class="big-num">${total}</div>
      <div class="label">всего меток 💩</div>
    </div>
    <div class="stat-card">
      <div class="big-num">${avgRating}</div>
      <div class="label">средняя оценка туалета 🚽</div>
    </div>
    <div class="stat-card">
      <div class="big-num">${uniqueDays}</div>
      <div class="label">дней активности</div>
    </div>
    <div class="stat-card">
      <div class="label">любимый формат:</div>
      <div style="font-size: 18px; margin-top: 4px;">${topProcess}</div>
    </div>
    <div class="stat-card">
      <div class="label">последний раз:</div>
      <div style="font-size: 16px; margin-top: 4px;">${last}</div>
    </div>
  `;

  renderAchievements(myPoops);
}

// === ДОСТИЖЕНИЯ ===
const ACHIEVEMENTS = [
  { emoji: '🥇', title: 'Первый блин', desc: 'Первая метка', test: s => s.total >= 1 },
  { emoji: '🔟', title: 'Десяточка', desc: '10 меток', test: s => s.total >= 10 },
  { emoji: '💯', title: 'Сотка', desc: '100 меток', test: s => s.total >= 100 },
  { emoji: '⭐', title: 'Критик', desc: 'Оценка туалета 5⭐', test: s => s.maxRating >= 5 },
  { emoji: '🌙', title: 'Полночный экспресс', desc: 'Метка ночью (00–05)', test: s => s.nightOwl },
  { emoji: '📅', title: 'Постоянство', desc: 'Метки в 7 разных дней', test: s => s.uniqueDays >= 7 },
  { emoji: '🔥', title: 'Серия', desc: '3 дня подряд', test: s => s.maxStreak >= 3 },
  { emoji: '🗺️', title: 'Картограф', desc: '5 меток с заведением', test: s => s.withPlace >= 5 },
  { emoji: '🧪', title: 'Исследователь', desc: '5 разных форматов', test: s => s.distinctProcess >= 5 },
];

function computeAchStats(myPoops) {
  const days = [...new Set(myPoops.map(p => p.pooped_at.slice(0, 10)))].sort();
  let maxStreak = days.length ? 1 : 0, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((new Date(days[i]) - new Date(days[i - 1])) / 86400000);
    if (diff === 1) { cur++; maxStreak = Math.max(maxStreak, cur); } else { cur = 1; }
  }
  return {
    total: myPoops.length,
    maxRating: myPoops.reduce((m, p) => Math.max(m, p.rating || 0), 0),
    nightOwl: myPoops.some(p => { const h = new Date(p.pooped_at).getHours(); return h >= 0 && h < 5; }),
    uniqueDays: days.length,
    maxStreak,
    withPlace: myPoops.filter(p => p.place_name).length,
    distinctProcess: new Set(myPoops.filter(p => p.process_type).map(p => p.process_type)).size,
  };
}

function renderAchievements(myPoops) {
  const el = $('achievements');
  if (!el) return;
  const s = computeAchStats(myPoops);
  const unlocked = ACHIEVEMENTS.filter(a => a.test(s)).length;
  const title = $('ach-title');
  if (title) title.textContent = `Достижения 🏆 (${unlocked}/${ACHIEVEMENTS.length})`;
  el.innerHTML = ACHIEVEMENTS.map(a => {
    const got = a.test(s);
    return `<div class="badge ${got ? 'unlocked' : ''}">
        <div class="emoji">${a.emoji}</div>
        <div class="b-title">${a.title}</div>
        <div class="b-desc">${a.desc}</div>
      </div>`;
  }).join('');
}

// === ПОДПИСЬ (Borat) ===
const BORAT_LINES = [
  'Очень мило! Большой успех! 👍',
  'Ва-ва-ви-ва! 😲',
  'Дай пять! ✋',
  'Моя жена! 👰',
  'Мне очень нравится! 😎',
  'Чёткенько 🤙',
];
(function setBoratLine() {
  const el = $('borat-line');
  if (el) el.textContent = BORAT_LINES[Math.floor(Math.random() * BORAT_LINES.length)];
})();

// === START ===
checkAuth();

// === PWA ===
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
