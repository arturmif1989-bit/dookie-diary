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
let tileLayer = null;
let markerCluster = null;
let profileNames = {}; // id -> username (для просмотра профиля друга)
let profileColors = {}; // id -> marker_color
let editPoopId = null;  // id метки, которую сейчас редактируем (null = новая)
let viewedPoop = null;  // метка, открытая в окне просмотра
let foundPlace = null;  // последнее найденное через поиск место {lat, lng, name}
let mapFilter = { owner: 'all', minRating: 0, process: '' }; // фильтр карты

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

// Палитра цветов метки (выбирается в профиле). 6×5 = 30.
const MARKER_COLORS = [
  '#e74c3c', '#c0392b', '#e67e22', '#d35400', '#f39c12', '#f1c40f',
  '#cddc39', '#8bc34a', '#4caf50', '#27ae60', '#16a085', '#009688',
  '#00bcd4', '#03a9f4', '#2196f3', '#3f51b5', '#673ab7', '#9b59b6',
  '#9c27b0', '#e91e63', '#ff6f91', '#ff5722', '#795548', '#5d4037',
  '#607d8b', '#455a64', '#9e9e9e', '#2c3e50', '#ff9800', '#ffc107',
];
const DEFAULT_MARKER_COLOR = '#ffffff';
const REACTION_EMOJIS = ['👍', '😂', '🤢', '🔥', '💩'];
// Только настоящий hex-цвет — защита от подстановки произвольного значения в разметку
function safeColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_MARKER_COLOR;
}

// === HELPERS ===
function $(id) { return document.getElementById(id); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// Экранируем пользовательский текст перед вставкой через innerHTML (защита от XSS)
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

$('show-signup').addEventListener('click', () => show('signup-modal'));
$('show-signin').addEventListener('click', () => hide('signup-modal'));

$('signup-btn').addEventListener('click', async () => {
  const username = $('signup-username').value.trim();
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;

  if (!username || username.length < 3) return toast('Никнейм минимум 3 символа', 'error');
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(username)) return toast('Никнейм: только буквы, цифры, пробел, _ . -', 'error');
  if (!email) return toast('Введите email', 'error');
  if (password.length < 6) return toast('Пароль минимум 6 символов', 'error');

  $('signup-btn').disabled = true;
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { username } }
  });
  $('signup-btn').disabled = false;

  if (error) return toast(error.message, 'error');
  if (data.user && !data.session) {
    hide('signup-modal');
    toast('Проверь почту для подтверждения 📬', 'success');
  } else if (data.session) {
    currentUser = data.user;
    hide('signup-modal');
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
  updateFriendsBadge();
}

// === ТЕМА / ЭФФЕКТЫ / УТИЛИТЫ ===
function getTileLayer() {
  const dark = document.body.classList.contains('dark');
  return dark
    ? L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap, © CARTO', maxZoom: 19, detectRetina: true })
    : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19, detectRetina: true });
}

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  const tb = $('theme-btn');
  if (tb) tb.textContent = dark ? '☀️' : '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#1c1410' : '#6b4423';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  if (map && tileLayer) {
    map.removeLayer(tileLayer);
    tileLayer = getTileLayer().addTo(map);
  }
}

$('theme-btn').addEventListener('click', () => {
  applyTheme(!document.body.classList.contains('dark'));
});

// применяем сохранённую тему сразу при загрузке
applyTheme(localStorage.getItem('theme') === 'dark');

function ratingColor(r) {
  return ['#9e9e9e', '#c0392b', '#e67e22', '#f1c40f', '#7cb342', '#27ae60'][r || 0];
}

function poopConfetti() {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for (let i = 0; i < 24; i++) {
    const s = document.createElement('span');
    s.textContent = '💩';
    s.style.left = Math.random() * 100 + 'vw';
    s.style.animationDelay = (Math.random() * 0.4) + 's';
    s.style.fontSize = (16 + Math.random() * 20) + 'px';
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2500);
}

async function updateFriendsBadge() {
  const { count } = await sb.from('friendships')
    .select('*', { count: 'exact', head: true })
    .eq('addressee_id', currentUser.id)
    .eq('status', 'pending');
  const b = $('friends-badge');
  if (!b) return;
  if (count && count > 0) { b.textContent = count; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

// === КАРТА ===
function initMap() {
  if (map) return;

  map = L.map('map').setView([55.7558, 37.6173], 11); // дефолт — Москва
  map.attributionControl.setPrefix(false); // убрать подпись/флажок Leaflet, оставить © OSM

  tileLayer = getTileLayer().addTo(map);

  markerCluster = L.markerClusterGroup({ maxClusterRadius: 45 });
  map.addLayer(markerCluster);

  // Клик по карте в режиме добавления — ставим точную метку
  map.on('click', (e) => {
    if (!addingMode) return;
    const ll = e.latlng.wrap(); // нормализуем долготу в -180..180 (карта прокручивается бесконечно)
    pendingLatLng = { lat: ll.lat, lng: ll.lng };
    setAddingMode(false);
    openAddModal();
  });

  // прячем кнопку «Отметиться здесь» при ручном перемещении карты
  map.on('dragstart', () => $('search-here-btn').classList.add('hidden'));

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
  addAtMyLocation();
});

// Тап «+» → сразу берём текущее место по GPS и открываем окно
function addAtMyLocation() {
  if (!navigator.geolocation) {
    setAddingMode(true);
    toast('Геолокация недоступна — выбери точку на карте 👇');
    return;
  }
  toast('Определяю место… 📍');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      pendingLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (map) map.setView([pendingLatLng.lat, pendingLatLng.lng], 16);
      openAddModal();
    },
    () => {
      setAddingMode(true);
      toast('Не удалось определить место — выбери точку на карте 👇');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// «Указать точнее на карте» из окна метки
$('pick-on-map').addEventListener('click', () => {
  hide('add-modal');
  setAddingMode(true);
  toast('Нажми на карту, где поставить метку 💩');
});

// === ПОИСК МЕСТА (OpenStreetMap / Nominatim) ===
async function searchPlace() {
  const q = $('map-search-input').value.trim();
  if (!q) return;
  const btn = $('map-search-btn');
  btn.disabled = true;
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&q=' + encodeURIComponent(q);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (!data || data.length === 0) { toast('Ничего не найдено 🤷', 'error'); return; }
    const place = data[0];
    const lat = parseFloat(place.lat), lon = parseFloat(place.lon);
    if (!isFinite(lat) || !isFinite(lon)) { toast('Ничего не найдено 🤷', 'error'); return; }
    if (map) map.setView([lat, lon], 16);
    const name = (place.display_name || q).split(',').slice(0, 2).join(',');
    foundPlace = { lat, lng: lon, name };
    $('search-here-btn').classList.remove('hidden');
    toast('📍 ' + name, 'success');
  } catch (e) {
    toast('Поиск недоступен, попробуй ещё раз', 'error');
  } finally {
    btn.disabled = false;
  }
}

$('map-search-btn').addEventListener('click', searchPlace);
$('map-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchPlace(); }
});

// Кнопка «где я» — центрируем карту на текущем GPS и ставим точку «ты здесь»
let myLocMarker = null;
$('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Геолокация недоступна', 'error');
  toast('Ищу тебя… 📍');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (map) map.setView([latitude, longitude], 16);
      const icon = L.divIcon({ html: '<div class="me-dot"></div>', className: '', iconSize: [20, 20], iconAnchor: [10, 10] });
      if (myLocMarker) myLocMarker.setLatLng([latitude, longitude]);
      else if (map) myLocMarker = L.marker([latitude, longitude], { icon, zIndexOffset: 2000 }).addTo(map);
    },
    () => toast('Не удалось определить место', 'error'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// «Отметиться здесь» — ставим метку в найденном месте, имя подставляем
$('search-here-btn').addEventListener('click', () => {
  if (!foundPlace) return;
  pendingLatLng = { lat: foundPlace.lat, lng: foundPlace.lng };
  $('search-here-btn').classList.add('hidden');
  openAddModal();
  $('poop-place').value = foundPlace.name;
});

function openAddModal() {
  editPoopId = null;
  $('add-title').textContent = 'Новая метка 💩';
  $('pick-on-map').style.display = '';
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

  const { lat, lng } = pendingLatLng;
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return toast('Кривые координаты — выбери место заново', 'error');
  }

  const payload = {
    latitude: lat,
    longitude: lng,
    place_name: place || null,
    note: note || null,
    rating: selectedRating || null,
    process_type: selectedProcess || null,
    pooped_at: new Date(dateStr).toISOString()
  };

  $('modal-save').disabled = true;
  let error;
  if (editPoopId) {
    ({ error } = await sb.from('poops').update(payload).eq('id', editPoopId));
  } else {
    ({ error } = await sb.from('poops').insert({ user_id: currentUser.id, ...payload }));
  }
  $('modal-save').disabled = false;

  if (error) {
    toast('Ошибка: ' + error.message, 'error');
    return;
  }

  const wasEdit = !!editPoopId;
  editPoopId = null;
  hide('add-modal');
  if (wasEdit) {
    toast('Изменено ✏️', 'success');
  } else {
    poopConfetti();
  }
  await loadPoops();
  if (!wasEdit) announceNearby(pendingLatLng);
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
  markerCluster.clearLayers();
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
      .select('id, username, marker_color')
      .in('id', userIds);
    if (profiles) {
      profilesMap = Object.fromEntries(profiles.map(p => [p.id, p.username]));
      profiles.forEach(p => { profileColors[p.id] = p.marker_color; });
    }
    Object.assign(profileNames, profilesMap);
  }

  poops.filter(matchesFilter).forEach(poop => {
    const isOwn = poop.user_id === currentUser.id;
    const ownerColor = safeColor(profileColors[poop.user_id]);
    const icon = L.divIcon({
      html: `<div class="poop-pin" style="background:${ownerColor};border-color:${ratingColor(poop.rating)}">💩</div>`,
      className: '',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });

    const marker = L.marker([poop.latitude, poop.longitude], { icon })
      .on('click', () => showPoopDetails(poop, profilesMap[poop.user_id] || 'неизвестно', isOwn));
    markerCluster.addLayer(marker);

    markers.push(marker);
  });

  const myTotal = poops.filter(p => p.user_id === currentUser.id).length;
  $('map-hint').classList.toggle('hidden', myTotal > 0);

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
  viewedPoop = poop;
  $('view-delete').classList.toggle('hidden', !isOwn);
  $('view-edit').classList.toggle('hidden', !isOwn);

  loadReactions(poop.id);
  show('view-modal');
}

// === РЕАКЦИИ НА МЕТКИ ===
async function loadReactions(poopId) {
  const box = $('view-reactions');
  if (!box) return;
  box.dataset.poopId = poopId;
  const { data } = await sb.from('reactions').select('user_id, emoji').eq('poop_id', poopId);
  const counts = {};
  const mine = new Set();
  (data || []).forEach(r => {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (r.user_id === currentUser.id) mine.add(r.emoji);
  });
  box.innerHTML = REACTION_EMOJIS.map(e => {
    const c = counts[e] || 0;
    return `<button class="react-btn${mine.has(e) ? ' reacted' : ''}" onclick="toggleReaction('${poopId}','${e}')">${e}${c ? ' ' + c : ''}</button>`;
  }).join('');
}

window.toggleReaction = async function(poopId, emoji) {
  const { data } = await sb.from('reactions')
    .select('id')
    .eq('poop_id', poopId).eq('user_id', currentUser.id).eq('emoji', emoji)
    .limit(1);
  if (data && data.length) {
    await sb.from('reactions').delete().eq('id', data[0].id);
  } else {
    const { error } = await sb.from('reactions').insert({ poop_id: poopId, user_id: currentUser.id, emoji });
    if (error) { toast('Ошибка: ' + error.message, 'error'); return; }
  }
  loadReactions(poopId);
};

$('view-close').addEventListener('click', () => hide('view-modal'));
$('friend-stats-close').addEventListener('click', () => hide('friend-stats-modal'));

// Открыть метку на редактирование (своя метка)
function openEditModal(poop) {
  if (!poop) return;
  hide('view-modal');
  pendingLatLng = { lat: poop.latitude, lng: poop.longitude };
  const d = new Date(poop.pooped_at);
  const tz = d.getTimezoneOffset() * 60000;
  $('poop-date').value = new Date(d - tz).toISOString().slice(0, 16);
  $('poop-place').value = poop.place_name || '';
  $('poop-note').value = poop.note || '';
  selectedRating = poop.rating || 0;
  updateRatingUI();
  selectedProcess = poop.process_type || null;
  renderProcessChips();
  $('location-info').textContent = `📍 ${poop.latitude.toFixed(5)}, ${poop.longitude.toFixed(5)}`;
  editPoopId = poop.id;
  $('add-title').textContent = 'Изменить метку ✏️';
  $('pick-on-map').style.display = 'none';
  show('add-modal');
}
$('view-edit').addEventListener('click', () => openEditModal(viewedPoop));

// «Маршрут» — открыть метку в Яндекс.Картах с маршрутом от текущего места
$('view-route').addEventListener('click', () => {
  if (!viewedPoop) return;
  const url = `https://yandex.ru/maps/?rtext=~${viewedPoop.latitude},${viewedPoop.longitude}&rtt=auto`;
  window.open(url, '_blank');
});

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
$('tab-feed').addEventListener('click', () => switchTab('feed'));
$('tab-list').addEventListener('click', () => switchTab('list'));

function switchTab(name) {
  ['map', 'friends', 'stats', 'feed', 'list'].forEach(t => {
    $('tab-' + t).classList.toggle('active', t === name);
    $(t + '-view').classList.toggle('hidden', t !== name);
  });
  if (name === 'map' && map) {
    setTimeout(() => map.invalidateSize(), 100);
    loadPoops(); // подтягиваем свежие метки (в т.ч. новые метки друзей)
  }
  if (name === 'friends') loadFriends();
  if (name === 'stats') renderStats();
  if (name === 'feed') loadFeed();
  if (name === 'list') loadList();
}

// === ФИЛЬТР КАРТЫ ===
function matchesFilter(p) {
  if (mapFilter.owner === 'mine' && p.user_id !== currentUser.id) return false;
  if (mapFilter.owner !== 'all' && mapFilter.owner !== 'mine' && p.user_id !== mapFilter.owner) return false;
  if (mapFilter.minRating && (!p.rating || p.rating < mapFilter.minRating)) return false;
  if (mapFilter.process && p.process_type !== mapFilter.process) return false;
  return true;
}

function openFilterModal() {
  const others = [...new Set(allPoops.map(p => p.user_id))].filter(id => id !== currentUser.id);
  let opts = '<option value="all">Все</option><option value="mine">Только мои</option>';
  others.forEach(id => { opts += `<option value="${id}">@${escapeHtml(profileNames[id] || '?')}</option>`; });
  $('filter-owner').innerHTML = opts;
  $('filter-owner').value = mapFilter.owner;
  $('filter-process').innerHTML = '<option value="">Любой</option>' +
    PROCESS_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  $('filter-process').value = mapFilter.process;
  $('filter-rating').value = String(mapFilter.minRating);
  show('filter-modal');
}

function updateFilterBtn() {
  const active = mapFilter.owner !== 'all' || mapFilter.minRating || mapFilter.process;
  $('filter-btn').classList.toggle('active', !!active);
}

$('filter-btn').addEventListener('click', openFilterModal);
$('filter-apply').addEventListener('click', () => {
  mapFilter.owner = $('filter-owner').value;
  mapFilter.minRating = parseInt($('filter-rating').value) || 0;
  mapFilter.process = $('filter-process').value;
  hide('filter-modal');
  updateFilterBtn();
  loadPoops();
});
$('filter-reset').addEventListener('click', () => {
  mapFilter = { owner: 'all', minRating: 0, process: '' };
  hide('filter-modal');
  updateFilterBtn();
  loadPoops();
});

// === СПИСОК СВОИХ МЕТОК ===
$('list-search').addEventListener('input', loadList);
$('list-sort').addEventListener('change', loadList);

async function loadList() {
  const container = $('list-content');
  let mine = allPoops.filter(p => p.user_id === currentUser.id);
  if (!mine.length) {
    const { data } = await sb.from('poops').select('*').eq('user_id', currentUser.id);
    mine = data || [];
  }
  const q = $('list-search').value.trim().toLowerCase();
  if (q) mine = mine.filter(p => (p.place_name || '').toLowerCase().includes(q));
  const sort = $('list-sort').value;
  mine = mine.slice().sort((a, b) => {
    if (sort === 'date_asc') return new Date(a.pooped_at) - new Date(b.pooped_at);
    if (sort === 'rating_desc') return (b.rating || 0) - (a.rating || 0);
    if (sort === 'rating_asc') return (a.rating || 0) - (b.rating || 0);
    return new Date(b.pooped_at) - new Date(a.pooped_at);
  });
  if (!mine.length) {
    container.innerHTML = '<p class="empty">Меток нет. Поставь первую на карте!</p>';
    return;
  }
  container.innerHTML = '';
  mine.forEach(poop => {
    const place = poop.place_name ? escapeHtml(poop.place_name) : 'без названия';
    const stars = poop.rating ? '🚽 ' + '⭐'.repeat(poop.rating) : '';
    const when = new Date(poop.pooped_at).toLocaleDateString('ru-RU');
    const proc = poop.process_type ? escapeHtml(poop.process_type) : '';
    const card = document.createElement('div');
    card.className = 'list-item';
    card.innerHTML = `<div class="list-main">📍 ${place}</div><div class="list-meta">${when} · ${stars} ${proc}</div>`;
    card.addEventListener('click', () => {
      switchTab('map');
      if (map) map.setView([poop.latitude, poop.longitude], 16);
      showPoopDetails(poop, profileNames[poop.user_id] || 'ты', true);
    });
    container.appendChild(card);
  });
}

// === ЛЕНТА АКТИВНОСТИ (свои + друзей, по RLS) ===
async function loadFeed() {
  const container = $('feed-content');
  container.innerHTML = '<p class="empty">Загрузка…</p>';
  const { data: poops, error } = await sb
    .from('poops')
    .select('*')
    .order('pooped_at', { ascending: false })
    .limit(30);
  if (error) {
    container.innerHTML = `<p class="empty">Ошибка: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!poops || poops.length === 0) {
    container.innerHTML = '<p class="empty">Пока пусто. Поставь метку или добавь друзей!</p>';
    return;
  }
  const ids = [...new Set(poops.map(p => p.user_id))];
  const { data: profs } = await sb.from('profiles').select('id, username, marker_color').in('id', ids);
  (profs || []).forEach(p => { profileNames[p.id] = p.username; profileColors[p.id] = p.marker_color; });

  container.innerHTML = '';
  poops.forEach(poop => {
    const who = escapeHtml(profileNames[poop.user_id] || '?');
    const mine = poop.user_id === currentUser.id;
    const color = safeColor(profileColors[poop.user_id]);
    const place = poop.place_name ? escapeHtml(poop.place_name) : 'где-то';
    const stars = poop.rating ? '🚽 ' + '⭐'.repeat(poop.rating) : '';
    const proc = poop.process_type ? escapeHtml(poop.process_type) : '';
    const when = new Date(poop.pooped_at).toLocaleString('ru-RU');
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <div class="feed-pin" style="background:${color}">💩</div>
      <div class="feed-body">
        <div class="feed-top"><b>@${who}${mine ? ' · ты' : ''}</b> · 📍 ${place}</div>
        <div class="feed-meta">${stars} ${proc}</div>
        <div class="feed-date">${when}</div>
      </div>
    `;
    container.appendChild(card);
  });
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
    container.innerHTML = `<p class="empty">Ошибка: ${escapeHtml(error.message)}</p>`;
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

    card.innerHTML = `<div class="username">@${escapeHtml(user.username)}</div><div>${statusBtn}</div>`;
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
  updateFriendsBadge();
};

window.acceptRequest = async function(friendshipId) {
  const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
  if (error) return toast('Ошибка: ' + error.message, 'error');
  toast('Теперь вы друзья 🎉', 'success');
  loadFriends();
  loadPoops();
  updateFriendsBadge();
};

window.removeFriend = async function(friendshipId) {
  if (!confirm('Удалить из друзей?')) return;
  const { error } = await sb.from('friendships').delete().eq('id', friendshipId);
  if (error) return toast('Ошибка: ' + error.message, 'error');
  toast('Удалено', 'success');
  loadFriends();
  loadPoops();
  updateFriendsBadge();
};

// Просмотр статистики и достижений друга (данные уже в allPoops по RLS)
window.showFriendStats = function(userId) {
  const username = profileNames[userId] || '?';
  const poops = allPoops.filter(p => p.user_id === userId);
  const total = poops.length;
  const rated = poops.filter(p => p.rating);
  const avg = rated.length
    ? (rated.reduce((a, p) => a + p.rating, 0) / rated.length).toFixed(1)
    : '—';
  const s = computeAchStats(poops);
  const unlocked = ACHIEVEMENTS.filter(a => a.test(s)).length;

  $('friend-stats-title').textContent = '@' + username;
  $('friend-stats-body').innerHTML = `
    <div class="stat-card"><div class="big-num">${total}</div><div class="label">меток 💩</div></div>
    <div class="stat-card"><div class="big-num">${avg}</div><div class="label">средняя оценка 🚽</div></div>
    <div class="stat-card"><div class="big-num">${s.uniqueDays}</div><div class="label">дней активности</div></div>
    <h2 style="margin-top:14px;">Достижения 🏆 (${unlocked}/${ACHIEVEMENTS.length})</h2>
    <div class="achievements">${ACHIEVEMENTS.map(a => {
      const got = a.test(s);
      return `<div class="badge ${got ? 'unlocked' : ''}">
          <div class="emoji">${a.emoji}</div>
          <div class="b-title">${a.title}</div>
          <div class="b-desc">${a.desc}</div>
        </div>`;
    }).join('')}</div>
  `;
  show('friend-stats-modal');
};

// === ЦВЕТ МЕТКИ (профиль) ===
async function openColorModal() {
  const { data } = await sb.from('profiles').select('marker_color').eq('id', currentUser.id).single();
  const current = data ? data.marker_color : null;
  $('color-grid').innerHTML = MARKER_COLORS.map(c =>
    `<div class="color-swatch${c === current ? ' selected' : ''}" style="background:${c}" onclick="pickColor('${c}')">💩</div>`
  ).join('');
  show('color-modal');
}

window.pickColor = async function(color) {
  const safe = safeColor(color);
  const { error } = await sb.from('profiles').update({ marker_color: safe }).eq('id', currentUser.id);
  if (error) return toast('Ошибка: ' + error.message, 'error');
  profileColors[currentUser.id] = safe;
  hide('color-modal');
  toast('Цвет метки обновлён 🎨', 'success');
  loadPoops();
};

$('color-btn').addEventListener('click', openColorModal);
$('color-close').addEventListener('click', () => hide('color-modal'));

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
        <div class="username">@${escapeHtml(profMap[p.requester_id] || '?')}</div>
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
  Object.assign(profileNames, profMap);

  friends.forEach(f => {
    const otherId = f.requester_id === currentUser.id ? f.addressee_id : f.requester_id;
    const card = document.createElement('div');
    card.className = 'user-card';
    card.innerHTML = `
      <div class="username" style="cursor:pointer" onclick="showFriendStats('${otherId}')">@${escapeHtml(profMap[otherId] || '?')} 📊</div>
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
  'Мой жена! 👰',
  'Як ше маш! 👋',
  'Если покупаешь тачка, пусть в ней будет бабий магнит 🚗',
  'На трон села, на трон села! Царь во дворца, царь во дворца! Ходи то, делай сюда — царь во дворца! 👑',
  'А я плов кушаю, никого не слушаю! 🍚',
  'Сэр, вы заслуживаете медаль «За выдающиеся способности» 🏅',
  'Нраица! 🤙',
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

// Подсказка «Установить на телефон»
let deferredInstallPrompt = null;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

function showInstallBanner(text, withButton) {
  if (isStandalone || localStorage.getItem('installDismissed')) return;
  const banner = $('install-banner');
  if (!banner) return;
  $('install-text').textContent = text;
  $('install-btn').style.display = withButton ? '' : 'none';
  banner.classList.remove('hidden');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner('📲 Добавь «Какарту» на телефон', true);
});

$('install-btn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('install-banner').classList.add('hidden');
});

$('install-close').addEventListener('click', () => {
  $('install-banner').classList.add('hidden');
  localStorage.setItem('installDismissed', '1');
});

// iOS Safari не даёт кнопку установки — показываем инструкцию
if (isIOS && !isStandalone) {
  showInstallBanner('📲 Установить: «Поделиться» → «На экран «Домой»»', false);
}
