import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const el = (id) => document.getElementById(id);
const HOUR = 3600;
const DEFAULT_POLAR = THREE.MathUtils.degToRad(36); // ~54 fokos rálátás a földtől számítva

// --- 0. Névtelen Böngésző Session Token & Elmentett Meghívókulcsok ("Lábtörlő alatti kulcsok") ---
function getSessionToken() {
  let tok = localStorage.getItem('kisfalu_session_token');
  if (!tok) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    tok = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 28);
    localStorage.setItem('kisfalu_session_token', tok);
  }
  return tok;
}
const SESSION_TOKEN = getSessionToken();

function getSavedInviteKeys() {
  try {
    return JSON.parse(localStorage.getItem('kisfalu_invite_keys') || '{}');
  } catch {
    return {};
  }
}
function saveInviteKeyForHouse(houseName, key) {
  const keys = getSavedInviteKeys();
  keys[houseName.toLowerCase()] = key;
  localStorage.setItem('kisfalu_invite_keys', JSON.stringify(keys));
}

// --- 0.5 Statikus / GitHub Pages LocalStorage Backend Emulátor ---
// Ha az oldal GitHub Pages-en (vagy bármilyen statikus tárhelyen, Node.js szerver nélkül) fut,
// minden /api/... végpontot (DM fiók-összekötés, szobaberendezés, zárt ház meghívók, ajándékozás, új lakos)
// automatikusan és transzparensen a böngésző localStorage adatbázisából szolgálunk ki!
const STARTER_CATALOG = [
  { type: 'agy', label: '🛏️ Faágy', defaultPlaced: true, x: -2.1, z: -1.6, rot: 0 },
  { type: 'asztal', label: '🪑 Ebédlőasztal', defaultPlaced: true, x: 1.2, z: -0.5, rot: 0 },
  { type: 'szek', label: '🪑 Faszék', defaultPlaced: true, x: 1.2, z: 0.7, rot: Math.PI },
  { type: 'szonyeg', label: '🧶 Szőtt szőnyeg', defaultPlaced: true, x: 0, z: 0.2, rot: 0 },
  { type: 'kandallo', label: '🔥 Kandalló', defaultPlaced: false, x: 0, z: -2.4, rot: 0 },
  { type: 'trofea', label: '🦌 Szarvasagancs', defaultPlaced: false, x: -2.2, z: 1.4, rot: Math.PI / 2 },
  { type: 'lada', label: '🧰 Kincsesláda', defaultPlaced: false, x: 2.2, z: -1.8, rot: 0 },
  { type: 'bogracs_disz', label: '🍲 Arany Bogrács', defaultPlaced: false, x: -0.8, z: 1.4, rot: 0 },
];

function randomInviteKey(len = 6) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function hashPasswordLocal(password, salt = 'bf_salt_v1') {
  const str = `${salt}:${password}`;
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${salt}:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function verifyPasswordLocal(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt] = storedHash.split(':');
  return hashPasswordLocal(password, salt) === storedHash;
}

function createDefaultRpgProfileLocal() {
  return {
    coins: 50,
    energy: 100,
    xp: 0,
    resources: { fa: 0, liszt: 0, hal: 0, tej: 0 },
    cooldowns: {},
    stats: { worksDone: 0, visitedFoter: false, boughtFurniture: false, votedOption: null },
    claimedQuests: {},
    votes: { pekseg: 48, ortorony: 39, konyvtar: 27 },
    lastEnergyUpdate: Date.now(),
  };
}

function createStarterHouseLocal(username, index = 0, passwordHash = null) {
  const isPrivateDefault = index === 1 || index === 5;
  const isDev = username.toLowerCase() === 'gulyas_mester';
  return {
    owner: username,
    passwordHash: isDev ? 'PROTECTED_DEVELOPER_RESERVED' : passwordHash,
    privacy: isPrivateDefault ? 'private' : 'public',
    inviteKey: randomInviteKey(6),
    guestList: [],
    rpg: createDefaultRpgProfileLocal(),
    items: STARTER_CATALOG.map((item, idx) => ({
      id: `${username}_item_${idx + 1}`,
      type: item.type,
      label: item.label,
      placed: item.defaultPlaced,
      x: item.x,
      z: item.z,
      rot: item.rot,
      giftFrom: null,
      unboxed: true,
    })),
  };
}

// Utcafronti építési telkek (minden új ház közvetlenül a falusi utcákhoz csatlakozik, bejárattal az út felé!)
const STREET_PLOTS = [
  // Déli Főutca mentén (közvetlen kapcsolat a Főtérrel és a Déli úttal)
  { x: -6.5, z: 23.5, rot: 1.57 },
  { x: 6.5, z: 23.5, rot: -1.57 },
  { x: -6.5, z: 36.5, rot: 1.57 },
  { x: 6.5, z: 36.5, rot: -1.57 },
  // Nyugati Vadász és Malom út mentén
  { x: -22.0, z: 1.5, rot: 0.0 },
  { x: -34.0, z: 1.5, rot: 0.0 },
  // Keleti Kocsma és Horgász part út mentén
  { x: 22.0, z: 1.5, rot: 0.0 },
  { x: 34.0, z: 1.5, rot: 0.0 },
  // Dél-Nyugati Betyár köz
  { x: -35.0, z: 28.0, rot: 2.1 },
  { x: -20.0, z: 44.0, rot: 2.8 },
  // Dél-Keleti Piac és Méhész köz
  { x: 36.0, z: 32.0, rot: -2.3 },
  { x: 20.0, z: 44.0, rot: -2.8 },
  // Északi Főutca (hídtól északra)
  { x: -6.5, z: -26.0, rot: 1.57 },
  { x: 6.5, z: -26.0, rot: -1.57 },
  { x: -6.5, z: -38.0, rot: 1.57 },
  { x: 6.5, z: -38.0, rot: -1.57 },
  // Észak-Nyugati Vadon út
  { x: -28.0, z: -32.0, rot: 0.8 },
  { x: -44.0, z: -32.0, rot: 0.8 },
  // Észak-Keleti Gyümölcsös út
  { x: 24.0, z: -32.0, rot: -0.8 },
  { x: 36.0, z: -38.0, rot: -0.8 },
  // Déli Mezei utcavég
  { x: 6.5, z: 46.0, rot: -1.57 },
];

function findNextPlotLocal(houses) {
  const occupied = houses.map((h) => [h.x, h.z]);
  for (const plot of STREET_PLOTS) {
    const isTaken = occupied.some(([ox, oz]) => Math.hypot(plot.x - ox, plot.z - oz) < 6.5);
    if (!isTaken) {
      return { x: plot.x, z: plot.z, rot: plot.rot };
    }
  }
  const extraIdx = houses.length - STREET_PLOTS.length;
  const side = extraIdx % 2 === 0 ? 1 : -1;
  const z = 52 + Math.floor(extraIdx / 2) * 10;
  return { x: side * 6.5, z, rot: side > 0 ? -1.57 : 1.57 };
}

let cachedVillageData = null;

function loadLocalDb() {
  let db = null;
  try {
    const raw = localStorage.getItem('kisfalu_static_db_v1');
    if (raw) db = JSON.parse(raw);
  } catch { /* fallback */ }
  if (!db) {
    db = {
      sessions: {},
      pendingClaims: {},
      houses: {},
      extraResidents: [],
      customizations: {},
    };
  }
  if (!db.sessions) db.sessions = {};
  if (!db.houses) db.houses = {};

  // Ha a korábbi verzióban be volt ragadva a gulyas_mester session, kitakarítjuk:
  if (db.sessions[SESSION_TOKEN]?.toLowerCase() === 'gulyas_mester') {
    delete db.sessions[SESSION_TOKEN];
  }
  if (db.houses['gulyas_mester']) {
    db.houses['gulyas_mester'].passwordHash = 'PROTECTED_DEVELOPER_RESERVED';
  }

  if (cachedVillageData?.residents) {
    cachedVillageData.residents.forEach((r, idx) => {
      const k = r.name.toLowerCase();
      if (!db.houses[k]) {
        db.houses[k] = createStarterHouseLocal(r.name, idx);
      }
      if (k === 'gulyas_mester') {
        db.houses[k].passwordHash = 'PROTECTED_DEVELOPER_RESERVED';
      }
    });
  }
  localStorage.setItem('kisfalu_static_db_v1', JSON.stringify(db));
  return db;
}

function saveLocalDb(db) {
  localStorage.setItem('kisfalu_static_db_v1', JSON.stringify(db));
}

function jsonResp(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function handleLocalApi(urlStr, options = {}) {
  const u = new URL(urlStr, window.location.origin);
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const db = loadLocalDb();
  const rawCurrentUser = db.sessions[SESSION_TOKEN] || localStorage.getItem('kisfalu_my_user') || null;
  const currentUser = (rawCurrentUser && rawCurrentUser.toLowerCase() !== 'gulyas_mester') ? rawCurrentUser : null;

  if (u.pathname.endsWith('/api/me') && method === 'GET') {
    const privacyMap = {};
    for (const [k, h] of Object.entries(db.houses)) privacyMap[k] = h.privacy;
    let rpg = null;
    if (currentUser) {
      const h = db.houses[currentUser.toLowerCase()];
      if (h) {
        if (!h.rpg) h.rpg = createDefaultRpgProfileLocal();
        rpg = h.rpg;
      }
    }
    return jsonResp(200, {
      username: currentUser,
      privacyMap,
      rpg,
      maxHouses: cachedVillageData?.maxHouses || 40,
      claimedCount: (cachedVillageData?.residents || []).length,
    });
  }

  if (u.pathname.endsWith('/api/auth/login') && method === 'POST') {
    const rawName = String(body.username || '').trim().replace(/^@/, '');
    const password = String(body.password || '');
    if (!rawName || !password) {
      return jsonResp(400, { error: 'Add meg a játékbeli karakternévedet és a jelszavadat!' });
    }
    if (rawName.toLowerCase() === 'gulyas_mester') {
      return jsonResp(403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
    }
    const allRes = cachedVillageData?.residents || [];
    const resident = allRes.find((r) => r.name.toLowerCase() === rawName.toLowerCase());
    if (!resident) {
      return jsonResp(404, { error: 'Ezzel a névvel még nincs ház a faluban! Foglalj magadnak új telket.' });
    }
    const key = resident.name.toLowerCase();
    if (!db.houses[key]) db.houses[key] = createStarterHouseLocal(resident.name);
    const house = db.houses[key];

    if (house.passwordHash) {
      if (!verifyPasswordLocal(password, house.passwordHash)) {
        return jsonResp(401, { error: 'Hibás jelszó ehhez a házhoz!' });
      }
    } else {
      if (password.length < 4) {
        return jsonResp(400, { error: 'A jelszónak legalább 4 karakternek kell lennie!' });
      }
      house.passwordHash = hashPasswordLocal(password);
    }

    if (!house.rpg) house.rpg = createDefaultRpgProfileLocal();
    db.sessions[SESSION_TOKEN] = resident.name;
    saveLocalDb(db);
    return jsonResp(200, { ok: true, username: resident.name, rpg: house.rpg });
  }

  if (u.pathname.endsWith('/api/rpg/sync') && method === 'POST') {
    const targetUser = currentUser || String(body.username || '').trim();
    if (!targetUser || targetUser.toLowerCase() === 'gulyas_mester') return jsonResp(403, { error: 'Nincs kiválasztott karakter.' });
    const key = targetUser.toLowerCase();
    if (!db.houses[key]) db.houses[key] = createStarterHouseLocal(targetUser);
    if (body.rpg && typeof body.rpg === 'object') {
      db.houses[key].rpg = {
        ...(db.houses[key].rpg || createDefaultRpgProfileLocal()),
        ...body.rpg,
      };
      saveLocalDb(db);
    }
    return jsonResp(200, { ok: true, rpg: db.houses[key].rpg });
  }

  if (u.pathname.endsWith('/api/claim/request') && method === 'POST') {
    const name = String(body.username || '').trim().replace(/^@/, '');
    if (name.toLowerCase() === 'gulyas_mester') {
      return jsonResp(403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
    }
    const allRes = cachedVillageData?.residents || [];
    const resident = allRes.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!resident) {
      return jsonResp(404, { error: 'Ezzel a névvel még nincs ház a faluban! Először költöztesd be.' });
    }
    const code = `BF-${Math.floor(1000 + Math.random() * 9000)}`;
    db.pendingClaims[code] = { username: resident.name, expiresAt: Date.now() + 600000 };
    saveLocalDb(db);
    return jsonResp(200, { code, username: resident.name, expiresInSec: 600 });
  }

  if (u.pathname.endsWith('/api/claim/simulate-dm') && method === 'POST') {
    const code = String(body.code || '').trim().toUpperCase();
    const pending = db.pendingClaims[code];
    if (!pending) return jsonResp(400, { error: 'Érvénytelen vagy lejárt kód.' });
    db.sessions[SESSION_TOKEN] = pending.username;
    delete db.pendingClaims[code];
    const key = pending.username.toLowerCase();
    if (!db.houses[key]) db.houses[key] = createStarterHouseLocal(pending.username);
    if (!db.houses[key].rpg) db.houses[key].rpg = createDefaultRpgProfileLocal();
    saveLocalDb(db);
    return jsonResp(200, { ok: true, username: pending.username, rpg: db.houses[key].rpg });
  }

  if (u.pathname.endsWith('/api/claim/logout') && method === 'POST') {
    delete db.sessions[SESSION_TOKEN];
    saveLocalDb(db);
    return jsonResp(200, { ok: true });
  }

  if (u.pathname.endsWith('/api/house') && method === 'GET') {
    const targetName = String(u.searchParams.get('name') || '').trim().toLowerCase();
    const providedKey = String(u.searchParams.get('key') || '').trim();
    let house = db.houses[targetName];
    if (!house) {
      const resObj = (cachedVillageData?.residents || []).find((r) => r.name.toLowerCase() === targetName);
      if (!resObj) return jsonResp(404, { error: 'A ház nem található.' });
      house = createStarterHouseLocal(resObj.name);
      db.houses[targetName] = house;
      saveLocalDb(db);
    }
    const isOwner = Boolean(currentUser && currentUser.toLowerCase() === targetName);
    const hasValidKey = Boolean(providedKey && providedKey === house.inviteKey);
    const onGuestList = Boolean(currentUser && house.guestList.some((g) => g.toLowerCase() === currentUser.toLowerCase()));
    const isPublic = house.privacy === 'public';

    if (!isOwner && !isPublic && !hasValidKey && !onGuestList) {
      return jsonResp(403, {
        allowed: false,
        privacy: house.privacy,
        owner: house.owner,
        message: 'Ez a ház zárt. Csak a tulajdonos meghívó linkjével vagy a vendéglistán szerepelve léphetsz be!',
      });
    }
    return jsonResp(200, {
      allowed: true,
      owner: house.owner,
      isOwner,
      privacy: house.privacy,
      inviteKey: isOwner ? house.inviteKey : undefined,
      guestList: isOwner ? house.guestList : undefined,
      items: house.items,
    });
  }

  if (u.pathname.endsWith('/api/house/save') && method === 'POST') {
    if (!currentUser) return jsonResp(403, { error: 'Nincs összekötött fiók.' });
    const key = currentUser.toLowerCase();
    const house = db.houses[key];
    if (!house) return jsonResp(404, { error: 'Ház nem található.' });
    if (body.privacy === 'public' || body.privacy === 'private') house.privacy = body.privacy;
    if (Array.isArray(body.guestList)) {
      house.guestList = body.guestList.map((g) => String(g).trim().replace(/^@/, '')).filter(Boolean).slice(0, 20);
    }
    if (Array.isArray(body.items)) {
      const updatedMap = new Map(body.items.map((i) => [i.id, i]));
      let placedCount = 0;
      for (const item of house.items) {
        const incoming = updatedMap.get(item.id);
        if (!incoming) continue;
        item.placed = Boolean(incoming.placed) && placedCount < 12;
        if (item.placed) placedCount++;
        item.x = Math.max(-2.6, Math.min(2.6, Number(incoming.x) || 0));
        item.z = Math.max(-2.6, Math.min(2.6, Number(incoming.z) || 0));
        item.rot = Number(incoming.rot) || 0;
        item.unboxed = incoming.unboxed !== false;
      }
    }
    saveLocalDb(db);
    return jsonResp(200, { ok: true, house });
  }

  if (u.pathname.endsWith('/api/house/rekey') && method === 'POST') {
    if (!currentUser) return jsonResp(403, { error: 'Nem vagy bejelentkezve.' });
    const house = db.houses[currentUser.toLowerCase()];
    if (!house) return jsonResp(404, { error: 'Ház nem található.' });
    house.inviteKey = randomInviteKey(6);
    saveLocalDb(db);
    return jsonResp(200, { ok: true, inviteKey: house.inviteKey });
  }

  if (u.pathname.endsWith('/api/house/gift') && method === 'POST') {
    if (!currentUser) return jsonResp(403, { error: 'Ajándékozáshoz kösd össze a fiókod!' });
    const targetName = String(body.toUsername || '').trim().replace(/^@/, '').toLowerCase();
    const itemId = String(body.itemId || '');
    if (!targetName || targetName === currentUser.toLowerCase()) {
      return jsonResp(400, { error: 'Adj meg egy másik lakost címzettként!' });
    }
    const myHouse = db.houses[currentUser.toLowerCase()];
    const targetHouse = db.houses[targetName];
    if (!targetHouse) return jsonResp(404, { error: 'A címzett lakosnak még nincs háza a faluban!' });
    const idx = myHouse.items.findIndex((i) => i.id === itemId);
    if (idx === -1) return jsonResp(404, { error: 'A kiválasztott tárgy nem található a raktáradban.' });
    const [giftedItem] = myHouse.items.splice(idx, 1);
    giftedItem.id = `${targetName}_gift_${Date.now()}`;
    giftedItem.placed = true;
    giftedItem.x = (Math.random() - 0.5) * 1.6;
    giftedItem.z = (Math.random() - 0.5) * 1.6;
    giftedItem.rot = 0;
    giftedItem.giftFrom = currentUser;
    giftedItem.unboxed = false;
    targetHouse.items.push(giftedItem);
    saveLocalDb(db);
    return jsonResp(200, { ok: true, items: myHouse.items, giftedTo: targetHouse.owner });
  }

  if (u.pathname.endsWith('/api/house/add-item') && method === 'POST') {
    if (!currentUser) return jsonResp(403, { error: 'Vásárláshoz válaszd ki a karaktered!' });
    const myHouse = db.houses[currentUser.toLowerCase()];
    if (!myHouse) return jsonResp(404, { error: 'Ház nem található.' });
    const newItem = {
      id: `${currentUser.toLowerCase()}_shop_${Date.now()}`,
      type: String(body.type || 'bogracs_disz'),
      label: String(body.label || '🍲 Dísztárgy'),
      placed: true,
      x: Math.round(((Math.random() - 0.5) * 2.2) * 4) / 4,
      z: Math.round(((Math.random() - 0.5) * 2.2) * 4) / 4,
      rot: 0,
      giftFrom: null,
      unboxed: true,
    };
    myHouse.items.push(newItem);
    saveLocalDb(db);
    return jsonResp(200, { ok: true, item: newItem, items: myHouse.items });
  }

  if ((u.pathname.endsWith('/api/resident') || u.pathname.endsWith('/api/auth/register')) && method === 'POST') {
    const rawName = String(body.username || body.name || '').trim().replace(/^@/, '');
    const password = String(body.password || '');
    if (!rawName || !/^[a-zA-Z0-9._huőúöüóéáűíŐÚÖÜÓÉÁŰÍ-]{2,28}$/.test(rawName)) {
      return jsonResp(400, { error: 'Adj meg egy érvényes játékbeli nevet (2–28 karakter)!' });
    }
    if (rawName.toLowerCase() === 'gulyas_mester') {
      return jsonResp(403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
    }
    if (password && password.length < 4) {
      return jsonResp(400, { error: 'A jelszónak legalább 4 karakternek kell lennie!' });
    }
    const allRes = cachedVillageData?.residents || [];
    const exists = allRes.find((r) => r.name.toLowerCase() === rawName.toLowerCase());
    if (exists) {
      return jsonResp(409, {
        error: 'Ezzel a névvel már áll egy ház a faluban! Lépj be a jelszavaddal a „🔑 Belépés” menüben!',
        resident: exists,
      });
    }
    const maxHouses = cachedVillageData?.maxHouses || 40;
    if (allRes.length >= maxHouses) {
      return jsonResp(403, {
        error: `🔒 Bográcsfalva megtelt (${maxHouses}/${maxHouses} telek)! Új ház már nem építhető, de a meglévő lakók beléphetnek.`,
        full: true,
        maxHouses,
        claimedCount: allRes.length,
      });
    }
    const plot = findNextPlotLocal(allRes);
    const ROLES = [
      { title: 'A kocsmában segít', place: 'kocsma', cloth: '#c84b31' },
      { title: 'Vadász', place: 'vadaszhaz', cloth: '#3f7350' },
      { title: 'Kofa a piacon', place: 'piac', cloth: '#d49b27' },
      { title: 'Horgász a stégen', place: 'steg', cloth: '#3a7ca5' },
      { title: 'Tűzmester segédje', place: 'tuz', cloth: '#b5552e' },
      { title: 'Molnár a szélmalomnál', place: 'malom', cloth: '#8d6e63' },
      { title: 'Pásztor a legelőn', place: 'legelo', cloth: '#558b2f' },
      { title: 'Nem dolgozik, sétálgat', place: 'szabad', cloth: '#6c5ce7' },
    ];
    const chosenRole = ROLES.find((r) => r.place === body.place) || ROLES[allRes.length % ROLES.length];
    const ROOFS = ['#c8523b', '#d99b26', '#4a7c59', '#5b6e8c', '#8c4a6b'];
    const newResident = {
      id: allRes.length + 1,
      name: rawName,
      title: body.title?.trim() || chosenRole.title,
      place: chosenRole.place,
      x: plot.x,
      z: plot.z,
      rot: plot.rot,
      roof: ROOFS[allRes.length % ROOFS.length],
      wall: '#f5eedc',
      cloth: chosenRole.cloth,
      day: cachedVillageData?.day || 1,
    };
    db.extraResidents.push(newResident);
    if (cachedVillageData?.residents) cachedVillageData.residents.push(newResident);
    const pwHash = password ? hashPasswordLocal(password) : null;
    const newHouse = createStarterHouseLocal(rawName, allRes.length - 1, pwHash);
    db.houses[rawName.toLowerCase()] = newHouse;
    db.sessions[SESSION_TOKEN] = rawName;
    saveLocalDb(db);
    return jsonResp(201, {
      ok: true,
      resident: newResident,
      rpg: newHouse.rpg,
      maxHouses,
      claimedCount: allRes.length,
    });
  }

  if (u.pathname.endsWith('/api/customize') && method === 'POST') {
    const key = String(body.name || '').toLowerCase();
    db.customizations[key] = {
      ...(db.customizations[key] || {}),
      ...(body.roof ? { roof: body.roof } : {}),
      ...(body.wall ? { wall: body.wall } : {}),
      ...(body.cloth ? { cloth: body.cloth } : {}),
    };
    saveLocalDb(db);
    return jsonResp(200, { ok: true });
  }

  return jsonResp(404, { error: 'Ismeretlen végpont.' });
}

const isStaticHost = window.location.hostname.endsWith('github.io') || window.location.protocol === 'file:';
let useLocalBackend = isStaticHost;

async function apiFetch(url, options = {}) {
  if (!useLocalBackend) {
    try {
      const headers = {
        'x-session-token': SESSION_TOKEN,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      };
      const resp = await fetch(url, { ...options, headers });
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return resp;
      }
      // Ha a tárhely nem JSON-t adott vissza (pl. GitHub Pages 404 HTML), átváltunk helyi módra
      useLocalBackend = true;
    } catch {
      useLocalBackend = true;
    }
  }
  return handleLocalApi(url, options);
}

// Folyó íve és a fahíd helye
const riverZ = (x) => Math.sin(x * 0.025) * 6 - 14;
const RIVER_HALF_WIDTH = 4.5;
const BRIDGE = { x: 0, southZ: -8.5, northZ: -19.5 };

// Nevezetes helyszínek és hozzájuk tartozó Játékos Akciók (Kiegyensúlyozott Gazdaság + Felhasználóhoz kötött Idő-limitek / Cooldown)
const PLACES = {
  tuz: {
    name: 'A Főtér',
    since: 'A falu központja az 1. nap óta',
    x: 0, z: 3.5, r: 4.2,
    at: 'a főtéren', to: 'a főtérre',
    story: 'A falu macskaköves főtere, ahol minden este 20:00-kor összegyűlik a falu apraja-nagyja. Tavasztól őszig díszkút áll a közepén, télen (havas tájon) pedig itt lobog a tábortűz és itt ragyog a falu karácsonyfája!',
    actions: [
      { id: 'rest_foter_walk', label: '🏛️ Korzózás és Beszélgetés (+10% Energia, +10 XP)', deltaEnergy: 10, deltaXp: 10, cooldownSec: 90, msg: 'Körbesétáltál a Főtéren és beszélgettél a falubeliekkel! (+10% Energia, +10 XP)' },
      { id: 'rest_bogracs', label: '🍲 Bográcsgulyás (-14 Tallér → +45% Energia, +10 XP)', costCoins: 14, deltaEnergy: 45, deltaXp: 10, cooldownSec: 90, msg: 'Ettél egy tál tüzes bográcsgulyást a Főtéren! (+45% Energia)' },
      { label: '🎄 Váltás Téli Főtérre (Tábortűz + Karácsonyfa)', onClick: () => applySeason('tel') },
      { label: '🗳️ Falugyűlés & Szavazás megnyitása', onClick: () => openActivitiesDrawer('community') },
    ],
  },
  tuzkor: {
    name: 'Az esti Főtér',
    since: 'Minden este 20:00-kor',
    x: 0, z: 3.5, r: 7.5,
    at: 'az esti főtéren', to: 'az esti főtérre',
    story: 'Esténként a lakók összegyűlnek a Főtéren.',
    actions: [],
  },
  kocsma: {
    name: 'A Falusi Kocsma',
    since: 'A 3. napon épült',
    x: 15, z: 9, r: 4.0,
    at: 'a kocsmánál', to: 'a kocsmához',
    story: 'A falu 84-12-re a kocsmát szavazta meg a könyvtár helyett. A hordók mindig tele vannak.',
    actions: [
      { id: 'rest_pub_drink', label: '🍺 Koccintás és Pihenés (-8 Tallér → +25% Energia, +10 XP)', costCoins: 8, deltaEnergy: 25, deltaXp: 10, cooldownSec: 60, msg: 'Koccintottál a lakókkal, és meghallgattad a legújabb falusi pletykákat! (+25% Energia)' },
      { id: 'job_pub', label: '🔨 Munka: Csapos műszak (-25% Energia → +28 Tallér, +18 XP)', costEnergy: 25, deltaCoins: 28, deltaXp: 18, cooldownSec: 120, msg: 'Beálltál a pult mögé segíteni @csapos_bela mellé! (+28 Tallér, +18 XP)' },
    ],
  },
  vadaszhaz: {
    name: 'A Vadászház',
    since: 'A 4. napon épült',
    x: -36, z: -32, r: 4.5,
    at: 'a vadászháznál', to: 'a vadászházhoz',
    story: 'Az északi folyóparton, a sűrű erdő szélén áll. Innen indulnak a vadászok és a favágók.',
    actions: [
      { id: 'job_wood', label: '🪓 Munka: Favágás (-22% Energia → +2 Fa, +18 Tallér)', costEnergy: 22, deltaCoins: 18, deltaXp: 15, deltaRes: { fa: 2 }, cooldownSec: 90, msg: 'Kivágtál és felaprítottál két öl tűzifát! (+2 🪵 Fa, +18 Tallér)' },
      { id: 'job_hunt', label: '🏹 Munka: Vadászat (-25% Energia → +26 Tallér, +18 XP)', costEnergy: 25, deltaCoins: 26, deltaXp: 18, cooldownSec: 120, msg: 'Sikeresen visszatértél az erdei portyáról! (+26 Tallér, +18 XP)' },
    ],
  },
  piac: {
    name: 'A Falusi Piac',
    since: 'Az 5. napon nyílt',
    x: 30, z: -26, r: 4.5,
    at: 'a piacon', to: 'a piacra',
    story: 'Friss sajt, lángos, méz és gyógynövények kaphatók a színes ponyvás standoknál.',
    actions: [
      { id: 'job_market', label: '🧀 Munka: Árusítás a standnál (-16% Energia → +18 Tallér)', costEnergy: 16, deltaCoins: 18, deltaXp: 12, cooldownSec: 75, msg: 'Eladtad a friss portékát a piacon! (+18 Tallér, +12 XP)' },
      { id: 'rest_langos', label: '🥨 Lángos vásárlása (-10 Tallér → +35% Energia)', costCoins: 10, deltaEnergy: 35, deltaXp: 8, cooldownSec: 60, msg: 'Friss fokhagymás-tejfölös lángost ettél @langos_laci standjánál! (+35% Energia)' },
      { label: '🛋️ Bútorbolt & Barkácsműhely megnyitása', onClick: () => openActivitiesDrawer('shop') },
    ],
  },
  steg: {
    name: 'A Horgászstég',
    since: 'A 4. napon ácsolták',
    x: 19, z: -9.2, r: 2.2,
    at: 'a stégen', to: 'a stégre',
    story: 'A folyó legmélyebb kanyarja fölé nyúlik be. A horgászok szerint kapitális harcsák laknak odalent.',
    actions: [
      { id: 'job_fish', label: '🎣 Munka: Horgászat (-14% Energia → +2 Hal, +12 Tallér)', costEnergy: 14, deltaCoins: 12, deltaXp: 10, deltaRes: { hal: 2 }, cooldownSec: 60, msg: 'Bedobtad a csalit a folyóba… és kifogtál két szép pontyot! (+2 🐟 Hal, +12 Tallér)' },
      { id: 'rest_river', label: '🌊 Pihenés a vízparton (+12% Energia)', deltaEnergy: 12, deltaXp: 5, cooldownSec: 90, msg: 'Leültél a stég szélére, és hallgatod a folyó csobogását. (+12% Energia)' },
    ],
  },
  hid: {
    name: 'A Fahíd',
    since: 'A 2. napon épült',
    x: 0, z: -14, r: 2.5,
    at: 'a hídnál', to: 'a hídhoz',
    story: 'Az egyetlen száraz átkelő a folyó déli és északi partja között.',
    actions: [
      { id: 'job_bridge', label: '🛡️ Munka: Hídőrség (-12% Energia → +14 Tallér)', costEnergy: 12, deltaCoins: 14, deltaXp: 10, cooldownSec: 60, msg: 'Ellenőrizted a hídon átkelő szekereket és vándorokat! (+14 Tallér)' },
    ],
  },
  malom: {
    name: 'A Szélmalom',
    since: 'A dombtető büszkesége',
    x: -32, z: 28, r: 4.0,
    at: 'a szélmalomnál', to: 'a szélmalomhoz',
    story: 'A vitorlák éjjel-nappal forognak, itt őrlik a falu lisztjét a lángoshoz és a kenyérhez.',
    actions: [
      { id: 'job_mill', label: '🌾 Munka: Búzaőrlés (-18% Energia → +2 Liszt, +15 Tallér)', costEnergy: 18, deltaCoins: 15, deltaXp: 12, deltaRes: { liszt: 2 }, cooldownSec: 75, msg: 'Felöntötted a garatra a búzát, friss liszt készült a falunak! (+2 🌾 Liszt, +15 Tallér)' },
    ],
  },
  legelo: {
    name: 'A Legelő',
    since: 'A tehenek és bárányok otthona',
    x: 42, z: 24, r: 5.0,
    at: 'a legelőn', to: 'a legelőre',
    story: 'Bekerített zöld legelő itatóval, ahol a falu tehenei és bárányai békésen legelésznek.',
    actions: [
      { id: 'job_milk', label: '🐄 Munka: Állatgondozás & Fejés (-18% Energia → +2 Tej, +15 Tallér)', costEnergy: 18, deltaCoins: 15, deltaXp: 12, deltaRes: { tej: 2 }, cooldownSec: 75, msg: 'Megtöltötted a vályút friss vízzel, és megfejted a teheneket! (+2 🥛 Tej, +15 Tallér)' },
    ],
  },
  gemeskut: {
    name: 'A Gémeskút',
    since: 'Friss kútvíz',
    x: -13, z: -2, r: 2.5,
    at: 'a gémeskútnál', to: 'a gémeskúthoz',
    story: 'Hűvös vizet ad a bográcsba és a megfáradt vándoroknak.',
    actions: [
      { id: 'rest_well', label: '🪣 Vízhúzás a kútból (+15% Energia, Ingyenes)', deltaEnergy: 15, deltaXp: 4, cooldownSec: 120, msg: 'Húztál egy vödör jéghideg kútvizet és felfrissültél! (+15% Energia)' },
    ],
  },
};
const WORK_PLACES = ['tuz', 'kocsma', 'vadaszhaz', 'piac', 'steg', 'malom', 'legelo', 'gemeskut'];

// Keresőben megjelenő Menüpontok és Akciók listája (Munka, Pihenés, Bolt, Küldetések, Szoba stb.)
const ACTION_MENU_ITEMS = [
  { id: 'act_menu_hub', title: 'Falusi Élet & Tevékenységek Központ (Főmenü)', sub: 'Munka, Pihenés, Bútorbolt, Barkácsolás és Napi Küldetések', type: 'act_tab', tab: 'work' },
  { id: 'act_shop', title: 'Bútorbolt és Barkácsműhely (Új 3D bútorok)', sub: 'Vásárolj vagy barkácsolj lámpát, könyvespolcot, növényt a szobádba', type: 'act_tab', tab: 'shop' },
  { id: 'act_quests', title: 'Napi Küldetések és Falugyűlés Szavazás', sub: 'Szavazz a falu következő épületére és szerezz jutalom Tallért', type: 'act_tab', tab: 'community' },
  { id: 'act_walk', title: 'Vándorlás és Séta (WASD + Mobil érintőpad mód)', sub: 'Szabad séta saját karakterrel a faluban', type: 'walk' },
  { id: 'act_fire', title: 'Főtér: Falugyűlés, Korzózás és Téli Karácsonyfa', sub: 'A falu központi főtere (télen tábortűzzel és karácsonyfával)', type: 'place', placeKey: 'tuz' },
  { id: 'act_room', title: 'Szobaberendezés és Ajándékozás', sub: 'Bútorok lerakása, zárt ház meghívólink, ajándék', type: 'my_room' },
  { id: 'act_rest', title: 'Pihenés és Alvás (Saját ház – +55% Energia, 5p Cooldown)', sub: 'Hazatérés a saját házadhoz és energiafeltöltés', type: 'act_tab', tab: 'rest' },
  { id: 'act_hunt', title: 'Munka: Vadászat és Favágás (+Fa, +Tallér)', sub: 'Vadászház az északi erdőszélen', type: 'place', placeKey: 'vadaszhaz' },
  { id: 'act_mill', title: 'Munka: Lisztőrlés a Szélmalomban (+Liszt, +Tallér)', sub: 'Dombvidéki szélmalom', type: 'place', placeKey: 'malom' },
  { id: 'act_market', title: 'Munka: Kereskedés a Piacon (+Tallér, Nyersanyag eladás)', sub: 'Árusítás és vásárlás a falusi piacon', type: 'place', placeKey: 'piac' },
  { id: 'act_pasture', title: 'Munka: Állatgondozás a Legelőn (+Tej, +Tallér)', sub: 'Tehenek és bárányok ellátása', type: 'place', placeKey: 'legelo' },
  { id: 'act_pub', title: 'Kikapcsolódás és Munka a Kocsmában (+Tallér / +Energia)', sub: 'Italok, pletykák és csapos műszak', type: 'place', placeKey: 'kocsma' },
  { id: 'act_fish', title: 'Horgászat és Pihenés a Stégen (+Hal, +Tallér)', sub: 'Pecázás a folyóparton', type: 'place', placeKey: 'steg' },
];

function hash(text, seed = 0) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// --- 1. Adatok és Session betöltése (Cache-busting verzióval) ---
const APP_VERSION = '20261110-6';
const villageResp = await fetch(`./village.json?v=${APP_VERSION}`, { cache: 'no-store' });
const villageData = await villageResp.json();
cachedVillageData = villageData;

// Korai deklarációk a Temporal Dead Zone (TDZ) elkerülésére legelső betöltéskor
const residents = [];
const byName = new Map();
const housePickers = [];
const figurePickers = [];
let myHomeBeacon = null;
let playerRpg = null;

// Ha statikus tárhelyen (pl. GitHub Pages) már mentettünk új lakost vagy ház-színezést a localStorage-ba, összefésüljük:
{
  const localDb = loadLocalDb();
  if (Array.isArray(localDb.extraResidents)) {
    for (const extra of localDb.extraResidents) {
      if (!villageData.residents.some((r) => r.name.toLowerCase() === extra.name.toLowerCase())) {
        villageData.residents.push(extra);
      }
    }
  }
  if (localDb.customizations) {
    for (const r of villageData.residents) {
      const cust = localDb.customizations[r.name.toLowerCase()];
      if (cust) Object.assign(r, cust);
    }
  }
}

const meResp = await apiFetch('/api/me');
const meData = meResp.ok ? await meResp.json() : { username: null, privacyMap: {} };

// Ha a korábbi verziókból a gulyas_mester session ragadt volna be a böngészőbe, kitakarítjuk:
if (localStorage.getItem('kisfalu_my_user')?.toLowerCase() === 'gulyas_mester') {
  localStorage.removeItem('kisfalu_my_user');
}

// Belépett felhasználó ellenőrzése (gulyas_mester a fejlesztőé, vendégeknek nem tölthető be automatikusan)
let currentConnectedUser = (meData.username && meData.username.toLowerCase() !== 'gulyas_mester')
  ? meData.username
  : (localStorage.getItem('kisfalu_my_user') || null);

if (currentConnectedUser && currentConnectedUser.toLowerCase() === 'gulyas_mester') {
  currentConnectedUser = null;
  localStorage.removeItem('kisfalu_my_user');
}
const housePrivacyMap = meData.privacyMap || {};

el('village-title').textContent = villageData.villageName || 'Bográcsfalva';
el('vote-text').innerHTML = villageData.voteQuestion || 'Mai szavazás: <b>PÉKSÉG</b> vagy <b>ŐRTORONY</b>?';

// Gyors lakos-összekötő segédfüggvény (Portfólió demó módhoz)
async function bindUserQuickly(username) {
  if (!username || username.toLowerCase() === 'gulyas_mester') return false;
  const reqResp = await apiFetch('/api/claim/request', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  if (!reqResp.ok) return false;
  const { code } = await reqResp.json();
  const simResp = await apiFetch('/api/claim/simulate-dm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!simResp.ok) return false;
  const data = await simResp.json();
  currentConnectedUser = data.username;
  localStorage.setItem('kisfalu_my_user', currentConnectedUser);
  if (playerRpg && typeof switchActiveUserRpg === 'function') {
    switchActiveUserRpg(currentConnectedUser, data.rpg);
  }
  updateClaimButtonUI();
  updateMyHomeBeaconPosition();
  return true;
}

function updateClaimButtonUI() {
  const btn = el('claim-open');
  const homeBtn = el('my-house-btn');
  if (currentConnectedUser) {
    btn.textContent = `👤 @${currentConnectedUser}`;
    btn.classList.remove('gold');
    btn.classList.add('green');
    homeBtn.textContent = `🏠 Saját házam (@${currentConnectedUser})`;
  } else {
    btn.textContent = '🔑 Belépés';
    btn.classList.add('gold');
    btn.classList.remove('green');
    homeBtn.textContent = '🏠 Saját házam';
  }
}
updateClaimButtonUI();

// --- 2. Three.js Renderer és Fő Jelenet ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb24a);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 1, 900);
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x9ab05a, 1.1);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xfff0cf, 3.0);
sun.position.set(-90, 120, -80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -125, right: 125, top: 125, bottom: -125, near: 10, far: 350 });
sun.shadow.bias = -0.0008;
scene.add(sun);

const fireLight = new THREE.PointLight(0xff8c3b, 8, 32, 1.6);
fireLight.position.set(0, 2.2, 3.5);
scene.add(fireLight);

const matCache = new Map();
function mat(hex) {
  const key = typeof hex === 'string' ? hex.toLowerCase() : hex;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshLambertMaterial({ color: hex, flatShading: true }));
  }
  return matCache.get(key);
}
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cone(r, h, color, x = 0, y = 0, z = 0, seg = 7) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// --- 3. Optimalizált Környezet (InstancedMesh) & Évszak Referenciák ---
const streetLampBulbs = [];
const envRefs = {
  groundMat: null,
  bankMat: null,
  waterMat: null,
  roadMat: null,
  crownInst: null,
  pineInst: null,
  bushInst: null,
  flowerInst: null,
  deciduousCoords: [],
  pineCoords: [],
  bushCoords: [],
  flowerValid: [],
  snowRoofs: [],
  rocks: [],
};

// Falusi utcarendszer (Híd utca, Főutca, Vadász dűlő, Kocsma út, Betyár köz, Piac köz, Északi utak)
// A házak sosem a falu útján állnak: a házak előtt tágas utcafront húzódik,
// és minden egyes ház közvetlenül egy rövid, tetszetős járdával csatlakozik az utcához!
const VILLAGE_ROADS = [
  // 1. Főtér és Híd tengely (Híd utca)
  { x1: 0, z1: 3.5, x2: 0, z2: -8.5, width: 3.2 },

  // 2. Déli Főutca (x=0)
  { x1: 0, z1: 3.5, x2: 0, z2: 20.0, width: 3.0 },
  { x1: 0, z1: 20.0, x2: 0, z2: 36.0, width: 3.0 },
  { x1: 0, z1: 36.0, x2: 0, z2: 50.0, width: 2.8 },

  // 3. Dél-Nyugati Betyár dűlő
  { x1: 0, z1: 20.0, x2: -11.0, z2: 20.0, width: 2.6 },
  { x1: -11.0, z1: 20.0, x2: -19.0, z2: 24.0, width: 2.5 },
  { x1: -19.0, z1: 24.0, x2: -28.0, z2: 30.0, width: 2.5 },
  { x1: -28.0, z1: 30.0, x2: -31.0, z2: 44.0, width: 2.5 },
  { x1: -31.0, z1: 44.0, x2: -16.0, z2: 46.0, width: 2.5 },
  { x1: -16.0, z1: 46.0, x2: -4.0, z2: 38.0, width: 2.5 },
  { x1: -4.0, z1: 38.0, x2: 0, z2: 36.0, width: 2.6 },

  // 4. Nyugati Vadász és Vadon út
  { x1: 0, z1: 3.5, x2: -14.0, z2: 3.5, width: 2.6 },
  { x1: -14.0, z1: 3.5, x2: -28.0, z2: -1.0, width: 2.5 },
  { x1: -28.0, z1: -1.0, x2: -38.0, z2: 4.0, width: 2.5 },
  { x1: -38.0, z1: 4.0, x2: -48.0, z2: 4.0, width: 2.5 },
  { x1: -48.0, z1: 4.0, x2: -54.0, z2: 4.0, width: 2.5 },
  { x1: -14.0, z1: 3.5, x2: -11.0, z2: 20.0, width: 2.5 },

  // 5. Dél-Keleti Piac és Kocsma körút
  { x1: 0, z1: 20.0, x2: 12.0, z2: 20.0, width: 2.6 },
  { x1: 12.0, z1: 20.0, x2: 20.0, z2: 25.0, width: 2.5 },
  { x1: 20.0, z1: 25.0, x2: 30.0, z2: 32.0, width: 2.5 },
  { x1: 30.0, z1: 32.0, x2: 40.0, z2: 32.0, width: 2.5 },
  { x1: 40.0, z1: 32.0, x2: 52.0, z2: 30.0, width: 2.5 },
  { x1: 52.0, z1: 30.0, x2: 52.0, z2: 16.0, width: 2.5 },
  { x1: 30.0, z1: 32.0, x2: 32.0, z2: 46.0, width: 2.5 },
  { x1: 32.0, z1: 46.0, x2: 14.0, z2: 46.0, width: 2.5 },
  { x1: 14.0, z1: 46.0, x2: 4.0, z2: 38.0, width: 2.5 },
  { x1: 4.0, z1: 38.0, x2: 0, z2: 36.0, width: 2.6 },

  // 6. Keleti Horgász és Tóparti út
  { x1: 0, z1: 3.5, x2: 14.0, z2: 3.5, width: 2.6 },
  { x1: 14.0, z1: 3.5, x2: 26.0, z2: 3.5, width: 2.6 },
  { x1: 26.0, z1: 3.5, x2: 36.0, z2: 3.0, width: 2.5 },
  { x1: 36.0, z1: 3.0, x2: 44.0, z2: 5.0, width: 2.5 },
  { x1: 44.0, z1: 5.0, x2: 52.0, z2: 4.0, width: 2.5 },
  { x1: 14.0, z1: 3.5, x2: 12.0, z2: 20.0, width: 2.5 },

  // 7. Északi Főutca (x=0)
  { x1: 0, z1: -19.5, x2: 0, z2: -36.0, width: 3.0 },
  { x1: 0, z1: -36.0, x2: 0, z2: -50.0, width: 2.8 },

  // 8. Észak-Nyugati Vadon út
  { x1: 0, z1: -19.5, x2: -14.0, z2: -20.0, width: 2.6 },
  { x1: -14.0, z1: -20.0, x2: -24.0, z2: -20.0, width: 2.6 },
  { x1: -24.0, z1: -20.0, x2: -36.0, z2: -16.0, width: 2.5 },
  { x1: -36.0, z1: -16.0, x2: -46.0, z2: -20.0, width: 2.5 },
  { x1: -14.0, z1: -20.0, x2: -12.0, z2: -27.0, width: 2.5 },
  { x1: -12.0, z1: -27.0, x2: -12.0, z2: -48.0, width: 2.5 },
  { x1: -12.0, z1: -48.0, x2: 0, z2: -48.0, width: 2.5 },

  // 9. Észak-Keleti Gyümölcsös út
  { x1: 0, z1: -19.5, x2: 14.0, z2: -20.0, width: 2.6 },
  { x1: 14.0, z1: -20.0, x2: 24.0, z2: -20.0, width: 2.6 },
  { x1: 24.0, z1: -20.0, x2: 32.0, z2: -18.0, width: 2.5 },
  { x1: 32.0, z1: -18.0, x2: 44.0, z2: -24.0, width: 2.5 },
  { x1: 44.0, z1: -24.0, x2: 48.0, z2: -36.0, width: 2.5 },
  { x1: 48.0, z1: -36.0, x2: 44.0, z2: -48.0, width: 2.5 },
  { x1: 14.0, z1: -20.0, x2: 14.0, z2: -24.0, width: 2.5 },
  { x1: 14.0, z1: -24.0, x2: 8.0, z2: -27.0, width: 2.5 },
  { x1: 8.0, z1: -27.0, x2: 0, z2: -28.0, width: 2.5 },
];

function getClosestPointOnRoads(px, pz) {
  let closestX = 0, closestZ = 0, minDistSq = Infinity;
  for (const r of VILLAGE_ROADS) {
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) continue;
    const u = Math.max(0, Math.min(1, ((px - r.x1) * dx + (pz - r.z1) * dz) / lenSq));
    const nx = r.x1 + u * dx;
    const nz = r.z1 + u * dz;
    const distSq = (px - nx) * (px - nx) + (pz - nz) * (pz - nz);
    if (distSq < minDistSq) {
      minDistSq = distSq;
      closestX = nx;
      closestZ = nz;
    }
  }
  return { x: closestX, z: closestZ, dist: Math.sqrt(minDistSq) };
}

function buildOptimizedEnvironment() {
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x8fb24a });
  envRefs.groundMat = groundMat;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(440, 440), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const bankMat = new THREE.MeshLambertMaterial({ color: 0xd5c295, flatShading: true });
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x4ea5d9, flatShading: true });
  envRefs.bankMat = bankMat;
  envRefs.waterMat = waterMat;

  const riverSegs = 110;
  for (let i = 0; i < riverSegs; i++) {
    const x1 = -220 + (i / riverSegs) * 440;
    const x2 = -220 + ((i + 1) / riverSegs) * 440;
    const xm = (x1 + x2) / 2;
    const zm = riverZ(xm);
    const angle = Math.atan2(riverZ(x2) - riverZ(x1), x2 - x1);
    const bank = new THREE.Mesh(
      new THREE.BoxGeometry(4.4, 0.06, RIVER_HALF_WIDTH * 2 + 1.8),
      bankMat
    );
    bank.position.set(xm, 0.01, zm);
    bank.rotation.y = -angle;
    bank.receiveShadow = true;
    scene.add(bank);

    const water = new THREE.Mesh(
      new THREE.BoxGeometry(4.4, 0.12, RIVER_HALF_WIDTH * 2),
      waterMat
    );
    water.position.set(xm, 0.03, zm);
    water.rotation.y = -angle;
    water.receiveShadow = true;
    scene.add(water);
  }

  // Falusi Úthálózat kiépítése
  const roadMat = new THREE.MeshLambertMaterial({ color: 0xc8b082, flatShading: true });
  envRefs.roadMat = roadMat;
  const addRoad = (x1, z1, x2, z2, width = 2.6) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const road = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, len), roadMat);
    road.position.set((x1 + x2) / 2, 0.03, (z1 + z2) / 2);
    road.rotation.y = Math.atan2(x2 - x1, z2 - z1);
    road.receiveShadow = true;
    scene.add(road);
  };

  for (const r of VILLAGE_ROADS) {
    addRoad(r.x1, r.z1, r.x2, r.z2, r.width);
  }

  // Útjelző fatáblák a főbb csomópontokon
  const createSignpost = (x, z, signs = []) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(cyl(0.08, 0.11, 2.3, 0x4a2e16, 0, 1.15, 0, 6));
    signs.forEach((s, idx) => {
      const y = 1.95 - idx * 0.35;
      const plank = box(1.15, 0.22, 0.06, 0x7c4f2a, 0, y, 0);
      plank.rotation.y = s.rot || 0;
      const arrow = cone(0.15, 0.22, 0x7c4f2a, Math.sin(s.rot || 0) * 0.6, y, Math.cos(s.rot || 0) * 0.6, 4);
      arrow.rotation.z = -Math.PI / 2;
      arrow.rotation.y = s.rot || 0;
      g.add(plank, arrow);
    });
    scene.add(g);
  };
  createSignpost(1.8, -1.0, [{ rot: -Math.PI / 2 }, { rot: Math.PI / 2 }]);
  createSignpost(-2.4, 5.0, [{ rot: Math.PI }, { rot: 2.4 }]);
  createSignpost(2.4, 5.0, [{ rot: 0 }, { rot: -1.2 }]);
  createSignpost(1.8, -20.5, [{ rot: 2.5 }, { rot: -0.8 }]);

  // Díszítőelemek a falu utcáin: fahordók és ládák
  const addDecorProp = (x, z, type = 'barrel') => {
    if (type === 'barrel') {
      const b = cyl(0.32, 0.38, 0.82, 0x6e472a, x, 0.41, z, 8);
      scene.add(b);
    } else {
      const c = box(0.7, 0.6, 0.7, 0x8a5a33, x, 0.3, z);
      scene.add(c);
    }
  };
  addDecorProp(18.2, 5.8, 'barrel');
  addDecorProp(17.6, 5.4, 'crate');
  addDecorProp(27.4, 5.6, 'barrel');
  addDecorProp(26.6, 5.8, 'crate');
  addDecorProp(-1.8, -7.2, 'barrel');

  const lampPositions = [
    [-2.5, -2], [2.5, -7], [-2.5, -21], [8, 6], [12, 11],
    [-10, 11], [-22, 20], [14, -22], [-15, -25], [26, 16],
    [-28, 7], [32, 7], [0, 24], [0, 40], [-18, 32], [20, 32]
  ];
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0x555045 });
  streetLampBulbs.push(bulbMat);

  for (const [lx, lz] of lampPositions) {
    const lamp = new THREE.Group();
    lamp.add(cyl(0.08, 0.11, 3.2, 0x3b2a1a, 0, 1.6, 0, 6));
    lamp.add(box(0.6, 0.08, 0.08, 0x3b2a1a, 0.25, 3.15, 0));
    const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.32), bulbMat);
    lantern.position.set(0.5, 2.9, 0);
    lamp.add(lantern);
    lamp.position.set(lx, 0, lz);
    scene.add(lamp);
  }

  const dummy = new THREE.Object3D();
  const colorHelper = new THREE.Color();

  const isSpotFree = (x, z) => {
    if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 2.5) return false;
    for (const p of Object.values(PLACES)) {
      if (Math.hypot(x - p.x, z - p.z) < p.r + 5.5) return false;
    }
    return true;
  };

  const treeCoords = [];
  for (let i = 0; i < 220; i++) {
    const a = hash(`t_${i}`, 1) * Math.PI * 2;
    const d = i < 55 ? 10 + hash(`t_${i}`, 2) * 28 : 54 + hash(`t_${i}`, 2) * 95;
    const x = (i < 55 ? -38 : 0) + Math.cos(a) * d;
    const z = (i < 55 ? -34 : 0) + Math.sin(a) * d;
    if (!isSpotFree(x, z)) continue;
    treeCoords.push({ x, z, scale: 0.75 + hash(`t_${i}`, 3) * 0.75, pine: i % 3 === 0, shade: hash(`t_${i}`, 4) });
  }

  const trunkInst = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.18, 0.26, 1.6, 6),
    mat(0x5a3a22),
    treeCoords.length
  );
  trunkInst.castShadow = true;
  const deciduousCoords = treeCoords.filter((t) => !t.pine);
  const pineCoords = treeCoords.filter((t) => t.pine);
  envRefs.deciduousCoords = deciduousCoords;
  envRefs.pineCoords = pineCoords;

  const crownInst = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1.35, 0),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    deciduousCoords.length
  );
  crownInst.castShadow = true;
  envRefs.crownInst = crownInst;

  const pineInst = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.4, 3.8, 7),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    pineCoords.length
  );
  pineInst.castShadow = true;
  envRefs.pineInst = pineInst;

  treeCoords.forEach((t, i) => {
    dummy.position.set(t.x, 0.8 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.set(0, t.shade * 6, 0);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
  });
  deciduousCoords.forEach((t, i) => {
    dummy.position.set(t.x, 2.2 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.set(0, t.shade * 6, 0);
    dummy.updateMatrix();
    crownInst.setMatrixAt(i, dummy.matrix);
    crownInst.setColorAt(i, colorHelper.setHex(t.shade > 0.5 ? 0x5c8c38 : 0x6e9e42));
  });
  pineCoords.forEach((t, i) => {
    dummy.position.set(t.x, 2.6 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.set(0, t.shade * 6, 0);
    dummy.updateMatrix();
    pineInst.setMatrixAt(i, dummy.matrix);
    pineInst.setColorAt(i, colorHelper.setHex(t.shade > 0.5 ? 0x3b6e4c : 0x457b57));
  });
  scene.add(trunkInst, crownInst, pineInst);

  // Folyóparti és kerti kövek
  envRefs.rocks = [];
  const rockInst = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.55, 0),
    mat(0x8b857c),
    90
  );
  rockInst.castShadow = true;
  for (let i = 0; i < 90; i++) {
    const rx = -140 + (i / 90) * 280 + (hash(`r_${i}`, 1) - 0.5) * 6;
    const side = i % 2 === 0 ? 1 : -1;
    const rz = riverZ(rx) + side * (RIVER_HALF_WIDTH + 0.8 + hash(`r_${i}`, 2) * 2.5);
    const s = 0.5 + hash(`r_${i}`, 3) * 0.9;
    dummy.position.set(rx, 0.2 * s, rz);
    dummy.scale.set(s * 1.2, s * 0.7, s);
    dummy.rotation.set(0, hash(`r_${i}`, 4) * 6, 0);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
    envRefs.rocks.push({ x: rx, z: rz, radius: s * 1.15, height: 0.32 * s });
  }
  scene.add(rockInst);

  // Utcai és kerti bokrok (Bushes)
  const bushCoords = [];
  for (let i = 0; i < VILLAGE_ROADS.length; i++) {
    const r = VILLAGE_ROADS[i];
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz);
    const steps = Math.floor(len / 6.0);
    const nx = -dz / len;
    const nz = dx / len;
    for (let s = 1; s <= steps; s++) {
      const u = s / (steps + 1);
      const mx = r.x1 + dx * u;
      const mz = r.z1 + dz * u;
      const side = (s % 2 === 0 ? 1 : -1);
      const bx = mx + nx * side * (r.width / 2 + 1.2 + hash(`bs_${i}_${s}`, 1) * 0.7);
      const bz = mz + nz * side * (r.width / 2 + 1.2 + hash(`bs_${i}_${s}`, 2) * 0.7);
      if (Math.abs(bz - riverZ(bx)) > RIVER_HALF_WIDTH + 1.6) {
        bushCoords.push({
          x: bx,
          z: bz,
          scale: 0.65 + hash(`bs_${i}_${s}`, 3) * 0.45,
          shade: hash(`bs_${i}_${s}`, 4),
        });
      }
    }
  }
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.12;
    const bx = PLACES.tuz.x + Math.cos(a) * 5.6;
    const bz = PLACES.tuz.z + Math.sin(a) * 5.6;
    bushCoords.push({
      x: bx,
      z: bz,
      scale: 0.6 + hash(`fbs_${i}`, 1) * 0.4,
      shade: hash(`fbs_${i}`, 2),
    });
  }

  const bushInst = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.72, 1),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    bushCoords.length
  );
  bushInst.castShadow = true;
  envRefs.bushInst = bushInst;
  envRefs.bushCoords = bushCoords;
  bushCoords.forEach((b, i) => {
    dummy.position.set(b.x, 0.45 * b.scale, b.z);
    dummy.scale.set(b.scale * 1.15, b.scale * 0.85, b.scale);
    dummy.rotation.set(0, b.shade * 6, 0);
    dummy.updateMatrix();
    bushInst.setMatrixAt(i, dummy.matrix);
    bushInst.setColorAt(i, colorHelper.setHex(b.shade > 0.5 ? 0x48732e : 0x588835));
  });
  scene.add(bushInst);

  // Gazdag virágmezők és udvari virágok (Flowers)
  const FLOWER_COUNT = 450;
  const flowerInst = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.24, 0.45, 5),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    FLOWER_COUNT
  );
  envRefs.flowerInst = flowerInst;
  const flowerColors = [0xe63946, 0xffb703, 0x8338ec, 0xffffff, 0x3a86ff, 0xf72585];
  for (let i = 0; i < FLOWER_COUNT; i++) {
    const fx = (hash(`fl_${i}`, 1) - 0.5) * 190;
    const fz = (hash(`fl_${i}`, 2) - 0.5) * 190;
    const valid = Math.abs(fz - riverZ(fx)) >= RIVER_HALF_WIDTH + 1.5 && Math.hypot(fx - PLACES.tuz.x, fz - PLACES.tuz.z) > 5.5;
    envRefs.flowerValid.push(valid);
    if (!valid) {
      dummy.scale.setScalar(0);
    } else {
      dummy.position.set(fx, 0.22, fz);
      dummy.scale.setScalar(0.7 + hash(`fl_${i}`, 3) * 0.7);
      dummy.rotation.set(0, hash(`fl_${i}`, 4) * 3, 0);
    }
    dummy.updateMatrix();
    flowerInst.setMatrixAt(i, dummy.matrix);
    flowerInst.setColorAt(i, colorHelper.setHex(flowerColors[i % flowerColors.length]));
  }
  scene.add(flowerInst);
}
buildOptimizedEnvironment();

// --- 4. Nevezetes épületek és Élő Állatok ---
const landmarkPickers = [];
const flames = [];
const smokePuffs = [];
let windmillBlades = null;
const pastureAnimals = [];
let foterRegularGroup = null;
let foterWinterGroup = null;
let xmasStarMesh = null;

function registerLandmark(key, group, radius = 4.5, height = 5) {
  scene.add(group);
  const picker = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 2, height, radius * 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  picker.position.set(PLACES[key].x, height / 2, PLACES[key].z);
  picker.userData.placeKey = key;
  scene.add(picker);
  landmarkPickers.push(picker);
}

// 4.1 A Főtér (Tavasztól őszig díszkút, Télen Karácsonyfa + Tábortűz és Bogrács!)
{
  const g = new THREE.Group();
  g.position.set(PLACES.tuz.x, 0, PLACES.tuz.z);

  // Macskaköves Főtér burkolat (kör alakú díszburkolat)
  const plazaOuter = cyl(4.8, 4.9, 0.1, 0x9b9286, 0, 0.05, 0, 24);
  const plazaInner = cyl(3.7, 3.7, 0.12, 0xb5aba0, 0, 0.06, 0, 20);
  g.add(plazaOuter, plazaInner);

  // Padok a Főtér szélén
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bench = box(1.65, 0.38, 0.48, 0x74482a, Math.cos(a) * 3.95, 0.22, Math.sin(a) * 3.95);
    bench.rotation.y = -a + Math.PI / 2;
    g.add(bench);
  }

  // A) Tavasz / Nyár / Ősz: Díszes kőkút a Főtér közepén
  foterRegularGroup = new THREE.Group();
  foterRegularGroup.add(cyl(1.45, 1.55, 0.48, 0x8b857c, 0, 0.28, 0, 12));
  foterRegularGroup.add(cyl(1.2, 1.2, 0.44, 0x4ea5d9, 0, 0.32, 0, 12));
  foterRegularGroup.add(cyl(0.28, 0.36, 1.65, 0x8b857c, 0, 1.0, 0, 8));
  foterRegularGroup.add(cyl(0.68, 0.38, 0.26, 0x8b857c, 0, 1.75, 0, 10));
  foterRegularGroup.add(cone(0.28, 0.55, 0x88d4ff, 0, 2.1, 0, 8));
  g.add(foterRegularGroup);

  // B) Téli Főtér (Havas tájon): Karácsonyfa + Tábortűz és Bogrács!
  foterWinterGroup = new THREE.Group();
  foterWinterGroup.visible = false;

  // 1) Karácsonyfa a Főtér bal-hátsó részén (-1.25, 0, -0.85)
  const xmasTree = new THREE.Group();
  xmasTree.position.set(-1.25, 0.08, -0.85);
  xmasTree.add(cyl(0.28, 0.36, 1.2, 0x5a3a22, 0, 0.6, 0, 8));
  xmasTree.add(cone(1.9, 2.0, 0x225c36, 0, 1.6, 0, 9));
  xmasTree.add(cone(1.55, 1.8, 0x2a6f42, 0, 2.65, 0, 9));
  xmasTree.add(cone(1.18, 1.5, 0x225c36, 0, 3.6, 0, 9));
  xmasTree.add(cone(0.78, 1.2, 0x2a6f42, 0, 4.4, 0, 9));

  // Csúcsdísz (ragyogó arany csillag)
  xmasStarMesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.38, 0),
    new THREE.MeshBasicMaterial({ color: 0xffe066 })
  );
  xmasStarMesh.position.set(0, 5.15, 0);
  xmasTree.add(xmasStarMesh);

  // Színes karácsonyfadísz gömbök spirálban a fán
  const baubleColors = [0xe63946, 0xffcf55, 0x4ea8de, 0xf1faee, 0xff9f1c];
  for (let i = 0; i < 20; i++) {
    const tNorm = i / 20;
    const hY = 1.0 + tNorm * 3.5;
    const rad = (1 - tNorm * 0.72) * 1.48;
    const ang = i * 1.35;
    const bauble = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 7, 7),
      new THREE.MeshBasicMaterial({ color: baubleColors[i % baubleColors.length] })
    );
    bauble.position.set(Math.cos(ang) * rad, hY, Math.sin(ang) * rad);
    xmasTree.add(bauble);
  }

  // Ajándékdobozok a karácsonyfa alatt
  const giftPresets = [
    { x: 0.75, z: 0.65, c: 0xd62828, s: 0.48 },
    { x: -0.7, z: 0.72, c: 0x2a9d8f, s: 0.42 },
    { x: 0.15, z: 0.95, c: 0xe9c46a, s: 0.45 },
  ];
  for (const gp of giftPresets) {
    xmasTree.add(box(gp.s, gp.s, gp.s, gp.c, gp.x, gp.s / 2, gp.z));
    xmasTree.add(box(gp.s + 0.03, gp.s + 0.02, 0.1, 0xffe066, gp.x, gp.s / 2, gp.z));
  }
  foterWinterGroup.add(xmasTree);

  // 2) Téli Tábortűz és Bogrács a Főtér jobb-elülső részén (1.35, 0, 0.85)
  const winterFire = new THREE.Group();
  winterFire.position.set(1.35, 0.08, 0.85);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    winterFire.add(box(0.32, 0.22, 0.28, 0x6e685f, Math.cos(a) * 0.82, 0.11, Math.sin(a) * 0.82));
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const pole = cyl(0.06, 0.08, 3.1, 0x4a2f18, Math.cos(a) * 0.55, 1.4, Math.sin(a) * 0.55, 6);
    pole.rotation.z = Math.cos(a) * 0.32;
    pole.rotation.x = -Math.sin(a) * 0.32;
    winterFire.add(pole);
  }
  winterFire.add(cyl(0.62, 0.4, 0.72, 0x2c2930, 0, 1.12, 0, 10));
  winterFire.add(cyl(0.57, 0.57, 0.05, 0xc84b31, 0, 1.49, 0, 10));
  for (let i = 0; i < 4; i++) {
    const f = cone(0.28, 0.75, i % 2 ? 0xffcf55 : 0xf0781f, (i - 1.5) * 0.18, 0.38, (i % 2 - 0.5) * 0.18, 5);
    winterFire.add(f);
    flames.push(f);
  }
  foterWinterGroup.add(winterFire);
  g.add(foterWinterGroup);

  for (let i = 0; i < 7; i++) {
    const puff = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.25, 0),
      new THREE.MeshBasicMaterial({ color: 0xeae2d3, transparent: true, opacity: 0.6 })
    );
    puff.visible = false;
    scene.add(puff);
    smokePuffs.push({ mesh: puff, offset: i / 7 });
  }
  registerLandmark('tuz', g, 4.5, 5.2);
}

// 4.2 Fahíd
{
  const g = new THREE.Group();
  const len = BRIDGE.southZ - BRIDGE.northZ;
  g.position.set(BRIDGE.x, 0, (BRIDGE.southZ + BRIDGE.northZ) / 2);
  g.add(box(3.4, 0.25, len, 0x8a5a33, 0, 0.45, 0));
  for (const side of [-1.55, 1.55]) {
    g.add(box(0.14, 0.12, len, 0x5a3a22, side, 1.15, 0));
    for (let z = -len / 2 + 0.5; z <= len / 2 - 0.5; z += 2.5) {
      g.add(box(0.16, 1.2, 0.16, 0x5a3a22, side, 0.6, z));
    }
  }
  registerLandmark('hid', g, 2.5, 2.5);
}

// 4.3 Kocsma
{
  const g = new THREE.Group();
  g.position.set(PLACES.kocsma.x, 0, PLACES.kocsma.z - 4.2);
  g.add(box(7.2, 2.8, 5.4, 0xf2e8cf, 0, 1.4, 0));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 2.6, 4), mat(0x9e3b24));
  roof.position.set(0, 4.1, 0);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
  g.add(box(1.2, 1.9, 0.15, 0x5a3a22, 0, 0.95, 2.72));
  for (const dx of [-2.4, 2.4]) {
    g.add(box(1.8, 0.6, 0.9, 0x8a5a33, dx, 0.3, 4.2));
  }
  g.add(cyl(0.45, 0.45, 1.0, 0x6b4423, -3.0, 0.5, 2.9, 8));
  registerLandmark('kocsma', g, 4.5, 5.5);
}

// 4.4 Vadászház
{
  const g = new THREE.Group();
  g.position.set(PLACES.vadaszhaz.x, 0, PLACES.vadaszhaz.z - 3.5);
  g.add(box(6.0, 2.5, 4.8, 0x74482a, 0, 1.25, 0));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.8, 2.4, 4), mat(0x3b5e3c));
  roof.position.set(0, 3.7, 0);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
  for (let i = 0; i < 3; i++) {
    const log = cyl(0.22, 0.22, 2.2, 0x9a6a3c, 3.6, 0.22 + i * 0.38, 0, 6);
    log.rotation.x = Math.PI / 2;
    g.add(log);
  }
  registerLandmark('vadaszhaz', g, 4.2, 5.0);
}

// 4.5 Piac
{
  const g = new THREE.Group();
  g.position.set(PLACES.piac.x, 0, PLACES.piac.z);
  const colors = [0xc8343a, 0xd99b26, 0x3f7350];
  [-3.2, 0, 3.2].forEach((dx, i) => {
    g.add(box(2.4, 0.9, 1.4, 0x8a5a33, dx, 0.45, -1.5));
    g.add(box(2.6, 0.25, 1.8, colors[i], dx, 2.1, -1.5));
    for (const sx of [-1.05, 1.05]) {
      g.add(box(0.1, 2.0, 0.1, 0x5a3a22, dx + sx, 1.05, -2.1));
      g.add(box(0.1, 2.0, 0.1, 0x5a3a22, dx + sx, 1.05, -0.9));
    }
  });
  registerLandmark('piac', g, 4.8, 3.5);
}

// 4.6 Horgászstég
{
  const g = new THREE.Group();
  const rz = riverZ(PLACES.steg.x);
  g.position.set(PLACES.steg.x, 0, rz + RIVER_HALF_WIDTH - 1.2);
  g.add(box(2.0, 0.2, 5.0, 0x8a5a33, 0, 0.4, 0));
  for (const dz of [-2.0, 0, 2.0]) {
    g.add(cyl(0.12, 0.12, 1.1, 0x5a3a22, -0.85, 0.1, dz, 6));
    g.add(cyl(0.12, 0.12, 1.1, 0x5a3a22, 0.85, 0.1, dz, 6));
  }
  registerLandmark('steg', g, 2.5, 2.5);
}

// 4.7 Szélmalom
{
  const g = new THREE.Group();
  g.position.set(PLACES.malom.x, 0, PLACES.malom.z);
  g.add(cyl(1.7, 2.4, 6.2, 0xf3ead6, 0, 3.1, 0, 8));
  g.add(cone(2.0, 1.8, 0x8c4a27, 0, 7.1, 0, 8));
  g.add(box(0.9, 1.6, 0.2, 0x5a3a22, 0, 0.8, 2.32));

  windmillBlades = new THREE.Group();
  windmillBlades.position.set(0, 5.4, 2.05);
  windmillBlades.add(cyl(0.2, 0.2, 0.6, 0x4a2f18, 0, 0, 0, 6));
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    arm.add(box(0.14, 3.8, 0.1, 0x5a3a22, 0, 1.9, 0));
    arm.add(box(0.65, 2.8, 0.04, 0xfff6e0, 0.32, 2.2, 0.04));
    windmillBlades.add(arm);
  }
  g.add(windmillBlades);
  registerLandmark('malom', g, 4.0, 8.0);
}

// 4.8 Gémeskút
{
  const g = new THREE.Group();
  g.position.set(PLACES.gemeskut.x, 0, PLACES.gemeskut.z);
  g.add(cyl(1.0, 1.0, 0.9, 0x8b857c, 0, 0.45, 0, 8));
  g.add(cyl(0.75, 0.75, 0.92, 0x3a7ca5, 0, 0.46, 0, 8));
  g.add(cyl(0.14, 0.18, 4.2, 0x5a3a22, -1.6, 2.1, 0, 6));
  const beam = box(4.8, 0.14, 0.14, 0x74482a, -0.4, 4.1, 0);
  beam.rotation.z = -0.25;
  g.add(beam);
  g.add(cyl(0.03, 0.03, 2.4, 0x8a5a33, 1.6, 2.4, 0, 4));
  g.add(cyl(0.22, 0.18, 0.4, 0x5a3a22, 1.6, 1.1, 0, 7));
  registerLandmark('gemeskut', g, 2.8, 5.0);
}

// 4.9 Legelő és Állatok
{
  const g = new THREE.Group();
  g.position.set(PLACES.legelo.x, 0, PLACES.legelo.z);
  const R = 7.5;
  for (let i = -R; i <= R; i += 2.5) {
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, i, 0.55, -R));
    if (Math.abs(i) > 1.5) g.add(box(0.16, 1.1, 0.16, 0x6b4423, i, 0.55, R));
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, -R, 0.55, i));
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, R, 0.55, i));
  }
  g.add(box(R * 2, 0.1, 0.1, 0x8a5a33, 0, 0.85, -R));
  g.add(box(0.1, 0.1, R * 2, 0x8a5a33, -R, 0.85, 0));
  g.add(box(0.1, 0.1, R * 2, 0x8a5a33, R, 0.85, 0));
  g.add(box(2.4, 0.5, 0.9, 0x6b4423, -4.2, 0.25, -4.5));
  g.add(box(2.1, 0.52, 0.65, 0x4ea5d9, -4.2, 0.26, -4.5));

  for (let i = 0; i < 7; i++) {
    const isCow = i < 3;
    const animal = new THREE.Group();
    if (isCow) {
      animal.add(box(0.9, 0.65, 1.4, 0xf5f5f0, 0, 0.65, 0));
      animal.add(box(0.45, 0.4, 0.5, 0x3b2f2f, 0.24, 0.72, 0.1));
      animal.add(box(0.5, 0.48, 0.55, 0xf5f5f0, 0, 0.88, 0.85));
      for (const [lx, lz] of [[-0.3, -0.5], [0.3, -0.5], [-0.3, 0.5], [0.3, 0.5]]) {
        animal.add(box(0.16, 0.45, 0.16, 0xf5f5f0, lx, 0.22, lz));
      }
    } else {
      animal.add(box(0.65, 0.5, 0.85, 0xfff8ea, 0, 0.5, 0));
      animal.add(box(0.35, 0.35, 0.4, 0x3b2f2f, 0, 0.65, 0.52));
      for (const [lx, lz] of [[-0.2, -0.3], [0.2, -0.3], [-0.2, 0.3], [0.2, 0.3]]) {
        animal.add(box(0.12, 0.35, 0.12, 0x3b2f2f, lx, 0.17, lz));
      }
    }
    const ax = (hash(`an_${i}`, 1) - 0.5) * 9;
    const az = (hash(`an_${i}`, 2) - 0.5) * 9;
    animal.position.set(ax, 0, az);
    g.add(animal);
    pastureAnimals.push({ mesh: animal, baseX: ax, baseZ: az, seed: i * 1.7 });
  }
  registerLandmark('legelo', g, 6.5, 3.0);
}

// --- 5. Táj / Évszak (Tavasz, Nyár, Ősz, Tél/Havas) & Független Időjárás Rendszer ---
let currentSeason = 'nyar';   // 'tavasz' | 'nyar' | 'osz' | 'tel'
let currentWeather = 'clear'; // 'clear' | 'rain' | 'snow' | 'fog'

const SEASON_PALETTES = {
  tavasz: {
    ground: 0x88c452,
    bank: 0xd6c79c,
    water: 0x4ea5d9,
    road: 0xc8b288,
    daySkyBg: 0x88c452,
    dayGroundLight: 0x9ec864,
    leaves: [0xf7a8b8, 0xffd1dc, 0x7ed957, 0x95e06c, 0x6ec24a],
    pines: [0x3e7a52, 0x4c8c62],
    bushes: [0x589b32, 0x6bb83e, 0x7ed957, 0x4d8c28],
    flowers: [0xffcf55, 0xf28482, 0xffffff, 0xc77dff, 0x7ed957],
    showFlowers: true,
  },
  nyar: {
    ground: 0x8fb24a,
    bank: 0xd5c295,
    water: 0x4ea5d9,
    road: 0xc8b082,
    daySkyBg: 0x8fb24a,
    dayGroundLight: 0x9ab05a,
    leaves: [0x5c8c38, 0x6e9e42, 0x4f7d2f, 0x65963e],
    pines: [0x3b6e4c, 0x457b57],
    bushes: [0x48732e, 0x3e6b28, 0x588835, 0x527931],
    flowers: [0xe63946, 0xffb703, 0x8338ec, 0xffffff, 0x3a86ff, 0xf72585],
    showFlowers: true,
  },
  osz: {
    ground: 0xb59449,
    bank: 0xc4ae82,
    water: 0x3d8ab8,
    road: 0xb89f72,
    daySkyBg: 0xb59449,
    dayGroundLight: 0xa88944,
    leaves: [0xc83e2b, 0xe07a2e, 0xe8b838, 0xa85528, 0xd95d39],
    pines: [0x32593e, 0x3b6648],
    bushes: [0xc86a24, 0xb84a20, 0xd49b27, 0x9e582a, 0xa85528],
    flowers: [0xe07a2e, 0xc83e2b, 0xe8b838, 0x9e582a],
    showFlowers: true,
  },
  tel: {
    ground: 0xeaf1f7,
    bank: 0xdce6ef,
    water: 0x7ab8de,
    road: 0xcfd8df,
    daySkyBg: 0xdce8f2,
    dayGroundLight: 0xd0dde8,
    leaves: [0xe8f1f7, 0xd2e2ec, 0xf4f9fc, 0xc5d8e6],
    pines: [0x8fb5af, 0xb8d4d0, 0xdbe9eb],
    bushes: [0xc8d8e4, 0xd6e5f0, 0xaec5c0, 0x98b2a8],
    flowers: [0xf4f9fc],
    showFlowers: false,
  },
};

function applySeason(season) {
  if (!SEASON_PALETTES[season]) return;
  currentSeason = season;
  const pal = SEASON_PALETTES[season];
  const isWinter = season === 'tel';

  document.querySelectorAll('.season-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.s === season);
  });

  // 1. Talaj, folyópart, víz és utak színezése
  if (envRefs.groundMat) envRefs.groundMat.color.setHex(pal.ground);
  if (envRefs.bankMat) envRefs.bankMat.color.setHex(pal.bank);
  if (envRefs.waterMat) envRefs.waterMat.color.setHex(pal.water);
  if (envRefs.roadMat) envRefs.roadMat.color.setHex(pal.road);

  // 2. Falevelek (Lombhullató fák + Fenyők) átszínezése az évszaknak megfelelően!
  const cHelper = new THREE.Color();
  if (envRefs.crownInst) {
    envRefs.deciduousCoords.forEach((t, i) => {
      const idx = Math.floor(t.shade * pal.leaves.length) % pal.leaves.length;
      envRefs.crownInst.setColorAt(i, cHelper.setHex(pal.leaves[idx]));
    });
    envRefs.crownInst.instanceColor.needsUpdate = true;
  }
  if (envRefs.pineInst) {
    envRefs.pineCoords.forEach((t, i) => {
      const idx = Math.floor(t.shade * pal.pines.length) % pal.pines.length;
      envRefs.pineInst.setColorAt(i, cHelper.setHex(pal.pines[idx]));
    });
    envRefs.pineInst.instanceColor.needsUpdate = true;
  }

  // Bokrok átszínezése az évszaknak megfelelően
  if (envRefs.bushInst && envRefs.bushCoords) {
    envRefs.bushCoords.forEach((b, i) => {
      const idx = Math.floor(b.shade * pal.bushes.length) % pal.bushes.length;
      envRefs.bushInst.setColorAt(i, cHelper.setHex(pal.bushes[idx]));
    });
    envRefs.bushInst.instanceColor.needsUpdate = true;
  }

  // 3. Virágok / Őszi avar / Téli hóréteg
  if (envRefs.flowerInst) {
    envRefs.flowerInst.visible = pal.showFlowers;
    if (pal.showFlowers) {
      const FL_LEN = 450;
      for (let i = 0; i < FL_LEN; i++) {
        envRefs.flowerInst.setColorAt(i, cHelper.setHex(pal.flowers[i % pal.flowers.length]));
      }
      envRefs.flowerInst.instanceColor.needsUpdate = true;
    }
  }

  // 4. Házak tetején lévő hóréteg ki/bekapcsolása
  for (const sr of envRefs.snowRoofs) {
    sr.visible = isWinter;
  }

  // 5. Főtér átváltása: Télen Tábortűz + Karácsonyfa, más évszakban Díszkút!
  if (foterRegularGroup) foterRegularGroup.visible = !isWinter;
  if (foterWinterGroup) foterWinterGroup.visible = isWinter;
  for (const sp of smokePuffs) {
    sp.mesh.visible = isWinter;
  }

  updateFogForWeatherAndSeason();
  if (typeof updateDaylight === 'function' && typeof currentSec === 'function') {
    updateDaylight(currentSec(), 0);
  }
}

const WEATHER_COUNT = 950;
const weatherGeo = new THREE.BufferGeometry();
const weatherPositions = new Float32Array(WEATHER_COUNT * 3);
for (let i = 0; i < WEATHER_COUNT; i++) {
  weatherPositions[i * 3] = (Math.random() - 0.5) * 95;
  weatherPositions[i * 3 + 1] = Math.random() * 40;
  weatherPositions[i * 3 + 2] = (Math.random() - 0.5) * 95;
}
weatherGeo.setAttribute('position', new THREE.BufferAttribute(weatherPositions, 3));
const weatherMat = new THREE.PointsMaterial({ color: 0xd0e8ff, size: 0.35, transparent: true, opacity: 0.78 });
const weatherPoints = new THREE.Points(weatherGeo, weatherMat);
weatherPoints.visible = false;
scene.add(weatherPoints);

function updateFogForWeatherAndSeason() {
  if (currentWeather === 'fog') {
    const fogHex = currentSeason === 'tel' ? 0xdde7f0 : 0xc5cfd6;
    scene.fog = new THREE.FogExp2(fogHex, 0.015);
  } else if (currentWeather === 'rain') {
    scene.fog = new THREE.FogExp2(0x8fa3b8, 0.0038);
  } else if (currentWeather === 'snow') {
    scene.fog = new THREE.FogExp2(0xdce6f0, 0.0042);
  } else {
    // Derült időjárás (akár havas tájon is kristálytiszta, derült látótávolság!)
    scene.fog = null;
  }
}

function applyWeather(weather) {
  currentWeather = weather;
  document.querySelectorAll('.weather-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.w === weather);
  });

  weatherPoints.visible = weather === 'rain' || weather === 'snow';
  if (weather === 'rain') {
    weatherMat.color.setHex(0x9ec5fe);
    weatherMat.size = 0.28;
  } else if (weather === 'snow') {
    weatherMat.color.setHex(0xffffff);
    weatherMat.size = 0.48;
  }
  updateFogForWeatherAndSeason();
}

document.querySelectorAll('.season-btn').forEach((btn) => {
  btn.addEventListener('click', () => applySeason(btn.dataset.s));
});
document.querySelectorAll('.weather-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyWeather(btn.dataset.w));
});

function updateWeather(dt) {
  if (currentWeather !== 'rain' && currentWeather !== 'snow') return;
  const pos = weatherGeo.attributes.position.array;
  const fallSpeed = currentWeather === 'rain' ? 28 : 6.5;
  const cx = controls.target.x;
  const cz = controls.target.z;

  for (let i = 0; i < WEATHER_COUNT; i++) {
    const idx = i * 3;
    pos[idx + 1] -= fallSpeed * dt;
    if (currentWeather === 'snow') {
      pos[idx] += Math.sin(performance.now() * 0.002 + i) * 0.03;
    }
    if (pos[idx + 1] < 0) {
      pos[idx] = cx + (Math.random() - 0.5) * 95;
      pos[idx + 1] = 35 + Math.random() * 8;
      pos[idx + 2] = cz + (Math.random() - 0.5) * 95;
    }
  }
  weatherGeo.attributes.position.needsUpdate = true;
}

// --- 6. Lakosok, Házak és a "Saját házam" 3D Jelzőoszlop ---
// 3D "Saját házam" mutató a saját ház teteje felett (forgó gyűrű + lefelé mutató nyíl)
myHomeBeacon = new THREE.Group();
{
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.85, 1.8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff5a36 })
  );
  arrow.rotation.x = Math.PI;
  arrow.position.y = 5.6;
  myHomeBeacon.add(arrow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.8, 3.2, 24),
    new THREE.MeshBasicMaterial({ color: 0xff5a36, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  myHomeBeacon.add(ring);
  myHomeBeacon.visible = false;
  scene.add(myHomeBeacon);
}

function updateMyHomeBeaconPosition() {
  if (!myHomeBeacon) return;
  if (!currentConnectedUser) {
    myHomeBeacon.visible = false;
    return;
  }
  const myRes = byName.get(currentConnectedUser.toLowerCase());
  if (!myRes) {
    myHomeBeacon.visible = false;
    return;
  }
  myHomeBeacon.visible = true;
  myHomeBeacon.position.set(myRes.x, 0, myRes.z);
}

function createHouseGroup(res) {
  const g = new THREE.Group();
  const wallMat = new THREE.MeshLambertMaterial({ color: res.wall || '#f5eedc', flatShading: true });
  const roofMat = new THREE.MeshLambertMaterial({ color: res.roof || '#c8523b', flatShading: true });
  const winMat = new THREE.MeshBasicMaterial({ color: 0x3a2e24 });

  const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.2, 3.8), wallMat);
  wallMesh.position.y = 1.1;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  g.add(wallMesh);

  const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.0, 4), roofMat);
  roofMesh.position.y = 3.1;
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.castShadow = true;
  g.add(roofMesh);

  // Téli hóréteg a háztetőn (csak téli/havas tájon látszik)
  const snowRoof = new THREE.Mesh(
    new THREE.ConeGeometry(3.52, 1.55, 4),
    mat(0xf2f7fb)
  );
  snowRoof.position.y = 3.38;
  snowRoof.rotation.y = Math.PI / 4;
  snowRoof.visible = currentSeason === 'tel';
  g.add(snowRoof);
  envRefs.snowRoofs.push(snowRoof);

  // Kémény és Ajtó
  g.add(box(0.55, 1.2, 0.55, 0x7a6f64, 1.1, 3.3, -0.6));
  g.add(box(0.85, 1.55, 0.12, 0x5a3a22, 0, 0.78, 1.92));

  // Bejárati kőlépcső / küszöb
  const doorstep = box(1.3, 0.14, 0.65, 0x857a6e, 0, 0.07, 2.15);
  g.add(doorstep);

  // Ablakok és virágládák virágokkal az ablakok alatt
  for (const wx of [-1.25, 1.25]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.62, 0.12), winMat);
    win.position.set(wx, 1.25, 1.92);
    const planter = box(0.72, 0.22, 0.26, 0x5a3a22, wx, 0.88, 2.0);
    const blossomColor = (wx < 0) ? 0xe63946 : 0xffb703;
    const blossoms = box(0.66, 0.16, 0.20, blossomColor, wx, 1.02, 2.0);
    g.add(win, planter, blossoms);
  }

  // Udvar díszek: Fa léckerítés a telek két oldalán
  for (const side of [-2.55, 2.55]) {
    g.add(box(0.12, 0.75, 0.12, 0x5a3a22, side, 0.375, 2.0));
    g.add(box(0.12, 0.75, 0.12, 0x5a3a22, side, 0.375, 0.0));
    g.add(box(0.08, 0.09, 2.0, 0x6e472a, side, 0.52, 1.0));
    g.add(box(0.08, 0.09, 2.0, 0x6e472a, side, 0.25, 1.0));
  }

  // Cserép virág / levendula a lépcső mellett
  g.add(cyl(0.22, 0.16, 0.3, 0xa65228, 0.95, 0.15, 2.25));
  g.add(cone(0.32, 0.55, 0x8338ec, 0.95, 0.52, 2.25));

  g.position.set(res.x, 0, res.z);
  g.rotation.y = res.rot || 0;
  g.userData = { wallMat, roofMat, winMat, resident: res };
  wallMesh.userData.resident = res;
  roofMesh.userData.resident = res;
  housePickers.push(wallMesh, roofMesh);
  scene.add(g);

  // KÖZVETLEN JÁRDA AZ UTCÁHOZ (Ház-utca összekötés tetszetős szegélyköves járdával)
  const doorX = res.x + Math.sin(res.rot || 0) * 2.3;
  const doorZ = res.z + Math.cos(res.rot || 0) * 2.3;
  const nearestRoad = getClosestPointOnRoads(doorX, doorZ);
  const pathDist = Math.hypot(nearestRoad.x - doorX, nearestRoad.z - doorZ);
  if (pathDist > 0.35) {
    const sidewalkGroup = new THREE.Group();
    // Fő járdafelület (kavicsos/díszköves járda)
    const walkMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.65, 0.05, pathDist),
      envRefs.roadMat || mat(0xc8b082)
    );
    walkMesh.receiveShadow = true;
    sidewalkGroup.add(walkMesh);

    // Kétoldali szegélykő a járda mentén
    const curbMat = mat(0x8f8474);
    const curbLeft = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, pathDist), curbMat);
    curbLeft.position.x = -0.85;
    const curbRight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, pathDist), curbMat);
    curbRight.position.x = 0.85;
    curbLeft.receiveShadow = true;
    curbRight.receiveShadow = true;
    sidewalkGroup.add(curbLeft, curbRight);

    sidewalkGroup.position.set((doorX + nearestRoad.x) / 2, 0.032, (doorZ + nearestRoad.z) / 2);
    sidewalkGroup.rotation.y = Math.atan2(nearestRoad.x - doorX, nearestRoad.z - doorZ);
    scene.add(sidewalkGroup);
  }

  return g;
}

function createVillagerGroup(res) {
  const g = new THREE.Group();
  const clothMat = new THREE.MeshLambertMaterial({ color: res.cloth || '#c8343a', flatShading: true });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 1.05, 7), clothMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), mat(0xf4cbb2));
  head.position.y = 1.32;
  head.castShadow = true;
  g.add(head);

  const hatBrim = cyl(0.42, 0.42, 0.06, 0x3b2818, 0, 1.52, 0, 8);
  const hatTop = cyl(0.24, 0.27, 0.25, 0x3b2818, 0, 1.65, 0, 8);
  g.add(hatBrim, hatTop);

  g.userData = { clothMat, resident: res };
  body.userData.residentFigure = res;
  head.userData.residentFigure = res;
  figurePickers.push(body, head);
  scene.add(g);
  return g;
}

function updatePlotCapacityUI() {
  const maxHouses = villageData.maxHouses || 40;
  const count = residents.length;
  const free = Math.max(0, maxHouses - count);
  const isFull = count >= maxHouses;

  el('resident-count').textContent = `${count} lakos · ${villageData.day || 5}. nap`;
  const badge = el('plot-capacity-badge');
  if (badge) {
    badge.textContent = isFull
      ? `🔒 Telkek: ${count} / ${maxHouses} (MEGTELT)`
      : `🏘️ Telkek: ${count} / ${maxHouses} foglalt (${free} szabad)`;
    badge.style.color = isFull ? 'var(--red)' : 'var(--green)';
  }

  const addOpenBtn = el('add-open');
  if (addOpenBtn) {
    addOpenBtn.textContent = isFull
      ? `🔒 Falu tele (${count}/${maxHouses})`
      : `🏡 Telek foglalása (${free})`;
  }

  const banner = el('add-capacity-banner');
  const capText = el('add-capacity-text');
  const capSub = el('add-capacity-sub');
  const fullWarn = el('add-full-warning');
  const submitBtn = el('add-submit-btn');

  if (banner && capText && capSub) {
    banner.classList.toggle('full', isFull);
    capText.textContent = isFull
      ? `🔒 Telkek: ${count} / ${maxHouses} (Minden telek elkelt)`
      : `🏘️ Foglalt telkek: ${count} / ${maxHouses}`;
    capSub.textContent = isFull ? 'Lezárva' : `${free} szabad telek`;
  }
  if (fullWarn) fullWarn.hidden = !isFull;
  if (submitBtn) {
    submitBtn.disabled = isFull;
    submitBtn.textContent = isFull
      ? `🔒 A falu megtelt (${maxHouses}/${maxHouses})`
      : '🏡 Telek generálása és Beköltözés!';
  }
}

function addResidentToWorld(raw) {
  const doorDist = 2.9;
  const door = [
    raw.x + Math.sin(raw.rot || 0) * doorDist,
    raw.z + Math.cos(raw.rot || 0) * doorDist,
  ];
  const res = {
    ...raw,
    door,
    speed: 1.8 + hash(raw.name, 3) * 0.6,
  };
  res.houseGroup = createHouseGroup(res);
  res.figureGroup = createVillagerGroup(res);
  residents.push(res);
  byName.set(res.name.toLowerCase(), res);
  if (!housePrivacyMap[res.name.toLowerCase()]) {
    housePrivacyMap[res.name.toLowerCase()] = 'public';
  }
  updatePlotCapacityUI();
  return res;
}

villageData.residents.forEach(addResidentToWorld);
updateClaimButtonUI();
updateMyHomeBeaconPosition();

// --- 7. Determinisztikus Falusi Élet, Séta az Utcákon és Alvásrend ---
const VILLAGE_CIRCUITS = {
  SW_MAIN: [
    [-11, 20], [-19, 24], [-28, 30], [-31, 44], [-16, 46], [-4, 38], [0, 36], [0, 20]
  ],
  SE_MAIN: [
    [12, 20], [20, 25], [30, 32], [32, 46], [14, 46], [4, 38], [0, 36], [0, 20]
  ],
  WEST_VADON: [
    [-14, 3.5], [-28, -1], [-38, 4], [-48, 4], [-54, 4], [-48, 4], [-38, 4], [-14, 3.5], [-11, 20], [0, 20], [0, 3.5]
  ],
  EAST_HORGASZ: [
    [14, 3.5], [26, 3.5], [36, 3], [44, 5], [52, 4], [44, 5], [36, 3], [14, 3.5], [12, 20], [0, 20], [0, 3.5]
  ],
  NW_MAIN: [
    [-14, -20], [-24, -20], [-36, -16], [-12, -27], [-12, -48], [0, -48], [0, -36], [0, -19.5]
  ],
  NE_MAIN: [
    [14, -20], [24, -20], [32, -18], [44, -24], [48, -36], [44, -48], [0, -48], [0, -36], [0, -19.5]
  ],
  FOTER_SOUTH: [
    [0, 3.5], [0, 20], [12, 20], [20, 25], [30, 32], [4, 38], [0, 36], [-4, 38], [-11, 20], [0, 20]
  ]
};

function getResidentStreetRoute(res) {
  if (res.cachedRoute) return res.cachedRoute;
  const doorX = res.door[0];
  const doorZ = res.door[1];
  const nr = getClosestPointOnRoads(doorX, doorZ);

  let circ = VILLAGE_CIRCUITS.FOTER_SOUTH;
  if (res.z < 0) {
    circ = res.x < 0 ? VILLAGE_CIRCUITS.NW_MAIN : VILLAGE_CIRCUITS.NE_MAIN;
  } else {
    if (res.x < -20 && res.z < 15) circ = VILLAGE_CIRCUITS.WEST_VADON;
    else if (res.x > 25 && res.z < 15) circ = VILLAGE_CIRCUITS.EAST_HORGASZ;
    else if (res.x < 0) circ = VILLAGE_CIRCUITS.SW_MAIN;
    else circ = VILLAGE_CIRCUITS.SE_MAIN;
  }

  // Megkeressük a legközelebbi csomópontot a járdavéghez
  let bestIdx = 0, bestDist = Infinity;
  circ.forEach((pt, i) => {
    const d = Math.hypot(pt[0] - nr.x, pt[1] - nr.z);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });

  const loop = [];
  for (let i = 0; i < circ.length; i++) {
    loop.push(circ[(bestIdx + i) % circ.length]);
  }
  loop.push(circ[bestIdx]);

  const pts = [
    [doorX, doorZ],
    [nr.x, nr.z],
    ...loop,
    [nr.x, nr.z],
    [doorX, doorZ]
  ];
  res.cachedRoute = measureRoute(pts);
  return res.cachedRoute;
}

function spotNearPlace(res, placeKey) {
  const p = PLACES[placeKey] || PLACES.tuz;
  const angle = hash(res.name, 10 + placeKey.length) * Math.PI * 2;
  const r = (0.35 + 0.65 * Math.sqrt(hash(res.name, 20 + placeKey.length))) * p.r;
  return [p.x + Math.cos(angle) * r, p.z + Math.sin(angle) * r];
}

function buildWaypoints(x1, z1, x2, z2) {
  const side1 = z1 > riverZ(x1);
  const side2 = z2 > riverZ(x2);
  if (side1 === side2) return [[x1, z1], [x2, z2]];
  const firstBridgeZ = side1 ? BRIDGE.southZ : BRIDGE.northZ;
  const secondBridgeZ = side1 ? BRIDGE.northZ : BRIDGE.southZ;
  return [
    [x1, z1],
    [BRIDGE.x, firstBridgeZ],
    [BRIDGE.x, secondBridgeZ],
    [x2, z2],
  ];
}

function measureRoute(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    lengths.push(lengths[i - 1] + d);
  }
  return { points, lengths, total: lengths[lengths.length - 1] || 0.01 };
}

function positionAlong(route, dist) {
  const { points, lengths, total } = route;
  const d = Math.max(0, Math.min(total, dist));
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < d) i++;
  const span = (lengths[i] - lengths[i - 1]) || 1;
  const k = (d - lengths[i - 1]) / span;
  const [ax, az] = points[i - 1];
  const [bx, bz] = points[i];
  return {
    x: ax + (bx - ax) * k,
    z: az + (bz - az) * k,
    heading: Math.atan2(bx - ax, bz - az),
  };
}

function whereIs(res, sec) {
  const bedtimeHour = 19.0 + hash(res.name, 11) * 3.0; // Random 19:00 - 22:00 között
  const wakeHour = 5.0 + hash(res.name, 12) * 3.0;    // Random 5:00 - 8:00 között
  const bedtimeSec = bedtimeHour * HOUR;
  const wakeSec = wakeHour * HOUR;

  // 1. Éjszakai alvás: este bemegy a házába, és csak reggel jön elő
  const isSleeping = (sec >= bedtimeSec || sec < wakeSec);
  if (isSleeping) {
    return {
      mode: 'sleep',
      x: res.door[0],
      z: res.door[1],
      heading: res.rot || 0,
      visible: false,
    };
  }

  // 2. Este a lefekvés előtti 90 másodpercben a járdán besétál a házába
  const returnWindow = 90;
  if (sec >= bedtimeSec - returnWindow && sec < bedtimeSec) {
    const route = getResidentStreetRoute(res);
    const pDoor = route.points[0];
    const pRoad = route.points[1];
    const t = (sec - (bedtimeSec - returnWindow)) / returnWindow;
    const x = pRoad[0] + (pDoor[0] - pRoad[0]) * t;
    const z = pRoad[1] + (pDoor[1] - pRoad[1]) * t;
    return {
      mode: 'walk',
      x,
      z,
      heading: Math.atan2(pDoor[0] - pRoad[0], pDoor[1] - pRoad[1]),
      visible: true,
    };
  }

  // 3. Reggeli ébredéskor az első 60 másodpercben a házból kilép a járdán az utcára
  if (sec >= wakeSec && sec < wakeSec + 60) {
    const route = getResidentStreetRoute(res);
    const pDoor = route.points[0];
    const pRoad = route.points[1];
    const t = (sec - wakeSec) / 60;
    const x = pDoor[0] + (pRoad[0] - pDoor[0]) * t;
    const z = pDoor[1] + (pRoad[1] - pDoor[1]) * t;
    return {
      mode: 'walk',
      x,
      z,
      heading: Math.atan2(pRoad[0] - pDoor[0], pRoad[1] - pDoor[1]),
      visible: true,
    };
  }

  // 4. Nappali folyamatos séta a falu utcáin
  const route = getResidentStreetRoute(res);
  const elapsed = sec - wakeSec;
  const dist = (elapsed * res.speed) % route.total;
  const p = positionAlong(route, dist);
  return {
    mode: 'walk',
    ...p,
    visible: true,
  };
}

// --- 8. TELJES 3D FORGATHATÓ KAMERA (360° Forgatás + Döntés + Vezérlő Widget) ---
const controls = new MapControls(camera, renderer.domElement);
controls.enableRotate = true; // 3D forgatás engedélyezve!
controls.rotateSpeed = 0.85;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 14;
controls.maxDistance = 175;
controls.minPolarAngle = 0.22;              // Felülnézet közelében
controls.maxPolarAngle = Math.PI / 2 - 0.08; // Ne menjen a föld alá
controls.screenSpacePanning = false;

let camAzimuth = 0;
let camPolar = DEFAULT_POLAR;
let leftMouseRotates = false;

// Kamera pozíció beállítása úgy, hogy MEGTARTJA a választott 3D forgatási szöget (azimuth & polar)!
function setView(x, z, dist, azimuth = camAzimuth, polar = camPolar) {
  camAzimuth = azimuth;
  camPolar = polar;
  controls.target.set(x, 0, z);
  const sinP = Math.sin(polar);
  const cosP = Math.cos(polar);
  camera.position.set(
    x + dist * sinP * Math.sin(azimuth),
    dist * cosP,
    z + dist * sinP * Math.cos(azimuth)
  );
  controls.update();
}
setView(0, 2, 76, 0, DEFAULT_POLAR);

// Amikor a felhasználó egérrel forgatja a kamerát, elmentjük az aktuális szöget
controls.addEventListener('change', () => {
  if (!flight && !behindMode && !walker) {
    camAzimuth = controls.getAzimuthalAngle();
    camPolar = controls.getPolarAngle();
  }
});

let flight = null;
function flyTo(x, z, dist = 32, targetAzimuth = camAzimuth, targetPolar = camPolar) {
  const fromDist = camera.position.distanceTo(controls.target);
  flight = {
    t: 0,
    fromX: controls.target.x,
    fromZ: controls.target.z,
    fromDist,
    fromAzimuth: camAzimuth,
    fromPolar: camPolar,
    x,
    z,
    dist,
    targetAzimuth,
    targetPolar,
  };
}

// Jobb alsó 3D Kamera gombok (Forgatás balra/jobbra, Döntési szög, Észak, Bal egérgomb módváltó)
el('cam-rot-left').addEventListener('click', () => {
  const dist = camera.position.distanceTo(controls.target);
  flyTo(controls.target.x, controls.target.z, dist, camAzimuth + Math.PI / 4, camPolar);
});
el('cam-rot-right').addEventListener('click', () => {
  const dist = camera.position.distanceTo(controls.target);
  flyTo(controls.target.x, controls.target.z, dist, camAzimuth - Math.PI / 4, camPolar);
});
el('cam-tilt-btn').addEventListener('click', () => {
  const dist = camera.position.distanceTo(controls.target);
  const nextPolar = camPolar > 0.9 ? 0.42 : camPolar < 0.55 ? 0.78 : 1.18;
  flyTo(controls.target.x, controls.target.z, dist, camAzimuth, nextPolar);
});
el('cam-reset-north').addEventListener('click', () => {
  const dist = camera.position.distanceTo(controls.target);
  flyTo(controls.target.x, controls.target.z, dist, 0, DEFAULT_POLAR);
});
el('cam-left-mode').addEventListener('click', () => {
  leftMouseRotates = !leftMouseRotates;
  controls.mouseButtons.LEFT = leftMouseRotates ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = leftMouseRotates ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = leftMouseRotates ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
  controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
  const btn = el('cam-left-mode');
  btn.classList.toggle('active', leftMouseRotates);
  btn.textContent = leftMouseRotates
    ? '🔄 1 ujj / Bal egér: 3D Forgatás'
    : '✋ 1 ujj / Bal egér: Mozgatás';
});

const pin = cone(0.65, 1.5, 0xffcf55, 0, 5, 0, 6);
pin.rotation.x = Math.PI;
pin.visible = false;
scene.add(pin);

// --- 8.5 Időkezelés és Napszak-fények ---
let liveTime = true;
let manualSec = 12 * HOUR;
const slider = el('time-slider');
const liveBtn = el('time-live-btn');
const modeLabel = el('time-mode-label');

slider.addEventListener('input', () => {
  liveTime = false;
  liveBtn.classList.remove('active');
  modeLabel.textContent = 'Kézi csúszka';
  manualSec = Number(slider.value) * 60;
});
liveBtn.addEventListener('click', () => {
  liveTime = true;
  liveBtn.classList.add('active');
  modeLabel.textContent = 'Élő idő';
});

function currentSec() {
  if (liveTime) {
    const now = new Date();
    const s = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
    slider.value = String(Math.floor(s / 60));
    return s;
  }
  return manualSec;
}

const LIGHT_KEYFRAMES = [
  { h: 0, sky: 0x3b4e78, ground: 0x1a1e16, hemi: 0.35, sun: 0x7b92c4, power: 0.3, fire: 28, bg: 0x0b101d },
  { h: 5.5, sky: 0x3b4e78, ground: 0x1a1e16, hemi: 0.35, sun: 0x7b92c4, power: 0.3, fire: 28, bg: 0x0b101d },
  { h: 7, sky: 0xffd296, ground: 0x8a7240, hemi: 0.9, sun: 0xffae52, power: 1.9, fire: 14, bg: 0x736232 },
  { h: 8.5, sky: 0xffffff, ground: 0x9ab05a, hemi: 1.15, sun: 0xfff0cf, power: 3.0, fire: 6, bg: 0x8fb24a },
  { h: 18, sky: 0xffffff, ground: 0x9ab05a, hemi: 1.15, sun: 0xfff0cf, power: 3.0, fire: 6, bg: 0x8fb24a },
  { h: 19.5, sky: 0xffc88a, ground: 0x826438, hemi: 0.95, sun: 0xff9d42, power: 2.0, fire: 20, bg: 0x6e5630 },
  { h: 21, sky: 0x4b4468, ground: 0x2a241e, hemi: 0.45, sun: 0x9c6b78, power: 0.5, fire: 30, bg: 0x181524 },
  { h: 24, sky: 0x3b4e78, ground: 0x1a1e16, hemi: 0.35, sun: 0x7b92c4, power: 0.3, fire: 28, bg: 0x0b101d },
];
const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();

function updateDaylight(sec, outsideCount) {
  const hour = sec / HOUR;
  let i = 0;
  while (i < LIGHT_KEYFRAMES.length - 2 && LIGHT_KEYFRAMES[i + 1].h <= hour) i++;
  const a = LIGHT_KEYFRAMES[i];
  const b = LIGHT_KEYFRAMES[i + 1];
  const k = (hour - a.h) / ((b.h - a.h) || 1);

  const pal = SEASON_PALETTES[currentSeason] || SEASON_PALETTES.nyar;
  const aGround = (a.h >= 8 && a.h <= 18.5) ? pal.dayGroundLight : a.ground;
  const bGround = (b.h >= 8 && b.h <= 18.5) ? pal.dayGroundLight : b.ground;
  const aBg = (a.h >= 8 && a.h <= 18.5) ? pal.daySkyBg : a.bg;
  const bBg = (b.h >= 8 && b.h <= 18.5) ? pal.daySkyBg : b.bg;

  hemiLight.color.copy(tmpColorA.setHex(a.sky)).lerp(tmpColorB.setHex(b.sky), k);
  hemiLight.groundColor.copy(tmpColorA.setHex(aGround)).lerp(tmpColorB.setHex(bGround), k);
  hemiLight.intensity = a.hemi + (b.hemi - a.hemi) * k;

  sun.color.copy(tmpColorA.setHex(a.sun)).lerp(tmpColorB.setHex(b.sun), k);
  sun.intensity = a.power + (b.power - a.power) * k;

  scene.background.copy(tmpColorA.setHex(aBg)).lerp(tmpColorB.setHex(bBg), k);
  const fireBase = a.fire + (b.fire - a.fire) * k;
  // Télen a tábortűz és a karácsonyfa meleg fénye erősebben világít a Főtéren
  const seasonFireFactor = currentSeason === 'tel' ? 1.15 : 0.35;
  fireLight.intensity = fireBase * seasonFireFactor * (1 + Math.sin(performance.now() * 0.012) * 0.12);

  const lampsOn = hour >= 18.2 || hour < 6.5;
  for (const bm of streetLampBulbs) {
    bm.color.setHex(lampsOn ? 0xffe082 : 0x555045);
  }

  for (const res of residents) {
    const sleepHour = 21.8 + hash(res.name, 9) * 2.0;
    const isLit = (hour >= 18.5 && hour < sleepHour) || (hour >= 5.5 && hour < 6.8);
    res.houseGroup.userData.winMat.color.setHex(isLit ? 0xffd470 : 0x3a2e24);
  }

  const hh = String(Math.floor(hour)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  el('clock-text').textContent = `${hh}:${mm} · ${outsideCount} lakos van kint`;
}

// --- 9. 3D SZOBA BELSŐ NÉZET (Interior Scene) ---
let inRoomMode = false;
let activeRoomData = null;
let selectedFurnitureId = null;
let draggingFurnitureMesh = null;

const roomScene = new THREE.Scene();
roomScene.background = new THREE.Color(0x231912);
const roomCamera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 100);
const roomControls = new OrbitControls(roomCamera, renderer.domElement);
roomControls.enableDamping = true;
roomControls.enabled = false;
roomControls.maxPolarAngle = Math.PI / 2 - 0.08;
roomControls.minDistance = 4.5;
roomControls.maxDistance = 16;

const roomHemi = new THREE.HemisphereLight(0xfff5e4, 0x5a3e28, 1.25);
roomScene.add(roomHemi);
const roomPoint = new THREE.PointLight(0xffb86c, 2.2, 18);
roomPoint.position.set(0, 4.2, 0);
roomPoint.castShadow = true;
roomScene.add(roomPoint);

const roomFloor = new THREE.Mesh(
  new THREE.BoxGeometry(6.4, 0.25, 6.4),
  new THREE.MeshLambertMaterial({ color: 0xb07d4f })
);
roomFloor.position.y = -0.125;
roomFloor.receiveShadow = true;
roomScene.add(roomFloor);

const backWall = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.4, 0.25), mat(0xf5eedc));
backWall.position.set(0, 1.7, -3.1);
backWall.receiveShadow = true;
roomScene.add(backWall);

const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.4, 6.4), mat(0xede2c9));
leftWall.position.set(-3.1, 1.7, 0);
leftWall.receiveShadow = true;
roomScene.add(leftWall);

roomScene.add(box(1.5, 1.2, 0.3, 0x8fd0e8, 1.2, 1.9, -3.08));
roomScene.add(box(1.65, 0.12, 0.34, 0x5a3a22, 1.2, 1.28, -3.06));

const furnitureGroup = new THREE.Group();
roomScene.add(furnitureGroup);
const furnitureMeshes = [];

function build3DFurnitureModel(item) {
  const g = new THREE.Group();
  if (!item.unboxed) {
    g.add(box(0.85, 0.75, 0.85, 0xe63946, 0, 0.38, 0));
    g.add(box(0.9, 0.78, 0.18, 0xffcf55, 0, 0.39, 0));
    g.add(box(0.18, 0.78, 0.9, 0xffcf55, 0, 0.39, 0));
  } else {
    switch (item.type) {
      case 'agy':
        g.add(box(1.5, 0.4, 2.2, 0x6b4423, 0, 0.2, 0));
        g.add(box(1.36, 0.22, 1.95, 0xc8343a, 0, 0.45, 0.05));
        g.add(box(1.2, 0.18, 0.45, 0xfff8ea, 0, 0.6, -0.68));
        g.add(box(1.5, 0.95, 0.16, 0x5a3a22, 0, 0.48, -1.05));
        break;
      case 'asztal':
        g.add(box(1.7, 0.12, 1.1, 0x8a5a33, 0, 0.78, 0));
        for (const [lx, lz] of [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]]) {
          g.add(box(0.12, 0.75, 0.12, 0x5a3a22, lx, 0.38, lz));
        }
        break;
      case 'szek':
        g.add(box(0.6, 0.08, 0.6, 0x8a5a33, 0, 0.46, 0));
        g.add(box(0.6, 0.55, 0.08, 0x6b4423, 0, 0.75, -0.26));
        for (const [lx, lz] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) {
          g.add(box(0.08, 0.45, 0.08, 0x5a3a22, lx, 0.22, lz));
        }
        break;
      case 'szonyeg':
        g.add(cyl(1.45, 1.45, 0.03, 0xb5382a, 0, 0.02, 0, 16));
        g.add(cyl(1.05, 1.05, 0.035, 0xffcf55, 0, 0.022, 0, 16));
        break;
      case 'kandallo':
        g.add(box(1.6, 1.6, 0.8, 0x7a7267, 0, 0.8, 0));
        g.add(box(0.9, 0.85, 0.5, 0x221d1a, 0, 0.45, 0.2));
        g.add(cone(0.28, 0.55, 0xff7b29, 0, 0.3, 0.25, 6));
        break;
      case 'trofea':
        g.add(box(0.55, 0.65, 0.45, 0x74482a, 0, 0.35, 0));
        g.add(cyl(0.05, 0.08, 0.9, 0xe8dcc0, -0.3, 0.9, 0, 5));
        g.add(cyl(0.05, 0.08, 0.9, 0xe8dcc0, 0.3, 0.9, 0, 5));
        break;
      case 'lada':
        g.add(box(1.1, 0.65, 0.7, 0x6b4423, 0, 0.32, 0));
        g.add(box(1.14, 0.12, 0.74, 0xd99b26, 0, 0.45, 0));
        break;
      case 'lampa':
        g.add(cyl(0.32, 0.36, 0.08, 0x3b2a1a, 0, 0.04, 0, 10));
        g.add(cyl(0.06, 0.06, 1.55, 0x4a3520, 0, 0.8, 0, 8));
        g.add(cone(0.42, 0.45, 0xffe066, 0, 1.65, 0, 10));
        break;
      case 'konyvespolc':
        g.add(box(1.4, 1.85, 0.48, 0x6b4423, 0, 0.92, 0));
        g.add(box(1.26, 0.42, 0.38, 0xc8343a, -0.1, 0.52, 0.06));
        g.add(box(1.18, 0.42, 0.38, 0x29648a, 0.05, 1.05, 0.06));
        g.add(box(1.22, 0.38, 0.38, 0x3f7350, -0.05, 1.55, 0.06));
        break;
      case 'noveny':
        g.add(cyl(0.34, 0.26, 0.5, 0xb5552e, 0, 0.25, 0, 8));
        g.add(cone(0.55, 0.95, 0x3f7350, 0, 0.85, 0, 7));
        g.add(cone(0.42, 0.75, 0x52b788, 0, 1.3, 0, 7));
        break;
      case 'mini_fenyo':
        g.add(cyl(0.2, 0.24, 0.35, 0x74482a, 0, 0.18, 0, 8));
        g.add(cone(0.68, 0.9, 0x225c36, 0, 0.7, 0, 8));
        g.add(cone(0.5, 0.75, 0x2a6f42, 0, 1.2, 0, 8));
        g.add(cone(0.2, 0.25, 0xffe066, 0, 1.68, 0, 5));
        break;
      default:
        g.add(cyl(0.5, 0.32, 0.65, 0xffcf55, 0, 0.35, 0, 10));
        break;
    }
  }

  g.position.set(item.x || 0, 0, item.z || 0);
  g.rotation.y = item.rot || 0;
  g.userData.item = item;
  g.traverse((node) => {
    if (node.isMesh) {
      node.userData.furnitureGroup = g;
      furnitureMeshes.push(node);
    }
  });
  return g;
}

function rebuildRoom3D() {
  furnitureGroup.clear();
  furnitureMeshes.length = 0;
  if (!activeRoomData) return;

  for (const item of activeRoomData.items) {
    if (!item.placed) continue;
    const model = build3DFurnitureModel(item);
    if (item.id === selectedFurnitureId) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.75, 0.9, 20),
        new THREE.MeshBasicMaterial({ color: 0xff5a36, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      model.add(ring);
    }
    furnitureGroup.add(model);
  }
}

function renderRoomEditorUI() {
  if (!activeRoomData) return;
  const isOwner = activeRoomData.isOwner;
  el('room-editor').hidden = !isOwner;

  const badge = el('room-badge');
  badge.textContent = activeRoomData.privacy === 'private' ? '🔒 Zárt ház' : '🌍 Nyitott ház';
  badge.className = `badge ${activeRoomData.privacy === 'private' ? 'locked' : 'open'}`;

  if (!isOwner) {
    el('room-subtitle').textContent = 'Vendégségben vagy. Forgasd a kamerát egérrel a szoba megtekintéséhez!';
    return;
  }

  el('room-subtitle').textContent = 'Saját szobád: kattints egy bútorra lent a lerakáshoz, vagy húzd a padlón egérrel!';

  const invBar = el('room-inventory');
  invBar.replaceChildren(...activeRoomData.items.map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isGift = !item.unboxed;
    btn.className = `inv-btn ${item.placed ? 'placed' : ''} ${item.id === selectedFurnitureId ? 'selected' : ''} ${isGift ? 'gift-box' : ''}`;
    btn.textContent = isGift
      ? `🎁 Ajándék (@${item.giftFrom}-tól) – Kattints a kibontáshoz!`
      : `${item.label} ${item.placed ? '✓' : '(Raktárban)'}`;
    btn.addEventListener('click', () => {
      if (isGift) {
        item.unboxed = true;
        item.placed = true;
        selectedFurnitureId = item.id;
        rebuildRoom3D();
        renderRoomEditorUI();
        return;
      }
      if (!item.placed) {
        item.placed = true;
        selectedFurnitureId = item.id;
      } else {
        selectedFurnitureId = item.id;
      }
      rebuildRoom3D();
      renderRoomEditorUI();
    });
    return btn;
  }));

  const privBtn = el('room-privacy-btn');
  privBtn.textContent = activeRoomData.privacy === 'private'
    ? '🔒 Ház: Zárt (Csak meghívóval)'
    : '🌍 Ház: Nyitott (Publikus)';

  if (activeRoomData.inviteKey) {
    const link = `${window.location.origin}/#haz=${encodeURIComponent(activeRoomData.owner)}&kulcs=${encodeURIComponent(activeRoomData.inviteKey)}`;
    el('room-invite-input').value = link;
  }

  const guestContainer = el('room-guest-tags');
  guestContainer.replaceChildren(...(activeRoomData.guestList || []).map((gName) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mini-btn';
    chip.textContent = `@${gName} ×`;
    chip.addEventListener('click', () => {
      activeRoomData.guestList = activeRoomData.guestList.filter((x) => x !== gName);
      renderRoomEditorUI();
    });
    return chip;
  }));

  const giftSelect = el('gift-item-select');
  giftSelect.replaceChildren(...activeRoomData.items.map((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    return opt;
  }));
}

async function enterHouseInterior(houseOwnerName, explicitInviteKey = null) {
  const lower = houseOwnerName.toLowerCase();
  const savedKeys = getSavedInviteKeys();
  const keyToUse = explicitInviteKey || savedKeys[lower] || '';

  const resp = await apiFetch(`/api/house?name=${encodeURIComponent(lower)}&key=${encodeURIComponent(keyToUse)}`);
  const data = await resp.json();

  if (!resp.ok || !data.allowed) {
    el('card-status').textContent = `🔒 ${data.message || 'Ez a ház zárt, csak meghívóval látogatható!'}`;
    return;
  }

  if (explicitInviteKey) {
    saveInviteKeyForHouse(lower, explicitInviteKey);
  }

  activeRoomData = data;
  selectedFurnitureId = data.items.find((i) => i.placed)?.id || null;
  inRoomMode = true;

  el('top').hidden = true;
  el('vote').hidden = true;
  el('cam-widget').hidden = true;
  el('zen-toggle-btn').hidden = true;
  el('home-compass-pointer').hidden = true;
  el('card').hidden = true;
  el('labels').hidden = true;
  el('claim-drawer').hidden = true;
  el('activities-drawer').hidden = true;
  el('room-hud').hidden = false;
  el('room-title').textContent = `🏠 @${data.owner} szobája`;

  controls.enabled = false;
  roomControls.enabled = true;
  roomCamera.position.set(5.5, 5.2, 6.5);
  roomControls.target.set(0, 0.6, 0);
  roomControls.update();

  rebuildRoom3D();
  renderRoomEditorUI();
}

function exitRoomInterior() {
  inRoomMode = false;
  activeRoomData = null;
  draggingFurnitureMesh = null;
  roomControls.enabled = false;
  controls.enabled = true;

  el('room-hud').hidden = true;
  el('zen-toggle-btn').hidden = false;
  el('top').hidden = false;
  el('vote').hidden = false;
  el('cam-widget').hidden = false;
  el('labels').hidden = false;
}

el('room-exit-btn').addEventListener('click', exitRoomInterior);

el('room-rotate-btn').addEventListener('click', () => {
  if (!activeRoomData?.isOwner || !selectedFurnitureId) return;
  const item = activeRoomData.items.find((i) => i.id === selectedFurnitureId);
  if (item) {
    item.rot = ((item.rot || 0) + Math.PI / 2) % (Math.PI * 2);
    rebuildRoom3D();
  }
});

el('room-remove-btn').addEventListener('click', () => {
  if (!activeRoomData?.isOwner || !selectedFurnitureId) return;
  const item = activeRoomData.items.find((i) => i.id === selectedFurnitureId);
  if (item) {
    item.placed = false;
    rebuildRoom3D();
    renderRoomEditorUI();
  }
});

el('room-privacy-btn').addEventListener('click', () => {
  if (!activeRoomData?.isOwner) return;
  activeRoomData.privacy = activeRoomData.privacy === 'public' ? 'private' : 'public';
  housePrivacyMap[activeRoomData.owner.toLowerCase()] = activeRoomData.privacy;
  renderRoomEditorUI();
});

el('room-invite-toggle').addEventListener('click', () => {
  el('room-gift-panel').hidden = true;
  el('room-invite-panel').hidden = !el('room-invite-panel').hidden;
});

el('room-gift-toggle').addEventListener('click', () => {
  el('room-invite-panel').hidden = true;
  el('room-gift-panel').hidden = !el('room-gift-panel').hidden;
});

el('room-copy-invite').addEventListener('click', async () => {
  const input = el('room-invite-input');
  try {
    await navigator.clipboard.writeText(input.value);
    el('room-copy-invite').textContent = '✓ Kimásolva!';
  } catch {
    input.select();
  }
  setTimeout(() => { el('room-copy-invite').textContent = 'Másolás'; }, 2000);
});

el('room-rekey-btn').addEventListener('click', async () => {
  const resp = await apiFetch('/api/house/rekey', { method: 'POST' });
  if (resp.ok) {
    const data = await resp.json();
    activeRoomData.inviteKey = data.inviteKey;
    renderRoomEditorUI();
  }
});

el('room-guest-add').addEventListener('click', () => {
  const val = el('room-guest-input').value.trim().replace(/^@/, '');
  if (!val || !activeRoomData) return;
  if (!activeRoomData.guestList.includes(val)) {
    activeRoomData.guestList.push(val);
  }
  el('room-guest-input').value = '';
  renderRoomEditorUI();
});

el('room-save-btn').addEventListener('click', async () => {
  if (!activeRoomData?.isOwner) return;
  const btn = el('room-save-btn');
  btn.textContent = 'Mentés…';
  const resp = await apiFetch('/api/house/save', {
    method: 'POST',
    body: JSON.stringify({
      privacy: activeRoomData.privacy,
      guestList: activeRoomData.guestList,
      items: activeRoomData.items,
    }),
  });
  if (resp.ok) {
    housePrivacyMap[activeRoomData.owner.toLowerCase()] = activeRoomData.privacy;
    btn.textContent = '✓ Elmentve!';
  } else {
    btn.textContent = 'Hiba a mentéskor';
  }
  setTimeout(() => { btn.textContent = '💾 Berendezés mentése'; }, 1800);
});

el('gift-send-btn').addEventListener('click', async () => {
  const itemId = el('gift-item-select').value;
  const toUsername = el('gift-target-input').value.trim();
  const msgEl = el('gift-status-msg');
  msgEl.hidden = false;

  const resp = await apiFetch('/api/house/gift', {
    method: 'POST',
    body: JSON.stringify({ itemId, toUsername }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    msgEl.style.color = 'var(--red)';
    msgEl.textContent = data.error || 'Nem sikerült elküldeni.';
    return;
  }
  activeRoomData.items = data.items;
  el('gift-target-input').value = '';
  msgEl.style.color = 'var(--green)';
  msgEl.textContent = `🎁 Ajándék elküldve @${data.giftedTo} szobájába!`;
  rebuildRoom3D();
  renderRoomEditorUI();
});

const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeIntersect = new THREE.Vector3();
const roomRaycaster = new THREE.Raycaster();
const roomPointer = new THREE.Vector2();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!inRoomMode || !activeRoomData?.isOwner) return;
  roomPointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  roomRaycaster.setFromCamera(roomPointer, roomCamera);
  const hitList = roomRaycaster.intersectObjects(furnitureMeshes, false);
  if (hitList.length) {
    const fg = hitList[0].object.userData.furnitureGroup;
    if (fg) {
      const item = fg.userData.item;
      if (!item.unboxed) item.unboxed = true;
      selectedFurnitureId = item.id;
      draggingFurnitureMesh = fg;
      roomControls.enabled = false;
      rebuildRoom3D();
      renderRoomEditorUI();
    }
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!inRoomMode || !draggingFurnitureMesh) return;
  roomPointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  roomRaycaster.setFromCamera(roomPointer, roomCamera);
  if (roomRaycaster.ray.intersectPlane(floorPlane, planeIntersect)) {
    const nx = Math.max(-2.3, Math.min(2.3, Math.round(planeIntersect.x * 4) / 4));
    const nz = Math.max(-2.3, Math.min(2.3, Math.round(planeIntersect.z * 4) / 4));
    const item = draggingFurnitureMesh.userData.item;
    item.x = nx;
    item.z = nz;
    rebuildRoom3D();
  }
});

window.addEventListener('pointerup', () => {
  if (inRoomMode && draggingFurnitureMesh) {
    draggingFurnitureMesh = null;
    roomControls.enabled = true;
  }
});

// --- 10. "Saját házam" ugrás & DM Fiók-összekötő Panel ---
let pendingClaimCode = null;

function flyToMyOwnHouse() {
  if (!currentConnectedUser) {
    openClaimDrawer();
    return;
  }
  const myRes = byName.get(currentConnectedUser.toLowerCase());
  if (!myRes) {
    openClaimDrawer();
    return;
  }
  el('claim-drawer').hidden = true;
  el('search-dropdown').hidden = true;
  selectHouse(myRes);
}

el('my-house-btn').addEventListener('click', flyToMyOwnHouse);
el('my-home-tag').addEventListener('click', flyToMyOwnHouse);
el('home-compass-pointer').addEventListener('click', flyToMyOwnHouse);

function populateQuickSelect() {
  const sel = el('claim-quick-select');
  if (!sel) return;
  const sorted = [...residents]
    .filter((r) => r.name.toLowerCase() !== 'gulyas_mester')
    .sort((a, b) => b.name.localeCompare(a.name, 'hu'));

  const options = sorted.map((r) => {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = `@${r.name} (${r.title})`;
    if (currentConnectedUser && r.name.toLowerCase() === currentConnectedUser.toLowerCase()) {
      opt.selected = true;
    }
    return opt;
  });

  const devOpt = document.createElement('option');
  devOpt.value = '';
  devOpt.disabled = true;
  devOpt.textContent = '🔒 @gulyas_mester (Fejlesztőnek lefoglalva)';
  options.unshift(devOpt);

  sel.replaceChildren(...options);
}

function openClaimDrawer(prefillName = '') {
  el('add-drawer').hidden = true;
  el('chronicle-drawer').hidden = true;
  el('activities-drawer').hidden = true;
  el('claim-drawer').hidden = false;
  el('claim-msg').hidden = true;
  populateQuickSelect();

  if (currentConnectedUser) {
    el('claim-step-1').hidden = true;
    el('claim-step-2').hidden = true;
    el('claim-step-3').hidden = false;
    el('claim-connected-user').textContent = `@${currentConnectedUser}`;
  } else {
    el('claim-step-1').hidden = false;
    el('claim-step-2').hidden = true;
    el('claim-step-3').hidden = true;
    if (prefillName) el('claim-username').value = prefillName;
  }
}

el('claim-open').addEventListener('click', () => {
  if (el('claim-drawer').hidden) openClaimDrawer();
  else el('claim-drawer').hidden = true;
});
el('claim-close').addEventListener('click', () => { el('claim-drawer').hidden = true; });

el('claim-quick-btn').addEventListener('click', async () => {
  const chosen = el('claim-quick-select').value;
  if (!chosen || chosen.toLowerCase() === 'gulyas_mester') return;
  await bindUserQuickly(chosen);
  flyToMyOwnHouse();
});

if (el('claim-to-add-btn')) {
  el('claim-to-add-btn').addEventListener('click', () => {
    el('claim-drawer').hidden = true;
    updatePlotCapacityUI();
    el('add-drawer').hidden = false;
    el('new-name')?.focus();
  });
}

el('claim-fly-home-btn').addEventListener('click', flyToMyOwnHouse);

async function loginWithPassword() {
  const username = el('claim-username').value.trim();
  const password = el('claim-password').value;
  const msg = el('claim-msg');
  msg.hidden = true;

  if (!username || !password) {
    msg.textContent = 'Add meg a játékbeli karakternévedet és a jelszavadat!';
    msg.hidden = false;
    return;
  }

  if (username.toLowerCase() === 'gulyas_mester') {
    msg.textContent = '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!';
    msg.hidden = false;
    return;
  }

  const resp = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    msg.textContent = data.error || 'Sikertelen belépés.';
    msg.hidden = false;
    return;
  }

  currentConnectedUser = data.username;
  localStorage.setItem('kisfalu_my_user', currentConnectedUser);
  switchActiveUserRpg(currentConnectedUser, data.rpg);
  updateClaimButtonUI();
  updateMyHomeBeaconPosition();
  el('claim-password').value = '';
  openClaimDrawer();
  flyToMyOwnHouse();
}

if (el('claim-login-btn')) {
  el('claim-login-btn').addEventListener('click', loginWithPassword);
}
if (el('claim-username')) {
  el('claim-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el('claim-password')?.focus();
    }
  });
}
if (el('claim-password')) {
  el('claim-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loginWithPassword();
    }
  });
}

el('claim-back-btn').addEventListener('click', () => {
  el('claim-step-2').hidden = true;
  el('claim-step-1').hidden = false;
});

el('claim-sim-btn').addEventListener('click', async () => {
  if (!pendingClaimCode) return;
  const resp = await apiFetch('/api/claim/simulate-dm', {
    method: 'POST',
    body: JSON.stringify({ code: pendingClaimCode }),
  });
  const data = await resp.json();
  if (resp.ok) {
    currentConnectedUser = data.username;
    localStorage.setItem('kisfalu_my_user', currentConnectedUser);
    switchActiveUserRpg(currentConnectedUser, data.rpg);
    updateClaimButtonUI();
    updateMyHomeBeaconPosition();
    openClaimDrawer();
  }
});

el('claim-go-room-btn').addEventListener('click', () => {
  if (currentConnectedUser) {
    el('claim-drawer').hidden = true;
    enterHouseInterior(currentConnectedUser);
  }
});

el('claim-logout-btn').addEventListener('click', async () => {
  await apiFetch('/api/claim/logout', { method: 'POST' });
  currentConnectedUser = null;
  localStorage.removeItem('kisfalu_my_user');
  updateClaimButtonUI();
  updateMyHomeBeaconPosition();
  openClaimDrawer();
});

// --- 11. Kártyák, Akciók (Munka/Pihenés), Testreszabás és Napló ---
let selectedRes = null;
let selectedPlaceKey = null;
let followMode = false;
let behindMode = false;

const PALETTE_ROOFS = ['#c8523b', '#d99b26', '#4a7c59', '#5b6e8c', '#8c4a6b', '#4a3b32'];
const PALETTE_WALLS = ['#f5eedc', '#fff6e0', '#e3d5b8', '#d8e2dc', '#f4d5cc'];
const PALETTE_CLOTH = ['#c8343a', '#29648a', '#3f7350', '#d49b27', '#7209b7', '#bc4749'];

function renderSwatches(containerId, colors, currentHex, onPick) {
  const row = el(containerId);
  const label = row.querySelector('span');
  row.replaceChildren(label);
  for (const hex of colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `swatch ${currentHex?.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`;
    btn.style.background = hex;
    btn.addEventListener('click', () => onPick(hex));
    row.append(btn);
  }
}

async function saveCustomization(res, changes) {
  Object.assign(res, changes);
  res.houseGroup.userData.roofMat.color.set(res.roof);
  res.houseGroup.userData.wallMat.color.set(res.wall);
  res.figureGroup.userData.clothMat.color.set(res.cloth);
  openCustomizePanel(res);
  try {
    await apiFetch('/api/customize', {
      method: 'POST',
      body: JSON.stringify({ name: res.name, ...changes }),
    });
  } catch { /* helyi mentés */ }
}

function openCustomizePanel(res) {
  el('custom-box').hidden = false;
  renderSwatches('swatches-roof', PALETTE_ROOFS, res.roof, (roof) => saveCustomization(res, { roof }));
  renderSwatches('swatches-wall', PALETTE_WALLS, res.wall, (wall) => saveCustomization(res, { wall }));
  renderSwatches('swatches-cloth', PALETTE_CLOTH, res.cloth, (cloth) => saveCustomization(res, { cloth }));
}

function statusTextFor(res, sec) {
  const bedtimeHour = 19.0 + hash(res.name, 11) * 3.0; // 19:00 - 22:00
  const wakeHour = 5.0 + hash(res.name, 12) * 3.0;    // 5:00 - 8:00
  const bedtimeSec = bedtimeHour * HOUR;
  const wakeSec = wakeHour * HOUR;

  const bh = Math.floor(bedtimeHour);
  const bm = Math.floor((bedtimeHour - bh) * 60);
  const wh = Math.floor(wakeHour);
  const wm = Math.floor((wakeHour - wh) * 60);
  const bStr = String(bh).padStart(2, '0') + ':' + String(bm).padStart(2, '0');
  const wStr = String(wh).padStart(2, '0') + ':' + String(wm).padStart(2, '0');

  const isSleeping = (sec >= bedtimeSec || sec < wakeSec);
  if (isSleeping) {
    return `🌙 Otthon alszik a házában (${bStr} - ${wStr})`;
  }

  if (sec >= bedtimeSec - 90 && sec < bedtimeSec) {
    return `🏡 Épp a járdán lép be a házába aludni (${bStr})`;
  }

  if (sec >= wakeSec && sec < wakeSec + 60) {
    return `☀️ Épp kilép a házából az utcára sétálni (${wStr})`;
  }

  return '🚶 Épp folyamatosan sétál a falusi utcán';
}

function buildResidentDiary(res, upToSec) {
  const events = [];
  const bedtimeHour = 19.0 + hash(res.name, 11) * 3.0;
  const wakeHour = 5.0 + hash(res.name, 12) * 3.0;
  const bedtimeSec = bedtimeHour * HOUR;
  const wakeSec = wakeHour * HOUR;

  const bh = Math.floor(bedtimeHour);
  const bm = Math.floor((bedtimeHour - bh) * 60);
  const wh = Math.floor(wakeHour);
  const wm = Math.floor((wakeHour - wh) * 60);
  const bStr = String(bh).padStart(2, '0') + ':' + String(bm).padStart(2, '0');
  const wStr = String(wh).padStart(2, '0') + ':' + String(wm).padStart(2, '0');

  if (upToSec >= wakeSec) {
    events.push({ time: wStr, label: '☀️ Felébredt és kilépett a házából az utcára sétálni' });
  }
  if (upToSec >= 12 * HOUR && wakeSec <= 12 * HOUR) {
    events.push({ time: '12:00', label: '🚶 Nappali séta és beszélgetés a falusi utcákon' });
  }
  if (upToSec >= bedtimeSec) {
    events.push({ time: bStr, label: '🌙 Bement a házába és nyugovóra tért aludni' });
  }
  return events.reverse();
}

function updateCardPrivacyBadge(res) {
  const badge = el('card-privacy-badge');
  const priv = housePrivacyMap[res.name.toLowerCase()] || 'public';
  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === res.name.toLowerCase();
  badge.hidden = false;
  badge.textContent = `${isMine ? '🏠 Saját házam · ' : ''}${priv === 'private' ? '🔒 Zárt ház' : '🌍 Nyitott ház'}`;
  badge.className = `badge ${priv === 'private' ? 'locked' : 'open'}`;
}

// --- 11.2 FELHASZNÁLÓHOZ KÖTÖTT RPG GAZDASÁG, IDŐ-LIMITEK (COOLDOWN) & KIEGYENSÚLYOZOTT ÁRAK ---
const ENERGY_REGEN_INTERVAL_MS = 20000; // +1% Energia 20 másodpercenként

function getStorageKeyForUser(username) {
  const u = (username || currentConnectedUser || 'guest').toLowerCase();
  return `kisfalu_rpg_user_v2_${u}`;
}

function applyPassiveEnergyRegen(rpgObj) {
  const now = Date.now();
  const last = rpgObj.lastEnergyUpdate || now;
  const elapsed = Math.max(0, now - last);
  if (rpgObj.energy < 100 && elapsed >= ENERGY_REGEN_INTERVAL_MS) {
    const gained = Math.floor(elapsed / ENERGY_REGEN_INTERVAL_MS);
    rpgObj.energy = Math.min(100, rpgObj.energy + gained);
    rpgObj.lastEnergyUpdate = last + gained * ENERGY_REGEN_INTERVAL_MS;
  } else if (rpgObj.energy >= 100) {
    rpgObj.lastEnergyUpdate = now;
  }
  return rpgObj;
}

function loadUserRpg(username, serverRpg = null) {
  const key = getStorageKeyForUser(username);
  let loaded = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) loaded = JSON.parse(raw);
  } catch { /* fallback */ }

  const base = createDefaultRpgProfileLocal();
  const merged = {
    ...base,
    ...(serverRpg || {}),
    ...(loaded || {}),
    resources: { ...base.resources, ...(serverRpg?.resources || {}), ...(loaded?.resources || {}) },
    cooldowns: { ...(serverRpg?.cooldowns || {}), ...(loaded?.cooldowns || {}) },
    stats: { ...base.stats, ...(serverRpg?.stats || {}), ...(loaded?.stats || {}) },
    claimedQuests: { ...(serverRpg?.claimedQuests || {}), ...(loaded?.claimedQuests || {}) },
    votes: { ...base.votes, ...(serverRpg?.votes || {}), ...(loaded?.votes || {}) },
  };
  return applyPassiveEnergyRegen(merged);
}

playerRpg = loadUserRpg(currentConnectedUser, meData.rpg);

function switchActiveUserRpg(username, serverRpg = null) {
  playerRpg = loadUserRpg(username, serverRpg);
  savePlayerRpg(false);
  if (!el('activities-drawer').hidden) renderActivitiesContent();
}

function savePlayerRpg(syncToServer = true) {
  if (!playerRpg) return;
  playerRpg.lastEnergyUpdate = playerRpg.lastEnergyUpdate || Date.now();
  localStorage.setItem(getStorageKeyForUser(currentConnectedUser), JSON.stringify(playerRpg));
  updatePlayerStatsUI();
  if (syncToServer && currentConnectedUser) {
    apiFetch('/api/rpg/sync', {
      method: 'POST',
      body: JSON.stringify({ username: currentConnectedUser, rpg: playerRpg }),
    }).catch(() => {});
  }
}

// Cooldown (idő-limit) segédfüggvények az adott felhasználóhoz csatolva
function getCooldownRemainingSec(actionId) {
  if (!actionId || !playerRpg?.cooldowns) return 0;
  const unlockAt = playerRpg.cooldowns[actionId] || 0;
  const remMs = unlockAt - Date.now();
  return remMs > 0 ? Math.ceil(remMs / 1000) : 0;
}

function setActionCooldown(actionId, cooldownSec) {
  if (!actionId || !cooldownSec || !playerRpg) return;
  if (!playerRpg.cooldowns) playerRpg.cooldowns = {};
  playerRpg.cooldowns[actionId] = Date.now() + cooldownSec * 1000;
}

function formatCooldown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s} mp`;
}

const LEVEL_TITLES = ['Beköltöző', 'Falusi Polgár', 'Mesterember', 'Tanácsnok', 'Falubíró', 'Főispán'];
function getPlayerLevelInfo() {
  const lvl = Math.floor(((playerRpg && playerRpg.xp) || 0) / 50) + 1;
  const title = LEVEL_TITLES[Math.min(lvl - 1, LEVEL_TITLES.length - 1)];
  return { lvl, title };
}

function updatePlayerStatsUI() {
  if (!playerRpg) return;
  const { lvl, title } = getPlayerLevelInfo();
  el('stat-coins').textContent = `💰 ${playerRpg.coins} Tallér`;
  el('stat-level').textContent = `⭐ ${lvl}. szint (${title})`;
  const regenHint = playerRpg.energy < 100 ? ' (+1%/20mp)' : '';
  el('stat-energy-text').textContent = `⚡ ${playerRpg.energy}% Energia${regenHint}`;
  el('stat-energy-fill').style.width = `${Math.max(0, Math.min(100, playerRpg.energy))}%`;
  const r = playerRpg.resources;
  el('stat-resources').innerHTML = `<span>🪵 Fa: <b>${r.fa}</b></span> · <span>🌾 Liszt: <b>${r.liszt}</b></span> · <span>🐟 Hal: <b>${r.hal}</b></span> · <span>🥛 Tej: <b>${r.tej}</b></span>`;
}
updatePlayerStatsUI();

// Kezdéskor nem kötjük be erőszakkal a fejlesztői karaktert (gulyas_mester) vendégként,
// a látogató tiszta vendégként indul, és a "🔑 Belépés" vagy "🏠 Saját házam" gombbal léphet be / foglalhat telket:
updateClaimButtonUI();

let currentCardActions = [];

function executeGameAction(act, feedbackEl = null) {
  if (act.onClick) {
    act.onClick();
    return;
  }

  const cdRem = getCooldownRemainingSec(act.id);
  if (cdRem > 0) {
    if (feedbackEl) {
      feedbackEl.style.color = 'var(--red)';
      feedbackEl.textContent = `⏳ Ez a képesség még pihen! Hátralévő idő (@${currentConnectedUser || 'vendég'}): ${formatCooldown(cdRem)}.`;
      feedbackEl.hidden = false;
    }
    return;
  }

  const costCoins = act.costCoins || 0;
  const costEnergy = act.costEnergy || 0;
  if (playerRpg.coins < costCoins) {
    if (feedbackEl) {
      feedbackEl.style.color = 'var(--red)';
      feedbackEl.textContent = `⚠️ Nincs elég Tallérod (${costCoins} Tallér szükséges)! Vállalj munkát!`;
      feedbackEl.hidden = false;
    }
    return;
  }
  if (playerRpg.energy < costEnergy) {
    if (feedbackEl) {
      feedbackEl.style.color = 'var(--red)';
      feedbackEl.textContent = `⚠️ Túl fáradt vagy (${costEnergy}% Energia szükséges)! Pihenj otthon vagy egyél a Főtéren!`;
      feedbackEl.hidden = false;
    }
    return;
  }

  playerRpg.coins = Math.max(0, playerRpg.coins - costCoins + (act.deltaCoins || 0));
  playerRpg.energy = Math.max(0, Math.min(100, playerRpg.energy - costEnergy + (act.deltaEnergy || 0)));
  playerRpg.lastEnergyUpdate = Date.now();
  playerRpg.xp = (playerRpg.xp || 0) + (act.deltaXp || 0);
  if (costEnergy > 0) playerRpg.stats.worksDone = (playerRpg.stats.worksDone || 0) + 1;

  if (act.deltaRes) {
    for (const [rk, rv] of Object.entries(act.deltaRes)) {
      playerRpg.resources[rk] = (playerRpg.resources[rk] || 0) + rv;
    }
  }
  if (act.id && act.cooldownSec) {
    setActionCooldown(act.id, act.cooldownSec);
  }
  savePlayerRpg();
  refreshCardActionButtonsCooldownUI();

  if (feedbackEl) {
    feedbackEl.style.color = 'var(--green)';
    const cdNotice = act.cooldownSec ? ` (Újra használható: ${formatCooldown(act.cooldownSec)} múlva)` : '';
    feedbackEl.textContent = `✓ ${act.msg}${cdNotice}`;
    feedbackEl.hidden = false;
  }
}

function renderActionButtonsOnCard(actionsList, titleText = '⚡ Elérhető tevékenységek (Akciók):') {
  currentCardActions = actionsList || [];
  const boxEl = el('action-box');
  const btnsEl = el('action-buttons');
  const fbEl = el('action-feedback');
  fbEl.hidden = true;

  if (!actionsList || !actionsList.length) {
    boxEl.hidden = true;
    return;
  }
  boxEl.hidden = false;
  el('action-box-title').textContent = titleText;
  btnsEl.replaceChildren(...actionsList.map((act) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost primary';
    b.dataset.actionId = act.id || '';
    b.dataset.baseLabel = act.label;
    const rem = getCooldownRemainingSec(act.id);
    b.textContent = rem > 0 ? `⏳ ${act.label} (${formatCooldown(rem)})` : act.label;
    b.disabled = rem > 0;
    b.addEventListener('click', () => executeGameAction(act, fbEl));
    return b;
  }));
}

function refreshCardActionButtonsCooldownUI() {
  if (el('card').hidden || !currentCardActions.length) return;
  const btns = el('action-buttons').querySelectorAll('button[data-action-id]');
  btns.forEach((b) => {
    const aid = b.dataset.actionId;
    if (!aid) return;
    const rem = getCooldownRemainingSec(aid);
    b.disabled = rem > 0;
    b.textContent = rem > 0 ? `⏳ ${b.dataset.baseLabel} (${formatCooldown(rem)})` : b.dataset.baseLabel;
  });
}

let activeMenuTab = 'work';
let workTimer = null;

function showMenuToast(msg, isError = false) {
  const tEl = el('menu-toast');
  tEl.hidden = false;
  tEl.style.background = isError ? '#f8d7da' : '#d1e7dd';
  tEl.style.color = isError ? '#842029' : '#0f5132';
  tEl.textContent = msg;
}

// KIEGYENSÚLYOZOTT (REBALANCED) MUNKÁK, PIHENÉS ÉS BÚTORBOLT ÁRAK + FELHASZNÁLÓHOZ KÖTÖTT COOLDOWN IDŐK
const WORK_JOBS = [
  { id: 'job_wood', title: '🪓 Favágás a Vadászháznál', desc: 'Kivágod és felaprítod a tűzifát az északi erdőszélen.', placeKey: 'vadaszhaz', costEnergy: 22, rewardCoins: 18, rewardXp: 15, rewardRes: { fa: 2 }, cooldownSec: 90, rewardLabel: '+18 Tallér, +2 🪵 Fa, +15 XP' },
  { id: 'job_mill', title: '🌾 Búzaőrlés a Szélmalomban', desc: 'Megőrlöd a friss búzát a dombtetőn álló malomban.', placeKey: 'malom', costEnergy: 18, rewardCoins: 15, rewardXp: 12, rewardRes: { liszt: 2 }, cooldownSec: 75, rewardLabel: '+15 Tallér, +2 🌾 Liszt, +12 XP' },
  { id: 'job_fish', title: '🎣 Horgászat a Folyóparti Stégen', desc: 'Kapitális pontyokra és harcsákra pecázol a folyón.', placeKey: 'steg', costEnergy: 14, rewardCoins: 12, rewardXp: 10, rewardRes: { hal: 2 }, cooldownSec: 60, rewardLabel: '+12 Tallér, +2 🐟 Hal, +10 XP' },
  { id: 'job_milk', title: '🐄 Állatgondozás és Fejés a Legelőn', desc: 'Ellátod a falu teheneit és bárányait a bekerített legelőn.', placeKey: 'legelo', costEnergy: 18, rewardCoins: 15, rewardXp: 12, rewardRes: { tej: 2 }, cooldownSec: 75, rewardLabel: '+15 Tallér, +2 🥛 Tej, +12 XP' },
  { id: 'job_pub', title: '🍺 Csapos műszak a Kocsmában', desc: 'Besegítesz a pult mögött a szomjas falubelieknek.', placeKey: 'kocsma', costEnergy: 25, rewardCoins: 28, rewardXp: 18, rewardRes: {}, cooldownSec: 120, rewardLabel: '+28 Tallér, +18 XP' },
];

const REST_OPTIONS = [
  { id: 'rest_home', title: '🛌 Alvás a Saját Házadban', desc: 'Hazatérsz a saját ágyadba és kipihened magad (5 perc Cooldown).', costCoins: 0, deltaEnergy: 55, deltaXp: 5, cooldownSec: 300, badge: 'Ingyenes → +55% Energia (⏳ 5p limit)', goHome: true },
  { id: 'rest_bogracs', title: '🍲 Bográcsgulyás a Főtéren', desc: 'Egy tál tüzes falusi bográcsgulyás a Főtéren (1.5 perc Cooldown).', placeKey: 'tuz', costCoins: 14, deltaEnergy: 45, deltaXp: 10, cooldownSec: 90, badge: '-14 Tallér → +45% Energia, +10 XP' },
  { id: 'rest_langos', title: '🥨 Fokhagymás-tejfölös Lángos a Piacon', desc: 'Frissen sült piaci lángos @langos_laci standjáról (1 perc Cooldown).', placeKey: 'piac', costCoins: 10, deltaEnergy: 35, deltaXp: 8, cooldownSec: 60, badge: '-10 Tallér → +35% Energia, +8 XP' },
  { id: 'rest_well', title: '🪣 Jéghideg Kútvíz a Gémeskútnál', desc: 'Húzol egy vödör frissítő kútvizet (2 perc Cooldown).', placeKey: 'gemeskut', costCoins: 0, deltaEnergy: 15, deltaXp: 4, cooldownSec: 120, badge: 'Ingyenes → +15% Energia (⏳ 2p limit)' },
];

const SHOP_ITEMS = [
  { type: 'noveny', label: '🪴 Dézsás Szobanövény', desc: 'Dús zöld falusi dézsás növény a szoba sarkába.', costCoins: 65, costWood: 0 },
  { type: 'lampa', label: '🕯️ Kovácsoltvas Állólámpa', desc: 'Meleg fényű 3D állólámpa a szobádba.', costCoins: 95, costWood: 2 },
  { type: 'konyvespolc', label: '📚 Tölgyfa Könyvespolc', desc: 'Tömör tölgyfából ácsolt könyvespolc színes kötetekkel.', costCoins: 140, costWood: 5 },
  { type: 'mini_fenyo', label: '🎄 Ünnepi Szobai Karácsonyfa', desc: 'Feldíszített fenyőfa arany csúcsdísszel a házadba.', costCoins: 180, costWood: 4 },
  { type: 'kandallo', label: '🔥 Épített Kő Kandalló', desc: 'Lobogó tűzzel fűtött kő kandalló a szobád falához.', costCoins: 260, costWood: 8 },
  { type: 'bogracs_disz', label: '🍲 Arany Bogrács Vándorkupa', desc: 'A falu legfényesebb presztízs dísztárgya a szobádba.', costCoins: 420, costWood: 0 },
];

const DAILY_QUESTS = [
  { id: 'q_work2', title: '🔨 Dolgos kezek: Végezz el 2 munkát a faluban!', rewardCoins: 35, check: () => (playerRpg.stats.worksDone || 0) >= 2, progressText: () => `${Math.min(2, playerRpg.stats.worksDone || 0)} / 2 munka kész` },
  { id: 'q_foter', title: '🏛️ Közösségi élet: Látogass el a Főtérre!', rewardCoins: 20, check: () => Boolean(playerRpg.stats.visitedFoter), progressText: () => playerRpg.stats.visitedFoter ? 'Teljesítve ✓' : 'Kattints a Főtérre!' },
  { id: 'q_vote', title: '🗳️ Demokratikus falu: Adj le szavazatot a Falugyűlésen!', rewardCoins: 25, check: () => Boolean(playerRpg.stats.votedOption), progressText: () => playerRpg.stats.votedOption ? 'Szavaztál ✓' : 'Válassz épületet lent!' },
  { id: 'q_shop', title: '🛋️ Otthonépítő: Vásárolj vagy barkácsolj 1 bútort a Bútorboltban!', rewardCoins: 45, check: () => Boolean(playerRpg.stats.boughtFurniture), progressText: () => playerRpg.stats.boughtFurniture ? 'Teljesítve ✓' : '0 / 1 bútor' },
];

function startInteractiveJob(job) {
  if (workTimer) return;
  const cdRem = getCooldownRemainingSec(job.id);
  if (cdRem > 0) {
    showMenuToast(`⏳ Ezt a munkát még nem végezheted újra! Várakozási idő: ${formatCooldown(cdRem)}.`, true);
    return;
  }
  if (playerRpg.energy < job.costEnergy) {
    showMenuToast(`⚠️ Nincs elég energiád (${job.costEnergy}% szükséges)! Válts a „🍲 Pihenés” fülre!`, true);
    return;
  }
  const p = PLACES[job.placeKey];
  if (p) flyTo(p.x, p.z, 32);

  const progBox = el('work-progress-box');
  const progFill = el('work-bar-fill');
  el('work-progress-title').textContent = `${job.title} folyamatban…`;
  progBox.hidden = false;
  progFill.style.width = '0%';
  el('menu-toast').hidden = true;

  let step = 0;
  workTimer = setInterval(() => {
    step += 10;
    progFill.style.width = `${step}%`;
    if (step >= 100) {
      clearInterval(workTimer);
      workTimer = null;
      progBox.hidden = true;
      playerRpg.energy = Math.max(0, playerRpg.energy - job.costEnergy);
      playerRpg.lastEnergyUpdate = Date.now();
      playerRpg.coins += job.rewardCoins;
      playerRpg.xp += job.rewardXp;
      playerRpg.stats.worksDone = (playerRpg.stats.worksDone || 0) + 1;
      for (const [rk, rv] of Object.entries(job.rewardRes || {})) {
        playerRpg.resources[rk] = (playerRpg.resources[rk] || 0) + rv;
      }
      setActionCooldown(job.id, job.cooldownSec);
      savePlayerRpg();
      showMenuToast(`✓ Sikeres munka: ${job.title}! Jutalom: ${job.rewardLabel} (Cooldown: ${formatCooldown(job.cooldownSec)})`);
      renderActivitiesContent();
    }
  }, 150);
}

function renderActivitiesContent() {
  const container = el('activities-content');
  container.replaceChildren();

  if (activeMenuTab === 'work') {
    // 1. Nyersanyag-eladás a Piacon kártya (60mp Cooldown)
    const r = playerRpg.resources;
    const totalResCount = (r.fa || 0) + (r.liszt || 0) + (r.hal || 0) + (r.tej || 0);
    const sellValue = (r.fa || 0) * 5 + (r.liszt || 0) * 6 + (r.hal || 0) * 8 + (r.tej || 0) * 6;
    const sellCd = getCooldownRemainingSec('sell_market');

    const sellCard = document.createElement('div');
    sellCard.className = 'menu-item-card';
    sellCard.style.background = '#fff8ea';
    sellCard.innerHTML = `
      <div class="menu-item-info">
        <b>⚖️ Nyersanyagok eladása a Falusi Piacon</b>
        <span>Raktárad: 🪵 ${r.fa} Fa (5T) · 🌾 ${r.liszt} Liszt (6T) · 🐟 ${r.hal} Hal (8T) · 🥛 ${r.tej} Tej (6T)</span>
        <span class="reward-tag">Piaci érték: +${sellValue} Tallér</span>
        <span class="cooldown-tag">⏱️ Cooldown: 60 mp</span>
      </div>
    `;
    const sellBtn = document.createElement('button');
    sellBtn.type = 'button';
    sellBtn.className = 'menu-act-btn';
    sellBtn.dataset.cdAction = 'sell_market';
    sellBtn.dataset.readyText = totalResCount ? `💰 Eladás (+${sellValue})` : 'Üres a raktár';
    sellBtn.disabled = totalResCount === 0 || sellCd > 0;
    sellBtn.textContent = sellCd > 0 ? `⏳ ${formatCooldown(sellCd)}` : sellBtn.dataset.readyText;
    sellBtn.addEventListener('click', () => {
      if (getCooldownRemainingSec('sell_market') > 0 || totalResCount === 0) return;
      playerRpg.coins += sellValue;
      playerRpg.xp += 10;
      playerRpg.resources = { fa: 0, liszt: 0, hal: 0, tej: 0 };
      setActionCooldown('sell_market', 60);
      savePlayerRpg();
      flyTo(PLACES.piac.x, PLACES.piac.z, 32);
      showMenuToast(`✓ Eladtad a nyersanyagokat a Piacon +${sellValue} Tallérért! (Újra: 60 mp múlva)`);
      renderActivitiesContent();
    });
    sellCard.append(sellBtn);
    container.append(sellCard);

    for (const job of WORK_JOBS) {
      const rem = getCooldownRemainingSec(job.id);
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${job.title}</b>
          <span>${job.desc} (Energiaigény: -${job.costEnergy}%)</span>
          <span class="reward-tag">${job.rewardLabel}</span>
          <span class="cooldown-tag">⏱️ Idő-limit: ${formatCooldown(job.cooldownSec)}</span>
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.dataset.cdAction = job.id;
      btn.dataset.readyText = '🔨 Munka indítása';
      btn.disabled = rem > 0;
      btn.textContent = rem > 0 ? `⏳ ${formatCooldown(rem)}` : '🔨 Munka indítása';
      btn.addEventListener('click', () => startInteractiveJob(job));
      card.append(btn);
      container.append(card);
    }
    return;
  }

  if (activeMenuTab === 'rest') {
    for (const ro of REST_OPTIONS) {
      const rem = getCooldownRemainingSec(ro.id);
      const readyLabel = ro.costCoins ? `🍲 Fogyasztás (${ro.costCoins} T)` : '🛌 Pihenés';
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${ro.title}</b>
          <span>${ro.desc}</span>
          <span class="reward-tag">${ro.badge}</span>
          <span class="cooldown-tag">⏱️ Idő-limit: ${formatCooldown(ro.cooldownSec)}</span>
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.dataset.cdAction = ro.id;
      btn.dataset.readyText = readyLabel;
      btn.disabled = rem > 0;
      btn.textContent = rem > 0 ? `⏳ ${formatCooldown(rem)}` : readyLabel;
      btn.addEventListener('click', () => {
        const cdNow = getCooldownRemainingSec(ro.id);
        if (cdNow > 0) {
          showMenuToast(`⏳ Még várnod kell ${formatCooldown(cdNow)}-t a következő használatig!`, true);
          return;
        }
        if (playerRpg.coins < ro.costCoins) {
          showMenuToast(`⚠️ Nincs elég Tallérod (${ro.costCoins} Tallér szükséges)!`, true);
          return;
        }
        playerRpg.coins -= ro.costCoins;
        playerRpg.energy = Math.min(100, playerRpg.energy + ro.deltaEnergy);
        playerRpg.lastEnergyUpdate = Date.now();
        playerRpg.xp += ro.deltaXp;
        setActionCooldown(ro.id, ro.cooldownSec);
        savePlayerRpg();
        if (ro.goHome) flyToMyOwnHouse();
        else if (ro.placeKey && PLACES[ro.placeKey]) flyTo(PLACES[ro.placeKey].x, PLACES[ro.placeKey].z, 32);
        showMenuToast(`✓ Feltöltődtél: ${ro.title}! Energiád most ${playerRpg.energy}%. (Cooldown: ${formatCooldown(ro.cooldownSec)})`);
        renderActivitiesContent();
      });
      card.append(btn);
      container.append(card);
    }
    return;
  }

  if (activeMenuTab === 'shop') {
    for (const si of SHOP_ITEMS) {
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      const costStr = `${si.costCoins} Tallér${si.costWood ? ` + ${si.costWood} 🪵 Fa` : ''}`;
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${si.label}</b>
          <span>${si.desc}</span>
          <span class="reward-tag">Ár: ${costStr}</span>
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.textContent = '🛋️ Megveszem';
      btn.addEventListener('click', async () => {
        if (playerRpg.coins < si.costCoins) {
          showMenuToast(`⚠️ Nincs elég Tallérod (${si.costCoins} Tallér kell)!`, true);
          return;
        }
        if ((playerRpg.resources.fa || 0) < si.costWood) {
          showMenuToast(`⚠️ Nincs elég 🪵 Fád (${si.costWood} db kell)! Vágj fát a Vadászháznál!`, true);
          return;
        }
        const resp = await apiFetch('/api/house/add-item', {
          method: 'POST',
          body: JSON.stringify({ type: si.type, label: si.label }),
        });
        if (!resp.ok) {
          showMenuToast('⚠️ Először lépj be a karaktereddel a „🔑 Belépés” menüben!', true);
          return;
        }
        playerRpg.coins -= si.costCoins;
        playerRpg.resources.fa -= si.costWood;
        playerRpg.xp += 20;
        playerRpg.stats.boughtFurniture = true;
        savePlayerRpg();
        showMenuToast(`🎉 Megvásároltad: ${si.label}! Bekerült a saját szobádba!`);
      });
      card.append(btn);
      container.append(card);
    }
    return;
  }

  if (activeMenuTab === 'community') {
    // 1. Szavazás szekció
    const voteOptions = [
      { key: 'pekseg', label: '🥐 Falusi Pékség és Kemence' },
      { key: 'ortorony', label: '🗼 Magas Fenyő Őrtorony' },
      { key: 'konyvtar', label: '📚 Falusi Könyvtár és Olvasókör' },
    ];
    for (const vo of voteOptions) {
      const count = playerRpg.votes[vo.key] || 0;
      const isChosen = playerRpg.stats.votedOption === vo.key;
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${vo.label}</b>
          <span>Jelenlegi szavazatok: <b>${count} db</b></span>
          ${isChosen ? '<span class="reward-tag">✓ Erre szavaztál!</span>' : ''}
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.textContent = isChosen ? '✓ Szavazatod' : '🗳️ Szavazok';
      btn.addEventListener('click', () => {
        if (playerRpg.stats.votedOption === vo.key) return;
        if (playerRpg.stats.votedOption) {
          playerRpg.votes[playerRpg.stats.votedOption] = Math.max(0, (playerRpg.votes[playerRpg.stats.votedOption] || 1) - 1);
        } else {
          playerRpg.xp += 15;
        }
        playerRpg.stats.votedOption = vo.key;
        playerRpg.votes[vo.key] = (playerRpg.votes[vo.key] || 0) + 1;
        savePlayerRpg();
        el('vote-text').innerHTML = `Szavazás állása: <b>Pékség (${playerRpg.votes.pekseg})</b> · <b>Őrtorony (${playerRpg.votes.ortorony})</b>`;
        showMenuToast(`🗳️ Leadtad a szavazatodat erre: ${vo.label}!`);
        renderActivitiesContent();
      });
      card.append(btn);
      container.append(card);
    }

    // 2. Napi Küldetések
    for (const dq of DAILY_QUESTS) {
      const done = dq.check();
      const claimed = Boolean(playerRpg.claimedQuests[dq.id]);
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${dq.title}</b>
          <span>Állapot: ${dq.progressText()}</span>
          <span class="reward-tag">Jutalom: +${dq.rewardCoins} Tallér</span>
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.disabled = !done || claimed;
      btn.textContent = claimed ? '✓ Felvéve' : done ? `🎁 Jutalom (+${dq.rewardCoins})` : 'Folyamatban';
      btn.addEventListener('click', () => {
        if (!done || claimed) return;
        playerRpg.claimedQuests[dq.id] = true;
        playerRpg.coins += dq.rewardCoins;
        playerRpg.xp += 25;
        savePlayerRpg();
        showMenuToast(`🏆 Küldetés jutalom felvéve: +${dq.rewardCoins} Tallér!`);
        renderActivitiesContent();
      });
      card.append(btn);
      container.append(card);
    }
  }
}

// Élő 1 másodperces időzítő a Cooldown gombokhoz és a passzív Energia-visszatöltéshez (+1% / 20 mp)
setInterval(() => {
  const prevEnergy = playerRpg.energy;
  applyPassiveEnergyRegen(playerRpg);
  if (playerRpg.energy !== prevEnergy) {
    savePlayerRpg(false);
  }

  if (!el('activities-drawer').hidden) {
    const cdBtns = el('activities-content').querySelectorAll('button[data-cd-action]');
    cdBtns.forEach((btn) => {
      const aid = btn.dataset.cdAction;
      const rem = getCooldownRemainingSec(aid);
      if (rem > 0) {
        btn.disabled = true;
        btn.textContent = `⏳ ${formatCooldown(rem)}`;
      } else if (btn.textContent.startsWith('⏳')) {
        btn.disabled = aid === 'sell_market'
          ? ((playerRpg.resources.fa || 0) + (playerRpg.resources.liszt || 0) + (playerRpg.resources.hal || 0) + (playerRpg.resources.tej || 0)) === 0
          : false;
        btn.textContent = btn.dataset.readyText || 'Indítás';
      }
    });
  }

  refreshCardActionButtonsCooldownUI();
}, 1000);

function openActivitiesDrawer(tab = 'work') {
  el('add-drawer').hidden = true;
  el('chronicle-drawer').hidden = true;
  el('claim-drawer').hidden = true;
  el('activities-drawer').hidden = false;
  el('menu-toast').hidden = true;
  activeMenuTab = tab;
  document.querySelectorAll('.act-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.acttab === tab);
  });
  renderActivitiesContent();
}

el('activities-open').addEventListener('click', () => {
  if (el('activities-drawer').hidden) openActivitiesDrawer('work');
  else el('activities-drawer').hidden = true;
});
el('activities-open-top').addEventListener('click', () => openActivitiesDrawer('work'));
el('vote-open-menu-btn').addEventListener('click', () => openActivitiesDrawer('community'));
el('activities-close').addEventListener('click', () => { el('activities-drawer').hidden = true; });

document.querySelectorAll('.act-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeMenuTab = btn.dataset.acttab;
    el('menu-toast').hidden = true;
    document.querySelectorAll('.act-tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderActivitiesContent();
  });
});

function selectResident(res, fly = true) {
  setWalker(false);
  selectedRes = res;
  selectedPlaceKey = null;
  followMode = true;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('custom-box').hidden = true;

  el('card-name').textContent = `@${res.name}`;
  updateCardPrivacyBadge(res);
  el('card-role').textContent = res.title;
  el('card-story').textContent = `Beköltözött a ${res.day || 1}. napon.`;
  el('card-people').replaceChildren();

  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === res.name.toLowerCase();
  el('btn-enter-room').hidden = false;
  el('btn-set-mine').hidden = isMine;
  el('btn-follow').hidden = false;
  el('btn-behind').hidden = false;
  el('btn-house').hidden = false;
  el('btn-person').hidden = true;
  el('btn-custom').hidden = false;
  el('diary-box').hidden = false;

  renderActionButtonsOnCard([
    { id: 'rest_home', label: '🛌 Pihenés a házban (+55% Energia, 5p Cooldown)', deltaEnergy: 55, deltaXp: 5, cooldownSec: 300, msg: `@${res.name} kipihente magát otthon! (+55% Energia)` },
    { label: `🔨 Munkába küldés (${PLACES[res.place]?.name || 'Falu'})`, onClick: () => selectLandmark(res.place === 'szabad' ? 'tuz' : res.place) },
  ], '⚡ Karakter akciók:');

  refreshCardLive(currentSec());

  const s = whereIs(res, currentSec());
  const tx = s.mode === 'home' ? res.x : s.x;
  const tz = s.mode === 'home' ? res.z : s.z;
  pin.visible = true;
  pin.position.set(tx, s.mode === 'home' ? 4.8 : 2.5, tz);
  if (fly) flyTo(tx, tz, 30);
}

function selectHouse(res) {
  setWalker(false);
  setBehind(false);
  selectedRes = res;
  selectedPlaceKey = null;
  followMode = false;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('custom-box').hidden = true;

  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === res.name.toLowerCase();
  el('card-name').textContent = `@${res.name} háza`;
  updateCardPrivacyBadge(res);
  el('card-role').textContent = res.title;
  el('card-status').textContent = statusTextFor(res, currentSec());
  el('card-story').textContent = `Koordináták: (${res.x}, ${res.z}) · Kattints a „🚪 Belépés a házba” gombra a szoba megtekintéséhez!`;
  el('card-people').replaceChildren();

  el('btn-enter-room').hidden = false;
  el('btn-set-mine').hidden = isMine;
  el('btn-follow').hidden = true;
  el('btn-behind').hidden = true;
  el('btn-house').hidden = true;
  el('btn-person').hidden = false;
  el('btn-custom').hidden = false;
  el('diary-box').hidden = true;

  renderActionButtonsOnCard([
    { id: 'rest_home', label: '🛌 Pihenés / Alvás (+55% Energia, 5p Cooldown)', deltaEnergy: 55, deltaXp: 5, cooldownSec: 300, msg: 'Kipihented magad otthon! (+55% Energia)' },
    { label: '🛋️ Szoba berendezése', onClick: () => enterHouseInterior(res.name) },
    { label: '🛍️ Új bútor vásárlása (Bútorbolt)', onClick: () => openActivitiesDrawer('shop') },
  ], '⚡ Otthoni akciók:');

  pin.visible = true;
  pin.position.set(res.x, 4.9, res.z);
  flyTo(res.x, res.z, 30);
}

function selectLandmark(placeKey) {
  setWalker(false);
  setBehind(false);
  selectedRes = null;
  selectedPlaceKey = placeKey;
  followMode = false;

  if (placeKey === 'tuz') {
    playerRpg.stats.visitedFoter = true;
    savePlayerRpg();
  }

  const p = PLACES[placeKey] || PLACES.tuz;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('card-privacy-badge').hidden = true;
  el('custom-box').hidden = true;
  el('diary-box').hidden = true;
  el('btn-enter-room').hidden = true;
  el('btn-set-mine').hidden = true;
  el('btn-follow').hidden = true;
  el('btn-behind').hidden = true;
  el('btn-house').hidden = true;
  el('btn-person').hidden = true;
  el('btn-custom').hidden = true;

  el('card-name').textContent = p.name;
  el('card-role').textContent = p.since;
  el('card-story').textContent = p.story;

  renderActionButtonsOnCard(p.actions || [], '⚡ Helyszíni akciók (Munka / Kikapcsolódás):');

  refreshCardLive(currentSec());
  pin.visible = true;
  pin.position.set(p.x, 5.2, p.z);
  flyTo(p.x, p.z, 36);
}

function refreshCardLive(sec) {
  if (selectedRes && !el('diary-box').hidden) {
    el('card-status').textContent = statusTextFor(selectedRes, sec);
    const diary = buildResidentDiary(selectedRes, sec);
    el('diary-list').replaceChildren(...diary.map((d) => {
      const li = document.createElement('li');
      const t = document.createElement('time');
      t.textContent = d.time;
      li.append(t, d.label);
      return li;
    }));
  } else if (selectedPlaceKey) {
    const here = residents.filter((r) => {
      const st = whereIs(r, sec);
      return st.mode !== 'home' && st.targetKey === selectedPlaceKey;
    });
    el('card-status').textContent = here.length
      ? `Most itt tartózkodik: ${here.length} lakos`
      : 'Épp senki sincs itt.';
    el('card-people').replaceChildren(...here.slice(0, 8).map((r) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = `@${r.name}`;
      chip.addEventListener('click', () => selectResident(r));
      return chip;
    }));
  }
}

function closeCard() {
  setBehind(false);
  selectedRes = null;
  selectedPlaceKey = null;
  followMode = false;
  pin.visible = false;
  el('card').hidden = true;
  el('vote').hidden = false;
}

el('card-close').addEventListener('click', closeCard);
el('btn-enter-room').addEventListener('click', () => {
  if (selectedRes) enterHouseInterior(selectedRes.name);
});
el('btn-set-mine').addEventListener('click', async () => {
  if (!selectedRes) return;
  await bindUserQuickly(selectedRes.name);
  selectHouse(selectedRes);
});
el('btn-house').addEventListener('click', () => { if (selectedRes) selectHouse(selectedRes); });
el('btn-person').addEventListener('click', () => { if (selectedRes) selectResident(selectedRes); });
el('btn-custom').addEventListener('click', () => {
  if (!selectedRes) return;
  if (el('custom-box').hidden) openCustomizePanel(selectedRes);
  else el('custom-box').hidden = true;
});
el('btn-follow').addEventListener('click', () => {
  followMode = !followMode;
  el('btn-follow').classList.toggle('on', followMode);
  el('btn-follow').textContent = followMode ? 'Követés aktív' : 'Kövesd';
});
el('event-btn').addEventListener('click', () => selectLandmark('tuz'));

// --- 11.5 MENÜPONTOK ELREJTÉSE / ÖSSZECSUKÁSA & MOBIL KOMPAKT NÉZET ---
let zenMode = false;
function toggleZenMode() {
  zenMode = !zenMode;
  document.body.classList.toggle('zen-mode', zenMode);
  const btn = el('zen-toggle-btn');
  btn.classList.toggle('zen-active', zenMode);
  btn.textContent = zenMode ? '👁️ Menük megjelenítése' : '👁️ Menük elrejtése';
}
el('zen-toggle-btn').addEventListener('click', toggleZenMode);

el('brand-toggle-btn').addEventListener('click', () => {
  const tb = el('time-box');
  tb.hidden = !tb.hidden;
  el('brand-toggle-btn').textContent = tb.hidden ? '⚙️ Idő/Táj ▸' : '⚙️ Idő/Táj ▾';
});

el('pills-toggle-btn').addEventListener('click', () => {
  const row = el('main-btn-row');
  const stats = el('player-stats-bar');
  const nextHidden = !row.hidden;
  row.hidden = nextHidden;
  stats.hidden = nextHidden;
  el('pills-toggle-btn').textContent = nextHidden ? '☰ Menü ▸' : '☰ Menü ▾';
});

el('cam-collapse-btn').addEventListener('click', () => {
  const body = el('cam-widget-body');
  body.hidden = !body.hidden;
  el('cam-collapse-btn').textContent = body.hidden ? '▸ Mutat' : '▾ Elrejt';
});

el('vote-collapse-btn').addEventListener('click', () => {
  const body = el('vote-body');
  body.hidden = !body.hidden;
  el('vote-collapse-btn').textContent = body.hidden ? '▸' : '▾';
});

el('room-editor-collapse').addEventListener('click', () => {
  const body = el('room-editor-body');
  body.hidden = !body.hidden;
  el('room-editor-collapse').textContent = body.hidden ? '▸ Raktár megnyitása' : '▾ Raktár elrejtése';
});

// Mobil készülékeken alapból összecsukjuk a másodlagos paneleket (Idő/Táj csúszka és Kamera részletek),
// hogy a 3D falu azonnal teljes pompájában látszódjon, de 1 érintéssel bármikor lenyithatók legyenek!
if (window.innerWidth <= 768) {
  el('time-box').hidden = true;
  el('brand-toggle-btn').textContent = '⚙️ Idő/Táj ▸';
  el('cam-widget-body').hidden = true;
  el('cam-collapse-btn').textContent = '▸ Mutat';
}

// --- 12. TPS "Menj vele" mód és Saját WASD Séta + Mobil Érintőpad + Q/E kameraforgatás ---
function setBehind(on) {
  behindMode = on;
  controls.enabled = !on;
  el('btn-behind').classList.toggle('on', on);
  el('btn-behind').textContent = on ? 'Térkép nézet' : 'Menj vele';
  if (!on && selectedRes) {
    const st = whereIs(selectedRes, currentSec());
    setView(st.x, st.z, 34);
  }
}
el('btn-behind').addEventListener('click', () => {
  if (selectedRes) setBehind(!behindMode);
});

let walker = null;
const pressedKeys = new Set();
const playerMesh = createVillagerGroup({ name: 'Te', cloth: '#ffcf55' });
playerMesh.visible = false;
let dragLook = null;

function setWalker(on) {
  if (Boolean(walker) === on) return;
  if (on) {
    closeCard();
    el('activities-drawer').hidden = true;
    let spawnX = controls.target.x;
    let spawnZ = controls.target.z;
    let spawnHeading = Math.PI;

    // Ha egy házhoz közel vagyunk vagy kijelölt háznál indítjuk a sétát, a ház ajtaja elé a járdára spawnolunk!
    for (const r of residents) {
      if (Math.hypot(spawnX - r.x, spawnZ - r.z) < 4.5) {
        const rot = r.rot || 0;
        spawnX = r.x + Math.sin(rot) * 2.85;
        spawnZ = r.z + Math.cos(rot) * 2.85;
        spawnHeading = rot;
        break;
      }
    }

    const startY = getGroundHeight(spawnX, spawnZ);
    walker = { x: spawnX, z: spawnZ, y: startY, heading: spawnHeading, step: 0 };
    playerMesh.visible = true;
    controls.enabled = false;
    el('walk-hud').hidden = false;
    el('vote').hidden = true;
  } else {
    setView(walker.x, walker.z, 42);
    walker = null;
    playerMesh.visible = false;
    controls.enabled = true;
    el('walk-hud').hidden = true;
    el('vote').hidden = false;
    pressedKeys.clear();
  }
}

el('walk-open').addEventListener('click', () => setWalker(true));
el('walk-exit').addEventListener('click', () => setWalker(false));

// Mobil érintőpad (D-Pad) gombok bekötése a sétához
document.querySelectorAll('.dpad-btn').forEach((btn) => {
  const code = btn.dataset.key;
  const press = (e) => {
    e.preventDefault();
    pressedKeys.add(code);
    btn.classList.add('pressed');
  };
  const release = () => {
    pressedKeys.delete(code);
    btn.classList.remove('pressed');
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') {
    if (inRoomMode) exitRoomInterior();
    else if (walker) setWalker(false);
    else closeCard();
    el('add-drawer').hidden = true;
    el('chronicle-drawer').hidden = true;
    el('claim-drawer').hidden = true;
    el('activities-drawer').hidden = true;
    el('search-dropdown').hidden = true;
    return;
  }
  if (!walker && !inRoomMode) {
    if (e.code === 'KeyQ') el('cam-rot-left').click();
    if (e.code === 'KeyE') el('cam-rot-right').click();
    if (e.code === 'KeyH') toggleZenMode();
  }
  if (walker) pressedKeys.add(e.code);
});
window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (walker) dragLook = { x: e.clientX, id: e.pointerId };
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (walker && dragLook?.id === e.pointerId) {
    walker.heading -= (e.clientX - dragLook.x) * 0.007;
    dragLook.x = e.clientX;
  }
});
window.addEventListener('pointerup', () => { dragLook = null; });

// --- 12.5 Ütközéskezelés (Collision Detection) és Automatikus Lépcsőzés (Auto-Stepping) ---
function getGroundHeight(x, z) {
  // 1. Fahíd (Bridge) átívelése a folyó felett
  if (Math.abs(x - BRIDGE.x) < 2.0 && z <= BRIDGE.southZ + 0.8 && z >= BRIDGE.northZ - 0.8) {
    const t = Math.max(0, Math.min(1, (z - BRIDGE.northZ) / (BRIDGE.southZ - BRIDGE.northZ)));
    const arch = Math.sin(t * Math.PI) * 0.24;
    return 0.45 + arch; // 0.45m - 0.69m emelt fahíd magasság
  }

  // 2. Főtér macskaköves díszemelvény és padok
  const distFoter = Math.hypot(x - PLACES.tuz.x, z - PLACES.tuz.z);
  if (distFoter < 5.2) {
    // Főtéri padok (6 db pad r=3.95 távolságban, felmehet rá a karakter!)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const bx = PLACES.tuz.x + Math.cos(a) * 3.95;
      const bz = PLACES.tuz.z + Math.sin(a) * 3.95;
      const dx = x - bx;
      const dz = z - bz;
      const lx = dx * Math.sin(a) - dz * Math.cos(a);
      const lz = dx * Math.cos(a) + dz * Math.sin(a);
      if (Math.abs(lx) < 0.95 && Math.abs(lz) < 0.32) {
        return 0.41; // Felment a padra!
      }
    }
    if (distFoter < 3.7) return 0.12; // Belső díszkör
    if (distFoter < 4.8) return 0.10; // Külső burkolat
  }

  // 3. Folyóparti kövek (river rocks)
  if (Array.isArray(envRefs.rocks)) {
    for (const r of envRefs.rocks) {
      if (Math.hypot(x - r.x, z - r.z) < r.radius) {
        return r.height; // Felmegy a kőre!
      }
    }
  }

  // 4. Házak előtti kőlépcső / küszöb
  for (const r of residents) {
    const stepX = r.x + Math.sin(r.rot || 0) * 2.15;
    const stepZ = r.z + Math.cos(r.rot || 0) * 2.15;
    if (Math.hypot(x - stepX, z - stepZ) < 0.85) {
      return 0.12;
    }
  }

  return 0.0;
}

function isObstacleBlocked(x, z, radius = 0.45) {
  // A) Házak fala és teste (Collision: nem tudsz belemenni a falakba / nem tűnsz el a házban!)
  for (const r of residents) {
    const dx = x - r.x;
    const dz = z - r.z;
    if (dx * dx + dz * dz > 25) continue;
    const rot = r.rot || 0;
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;

    // Bejárati küszöb és lépcső zóna feloldása: a küszöbön és a bejárat előtt szabad a járás, nem akad be!
    if (Math.abs(lx) < 0.95 && lz >= 1.65) {
      continue;
    }

    const halfW = 2.2 + radius;
    const halfD = 1.9 + radius;
    if (Math.abs(lx) < halfW && Math.abs(lz) < halfD) {
      return true; // Ütközés a ház falaival!
    }
  }

  // B) Nagyobb nevezetes épületek
  if (Math.abs(x - 19) < 3.8 + radius && Math.abs(z - 9) < 3.2 + radius) return true; // Kocsma
  if (Math.abs(x - (-32)) < 3.5 + radius && Math.abs(z - 28) < 3.0 + radius) return true; // Vadászház
  if (Math.hypot(x - 38, z - 34) < 2.3 + radius) return true; // Szélmalom
  if (Math.hypot(x - PLACES.tuz.x, z - PLACES.tuz.z) < 1.55 + radius) return true; // Főtér kút/tűz középpont
  if (Math.hypot(x - (-18), z - (-8)) < 1.25 + radius) return true; // Gémekút

  // C) Folyó mély vize (csak a fahídon lehet átkelni)
  const inRiver = Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH - 0.4;
  const onBridge = Math.abs(x - BRIDGE.x) < 1.9 && z <= BRIDGE.southZ + 0.8 && z >= BRIDGE.northZ - 0.8;
  if (inRiver && !onBridge) return true;

  // D) Világhatár
  if (Math.abs(x) > 190 || Math.abs(z) > 190) return true;

  return false;
}

function resolveWalkerMovement(cx, cz, nx, nz, radius = 0.45) {
  // 1. Teljes előre haladás
  if (!isObstacleBlocked(nx, nz, radius)) {
    return { x: nx, z: nz };
  }
  // 2. Csúszás X fal mentén
  if (!isObstacleBlocked(nx, cz, radius)) {
    return { x: nx, z: cz };
  }
  // 3. Csúszás Z fal mentén
  if (!isObstacleBlocked(cx, nz, radius)) {
    return { x: cx, z: nz };
  }
  // 4. Megállás a falnál
  return { x: cx, z: cz };
}

function updateWalker(dt) {
  const has = (...codes) => codes.some((c) => pressedKeys.has(c));
  const forward = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
  const turn = (has('KeyA', 'ArrowLeft') ? 1 : 0) - (has('KeyD', 'ArrowRight') ? 1 : 0);
  walker.heading += turn * 2.3 * dt;

  const speed = (has('ShiftLeft', 'ShiftRight') ? 14 : 7.5) * forward * dt;
  if (forward !== 0) {
    const rawNx = walker.x + Math.sin(walker.heading) * speed;
    const rawNz = walker.z + Math.cos(walker.heading) * speed;

    // Ütközésvizsgálat a házakkal és tereptárgyakkal + falmenti csúszás:
    const resolved = resolveWalkerMovement(walker.x, walker.z, rawNx, rawNz, 0.45);
    walker.x = resolved.x;
    walker.z = resolved.z;
    walker.step += dt * 10;
  }

  // Auto-unjam biztonsági védelem: ha a karakter valamiért mégis házfalba kerülne, kivezetjük a járdára
  for (const r of residents) {
    const dx = walker.x - r.x;
    const dz = walker.z - r.z;
    if (dx * dx + dz * dz < 12) {
      const rot = r.rot || 0;
      const cos = Math.cos(-rot);
      const sin = Math.sin(-rot);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < 2.25 && lz < 1.7 && lz > -2.0) {
        walker.x = r.x + Math.sin(rot) * 2.85;
        walker.z = r.z + Math.cos(rot) * 2.85;
      }
    }
  }

  // Automatikus lépcsőzés és magasságkövetés (híd, főtéri padok, kövek, kőlépcsők)
  const targetY = getGroundHeight(walker.x, walker.z);
  walker.y = THREE.MathUtils.lerp(walker.y !== undefined ? walker.y : targetY, targetY, Math.min(1, dt * 14));

  const bob = forward !== 0 ? Math.abs(Math.sin(walker.step)) * 0.14 : 0;
  playerMesh.position.set(walker.x, walker.y + bob, walker.z);
  playerMesh.rotation.y = walker.heading;

  const camX = walker.x - Math.sin(walker.heading) * 6.5;
  const camZ = walker.z - Math.cos(walker.heading) * 6.5;
  camera.position.lerp(new THREE.Vector3(camX, walker.y + 3.3, camZ), Math.min(1, dt * 8));
  camera.lookAt(walker.x + Math.sin(walker.heading) * 4, walker.y + 1.2, walker.z + Math.cos(walker.heading) * 4);
  controls.target.set(walker.x, walker.y, walker.z);
}

// --- 13. KERESŐ ÉS KATEGÓRIÁS LISTA (ABC SZERINT CSÖKKENŐEN: Z -> A) ---
const q = el('q');
const hits = el('hits');
const searchDropdown = el('search-dropdown');
let activeSearchTab = 'all'; // 'all' | 'houses' | 'players' | 'actions'
let sortDescending = true;   // Alapértelmezett: ABC szerint csökkenő (Z -> A)

function compareStr(a, b) {
  return sortDescending
    ? b.localeCompare(a, 'hu', { sensitivity: 'base' })
    : a.localeCompare(b, 'hu', { sensitivity: 'base' });
}

function renderSearchList() {
  const needle = q.value.trim().replace(/^@/, '').toLowerCase();
  const sec = currentSec();
  hits.replaceChildren();

  const items = [];

  // 1. Akciók és Menüpontok (Munka, Pihenés, Bútorbolt, Küldetések, Szobaberendezés stb.)
  if (activeSearchTab === 'all' || activeSearchTab === 'actions') {
    const matchedActions = ACTION_MENU_ITEMS
      .filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.sub.toLowerCase().includes(needle))
      .sort((a, b) => compareStr(a.title, b.title));

    for (const act of matchedActions) {
      items.push({
        title: `⚡ ${act.title}`,
        sub: act.sub,
        badge: 'Akció / Menü',
        badgeClass: 'action',
        onClick: () => {
          searchDropdown.hidden = true;
          if (act.type === 'walk') setWalker(true);
          else if (act.type === 'act_tab') openActivitiesDrawer(act.tab);
          else if (act.type === 'my_home') flyToMyOwnHouse();
          else if (act.type === 'my_room') {
            if (currentConnectedUser) enterHouseInterior(currentConnectedUser);
            else openClaimDrawer();
          } else if (act.type === 'place') selectLandmark(act.placeKey);
        },
      });
    }
  }

  // 2. Házak (ABC szerint csökkenően: Z -> A)
  if (activeSearchTab === 'all' || activeSearchTab === 'houses') {
    const matchedHouses = residents
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle))
      .sort((a, b) => compareStr(a.name, b.name));

    for (const r of matchedHouses) {
      const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === r.name.toLowerCase();
      const priv = housePrivacyMap[r.name.toLowerCase()] === 'private' ? '🔒 Zárt' : '🌍 Nyitott';
      items.push({
        title: `🏡 @${r.name} háza`,
        sub: `${priv} · Koordináta: (${r.x}, ${r.z})`,
        badge: isMine ? '🏠 Saját házam' : 'Ház',
        badgeClass: isMine ? 'mine' : '',
        onClick: () => {
          searchDropdown.hidden = true;
          selectHouse(r);
        },
      });
    }
  }

  // 3. Játékosok / Lakók (ABC szerint csökkenően: Z -> A)
  if (activeSearchTab === 'all' || activeSearchTab === 'players') {
    const matchedPlayers = residents
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle))
      .sort((a, b) => compareStr(a.name, b.name));

    for (const r of matchedPlayers) {
      const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === r.name.toLowerCase();
      items.push({
        title: `👤 @${r.name}`,
        sub: `${r.title} · ${statusTextFor(r, sec)}`,
        badge: isMine ? 'Te vagy' : 'Játékos',
        badgeClass: isMine ? 'mine' : '',
        onClick: () => {
          searchDropdown.hidden = true;
          selectResident(r);
        },
      });
    }
  }

  el('search-count-label').textContent = `${items.length} találat · ABC ${sortDescending ? 'csökkenő (Z → A)' : 'növekvő (A → Z)'}`;

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Nincs találat. Kattints az „➕ Új követő” gombra új lakos felvételéhez!';
    hits.append(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';

    const mainDiv = document.createElement('div');
    mainDiv.className = 'item-main';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'item-title';
    titleSpan.textContent = item.title;
    const subSpan = document.createElement('span');
    subSpan.className = 'item-sub';
    subSpan.textContent = item.sub;
    mainDiv.append(titleSpan, subSpan);

    const tagSpan = document.createElement('span');
    tagSpan.className = `item-tag ${item.badgeClass || ''}`;
    tagSpan.textContent = item.badge;

    btn.append(mainDiv, tagSpan);
    btn.addEventListener('click', item.onClick);
    li.append(btn);
    hits.append(li);
  }
}

q.addEventListener('focus', () => {
  searchDropdown.hidden = false;
  renderSearchList();
});
q.addEventListener('input', () => {
  searchDropdown.hidden = false;
  renderSearchList();
});
el('search-toggle-btn').addEventListener('click', () => {
  searchDropdown.hidden = !searchDropdown.hidden;
  if (!searchDropdown.hidden) renderSearchList();
});

document.querySelectorAll('.s-tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => {
    activeSearchTab = tabBtn.dataset.tab;
    document.querySelectorAll('.s-tab').forEach((b) => b.classList.toggle('active', b === tabBtn));
    renderSearchList();
  });
});

el('sort-dir-btn').addEventListener('click', () => {
  sortDescending = !sortDescending;
  el('sort-dir-btn').textContent = sortDescending ? 'Sorrend: Z → A ↓' : 'Sorrend: A → Z ↑';
  el('search-toggle-btn').textContent = sortDescending ? '📋 Lista (Z–A)' : '📋 Lista (A–Z)';
  renderSearchList();
});

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#search')) {
    searchDropdown.hidden = true;
  }
});

// Procedurális Telek Elfoglalása (GDPR-mentes: Becenév + Jelszó + maxHouses korlát)
el('add-open').addEventListener('click', () => {
  el('chronicle-drawer').hidden = true;
  el('claim-drawer').hidden = true;
  el('activities-drawer').hidden = true;
  updatePlotCapacityUI();
  el('add-drawer').hidden = !el('add-drawer').hidden;
  if (!el('add-drawer').hidden) el('new-name').focus();
});
el('add-close').addEventListener('click', () => { el('add-drawer').hidden = true; });

if (el('add-to-claim-btn')) {
  el('add-to-claim-btn').addEventListener('click', () => {
    el('add-drawer').hidden = true;
    openClaimDrawer();
  });
}

el('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('add-error').hidden = true;
  const name = el('new-name').value.trim();
  const password = el('new-password') ? el('new-password').value : '';
  const place = el('new-place').value;
  const title = el('new-title').value.trim();

  if (name.toLowerCase() === 'gulyas_mester') {
    el('add-error').textContent = '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva! Kérlek válassz másik nevet.';
    el('add-error').hidden = false;
    return;
  }

  try {
    const resp = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: name, name, password, place, title }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      el('add-error').textContent = data.error || 'Hiba történt.';
      el('add-error').hidden = false;
      updatePlotCapacityUI();
      if (data.resident) {
        const existing = byName.get(data.resident.name.toLowerCase());
        if (existing) selectHouse(existing);
      }
      return;
    }
    const created = addResidentToWorld(data.resident);
    currentConnectedUser = created.name;
    localStorage.setItem('kisfalu_my_user', currentConnectedUser);
    switchActiveUserRpg(created.name, data.rpg);
    updateClaimButtonUI();
    updateMyHomeBeaconPosition();
    updatePlotCapacityUI();
    el('add-form').reset();
    el('add-drawer').hidden = true;
    selectHouse(created);
    flyToMyOwnHouse();
  } catch {
    el('add-error').textContent = 'Nem sikerült elérni a helyi szervert.';
    el('add-error').hidden = false;
  }
});

function renderChronicle() {
  const list = el('chronicle-list');
  list.replaceChildren(...(villageData.chronicle || []).slice().reverse().map((entry) => {
    const item = document.createElement('div');
    item.className = 'chronicle-item';
    const b = document.createElement('b');
    b.textContent = `${entry.day}. nap – ${entry.title}`;
    const p = document.createElement('p');
    for (const part of entry.text.split(/(@[a-zA-Z0-9._]+)/g)) {
      const target = part.startsWith('@') && byName.get(part.slice(1).toLowerCase());
      if (target) {
        const btn = document.createElement('button');
        btn.className = 'inline-user';
        btn.textContent = part;
        btn.addEventListener('click', () => {
          el('chronicle-drawer').hidden = true;
          selectResident(target);
        });
        p.append(btn);
      } else {
        p.append(part);
      }
    }
    item.append(b, p);
    return item;
  }));
}
renderChronicle();

el('chronicle-open').addEventListener('click', () => {
  el('add-drawer').hidden = true;
  el('claim-drawer').hidden = true;
  el('chronicle-drawer').hidden = !el('chronicle-drawer').hidden;
});
el('chronicle-close').addEventListener('click', () => { el('chronicle-drawer').hidden = true; });

// --- 14. Kattintás a Falu Térképen, Lebegő Címkék és Képernyőszéli "Saját házam" Iránytű ---
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (inRoomMode) return;
  pointerDownPos = { x: e.clientX, y: e.clientY };
  flight = null;
  followMode = false;
  el('btn-follow').classList.remove('on');
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (inRoomMode || walker || !pointerDownPos) return;
  if (Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 7) return;

  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);

  const hitList = raycaster.intersectObjects([...figurePickers, ...housePickers, ...landmarkPickers], false);
  if (!hitList.length) return;
  const hit = hitList[0].object;

  if (hit.userData.residentFigure) selectResident(hit.userData.residentFigure);
  else if (hit.userData.resident) selectHouse(hit.userData.resident);
  else if (hit.userData.placeKey) selectLandmark(hit.userData.placeKey);
});

const labelsContainer = el('labels');
const placeTags = Object.keys(PLACES).filter((k) => k !== 'tuzkor').map((key) => {
  const tag = document.createElement('button');
  tag.className = 'tag place';
  tag.textContent = PLACES[key].name;
  tag.addEventListener('click', () => selectLandmark(key));
  labelsContainer.append(tag);
  return { key, tag };
});

const personTagPool = Array.from({ length: 12 }, () => {
  const tag = document.createElement('button');
  tag.className = 'tag person';
  tag.hidden = true;
  tag.addEventListener('click', () => { if (tag._res) selectResident(tag._res); });
  labelsContainer.append(tag);
  return tag;
});

const projVec = new THREE.Vector3();
function projectToScreen(tag, x, y, z) {
  projVec.set(x, y, z).project(camera);
  if (Math.abs(projVec.x) > 1 || Math.abs(projVec.y) > 1 || projVec.z > 1) {
    tag.hidden = true;
    return false;
  }
  const px = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  const py = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  tag.hidden = false;
  tag.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
  return true;
}

// Saját házam címke + Képernyőszéli nyíl frissítése
function updateMyHomePointer(t) {
  const myTag = el('my-home-tag');
  const compassBtn = el('home-compass-pointer');
  if (!currentConnectedUser || inRoomMode) {
    myTag.hidden = true;
    compassBtn.hidden = true;
    return;
  }
  const myRes = byName.get(currentConnectedUser.toLowerCase());
  if (!myRes) {
    myTag.hidden = true;
    compassBtn.hidden = true;
    return;
  }

  // 3D jelző animálása a saját ház felett
  myHomeBeacon.children[0].position.y = 5.4 + Math.sin(t * 4.5) * 0.35;
  myHomeBeacon.children[0].rotation.y = t * 2.0;

  projVec.set(myRes.x, 6.2, myRes.z).project(camera);
  let ndcX = projVec.x;
  let ndcY = projVec.y;
  if (projVec.z > 1) {
    ndcX = -ndcX;
    ndcY = -ndcY;
  }

  const onScreen = Math.abs(projVec.x) <= 0.94 && Math.abs(projVec.y) <= 0.88 && projVec.z <= 1;
  if (onScreen) {
    compassBtn.hidden = true;
    myTag.hidden = false;
    myTag.textContent = `🏠 Saját házam (@${myRes.name})`;
    const px = (projVec.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
    myTag.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
  } else {
    // Ha a saját ház kívül van a képernyőn, a képernyő szélére tesszük az iránytű gombot!
    myTag.hidden = true;
    compassBtn.hidden = false;
    const angle = Math.atan2(-ndcY, ndcX);
    const marginX = window.innerWidth / 2 - 115;
    const marginY = window.innerHeight / 2 - 65;
    const edgeX = window.innerWidth / 2 + Math.cos(angle) * marginX;
    const edgeY = window.innerHeight / 2 + Math.sin(angle) * marginY;
    compassBtn.style.left = `${edgeX.toFixed(0)}px`;
    compassBtn.style.top = `${edgeY.toFixed(0)}px`;
    compassBtn.textContent = `🏠 Saját házam (@${myRes.name}) erre ➔`;
  }
}

// --- 15. Meghívó link (#haz=nev&kulcs=xyz) felismerése induláskor ---
function checkInviteHash() {
  if (!window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const haz = params.get('haz');
  const kulcs = params.get('kulcs');
  if (haz) {
    enterHouseInterior(haz, kulcs);
    history.replaceState(null, '', window.location.pathname);
  }
}
checkInviteHash();
window.addEventListener('hashchange', checkInviteHash);

// --- 16. Fő Animációs Ciklus ---
let lastTime = performance.now();
let frameCount = 0;

function tick(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const t = now / 1000;

  if (inRoomMode) {
    roomControls.update();
    renderer.render(roomScene, roomCamera);
    requestAnimationFrame(tick);
    return;
  }

  const sec = currentSec();

  if (flight) {
    flight.t = Math.min(1, flight.t + dt / 0.75);
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    setView(
      flight.fromX + (flight.x - flight.fromX) * k,
      flight.fromZ + (flight.z - flight.fromZ) * k,
      flight.fromDist + (flight.dist - flight.fromDist) * k,
      flight.fromAzimuth + (flight.targetAzimuth - flight.fromAzimuth) * k,
      flight.fromPolar + (flight.targetPolar - flight.fromPolar) * k
    );
    if (flight.t >= 1) flight = null;
  } else if (walker) {
    updateWalker(dt);
  } else if (behindMode && selectedRes) {
    const st = whereIs(selectedRes, sec);
    const camX = st.x - Math.sin(st.heading) * 6.0;
    const camZ = st.z - Math.cos(st.heading) * 6.0;
    camera.position.lerp(new THREE.Vector3(camX, 3.2, camZ), Math.min(1, dt * 6));
    camera.lookAt(st.x, 1.3, st.z);
    controls.target.set(st.x, 0, st.z);
  } else {
    controls.update();
  }

  if (windmillBlades) {
    windmillBlades.rotation.z -= dt * 0.65;
  }
  const isDaytime = sec > 6.5 * HOUR && sec < 20.5 * HOUR;
  for (const a of pastureAnimals) {
    if (isDaytime) {
      a.mesh.position.x = a.baseX + Math.sin(t * 0.4 + a.seed) * 1.4;
      a.mesh.position.z = a.baseZ + Math.cos(t * 0.3 + a.seed) * 1.4;
      a.mesh.rotation.y = Math.atan2(
        Math.cos(t * 0.4 + a.seed) * 0.4,
        -Math.sin(t * 0.3 + a.seed) * 0.3
      );
    }
  }

  updateWeather(dt);

  let outsideCount = 0;
  for (let i = 0; i < residents.length; i++) {
    const res = residents[i];
    const st = whereIs(res, sec);
    const isSleeping = st.mode === 'sleep' || st.mode === 'home';
    if (!isSleeping) outsideCount++;

    res.figureGroup.visible = !isSleeping || res === selectedRes;
    const groundY = getGroundHeight(st.x, st.z);
    const bob = st.mode === 'walk' ? Math.abs(Math.sin(t * 8.5 + i)) * 0.14 : 0;
    res.figureGroup.position.set(st.x, groundY + bob, st.z);
    res.figureGroup.rotation.y = st.heading;
  }

  if (currentSeason === 'tel') {
    if (xmasStarMesh) {
      xmasStarMesh.rotation.y = t * 1.6;
    }
    flames.forEach((f, i) => {
      f.scale.y = 0.85 + Math.sin(t * 14 + i * 2.1) * 0.25;
    });
    smokePuffs.forEach(({ mesh, offset }, i) => {
      const cycle = (t * 0.35 + offset) % 1;
      mesh.position.set(
        PLACES.tuz.x + 1.35 + Math.sin(t * 1.5 + i) * 0.35 * cycle,
        1.8 + cycle * 4.5,
        PLACES.tuz.z + 0.85 + Math.cos(t * 1.2 + i) * 0.35 * cycle
      );
      mesh.scale.setScalar(0.6 + cycle * 1.4);
      mesh.material.opacity = (1 - cycle) * 0.55;
    });
  }

  updateMyHomePointer(t);

  const chosenTag = el('chosen-tag');
  if (selectedRes && !el('diary-box').hidden) {
    const st = whereIs(selectedRes, sec);
    const tx = st.mode === 'home' ? selectedRes.x : st.x;
    const tz = st.mode === 'home' ? selectedRes.z : st.z;
    const ty = st.mode === 'home' ? 4.8 : 2.3;
    pin.position.set(tx, ty + Math.sin(t * 4) * 0.15, tz);
    chosenTag.textContent = `@${selectedRes.name}`;
    projectToScreen(chosenTag, tx, ty + 0.9, tz);
    if (followMode && !flight && !behindMode) {
      const dist = camera.position.distanceTo(controls.target);
      setView(
        controls.target.x + (tx - controls.target.x) * 0.08,
        controls.target.z + (tz - controls.target.z) * 0.08,
        dist
      );
    }
  } else {
    chosenTag.hidden = true;
  }

  for (const { key, tag } of placeTags) {
    const p = PLACES[key];
    projectToScreen(tag, p.x, 4.8, p.z);
  }
  const camDist = camera.position.distanceTo(controls.target);
  let usedTags = 0;
  if (camDist < 68) {
    for (const res of residents) {
      if (usedTags >= personTagPool.length) break;
      if (!res.figureGroup.visible || res === selectedRes) continue;
      const d = Math.hypot(res.figureGroup.position.x - controls.target.x, res.figureGroup.position.z - controls.target.z);
      if (d < 34) {
        const tag = personTagPool[usedTags];
        tag._res = res;
        tag.textContent = `@${res.name}`;
        if (projectToScreen(tag, res.figureGroup.position.x, 2.2, res.figureGroup.position.z)) {
          usedTags++;
        }
      }
    }
  }
  for (let i = usedTags; i < personTagPool.length; i++) personTagPool[i].hidden = true;

  if (frameCount % 15 === 0) {
    updateDaylight(sec, outsideCount);
    refreshCardLive(sec);
  }
  frameCount++;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  roomCamera.aspect = window.innerWidth / window.innerHeight;
  roomCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

updateDaylight(currentSec(), 0);
requestAnimationFrame(tick);
