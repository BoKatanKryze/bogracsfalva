import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createClient } from '@supabase/supabase-js';

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

// Az utcafronti telkek és a validátor lentebb, az úthálózat és PLACES után kerül deklarálásra.
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
      maxHouses: cachedVillageData?.maxHouses || 48,
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
    const maxHouses = cachedVillageData?.maxHouses || 48;
    if (allRes.length >= maxHouses) {
      return jsonResp(403, {
        error: `🔒 Bográcsfalva megtelt (${maxHouses}/${maxHouses} telek)! Új ház már nem építhető, de a meglévő lakók beléphetnek.`,
        full: true,
        maxHouses,
        claimedCount: allRes.length,
      });
    }
    const reqPlot = body.plot && isPlotValid(Number(body.plot.x), Number(body.plot.z), allRes)
      ? {
          x: Number(body.plot.x),
          z: Number(body.plot.z),
          rot: Number.isFinite(Number(body.plot.rot)) ? Number(body.plot.rot) : 0,
          houseStyle: Number.isFinite(Number(body.plot.houseStyle))
            ? Number(body.plot.houseStyle)
            : STREET_PLOTS.find((sp) => Math.hypot(sp.x - Number(body.plot.x), sp.z - Number(body.plot.z)) < 0.5)?.houseStyle,
        }
      : null;
    const plot = reqPlot || findNextPlotLocal(allRes);
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
    const styleCandidate = body.plot?.houseStyle ?? plot.houseStyle;
    const plotStyle = Number.isFinite(Number(styleCandidate)) ? Number(styleCandidate) : (allRes.length % 5);
    const newResident = {
      id: allRes.length + 1,
      name: rawName,
      title: body.title?.trim() || chosenRole.title,
      place: chosenRole.place,
      x: plot.x,
      z: plot.z,
      rot: plot.rot,
      houseStyle: plotStyle,
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
    x: 0, z: 11.0, r: 4.8,
    at: 'a főtéren', to: 'a főtérre',
    story: 'A falu macskaköves főtere, ahol minden este 20:00-kor összegyűlik a falu apraja-nagyja. Tavasztól őszig díszkút áll a közepén, télen (havas tájon) pedig itt lobog a tábortűz és itt ragyog a falu karácsonyfája!',
    actions: [
      { id: 'rest_foter_walk', label: '🏛️ Korzózás és Beszélgetés (+10% Energia, +10 XP)', deltaEnergy: 10, deltaXp: 10, cooldownSec: 90, msg: 'Körbesétáltál a Főtéren és beszélgettél a falubeliekkel! (+10% Energia, +10 XP)' },
      { id: 'rest_bogracs', label: '🍲 Bográcsgulyás (-14 Tallér → +45% Energia, +10 XP)', costCoins: 14, deltaEnergy: 45, deltaXp: 10, cooldownSec: 90, msg: 'Ettél egy tál tüzes bográcsgulyást a Főtéren! (+45% Energia)' },
      { label: '📋 Főtéri Üzenőtábla megnyitása (Üres)', onClick: () => selectLandmark('uzenotabla') },
      { label: '🎄 Váltás Téli Főtérre (Tábortűz + Karácsonyfa)', onClick: () => applySeason('tel') },
      { label: '🗳️ Falugyűlés & Szavazás megnyitása', onClick: () => openActivitiesDrawer('community') },
    ],
  },
  tuzkor: {
    name: 'Az esti Főtér',
    since: 'Minden este 20:00-kor',
    x: 0, z: 11.0, r: 7.5,
    at: 'az esti főtéren', to: 'az esti főtérre',
    story: 'Esténként a lakók összegyűlnek a Főtéren.',
    actions: [],
  },
  uzenotabla: {
    name: '📋 Főtéri Üzenőtábla',
    since: 'A falu közösségi hirdetőtáblája',
    x: 2.8, z: 8.2, r: 1.5,
    at: 'az üzenőtáblánál', to: 'az üzenőtáblához',
    story: '📋 A Főtér fa hirdetőtáblája. Jelenleg még nincsenek kifüggesztett üzenetek — itt lehet majd olvasni a falubeliek és a fejlesztő közleményeit!',
    actions: [
      { label: '🏛️ Vissza a Főtérre', onClick: () => selectLandmark('tuz') },
    ],
  },
  kocsma: {
    name: 'A Falusi Kocsma',
    since: 'A 3. napon épült',
    x: 26, z: 10.5, r: 4.5,
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
    x: -64, z: -32.0, r: 5.0,
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
    x: 30, z: -21.5, r: 4.5,
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
    x: -34, z: 16.0, r: 4.0,
    at: 'a szélmalomnál', to: 'a szélmalomhoz',
    story: 'A vitorlák éjjel-nappal forognak, itt őrlik a falu lisztjét a lángoshoz és a kenyérhez.',
    actions: [
      { id: 'job_mill', label: '🌾 Munka: Búzaőrlés (-18% Energia → +2 Liszt, +15 Tallér)', costEnergy: 18, deltaCoins: 15, deltaXp: 12, deltaRes: { liszt: 2 }, cooldownSec: 75, msg: 'Felöntötted a garatra a búzát, friss liszt készült a falunak! (+2 🌾 Liszt, +15 Tallér)' },
    ],
  },
  legelo: {
    name: 'A Legelő',
    since: 'A tehenek és bárányok otthona',
    x: 44, z: 20.5, r: 5.0,
    at: 'a legelőn', to: 'a legelőre',
    story: 'Bekerített zöld legelő itatóval, ahol a falu tehenei és bárányai békésen legelésznek.',
    actions: [
      { id: 'job_milk', label: '🐄 Munka: Állatgondozás & Fejés (-18% Energia → +2 Tej, +15 Tallér)', costEnergy: 18, deltaCoins: 15, deltaXp: 12, deltaRes: { tej: 2 }, cooldownSec: 75, msg: 'Megtöltötted a vályút friss vízzel, és megfejted a teheneket! (+2 🥛 Tej, +15 Tallér)' },
    ],
  },
  gemeskut: {
    name: 'A Gémeskút',
    since: 'Friss kútvíz',
    x: -24, z: 11.5, r: 2.5,
    at: 'a gémeskútnál', to: 'a gémeskúthoz',
    story: 'Hűvös vizet ad a bográcsba és a megfáradt vándoroknak.',
    actions: [
      { id: 'rest_well', label: '🪣 Vízhúzás a kútból (+15% Energia, Ingyenes)', deltaEnergy: 15, deltaXp: 4, cooldownSec: 120, msg: 'Húztál egy vödör jéghideg kútvizet és felfrissültél! (+15% Energia)' },
    ],
  },
};
const WORK_PLACES = ['tuz', 'kocsma', 'vadaszhaz', 'piac', 'steg', 'malom', 'legelo', 'gemeskut'];
const PHYSICAL_PLACE_KEYS = ['tuz', 'uzenotabla', 'kocsma', 'vadaszhaz', 'piac', 'steg', 'hid', 'malom', 'legelo', 'gemeskut'];
const DEVELOPER_HANDLE = 'gulyas_mester';

// Budapesti ihletésű 3D domborzat és Fejlesztői Domb (Gellért-hegy / Várhegy hatás)
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const DEV_HILL = { x: -37.9, z: -32.9, peakY: 6.8, plateauR: 5.5, outerR: 22.0 };
const TERRAIN_HILLS = [
  DEV_HILL,
  { x: -58, z: -48, peakY: 4.2, plateauR: 4.0, outerR: 28.0 },
  { x: 4, z: -58, peakY: 3.5, plateauR: 3.0, outerR: 26.0 },
  { x: 56, z: -48, peakY: 3.6, plateauR: 4.0, outerR: 28.0 },
  { x: -34, z: 16, peakY: 4.0, plateauR: 5.2, outerR: 20.0 },
  { x: -54, z: 48, peakY: 2.6, plateauR: 4.0, outerR: 28.0 },
  { x: 54, z: 46, peakY: 2.4, plateauR: 4.0, outerR: 28.0 },
  { x: 8, z: 70, peakY: 2.8, plateauR: 4.0, outerR: 26.0 },
];

function hillContrib(h, x, z) {
  const d = Math.hypot(x - h.x, z - h.z);
  if (d >= h.outerR) return 0;
  if (d <= h.plateauR) return h.peakY;
  const t = (d - h.plateauR) / (h.outerR - h.plateauR);
  return h.peakY * 0.5 * (1 + Math.cos(Math.PI * t));
}

function getTerrainElevation(x, z) {
  const rz = riverZ(x);
  const distRiver = Math.abs(z - rz);
  const riverMask = smoothstep(RIVER_HALF_WIDTH + 2.0, RIVER_HALF_WIDTH + 9.5, distRiver);

  let bridgeMask = 1.0;
  if (Math.abs(x) < 8.5 && z > -22 && z < 3) {
    const mx = smoothstep(3.0, 8.5, Math.abs(x));
    const mzS = smoothstep(-0.8, 3.0, z);
    const mzN = 1 - smoothstep(-22.0, -19.5, z);
    bridgeMask = Math.max(mx, mzS, mzN);
  }

  const devVal = hillContrib(DEV_HILL, x, z);
  let otherHills = 0;
  for (let i = 1; i < TERRAIN_HILLS.length; i++) {
    otherHills += hillContrib(TERRAIN_HILLS[i], x, z);
  }
  const budaUplift = smoothstep(-20, -65, z) * 1.4;
  const pestRise = smoothstep(25, 80, Math.hypot(x, z - 15)) * 1.1;
  const waves = Math.sin(x * 0.045) * Math.cos(z * 0.045) * 0.55 + Math.sin(x * 0.08 - z * 0.06) * 0.30;

  let y = Math.max(0, otherHills + budaUplift + pestRise + waves, devVal) * riverMask * bridgeMask;

  // Folyómeder mélyítése a z-fighting elkerülésére
  const bedMask = 1 - smoothstep(RIVER_HALF_WIDTH - 0.6, RIVER_HALF_WIDTH + 1.2, distRiver);
  y -= bedMask * 0.28;

  // Központi Főtér terasz (0, 11.0), 7.5m sugárban simán a ~0.35m szintre simul
  const dFoter = Math.hypot(x - 0, z - 11.0);
  if (dFoter < 7.5) {
    const foterBlend = 1 - smoothstep(4.8, 7.5, dFoter);
    y = y * (1 - foterBlend) + 0.35 * foterBlend;
  }
  return y;
}

// Városi 2 sávos úthálózat és járdarendszer konstansai (±3.375m, össz-szélesség 6.75m)
const CAR_ROAD_WIDTH = 4.6;
const SIDEWALK_WIDTH = 1.05;
const SIDEWALK_OFFSET = 2.85;
const MAX_NPC_SPEED = 4.5;

const ROAD_CHAINS = [
  { id: 'bridge_s', speedLimit: 30, pts: [[0, -8.5], [0, 0]] },
  { id: 'west_blvd', speedLimit: 30, pts: [[0, 0], [-14, 0, true], [-34, 0], [-56, 7], [-84, 20]] },
  { id: 'east_blvd', speedLimit: 30, pts: [[0, 0], [14, 0, true], [34, 0], [56, 6], [84, 18]] },
  { id: 'ring_west', speedLimit: 30, pts: [[-14, 0], [-17, 11], [-12, 22, true], [0, 25]] },
  { id: 'ring_east', speedLimit: 30, pts: [[14, 0], [17, 11], [12, 22, true], [0, 25]] },
  { id: 'south_spine', speedLimit: 50, pts: [[0, 25], [0, 46, true], [6, 66], [16, 86]] },
  { id: 'southwest_ave', speedLimit: 30, pts: [[-12, 22], [-32, 30], [-56, 36], [-84, 42]] },
  { id: 'southeast_ave', speedLimit: 30, pts: [[12, 22], [32, 29], [56, 34], [84, 40]] },
  { id: 'south_west_lower', speedLimit: 30, pts: [[0, 46], [-24, 52], [-52, 58], [-82, 64]] },
  { id: 'south_east_lower', speedLimit: 30, pts: [[0, 46], [24, 52], [52, 56], [82, 60]] },
  { id: 'north_spine', speedLimit: 50, pts: [[0, -19.5], [0, -29, true], [0, -36, true], [-4, -50, true], [-12, -78]] },
  { id: 'buda_east_ave', speedLimit: 30, pts: [[0, -29], [22, -31], [48, -36], [80, -44]] },
  { id: 'buda_ne_upper', speedLimit: 30, pts: [[-4, -50], [22, -52], [48, -56], [80, -62]] },
  { id: 'buda_west_ave', speedLimit: 30, pts: [[0, -36], [-18, -40, true], [-44, -48], [-78, -56]] },
  { id: 'dev_hill_road', speedLimit: 30, pts: [[-18, -40], [-24, -34.5], [-30, -33.8]] },
];

function buildSmoothPolyline(pts, steps = 2, maxCut = 6.5) {
  if (!pts || pts.length <= 2) {
    return (pts || []).map((p) => [p[0], p[1], Boolean(p[2])]);
  }
  const out = [[pts[0][0], pts[0][1], true]];
  for (let i = 1; i < pts.length - 1; i++) {
    const pPrev = pts[i - 1];
    const pCurr = pts[i];
    const pNext = pts[i + 1];
    if (pCurr[2] === true) {
      out.push([pCurr[0], pCurr[1], true]);
      continue;
    }
    const d1 = Math.hypot(pCurr[0] - pPrev[0], pCurr[1] - pPrev[1]);
    const d2 = Math.hypot(pNext[0] - pCurr[0], pNext[1] - pCurr[1]);
    const cut = Math.min(maxCut, d1 * 0.4, d2 * 0.4);
    if (cut < 0.25) {
      out.push([pCurr[0], pCurr[1], false]);
      continue;
    }
    const pInX = pCurr[0] + ((pPrev[0] - pCurr[0]) / d1) * cut;
    const pInZ = pCurr[1] + ((pPrev[1] - pCurr[1]) / d1) * cut;
    const pOutX = pCurr[0] + ((pNext[0] - pCurr[0]) / d2) * cut;
    const pOutZ = pCurr[1] + ((pNext[1] - pCurr[1]) / d2) * cut;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const omt = 1 - t;
      const qx = omt * omt * pInX + 2 * omt * t * pCurr[0] + t * t * pOutX;
      const qz = omt * omt * pInZ + 2 * omt * t * pCurr[1] + t * t * pOutZ;
      out.push([qx, qz, false]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last[0], last[1], true]);
  return out;
}

const VILLAGE_ROADS = [];
for (const chain of ROAD_CHAINS) {
  const smoothed = buildSmoothPolyline(chain.pts, 2, 6.5);
  for (let i = 0; i < smoothed.length - 1; i++) {
    const a = smoothed[i];
    const b = smoothed[i + 1];
    VILLAGE_ROADS.push({
      id: `${chain.id}_${i}`,
      chainId: chain.id,
      segIndex: i,
      segCount: smoothed.length - 1,
      isCurveSub: !(a[2] && b[2]),
      x1: a[0],
      z1: a[1],
      x2: b[0],
      z2: b[1],
      width: CAR_ROAD_WIDTH,
      speedLimit: chain.speedLimit,
    });
  }
}

function distPointToRoadSegment(px, pz, r) {
  const dx = r.x2 - r.x1;
  const dz = r.z2 - r.z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(px - r.x1, pz - r.z1);
  const u = Math.max(0, Math.min(1, ((px - r.x1) * dx + (pz - r.z1) * dz) / lenSq));
  return Math.hypot(px - (r.x1 + u * dx), pz - (r.z1 + u * dz));
}

function isSidewalkPointClear(px, pz, ownRoad) {
  for (const other of VILLAGE_ROADS) {
    if (other === ownRoad) continue;
    const clearance = (other.width || CAR_ROAD_WIDTH) * 0.5 + SIDEWALK_WIDTH * 0.5 - 0.03;
    if (distPointToRoadSegment(px, pz, other) < clearance) return false;
  }
  return true;
}

function buildSidewalkSegments() {
  const segs = [];
  for (const r of VILLAGE_ROADS) {
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const minLen = r.isCurveSub ? 0.8 : 1.5;

    for (const side of [-1, 1]) {
      const ox = r.x1 + nx * side * SIDEWALK_OFFSET;
      const oz = r.z1 + nz * side * SIDEWALK_OFFSET;
      const step = 0.2;
      const nSteps = Math.max(2, Math.ceil(len / step));
      let activeStart = null;
      const intervals = [];

      for (let k = 0; k <= nSteps; k++) {
        const t = (k / nSteps) * len;
        const ok = isSidewalkPointClear(ox + ux * t, oz + uz * t, r);
        if (ok && activeStart === null) {
          if (k > 0) {
            let lo = ((k - 1) / nSteps) * len;
            let hi = t;
            for (let b = 0; b < 8; b++) {
              const mid = (lo + hi) * 0.5;
              if (isSidewalkPointClear(ox + ux * mid, oz + uz * mid, r)) hi = mid;
              else lo = mid;
            }
            activeStart = hi;
          } else {
            activeStart = t;
          }
        } else if (!ok && activeStart !== null) {
          let lo = ((k - 1) / nSteps) * len;
          let hi = t;
          for (let b = 0; b < 8; b++) {
            const mid = (lo + hi) * 0.5;
            if (isSidewalkPointClear(ox + ux * mid, oz + uz * mid, r)) lo = mid;
            else hi = mid;
          }
          intervals.push([activeStart, lo]);
          activeStart = null;
        }
      }
      if (activeStart !== null) intervals.push([activeStart, len]);

      for (const [a, b] of intervals) {
        if (b - a < minLen) continue;
        segs.push({
          roadId: r.id,
          chainId: r.chainId,
          segIndex: r.segIndex,
          side,
          x1: ox + ux * a,
          z1: oz + uz * a,
          x2: ox + ux * b,
          z2: oz + uz * b,
          ux,
          uz,
          nx,
          nz,
          len: b - a,
        });
      }
    }
  }
  return segs;
}

const SIDEWALK_SEGMENTS = buildSidewalkSegments();

function getClosestPointOnRoads(px, pz) {
  const pIsNorth = pz < riverZ(px);
  let closestX = 0, closestZ = 0, minDistSq = Infinity, closestRoad = null;
  let fbX = 0, fbZ = 0, fbDistSq = Infinity, fbRoad = null;

  for (const r of VILLAGE_ROADS) {
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) continue;
    const u = Math.max(0, Math.min(1, ((px - r.x1) * dx + (pz - r.z1) * dz) / lenSq));
    const nx = r.x1 + u * dx;
    const nz = r.z1 + u * dz;
    const distSq = (px - nx) * (px - nx) + (pz - nz) * (pz - nz);
    if (distSq < fbDistSq) {
      fbDistSq = distSq;
      fbX = nx;
      fbZ = nz;
      fbRoad = r;
    }
    if ((nz < riverZ(nx)) !== pIsNorth) continue;
    if (distSq < minDistSq) {
      minDistSq = distSq;
      closestX = nx;
      closestZ = nz;
      closestRoad = r;
    }
  }
  if (!closestRoad) {
    return { x: fbX, z: fbZ, dist: Math.sqrt(fbDistSq), road: fbRoad };
  }
  return { x: closestX, z: closestZ, dist: Math.sqrt(minDistSq), road: closestRoad };
}

function getClosestSidewalkPoint(px, pz) {
  const pIsNorth = pz < riverZ(px);
  let bestX = 0, bestZ = 0, minDistSq = Infinity, bestSeg = null;
  for (const seg of SIDEWALK_SEGMENTS) {
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) continue;
    const u = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (pz - seg.z1) * dz) / lenSq));
    const nx = seg.x1 + u * dx;
    const nz = seg.z1 + u * dz;
    if ((nz < riverZ(nx)) !== pIsNorth) continue;
    const distSq = (px - nx) * (px - nx) + (pz - nz) * (pz - nz);
    if (distSq < minDistSq) {
      minDistSq = distSq;
      bestX = nx;
      bestZ = nz;
      bestSeg = seg;
    }
  }
  if (!bestSeg) {
    const nr = getClosestPointOnRoads(px, pz);
    return { x: nr.x, z: nr.z, dist: nr.dist, seg: null };
  }
  return { x: bestX, z: bestZ, dist: Math.sqrt(minDistSq), seg: bestSeg };
}

const CANONICAL_RESIDENT_COORDS = [
  { id: 1, x: -37.9, z: -32.9, rot: 1.6869, houseStyle: 2 },
  { id: 2, x: -38.7, z: -6.9, rot: 0.2318, houseStyle: 1 },
  { id: 3, x: -43.9, z: 11.8, rot: -2.8336, houseStyle: 3 },
  { id: 4, x: -55.4, z: 16, rot: -2.7379, houseStyle: 4 },
  { id: 5, x: -67.5, z: 21.5, rot: -2.7069, houseStyle: 0 },
  { id: 6, x: -77, z: 25.9, rot: -2.7069, houseStyle: 2 },
  { id: 7, x: 67.9, z: 20.1, rot: 2.7368, houseStyle: 1 },
  { id: 8, x: 77.5, z: 24.3, rot: 2.7368, houseStyle: 4 },
  { id: 9, x: -11.7, z: 30.8, rot: -2.7607, houseStyle: 3 },
  { id: 10, x: -43.2, z: 24.3, rot: 0.2446, houseStyle: 0 },
  { id: 11, x: -54.6, z: 27.1, rot: 0.2375, houseStyle: 4 },
  { id: 12, x: -63.6, z: 46.1, rot: -2.9304, houseStyle: 3 },
  { id: 13, x: 12.1, z: 30.8, rot: 2.805, houseStyle: 2 },
  { id: 14, x: 39.6, z: 39.1, rot: 2.937, houseStyle: 1 },
  { id: 15, x: 63.6, z: 44.1, rot: 2.9304, houseStyle: 0 },
  { id: 16, x: 9.2, z: -38.2, rot: 0.0905, houseStyle: 2 },
  { id: 17, x: 39.8, z: -26, rot: -2.9521, houseStyle: 1 },
  { id: 18, x: 52.8, z: -28.7, rot: -2.9104, houseStyle: 4 },
  { id: 19, x: 66, z: -32, rot: -2.8967, houseStyle: 3 },
  { id: 20, x: 76.2, z: -34.5, rot: -2.8967, houseStyle: 0 },
  { id: 21, x: -8.1, z: -29.3, rot: 1.5708, houseStyle: 3 },
  { id: 22, x: -21.8, z: -49.8, rot: -0.2985, houseStyle: 1 },
  { id: 23, x: -44.9, z: -56.7, rot: -0.2487, houseStyle: 4 },
  { id: 24, x: -58.2, z: -59.9, rot: -0.2311, houseStyle: 0 },
];

// Szigorú várostervezési szabad telkek (24 szabad telek + 24 foglalt = max 48 ház)
const STREET_PLOTS = [
  { x: -48.9, z: -4, rot: 0.308, houseStyle: 1 },
  { x: -61.9, z: 0.7, rot: 0.4037, houseStyle: 4 },
  { x: -74.5, z: 6.4, rot: 0.4346, houseStyle: 2 },
  { x: -84, z: 10.8, rot: 0.4346, houseStyle: 0 },
  { x: 55.7, z: 15, rot: 2.7705, houseStyle: 3 },
  { x: 74.4, z: 4.9, rot: -0.4048, houseStyle: 1 },
  { x: 84.1, z: 9, rot: -0.4048, houseStyle: 4 },
  { x: -26, z: 36.4, rot: -2.796, houseStyle: 2 },
  { x: -39.2, z: 40.4, rot: -2.897, houseStyle: 0 },
  { x: -50.7, z: 43.2, rot: -2.9041, houseStyle: 3 },
  { x: -73.8, z: 48.3, rot: -2.9304, houseStyle: 1 },
  { x: 26.2, z: 35.7, rot: 2.8383, houseStyle: 4 },
  { x: 50.9, z: 41.4, rot: 2.9339, houseStyle: 2 },
  { x: 73.8, z: 46.3, rot: 2.9304, houseStyle: 0 },
  { x: 23.6, z: -39.8, rot: 0.1657, houseStyle: 3 },
  { x: 36.6, z: -42.3, rot: 0.1895, houseStyle: 1 },
  { x: 49, z: -44.9, rot: 0.2312, houseStyle: 4 },
  { x: 62, z: -48.1, rot: 0.2449, houseStyle: 2 },
  { x: 72.2, z: -50.6, rot: 0.2449, houseStyle: 0 },
  { x: -11.4, z: -47, rot: 1.8491, houseStyle: 3 },
  { x: -31.8, z: -52.9, rot: -0.2985, houseStyle: 1 },
  { x: -58.6, z: -42.9, rot: 2.9105, houseStyle: 4 },
  { x: -68.8, z: -45.3, rot: 2.9105, houseStyle: 2 },
  { x: -68.4, z: -62.3, rot: -0.2311, houseStyle: 0 },
];

function isPlotValid(x, z, occupied = []) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  for (const h of occupied) {
    const hx = Array.isArray(h) ? h[0] : h.x;
    const hz = Array.isArray(h) ? h[1] : h.z;
    if (Math.hypot(x - hx, z - hz) < 9.5) return false;
  }
  if (getClosestPointOnRoads(x, z).dist < 6.8) return false;
  if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 6.7) return false;
  for (const key of PHYSICAL_PLACE_KEYS) {
    const p = PLACES[key];
    if (p && Math.hypot(x - p.x, z - p.z) < (p.r + 5.5)) return false;
  }
  return true;
}

function findNextPlotLocal(houses) {
  const occupied = houses || [];
  for (const plot of STREET_PLOTS) {
    if (isPlotValid(plot.x, plot.z, occupied)) {
      return { x: plot.x, z: plot.z, rot: plot.rot, houseStyle: plot.houseStyle };
    }
  }
  for (let idx = 0; idx < 120; idx++) {
    const side = idx % 2 === 0 ? 1 : -1;
    const row = Math.floor(idx / 2);
    const candX = side * 8.2;
    const candZ = 62 + row * 11;
    if (isPlotValid(candX, candZ, occupied)) {
      return { x: candX, z: candZ, rot: side > 0 ? -1.5708 : 1.5708 };
    }
  }
  return { x: -66, z: 11.7, rot: 3.1416 };
}

// Keresőben megjelenő Menüpontok és Akciók listája (Munka, Pihenés, Bolt, Küldetések, Szoba stb.)
const ACTION_MENU_ITEMS = [
  { id: 'act_menu_hub', title: 'Falusi Élet & Tevékenységek Központ (Főmenü)', sub: 'Munka, Pihenés, Bútorbolt, Barkácsolás és Napi Küldetések', type: 'act_tab', tab: 'work' },
  { id: 'act_shop', title: 'Bútorbolt és Barkácsműhely (Új 3D bútorok)', sub: 'Vásárolj vagy barkácsolj lámpát, könyvespolcot, növényt a szobádba', type: 'act_tab', tab: 'shop' },
  { id: 'act_quests', title: 'Napi Küldetések és Falugyűlés Szavazás', sub: 'Szavazz a falu következő épületére és szerezz jutalom Tallért', type: 'act_tab', tab: 'community' },
  { id: 'act_leaderboard', title: 'Falusi Ranglista & Dicsőségfal (XP és Tallér)', sub: 'Kövesd az élmezőnyt és a lakosok toplistáját (Top 3 kiemelve)', type: 'act_tab', tab: 'leaderboard' },
  { id: 'act_walk', title: 'Vándorlás és Séta (WASD + Mobil érintőpad mód)', sub: 'Szabad séta saját karakterrel a faluban', type: 'walk' },
  { id: 'act_fire', title: 'Főtér: Falugyűlés, Korzózás és Téli Karácsonyfa', sub: 'A falu központi főtere (télen tábortűzzel és karácsonyfával)', type: 'place', placeKey: 'tuz' },
  { id: 'act_board', title: 'Főtéri Üzenőtábla (Közösségi hirdetőtábla)', sub: 'Falu hirdetőtáblája a Főtéren (jelenleg üres)', type: 'place', placeKey: 'uzenotabla' },
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
const APP_VERSION = '20261115-5';
const villageResp = await fetch(`./village.json?v=${APP_VERSION}`, { cache: 'no-store' });
const villageData = await villageResp.json();
villageData.maxHouses = villageData.maxHouses || 48;
for (const r of (villageData.residents || [])) {
  const canon = CANONICAL_RESIDENT_COORDS.find((c) => c.id === r.id);
  if (canon) {
    r.x = canon.x;
    r.z = canon.z;
    r.rot = canon.rot;
    r.houseStyle = canon.houseStyle;
  }
}
cachedVillageData = villageData;

// Korai deklarációk a Temporal Dead Zone (TDZ) elkerülésére legelső betöltéskor
const residents = [];
const byName = new Map();
const housePickers = [];
const figurePickers = [];
const unclaimedHouses = [];
let pendingClaimPlot = null;
let houseFilterMode = 'all'; // 'all' | 'claimed' | 'free'
let myHomeBeacon = null;
let playerRpg = null;

// Ha statikus tárhelyen (pl. GitHub Pages) már mentettünk új lakost vagy ház-színezést a localStorage-ba, összefésüljük:
{
  const localDb = loadLocalDb();
  if (Array.isArray(localDb.extraResidents) && localDb.extraResidents.length) {
    let migrated = false;
    const occupied = [...villageData.residents];
    for (const extra of localDb.extraResidents) {
      if (villageData.residents.some((r) => r.name.toLowerCase() === extra.name.toLowerCase())) continue;
      if (!isPlotValid(extra.x, extra.z, occupied)) {
        const validPlot = findNextPlotLocal(occupied);
        extra.x = validPlot.x;
        extra.z = validPlot.z;
        extra.rot = validPlot.rot;
        migrated = true;
      }
      occupied.push(extra);
      villageData.residents.push(extra);
    }
    if (migrated) {
      saveLocalDb(localDb);
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
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb24a);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 1, 900);
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x9ab05a, 1.1);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xfff0cf, 3.0);
sun.position.set(-90, 120, -80);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
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
const geoCache = new Map();
function cachedGeo(key, factory) {
  if (!geoCache.has(key)) {
    geoCache.set(key, factory());
  }
  return geoCache.get(key);
}
function box(w, h, d, color, x = 0, y = 0, z = 0, castShadow = false) {
  const geo = cachedGeo(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, seg = 8, castShadow = false) {
  const geo = cachedGeo(`cyl:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}
function cone(r, h, color, x = 0, y = 0, z = 0, seg = 7, castShadow = false) {
  const geo = cachedGeo(`cone:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg));
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

// --- 3. Optimalizált Környezet (InstancedMesh) & Évszak Referenciák ---
const streetLampBulbs = [];
const envRefs = {
  groundMat: null,
  groundGeo: null,
  bankMat: null,
  waterMat: null,
  roadMat: null,
  sidewalkMat: null,
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

function updateGroundSeasonColors(season) {
  if (!envRefs.groundGeo) return;
  const pos = envRefs.groundGeo.attributes.position;
  let colAttr = envRefs.groundGeo.attributes.color;
  if (!colAttr) {
    colAttr = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    envRefs.groundGeo.setAttribute('color', colAttr);
  }
  const palettes = {
    nyar: [0x6a9a48, 0x7aa34e, 0x8d9958],
    tavasz: [0x6eb54a, 0x7ec456, 0x98b366],
    osz: [0x9c8240, 0xad8f48, 0x9f8a52],
    tel: [0xe4edf5, 0xedf4fa, 0xd8e4ee],
  };
  const [lowHex, midHex, highHex] = palettes[season] || palettes.nyar;
  const cLow = new THREE.Color(lowHex);
  const cMid = new THREE.Color(midHex);
  const cHigh = new THREE.Color(highHex);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const highWeight = smoothstep(3.0, 5.8, vy + smoothstep(-24, -65, vz) * 1.2);
    const midWeight = smoothstep(0.6, 2.8, vy);
    tmp.copy(cLow).lerp(cMid, midWeight).lerp(cHigh, highWeight);
    colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
  }
  colAttr.needsUpdate = true;
}

function addTerrainSlopedSpan(targetGroup, startX, startZ, endX, endZ, width, height, elevOffset, material, stepLen = 3.5) {
  const dxTot = endX - startX;
  const dzTot = endZ - startZ;
  const horizTot = Math.hypot(dxTot, dzTot);
  if (horizTot < 0.05) return;
  const steps = Math.max(1, Math.ceil(horizTot / stepLen));
  for (let i = 0; i < steps; i++) {
    const t1 = i / steps;
    const t2 = (i + 1) / steps;
    const x1 = startX + dxTot * t1;
    const z1 = startZ + dzTot * t1;
    const x2 = startX + dxTot * t2;
    const z2 = startZ + dzTot * t2;
    const y1 = getTerrainElevation(x1, z1) + elevOffset;
    const y2 = getTerrainElevation(x2, z2) + elevOffset;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const horiz = Math.hypot(dx, dz);
    const segLen3D = Math.hypot(dx, dy, dz) + 0.04;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, segLen3D),
      material
    );
    mesh.position.set((x1 + x2) * 0.5, (y1 + y2) * 0.5, (z1 + z2) * 0.5);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Math.atan2(dx, dz);
    mesh.rotation.x = -Math.atan2(dy, horiz);
    mesh.receiveShadow = true;
    targetGroup.add(mesh);
  }
}

const trafficSignTexCache = new Map();
function getTrafficSignTexture(type) {
  if (trafficSignTexCache.has(type)) return trafficSignTexCache.get(type);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  if (type === 'speed30' || type === 'speed50') {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#d62828';
    ctx.stroke();
    ctx.fillStyle = '#1d1f23';
    ctx.font = 'bold 54px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(type === 'speed30' ? '30' : '50', 64, 67);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  trafficSignTexCache.set(type, tex);
  return tex;
}

function createTrafficSign(x, z, rotY, type) {
  const g = new THREE.Group();
  g.position.set(x, getTerrainElevation(x, z), z);
  g.rotation.y = rotY;
  // Fém oszlop
  g.add(cyl(0.055, 0.065, 2.25, 0x7b828a, 0, 1.125, 0, 8));
  const headY = 2.18;

  if (type === 'stop') {
    const rimGeo = cachedGeo('sign_stop_rim', () => new THREE.CylinderGeometry(0.36, 0.36, 0.04, 8));
    const rim = new THREE.Mesh(rimGeo, mat(0xf5f5f0));
    rim.position.set(0, headY, 0);
    rim.rotation.set(Math.PI / 2, 0, Math.PI / 8);
    const faceGeo = cachedGeo('sign_stop_face', () => new THREE.CylinderGeometry(0.31, 0.31, 0.052, 8));
    const face = new THREE.Mesh(faceGeo, mat(0xd62828));
    face.position.set(0, headY, 0);
    face.rotation.set(Math.PI / 2, 0, Math.PI / 8);
    const bar = box(0.42, 0.10, 0.065, 0xffffff, 0, headY, 0);
    g.add(rim, face, bar);
  } else if (type === 'priority') {
    const rimGeo = cachedGeo('sign_prio_rim', () => new THREE.BoxGeometry(0.54, 0.54, 0.04));
    const rim = new THREE.Mesh(rimGeo, mat(0xf5f5f0));
    rim.position.set(0, headY, 0);
    rim.rotation.z = Math.PI / 4;
    const faceGeo = cachedGeo('sign_prio_face', () => new THREE.BoxGeometry(0.45, 0.45, 0.052));
    const face = new THREE.Mesh(faceGeo, mat(0xffc312));
    face.position.set(0, headY, 0);
    face.rotation.z = Math.PI / 4;
    g.add(rim, face);
  } else if (type === 'crosswalk') {
    g.add(box(0.52, 0.52, 0.045, 0x1e5fa8, 0, headY, 0));
    const triGeo = cachedGeo('sign_cw_tri', () => new THREE.CylinderGeometry(0.22, 0.22, 0.056, 3));
    const tri = new THREE.Mesh(triGeo, mat(0xffffff));
    tri.position.set(0, headY - 0.02, 0);
    tri.rotation.x = Math.PI / 2;
    g.add(tri);
    for (const bx of [-0.075, 0, 0.075]) {
      g.add(box(0.036, 0.09, 0.064, 0x1e5fa8, bx, headY - 0.08, 0));
    }
  } else if (type === 'speed30' || type === 'speed50') {
    const discGeo = cachedGeo('sign_speed_disc', () => new THREE.CylinderGeometry(0.32, 0.32, 0.045, 16));
    const disc = new THREE.Mesh(discGeo, mat(0xd62828));
    disc.position.set(0, headY, 0);
    disc.rotation.x = Math.PI / 2;
    const faceMat = new THREE.MeshBasicMaterial({ map: getTrafficSignTexture(type), transparent: true });
    const faceGeo = cachedGeo('sign_speed_plane', () => new THREE.PlaneGeometry(0.56, 0.56));
    const front = new THREE.Mesh(faceGeo, faceMat);
    front.position.set(0, headY, 0.028);
    const back = new THREE.Mesh(faceGeo, faceMat);
    back.position.set(0, headY, -0.028);
    back.rotation.y = Math.PI;
    g.add(disc, front, back);
  }

  scene.add(g);
  return g;
}

function buildOptimizedEnvironment() {
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  envRefs.groundMat = groundMat;
  const groundGeo = new THREE.PlaneGeometry(440, 440, 140, 140);
  groundGeo.rotateX(-Math.PI / 2);
  const gPos = groundGeo.attributes.position;
  for (let i = 0; i < gPos.count; i++) {
    const vx = gPos.getX(i);
    const vz = gPos.getZ(i);
    gPos.setY(i, getTerrainElevation(vx, vz));
  }
  groundGeo.computeVertexNormals();
  envRefs.groundGeo = groundGeo;
  updateGroundSeasonColors('nyar');

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // Fejlesztői Domb (DEV_HILL) mészkő szikla-kiszögellés, támfal és kilátó korlát a folyó felőli DK-i peremen (~(-36, -29))
  {
    const devCliffGroup = new THREE.Group();
    const rockColors = [0x9f9789, 0x8e8679, 0xada494];
    const outcrops = [
      { x: -37.8, z: -28.2, sx: 2.3, sy: 2.4, sz: 1.8, drop: 1.3 },
      { x: -35.8, z: -27.8, sx: 2.5, sy: 2.8, sz: 2.0, drop: 1.5 },
      { x: -34.2, z: -27.5, sx: 2.2, sy: 2.2, sz: 1.8, drop: 1.0 },
      { x: -35.0, z: -29.0, sx: 1.9, sy: 1.8, sz: 1.5, drop: 0.9 },
      { x: -33.4, z: -28.4, sx: 1.8, sy: 1.6, sz: 1.4, drop: 0.9 },
    ];
    outcrops.forEach((o, idx) => {
      const baseY = getTerrainElevation(o.x, o.z);
      const rockMesh = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.95, 0),
        mat(rockColors[idx % rockColors.length])
      );
      rockMesh.position.set(o.x, Math.max(0.4, baseY - o.drop), o.z);
      rockMesh.scale.set(o.sx, o.sy, o.sz);
      rockMesh.rotation.set(0.2 * idx, idx * 1.1, 0.15);
      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;
      devCliffGroup.add(rockMesh);
    });

    const rimPoints = [
      [-37.8, -29.0],
      [-36.2, -28.8],
      [-34.8, -29.2],
      [-33.6, -30.0],
    ];
    for (let i = 0; i < rimPoints.length - 1; i++) {
      const [ax, az] = rimPoints[i];
      const [bx, bz] = rimPoints[i + 1];
      const ay = getTerrainElevation(ax, az);
      const by = getTerrainElevation(bx, bz);
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      const my = (ay + by) * 0.5;
      const segLen = Math.hypot(bx - ax, bz - az) + 0.08;
      const yaw = Math.atan2(bx - ax, bz - az);

      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.35, segLen), mat(0x9b9284));
      wall.position.set(mx, my - 0.35, mz);
      wall.rotation.y = yaw;
      wall.castShadow = true;
      wall.receiveShadow = true;
      devCliffGroup.add(wall);

      const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.10, segLen), mat(0x5a3a22));
      topRail.position.set(mx, my + 0.96, mz);
      topRail.rotation.order = 'YXZ';
      topRail.rotation.y = yaw;
      topRail.rotation.x = -Math.atan2(by - ay, Math.hypot(bx - ax, bz - az));
      topRail.castShadow = true;
      devCliffGroup.add(topRail);

      const midRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, segLen), mat(0x6e472a));
      midRail.position.set(mx, my + 0.62, mz);
      midRail.rotation.order = 'YXZ';
      midRail.rotation.y = yaw;
      midRail.rotation.x = topRail.rotation.x;
      devCliffGroup.add(midRail);
    }
    for (const [px, pz] of rimPoints) {
      const py = getTerrainElevation(px, pz);
      devCliffGroup.add(box(0.14, 0.95, 0.14, 0x4a2e16, px, py + 0.52, pz, true));
    }
    scene.add(devCliffGroup);
  }

  const bankMat = new THREE.MeshLambertMaterial({ color: 0xd5c295, flatShading: true });
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x4ea5d9, flatShading: true });
  envRefs.bankMat = bankMat;
  envRefs.waterMat = waterMat;

  const dummy = new THREE.Object3D();
  const riverSegs = 110;
  const bankInst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(4.4, 0.06, RIVER_HALF_WIDTH * 2 + 1.8),
    bankMat,
    riverSegs
  );
  bankInst.receiveShadow = true;
  const waterInst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(4.4, 0.12, RIVER_HALF_WIDTH * 2),
    waterMat,
    riverSegs
  );
  waterInst.receiveShadow = true;

  for (let i = 0; i < riverSegs; i++) {
    const x1 = -220 + (i / riverSegs) * 440;
    const x2 = -220 + ((i + 1) / riverSegs) * 440;
    const xm = (x1 + x2) / 2;
    const zm = riverZ(xm);
    const angle = Math.atan2(riverZ(x2) - riverZ(x1), x2 - x1);

    dummy.scale.set(1, 1, 1);
    dummy.rotation.set(0, -angle, 0);
    dummy.position.set(xm, 0.01, zm);
    dummy.updateMatrix();
    bankInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(xm, 0.03, zm);
    dummy.updateMatrix();
    waterInst.setMatrixAt(i, dummy.matrix);
  }
  bankInst.instanceMatrix.needsUpdate = true;
  waterInst.instanceMatrix.needsUpdate = true;
  scene.add(bankInst, waterInst);

  // 1. Városi 2 sávos domborzat-követő aszfalt úthálózat és járdák (buildRoadSystem)
  const asphaltMat = new THREE.MeshLambertMaterial({ color: 0x3e4248, flatShading: true });
  envRefs.roadMat = asphaltMat;
  const sidewalkMat = new THREE.MeshLambertMaterial({ color: 0xd2cab8, flatShading: true });
  envRefs.sidewalkMat = sidewalkMat;
  const curbMat = mat(0x9e978b);

  function buildRoadSystem() {
    const roadGroup = new THREE.Group();
    const vertexCounts = new Map();
    const recordVertex = (x, z) => {
      const k = `${Math.round(x * 10)}_${Math.round(z * 10)}`;
      const prev = vertexCounts.get(k);
      if (prev) prev.count++;
      else vertexCounts.set(k, { x, z, count: 1 });
    };

    for (const r of VILLAGE_ROADS) {
      addTerrainSlopedSpan(roadGroup, r.x1, r.z1, r.x2, r.z2, r.width, 0.06, 0.03, asphaltMat, 3.5);
      recordVertex(r.x1, r.z1);
      recordVertex(r.x2, r.z2);
    }

    const capGeo = cachedGeo(`road_cap:${CAR_ROAD_WIDTH}`, () => new THREE.CylinderGeometry(CAR_ROAD_WIDTH / 2, CAR_ROAD_WIDTH / 2, 0.06, 16));
    for (const v of vertexCounts.values()) {
      const cap = new THREE.Mesh(capGeo, asphaltMat);
      cap.position.set(v.x, getTerrainElevation(v.x, v.z) + 0.03, v.z);
      cap.receiveShadow = true;
      roadGroup.add(cap);
    }

    // 2. Emelt domborzat-követő járdák szegélykővel + zárókorongokkal
    const swCapGeo = cachedGeo(`sw_cap:${SIDEWALK_WIDTH}`, () => new THREE.CylinderGeometry(SIDEWALK_WIDTH / 2, SIDEWALK_WIDTH / 2, 0.09, 12));
    const swEndpoints = new Map();
    const recordSwEnd = (x, z) => {
      const k = `${Math.round(x * 10)}_${Math.round(z * 10)}`;
      if (!swEndpoints.has(k)) swEndpoints.set(k, { x, z });
    };

    for (const seg of SIDEWALK_SEGMENTS) {
      addTerrainSlopedSpan(roadGroup, seg.x1, seg.z1, seg.x2, seg.z2, SIDEWALK_WIDTH, 0.09, 0.045, sidewalkMat, 3.5);
      const curbShift = -seg.side * (SIDEWALK_WIDTH / 2 - 0.04);
      addTerrainSlopedSpan(
        roadGroup,
        seg.x1 + seg.nx * curbShift,
        seg.z1 + seg.nz * curbShift,
        seg.x2 + seg.nx * curbShift,
        seg.z2 + seg.nz * curbShift,
        0.08,
        0.10,
        0.05,
        curbMat,
        3.5
      );
      recordSwEnd(seg.x1, seg.z1);
      recordSwEnd(seg.x2, seg.z2);
    }

    // Kanyarok külső ívén maradt apró járdahézagok áthidalása
    for (let i = 0; i < SIDEWALK_SEGMENTS.length; i++) {
      const a = SIDEWALK_SEGMENTS[i];
      for (let j = i + 1; j < SIDEWALK_SEGMENTS.length; j++) {
        const b = SIDEWALK_SEGMENTS[j];
        if (a.chainId !== b.chainId || a.side !== b.side) continue;
        if (Math.abs(a.segIndex - b.segIndex) !== 1) continue;
        const pairs = [
          [a.x2, a.z2, b.x1, b.z1],
          [b.x2, b.z2, a.x1, a.z1],
        ];
        for (const [px1, pz1, px2, pz2] of pairs) {
          const gap = Math.hypot(px2 - px1, pz2 - pz1);
          if (gap > 0.08 && gap < 2.6 && isSidewalkPointClear((px1 + px2) * 0.5, (pz1 + pz2) * 0.5, null)) {
            addTerrainSlopedSpan(roadGroup, px1, pz1, px2, pz2, SIDEWALK_WIDTH, 0.09, 0.045, sidewalkMat, 2.0);
          }
        }
      }
    }

    for (const ep of swEndpoints.values()) {
      const swCap = new THREE.Mesh(swCapGeo, sidewalkMat);
      swCap.position.set(ep.x, getTerrainElevation(ep.x, ep.z) + 0.045, ep.z);
      swCap.receiveShadow = true;
      roadGroup.add(swCap);
    }

    scene.add(roadGroup);

    // 3. Fehér szaggatott felezőcsíkok az úttengelyen (csomópontok kikerülésével)
    const junctionPts = [];
    for (const v of vertexCounts.values()) {
      if (v.count >= 3) junctionPts.push(v);
    }
    const dashPlacements = [];
    for (const r of VILLAGE_ROADS) {
      const dx = r.x2 - r.x1;
      const dz = r.z2 - r.z1;
      const len = Math.hypot(dx, dz);
      if (len < 1.2) continue;
      const ux = dx / len;
      const uz = dz / len;
      const yaw = Math.atan2(dx, dz);

      for (let t = 1.25; t <= len - 1.1; t += 2.2) {
        const wx = r.x1 + ux * t;
        const wz = r.z1 + uz * t;
        if (junctionPts.some((jv) => Math.hypot(wx - jv.x, wz - jv.z) < 2.8)) continue;
        if (wz > -9.2 && wz < -6.8 && Math.abs(wx) < 1.5) continue;
        if (wz < -19.0 && wz > -21.5 && Math.abs(wx) < 1.5) continue;
        const y0 = getTerrainElevation(wx - ux * 0.4, wz - uz * 0.4);
        const y1 = getTerrainElevation(wx + ux * 0.4, wz + uz * 0.4);
        const yMid = getTerrainElevation(wx, wz);
        dashPlacements.push({
          x: wx,
          y: yMid + 0.064,
          z: wz,
          yaw,
          pitch: -Math.atan2(y1 - y0, 0.8),
        });
      }
    }
    if (dashPlacements.length) {
      const dashInst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.14, 0.014, 1.1),
        mat(0xf2f2ec),
        dashPlacements.length
      );
      dashInst.receiveShadow = true;
      dashPlacements.forEach((d, idx) => {
        dummy.scale.set(1, 1, 1);
        dummy.position.set(d.x, d.y, d.z);
        dummy.rotation.order = 'YXZ';
        dummy.rotation.set(d.pitch, d.yaw, 0);
        dummy.updateMatrix();
        dashInst.setMatrixAt(idx, dummy.matrix);
      });
      dashInst.instanceMatrix.needsUpdate = true;
      scene.add(dashInst);
      dummy.rotation.order = 'XYZ';
    }
  }
  buildRoadSystem();

  // 4. Gyalogos átkelőhelyek (Zebrák) domborzathoz igazítva
  const CROSSWALKS = [
    { x: 0, z: -7.6, rot: 0 },
    { x: 0, z: -20.4, rot: 0 },
    { x: 0, z: -2.9, rot: 0 },
    { x: -2.9, z: 0, rot: Math.PI / 2 },
    { x: 2.9, z: 0, rot: Math.PI / 2 },
    { x: -14, z: 2.9, rot: 0 },
    { x: 14, z: 2.9, rot: 0 },
    { x: 0, z: 27.9, rot: 0 },
    { x: -2.9, z: 25, rot: Math.PI / 2 },
    { x: 2.9, z: 25, rot: Math.PI / 2 },
    { x: 0, z: 43.1, rot: 0 },
    { x: 0, z: 48.9, rot: 0 },
    { x: 2.9, z: -29, rot: Math.PI / 2 },
    { x: -2.9, z: -36, rot: Math.PI / 2 },
    { x: -20.4, z: -38.4, rot: Math.atan2(10, -7) },
  ];
  const zebraOffsets = [-1.75, -1.05, -0.35, 0.35, 1.05, 1.75];
  const zebraInst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.32, 0.02, 1.4),
    mat(0xf5f5f0),
    CROSSWALKS.length * zebraOffsets.length
  );
  zebraInst.receiveShadow = true;
  let zIdx = 0;
  for (const cw of CROSSWALKS) {
    const cosR = Math.cos(cw.rot);
    const sinR = Math.sin(cw.rot);
    for (const lx of zebraOffsets) {
      const sx = cw.x + cosR * lx;
      const sz = cw.z - sinR * lx;
      const sy = getTerrainElevation(sx, sz) + 0.068;
      dummy.scale.set(1, 1, 1);
      dummy.position.set(sx, sy, sz);
      dummy.rotation.set(0, cw.rot, 0);
      dummy.updateMatrix();
      zebraInst.setMatrixAt(zIdx++, dummy.matrix);
    }
  }
  zebraInst.instanceMatrix.needsUpdate = true;
  scene.add(zebraInst);

  // 5. 3D Közlekedési táblák (STOP, Főútvonal, Zebra, Sebességkorlátozás) — domborzaton
  createTrafficSign(-10.8, 3.6, -Math.PI / 2, 'stop');
  createTrafficSign(10.8, 3.6, Math.PI / 2, 'stop');
  createTrafficSign(-3.6, 28.4, -Math.PI / 2, 'stop');
  createTrafficSign(3.6, 49.4, Math.PI / 2, 'stop');
  createTrafficSign(-3.6, -26.2, -Math.PI / 2, 'stop');
  createTrafficSign(3.6, -32.2, Math.PI / 2, 'priority');

  createTrafficSign(3.4, -22.2, 0, 'priority');
  createTrafficSign(-3.4, -7.2, Math.PI, 'crosswalk');
  createTrafficSign(3.4, -7.2, 0, 'crosswalk');
  createTrafficSign(-3.4, -20.8, Math.PI, 'crosswalk');
  createTrafficSign(-5.8, 3.4, Math.PI / 2, 'crosswalk');

  createTrafficSign(-8.0, 3.5, Math.PI / 2, 'speed30');
  createTrafficSign(8.0, -3.5, -Math.PI / 2, 'speed30');
  createTrafficSign(3.5, -24.5, Math.PI, 'speed50');

  // Díszítőelemek a Kocsma sörkertje mellett (utaktól biztonságos távolságban, domborzaton)
  const addDecorProp = (x, z, type = 'barrel') => {
    const gy = getTerrainElevation(x, z);
    if (type === 'barrel') {
      const b = cyl(0.32, 0.38, 0.82, 0x6e472a, x, gy + 0.41, z, 8);
      scene.add(b);
    } else {
      const c = box(0.7, 0.6, 0.7, 0x8a5a33, x, gy + 0.3, z);
      scene.add(c);
    }
  };
  addDecorProp(22.2, 6.4, 'barrel');
  addDecorProp(21.5, 6.8, 'crate');
  addDecorProp(29.8, 6.4, 'barrel');
  addDecorProp(30.5, 6.8, 'crate');

  // Közvilágítási lámpaoszlopok szigorúan a járda külső szélén, domborzatra ültetve
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0x555045 });
  streetLampBulbs.push(bulbMat);
  const placedLampPts = [];
  for (let i = 0; i < SIDEWALK_SEGMENTS.length; i++) {
    const seg = SIDEWALK_SEGMENTS[i];
    if (seg.len < 6.5) continue;
    const countOnSeg = Math.max(1, Math.floor(seg.len / 22));
    for (let k = 0; k < countOnSeg; k++) {
      const u = (k + 0.5) / countOnSeg;
      const mx = seg.x1 + (seg.x2 - seg.x1) * u;
      const mz = seg.z1 + (seg.z2 - seg.z1) * u;
      const outShift = seg.side * (SIDEWALK_WIDTH * 0.5 + 0.16);
      const lx = mx + seg.nx * outShift;
      const lz = mz + seg.nz * outShift;
      if (getClosestPointOnRoads(lx, lz).dist < CAR_ROAD_WIDTH * 0.5 + 0.8) continue;
      if (placedLampPts.some((lp) => Math.hypot(lp[0] - lx, lp[1] - lz) < 13.5)) continue;
      placedLampPts.push([lx, lz]);

      const lamp = new THREE.Group();
      lamp.add(cyl(0.08, 0.11, 3.2, 0x3b2a1a, 0, 1.6, 0, 6));
      lamp.add(box(0.6, 0.08, 0.08, 0x3b2a1a, -seg.side * 0.25, 3.15, 0));
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.32), bulbMat);
      lantern.position.set(-seg.side * 0.5, 2.9, 0);
      lamp.add(lantern);
      lamp.rotation.y = Math.atan2(seg.ux, seg.uz) - Math.PI / 2;
      lamp.position.set(lx, getTerrainElevation(lx, lz), lz);
      scene.add(lamp);
    }
  }

  const colorHelper = new THREE.Color();
  const allOccupiedPlots = [
    ...(villageData?.residents || []),
    ...CANONICAL_RESIDENT_COORDS,
    ...STREET_PLOTS,
  ];

  const isSpotFree = (x, z) => {
    if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 2.6) return false;
    if (getClosestPointOnRoads(x, z).dist < 4.8) return false;
    for (const p of Object.values(PLACES)) {
      if (Math.hypot(x - p.x, z - p.z) < p.r + 5.5) return false;
    }
    for (const h of allOccupiedPlots) {
      if (Math.hypot(x - h.x, z - h.z) < 6.0) return false;
    }
    return true;
  };

  const treeCoords = [];
  for (let i = 0; i < 240; i++) {
    const a = hash(`t_${i}`, 1) * Math.PI * 2;
    const d = i < 55 ? 10 + hash(`t_${i}`, 2) * 32 : 56 + hash(`t_${i}`, 2) * 95;
    const x = (i < 55 ? -44 : 0) + Math.cos(a) * d;
    const z = (i < 55 ? -40 : 0) + Math.sin(a) * d;
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
    const gy = getTerrainElevation(t.x, t.z);
    dummy.position.set(t.x, gy + 0.8 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.set(0, t.shade * 6, 0);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
  });
  deciduousCoords.forEach((t, i) => {
    const gy = getTerrainElevation(t.x, t.z);
    dummy.position.set(t.x, gy + 2.2 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.set(0, t.shade * 6, 0);
    dummy.updateMatrix();
    crownInst.setMatrixAt(i, dummy.matrix);
    crownInst.setColorAt(i, colorHelper.setHex(t.shade > 0.5 ? 0x5c8c38 : 0x6e9e42));
  });
  pineCoords.forEach((t, i) => {
    const gy = getTerrainElevation(t.x, t.z);
    dummy.position.set(t.x, gy + 2.6 * t.scale, t.z);
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
    const gy = Math.max(0, getTerrainElevation(rx, rz));
    dummy.position.set(rx, gy + 0.2 * s, rz);
    dummy.scale.set(s * 1.2, s * 0.7, s);
    dummy.rotation.set(0, hash(`r_${i}`, 4) * 6, 0);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
    envRefs.rocks.push({ x: rx, z: rz, radius: s * 1.15, height: gy + 0.32 * s });
  }
  scene.add(rockInst);

  // Utcai és zöldsávos bokrok (Bushes) — szigorúan távol az aszfalttól, járdáktól és udvaroktól
  const isBushSpotOk = (bx, bz) => {
    if (Math.abs(bz - riverZ(bx)) <= RIVER_HALF_WIDTH + 1.6) return false;
    if (getClosestPointOnRoads(bx, bz).dist < 4.2) return false;
    for (const p of Object.values(PLACES)) {
      if (Math.hypot(bx - p.x, bz - p.z) < p.r + 1.1) return false;
    }
    for (const h of allOccupiedPlots) {
      if (Math.hypot(bx - h.x, bz - h.z) < 4.8) return false;
      const rot = h.rot || 0;
      const frontX = h.x + Math.sin(rot) * 4.5;
      const frontZ = h.z + Math.cos(rot) * 4.5;
      if (Math.hypot(bx - frontX, bz - frontZ) < 3.0) return false;
    }
    return true;
  };

  const bushCoords = [];
  for (let i = 0; i < VILLAGE_ROADS.length; i++) {
    const r = VILLAGE_ROADS[i];
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz);
    if (len < 3.0) continue;
    const steps = Math.floor(len / 7.0);
    const nx = -dz / len;
    const nz = dx / len;
    for (let s = 1; s <= steps; s++) {
      const u = s / (steps + 1);
      const mx = r.x1 + dx * u;
      const mz = r.z1 + dz * u;
      const side = (s % 2 === 0 ? 1 : -1);
      const offset = r.width / 2 + 2.0 + hash(`bs_${i}_${s}`, 1) * 0.6;
      const bx = mx + nx * side * offset;
      const bz = mz + nz * side * offset;
      if (isBushSpotOk(bx, bz)) {
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
    const a = (i / 14) * Math.PI * 2 + 0.25;
    const bx = PLACES.tuz.x + Math.cos(a) * 5.9;
    const bz = PLACES.tuz.z + Math.sin(a) * 5.9;
    if (Math.hypot(bx - PLACES.uzenotabla.x, bz - PLACES.uzenotabla.z) < 1.8) continue;
    if (Math.abs(bx) < 1.6) continue;
    if (getClosestPointOnRoads(bx, bz).dist >= 4.2) {
      bushCoords.push({
        x: bx,
        z: bz,
        scale: 0.6 + hash(`fbs_${i}`, 1) * 0.4,
        shade: hash(`fbs_${i}`, 2),
      });
    }
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
    const gy = getTerrainElevation(b.x, b.z);
    dummy.position.set(b.x, gy + 0.45 * b.scale, b.z);
    dummy.scale.set(b.scale * 1.15, b.scale * 0.85, b.scale);
    dummy.rotation.set(0, b.shade * 6, 0);
    dummy.updateMatrix();
    bushInst.setMatrixAt(i, dummy.matrix);
    bushInst.setColorAt(i, colorHelper.setHex(b.shade > 0.5 ? 0x48732e : 0x588835));
  });
  scene.add(bushInst);

  // Gazdag virágmezők (utak, járdák, házak és nevezetes épületek kikerülésével)
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
    const valid =
      Math.abs(fz - riverZ(fx)) >= RIVER_HALF_WIDTH + 1.5 &&
      getClosestPointOnRoads(fx, fz).dist >= 4.8 &&
      Object.values(PLACES).every((p) => Math.hypot(fx - p.x, fz - p.z) > p.r + 1.5) &&
      allOccupiedPlots.every((h) => Math.hypot(fx - h.x, fz - h.z) >= 4.8);
    envRefs.flowerValid.push(valid);
    if (!valid) {
      dummy.scale.setScalar(0);
    } else {
      const gy = getTerrainElevation(fx, fz);
      dummy.position.set(fx, gy + 0.22, fz);
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
  const p = PLACES[key];
  const baseY = (key === 'hid' || key === 'steg') ? 0 : getTerrainElevation(p.x, p.z);
  const picker = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 2, height, radius * 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  picker.position.set(p.x, baseY + height / 2, p.z);
  picker.userData.placeKey = key;
  scene.add(picker);
  landmarkPickers.push(picker);
}

// 4.1 A Főtér (Tavasztól őszig díszkút, Télen Karácsonyfa + Tábortűz és Bogrács!)
{
  const g = new THREE.Group();
  g.position.set(PLACES.tuz.x, getTerrainElevation(PLACES.tuz.x, PLACES.tuz.z), PLACES.tuz.z);

  // Macskaköves Főtér burkolat (kör alakú díszburkolat és sétánygyűrű)
  const plazaOuter = cyl(4.8, 4.9, 0.1, 0x9b9286, 0, 0.05, 0, 24);
  const plazaInner = cyl(3.7, 3.7, 0.12, 0xb5aba0, 0, 0.06, 0, 20);
  const promenadeRing = new THREE.Mesh(
    new THREE.RingGeometry(2.3, 3.4, 24),
    mat(0xa89f93)
  );
  promenadeRing.rotation.x = -Math.PI / 2;
  promenadeRing.position.y = 0.125;
  promenadeRing.receiveShadow = true;
  g.add(plazaOuter, plazaInner, promenadeRing);

  // Főteret a közeli járdákkal összekötő domborzat-követő gyalogos sétányok
  const plazaWalkways = new THREE.Group();
  const walkSurfaceMat = envRefs.sidewalkMat || mat(0xd2cab8);
  const walkCurbMat = mat(0x9e978b);
  for (const [z1, z2] of [[2.85, 6.2], [15.8, 22.15]]) {
    addTerrainSlopedSpan(plazaWalkways, 0, z1, 0, z2, 2.1, 0.08, 0.04, walkSurfaceMat, 1.5);
    addTerrainSlopedSpan(plazaWalkways, -1.05, z1, -1.05, z2, 0.08, 0.10, 0.05, walkCurbMat, 1.5);
    addTerrainSlopedSpan(plazaWalkways, 1.05, z1, 1.05, z2, 0.08, 0.10, 0.05, walkCurbMat, 1.5);
  }
  scene.add(plazaWalkways);

  // Padok a Főtér átlós sarkaiban (szabadon hagyva a 4 befutó útvonalat és a peremjárdát)
  const FOTER_BENCH_ANGLES = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
  for (const a of FOTER_BENCH_ANGLES) {
    const bench = box(1.65, 0.38, 0.48, 0x74482a, Math.cos(a) * 3.25, 0.22, Math.sin(a) * 3.25);
    bench.rotation.y = -a + Math.PI / 2;
    g.add(bench);
  }

  // A) Tavasz / Nyár / Ősz: Díszes kőkút a Főtér közepén
  foterRegularGroup = new THREE.Group();
  foterRegularGroup.add(cyl(1.45, 1.55, 0.48, 0x8b857c, 0, 0.28, 0, 12, true));
  foterRegularGroup.add(cyl(1.2, 1.2, 0.44, 0x4ea5d9, 0, 0.32, 0, 12));
  foterRegularGroup.add(cyl(0.28, 0.36, 1.65, 0x8b857c, 0, 1.0, 0, 8, true));
  foterRegularGroup.add(cyl(0.68, 0.38, 0.26, 0x8b857c, 0, 1.75, 0, 10, true));
  foterRegularGroup.add(cone(0.28, 0.55, 0x88d4ff, 0, 2.1, 0, 8));
  g.add(foterRegularGroup);

  // B) Téli Főtér (Havas tájon): Karácsonyfa + Tábortűz és Bogrács!
  foterWinterGroup = new THREE.Group();
  foterWinterGroup.visible = false;

  // 1) Karácsonyfa a Főtér bal-hátsó részén (-1.25, 0, -0.85)
  const xmasTree = new THREE.Group();
  xmasTree.position.set(-1.25, 0.08, -0.85);
  xmasTree.add(cyl(0.28, 0.36, 1.2, 0x5a3a22, 0, 0.6, 0, 8, true));
  xmasTree.add(cone(1.9, 2.0, 0x225c36, 0, 1.6, 0, 9, true));
  xmasTree.add(cone(1.55, 1.8, 0x2a6f42, 0, 2.65, 0, 9, true));
  xmasTree.add(cone(1.18, 1.5, 0x225c36, 0, 3.6, 0, 9, true));
  xmasTree.add(cone(0.78, 1.2, 0x2a6f42, 0, 4.4, 0, 9, true));

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

// 4.1b Üres Főtéri Üzenőtábla (Fa közösségi hirdetőtábla kis zsindelyes tetővel)
{
  const boardG = new THREE.Group();
  const bx = PLACES.uzenotabla.x;
  const bz = PLACES.uzenotabla.z;
  boardG.position.set(bx, getTerrainElevation(bx, bz), bz);
  boardG.rotation.y = Math.atan2(PLACES.tuz.x - bx, PLACES.tuz.z - bz);

  boardG.add(cyl(0.08, 0.09, 2.2, 0x5a3a22, -0.78, 1.1, 0, 7, true));
  boardG.add(cyl(0.08, 0.09, 2.2, 0x5a3a22, 0.78, 1.1, 0, 7, true));
  boardG.add(cyl(0.14, 0.16, 0.16, 0x7a7267, -0.78, 0.08, 0, 6));
  boardG.add(cyl(0.14, 0.16, 0.16, 0x7a7267, 0.78, 0.08, 0, 6));
  boardG.add(box(1.75, 1.15, 0.10, 0x74482a, 0, 1.48, 0, true));
  boardG.add(box(1.52, 0.92, 0.04, 0xd8be94, 0, 1.48, 0.05));
  boardG.add(box(1.40, 0.13, 0.05, 0x4a2f18, 0, 1.85, 0.06));
  const roofFront = box(2.05, 0.08, 0.44, 0x8c3b2b, 0, 2.18, 0.15, true);
  roofFront.rotation.x = 0.46;
  const roofBack = box(2.05, 0.08, 0.44, 0x8c3b2b, 0, 2.18, -0.15, true);
  roofBack.rotation.x = -0.46;
  boardG.add(roofFront, roofBack);
  boardG.add(box(2.08, 0.10, 0.12, 0x5a3a22, 0, 2.28, 0));

  registerLandmark('uzenotabla', boardG, 1.5, 2.8);
}

// 4.2 2 Sávos Közúti + Gyalogos Híd
{
  const g = new THREE.Group();
  const len = BRIDGE.southZ - BRIDGE.northZ;
  g.position.set(BRIDGE.x, 0, (BRIDGE.southZ + BRIDGE.northZ) / 2);

  // Tartószerkezet és hídfők
  g.add(box(6.8, 0.34, len, 0x7c5130, 0, 0.36, 0, true));
  for (const px of [-2.9, 2.9]) {
    for (const pz of [-3.6, 3.6]) {
      g.add(cyl(0.24, 0.28, 0.9, 0x5a3a22, px, 0.1, pz, 8));
    }
  }

  // Középső 4.6m-es 2 sávos sötét aszfalt úttest (top y = 0.56)
  const bridgeRoad = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_ROAD_WIDTH, 0.06, len),
    envRefs.roadMat || mat(0x3e4248)
  );
  bridgeRoad.position.set(0, 0.53, 0);
  bridgeRoad.receiveShadow = true;
  g.add(bridgeRoad);

  // Szaggatott fehér felezővonal a hídon
  for (let bz = -len / 2 + 1.25; bz <= len / 2 - 1.1; bz += 2.2) {
    g.add(box(0.14, 0.014, 1.1, 0xf2f2ec, 0, 0.566, bz));
  }

  // Kétoldali 1.1m széles emelt gyalogos járdák (x = ±2.85, top y = 0.62) és korlát (x = ±3.38)
  for (const side of [-1, 1]) {
    const sw = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.12, len),
      envRefs.sidewalkMat || mat(0xd2cab8)
    );
    sw.position.set(side * SIDEWALK_OFFSET, 0.56, 0);
    sw.receiveShadow = true;
    g.add(sw);

    const railX = side * 3.38;
    g.add(box(0.12, 0.10, len, 0x5a3a22, railX, 1.28, 0));
    g.add(box(0.08, 0.08, len, 0x6e472a, railX, 0.95, 0));
    for (let z = -len / 2 + 0.4; z <= len / 2 - 0.3; z += 2.04) {
      g.add(box(0.14, 0.78, 0.14, 0x5a3a22, railX, 0.92, z));
    }
  }

  // Finom feljáró rámpák a híd két végén (y: 0.08 -> 0.56/0.62)
  for (const endSign of [-1, 1]) {
    const rampRoad = new THREE.Mesh(
      new THREE.BoxGeometry(CAR_ROAD_WIDTH, 0.08, 0.62),
      envRefs.roadMat || mat(0x3e4248)
    );
    rampRoad.position.set(0, 0.30, endSign * (len / 2 + 0.22));
    rampRoad.rotation.x = endSign * 0.72;
    rampRoad.receiveShadow = true;
    g.add(rampRoad);
    for (const side of [-1, 1]) {
      const rampSw = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.08, 0.62),
        envRefs.sidewalkMat || mat(0xd2cab8)
      );
      rampSw.position.set(side * SIDEWALK_OFFSET, 0.34, endSign * (len / 2 + 0.22));
      rampSw.rotation.x = endSign * 0.76;
      rampSw.receiveShadow = true;
      g.add(rampSw);
    }
  }

  registerLandmark('hid', g, 3.4, 2.5);
}

// 4.3 Kocsma (A Falusi Kocsma tágas sörkerttel és sétánnyal a falu utcája mellett)
{
  const g = new THREE.Group();
  const baseY = getTerrainElevation(PLACES.kocsma.x, PLACES.kocsma.z);
  g.position.set(PLACES.kocsma.x, baseY, PLACES.kocsma.z);
  g.add(box(7.35, 1.1, 5.55, 0x8b8378, 0, -0.5, 0, true));
  g.add(box(7.2, 2.8, 5.4, 0xf2e8cf, 0, 1.4, 0, true));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 2.6, 4), mat(0x9e3b24));
  roof.position.set(0, 4.1, 0);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);

  // Bejárati ajtó (észak felé, a bevezető sétány és a korzó felé nézve)
  g.add(box(1.2, 1.9, 0.15, 0x5a3a22, 0, 0.95, -2.72));

  // Tágas sörkert kinti fa asztalokkal és padokkal az utca és a kocsma között
  const patioRelY = getTerrainElevation(PLACES.kocsma.x, PLACES.kocsma.z - 3.5) - baseY;
  for (const dx of [-2.4, 2.4]) {
    const tblDy = getTerrainElevation(PLACES.kocsma.x + dx, PLACES.kocsma.z - 4.2) - baseY;
    g.add(box(1.8, 0.6, 0.9, 0x8a5a33, dx, tblDy + 0.3, -4.2));
    g.add(box(1.6, 0.35, 0.35, 0x5a3a22, dx, tblDy + 0.18, -4.9));
    g.add(box(1.6, 0.35, 0.35, 0x5a3a22, dx, tblDy + 0.18, -3.5));
  }
  // Boros és sörös hordók
  g.add(cyl(0.45, 0.45, 1.0, 0x6b4423, -3.0, 0.5, -2.9, 8));
  g.add(cyl(0.38, 0.38, 0.85, 0x6b4423, -3.7, 0.42, -2.7, 8));

  // Sörkert kövezett alapja (lejtőre illesztett alaptesttel)
  const patio = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.42, 5.8), mat(0xd5c8af));
  patio.position.set(0, patioRelY - 0.16, -3.5);
  patio.receiveShadow = true;
  g.add(patio);

  registerLandmark('kocsma', g, 4.5, 5.5);
}

// 4.4 Vadászház (Erdei vadásztábor céltáblákkal, tábortűzzel és fa rakásokkal)
{
  const g = new THREE.Group();
  const baseY = getTerrainElevation(PLACES.vadaszhaz.x, PLACES.vadaszhaz.z);
  g.position.set(PLACES.vadaszhaz.x, baseY, PLACES.vadaszhaz.z);
  g.add(box(6.18, 1.3, 4.98, 0x6f675d, 0, -0.6, 0, true));
  g.add(box(6.0, 2.5, 4.8, 0x74482a, 0, 1.25, 0, true));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.8, 2.4, 4), mat(0x3b5e3c));
  roof.position.set(0, 3.7, 0);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);

  // Bejárati ajtó és veranda
  g.add(box(1.0, 1.8, 0.12, 0x4a2e16, 0, 0.9, 2.42));
  const porchRoof = box(3.2, 0.15, 1.4, 0x3b5e3c, 0, 2.2, 3.0);
  porchRoof.rotation.x = 0.12;
  const pillarL = cyl(0.08, 0.08, 2.5, 0x4a2e16, -1.4, 0.85, 3.5);
  const pillarR = cyl(0.08, 0.08, 2.5, 0x4a2e16, 1.4, 0.85, 3.5);
  g.add(porchRoof, pillarL, pillarR);

  // Céltábla (Archery Target) a vadászathoz (helyi domborzatra ültetve)
  const tgtDy = getTerrainElevation(PLACES.vadaszhaz.x + 4.5, PLACES.vadaszhaz.z + 1.0) - baseY;
  const targetPost = cyl(0.08, 0.08, 2.0, 0x4a2e16, 4.5, tgtDy + 1.0, 1.0);
  const targetStraw = cyl(0.65, 0.65, 0.12, 0xd4a373, 4.5, tgtDy + 1.3, 1.0);
  targetStraw.rotation.x = Math.PI / 2;
  const targetRing = cyl(0.42, 0.42, 0.13, 0xc8343a, 4.5, tgtDy + 1.3, 1.0);
  targetRing.rotation.x = Math.PI / 2;
  const targetBull = cyl(0.18, 0.18, 0.14, 0xffd166, 4.5, tgtDy + 1.3, 1.0);
  targetBull.rotation.x = Math.PI / 2;
  g.add(targetPost, targetStraw, targetRing, targetBull);

  // Felaprított fa rakatok (Firewood)
  const woodDy = getTerrainElevation(PLACES.vadaszhaz.x - 3.8, PLACES.vadaszhaz.z + 0.8) - baseY;
  for (let i = 0; i < 4; i++) {
    const log = cyl(0.22, 0.22, 2.2, 0x9a6a3c, -3.8, woodDy + 0.22 + i * 0.38, 0.8, 6);
    log.rotation.x = Math.PI / 2;
    g.add(log);
  }

  // Vadászati útjelző tábla
  const signDy = getTerrainElevation(PLACES.vadaszhaz.x - 3.2, PLACES.vadaszhaz.z + 3.2) - baseY;
  const signpost = box(0.9, 0.22, 0.06, 0x7c4f2a, -3.2, signDy + 1.6, 3.2);
  signpost.rotation.y = 0.35;
  g.add(cyl(0.08, 0.08, 1.8, 0x4a2e16, -3.2, signDy + 0.9, 3.2), signpost);

  registerLandmark('vadaszhaz', g, 4.2, 5.0);
}

// 4.5 Piac
{
  const g = new THREE.Group();
  const baseY = getTerrainElevation(PLACES.piac.x, PLACES.piac.z);
  g.position.set(PLACES.piac.x, baseY, PLACES.piac.z);
  const colors = [0xc8343a, 0xd99b26, 0x3f7350];
  [-3.2, 0, 3.2].forEach((dx, i) => {
    const dy = getTerrainElevation(PLACES.piac.x + dx, PLACES.piac.z - 1.5) - baseY;
    g.add(box(2.4, 0.9, 1.4, 0x8a5a33, dx, dy + 0.45, -1.5, true));
    g.add(box(2.6, 0.25, 1.8, colors[i], dx, dy + 2.1, -1.5, true));
    for (const sx of [-1.05, 1.05]) {
      g.add(box(0.1, 2.0, 0.1, 0x5a3a22, dx + sx, dy + 1.05, -2.1));
      g.add(box(0.1, 2.0, 0.1, 0x5a3a22, dx + sx, dy + 1.05, -0.9));
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
  const baseY = getTerrainElevation(PLACES.malom.x, PLACES.malom.z);
  g.position.set(PLACES.malom.x, baseY, PLACES.malom.z);
  g.add(cyl(2.5, 2.75, 1.0, 0x7c746a, 0, -0.45, 0, 8, true));
  g.add(cyl(1.7, 2.4, 6.2, 0xf3ead6, 0, 3.1, 0, 8, true));
  g.add(cone(2.0, 1.8, 0x8c4a27, 0, 7.1, 0, 8, true));
  g.add(box(0.9, 1.6, 0.2, 0x5a3a22, 0, 0.8, 2.32));

  windmillBlades = new THREE.Group();
  windmillBlades.position.set(0, 5.4, 2.05);
  windmillBlades.add(cyl(0.2, 0.2, 0.6, 0x4a2f18, 0, 0, 0, 6));
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    arm.add(box(0.14, 3.8, 0.1, 0x5a3a22, 0, 1.9, 0, true));
    arm.add(box(0.65, 2.8, 0.04, 0xfff6e0, 0.32, 2.2, 0.04, true));
    windmillBlades.add(arm);
  }
  g.add(windmillBlades);
  registerLandmark('malom', g, 4.0, 8.0);
}

// 4.8 Gémeskút
{
  const g = new THREE.Group();
  const baseY = getTerrainElevation(PLACES.gemeskut.x, PLACES.gemeskut.z);
  g.position.set(PLACES.gemeskut.x, baseY, PLACES.gemeskut.z);
  g.add(cyl(1.12, 1.24, 0.8, 0x7c746a, 0, -0.35, 0, 8));
  g.add(cyl(1.0, 1.0, 0.9, 0x8b857c, 0, 0.45, 0, 8, true));
  g.add(cyl(0.75, 0.75, 0.92, 0x3a7ca5, 0, 0.46, 0, 8));
  const poleDy = getTerrainElevation(PLACES.gemeskut.x - 1.6, PLACES.gemeskut.z) - baseY;
  g.add(cyl(0.14, 0.18, 4.2 + Math.max(0, -poleDy), 0x5a3a22, -1.6, 2.1 + Math.min(0, poleDy) * 0.5, 0, 6, true));
  const beam = box(4.8, 0.14, 0.14, 0x74482a, -0.4, 4.1, 0, true);
  beam.rotation.z = -0.25;
  g.add(beam);
  g.add(cyl(0.03, 0.03, 2.4, 0x8a5a33, 1.6, 2.4, 0, 4));
  g.add(cyl(0.22, 0.18, 0.4, 0x5a3a22, 1.6, 1.1, 0, 7));
  registerLandmark('gemeskut', g, 2.8, 5.0);
}

// 4.9 Legelő és Állatok
{
  const g = new THREE.Group();
  const baseY = getTerrainElevation(PLACES.legelo.x, PLACES.legelo.z);
  g.position.set(PLACES.legelo.x, baseY, PLACES.legelo.z);
  const R = 7.5;
  const relY = (lx, lz) => getTerrainElevation(PLACES.legelo.x + lx, PLACES.legelo.z + lz) - baseY;
  for (let i = -R; i <= R; i += 2.5) {
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, i, relY(i, -R) + 0.55, -R));
    if (Math.abs(i) > 1.5) g.add(box(0.16, 1.1, 0.16, 0x6b4423, i, relY(i, R) + 0.55, R));
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, -R, relY(-R, i) + 0.55, i));
    g.add(box(0.16, 1.1, 0.16, 0x6b4423, R, relY(R, i) + 0.55, i));
  }
  const addFenceRail = (x1, z1, x2, z2) => {
    const midY = (relY(x1, z1) + relY(x2, z2)) * 0.5 + 0.85;
    const len = Math.hypot(x2 - x1, z2 - z1);
    const dy = relY(x2, z2) - relY(x1, z1);
    const rail = box(0.1, 0.1, len + 0.08, 0x8a5a33, (x1 + x2) * 0.5, midY, (z1 + z2) * 0.5);
    rail.rotation.order = 'YXZ';
    rail.rotation.y = Math.atan2(x2 - x1, z2 - z1);
    rail.rotation.x = -Math.atan2(dy, len);
    g.add(rail);
  };
  for (let i = -R; i < R; i += 2.5) {
    addFenceRail(i, -R, i + 2.5, -R);
    addFenceRail(-R, i, -R, i + 2.5);
    addFenceRail(R, i, R, i + 2.5);
  }
  const troughDy = relY(-4.2, -4.5);
  g.add(box(2.4, 0.5, 0.9, 0x6b4423, -4.2, troughDy + 0.25, -4.5));
  g.add(box(2.1, 0.52, 0.65, 0x4ea5d9, -4.2, troughDy + 0.26, -4.5));

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
    animal.position.set(ax, relY(ax, az), az);
    g.add(animal);
    pastureAnimals.push({ mesh: animal, baseX: ax, baseZ: az, seed: i * 1.7, baseY });
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
    road: 0x3e4248,
    sidewalk: 0xd2cab8,
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
    road: 0x3e4248,
    sidewalk: 0xd2cab8,
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
    road: 0x46484b,
    sidewalk: 0xc8bea8,
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
    road: 0x737d8a,
    sidewalk: 0xdce5ed,
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

  // 1. Talaj (domborzati vertex-színezés évszak szerint), folyópart, víz, utak és járdák színezése
  if (envRefs.groundGeo) {
    updateGroundSeasonColors(season);
    if (envRefs.groundMat) envRefs.groundMat.color.setHex(0xffffff);
  } else if (envRefs.groundMat) {
    envRefs.groundMat.color.setHex(pal.ground);
  }
  if (envRefs.bankMat) envRefs.bankMat.color.setHex(pal.bank);
  if (envRefs.waterMat) envRefs.waterMat.color.setHex(pal.water);
  if (envRefs.roadMat) envRefs.roadMat.color.setHex(pal.road);
  if (envRefs.sidewalkMat) envRefs.sidewalkMat.color.setHex(pal.sidewalk);

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
  renderer.shadowMap.needsUpdate = true;
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
  myHomeBeacon.position.set(myRes.x, getTerrainElevation(myRes.x, myRes.z), myRes.z);
}

function getHouseStyleIndex(res) {
  if (res && res.houseStyle !== undefined && res.houseStyle !== null && Number.isFinite(Number(res.houseStyle))) {
    return ((Math.trunc(Number(res.houseStyle)) % 5) + 5) % 5;
  }
  return Math.floor(hash((res && res.name) || 'lakos', 7) * 5) % 5;
}

function getHouseDoorLocalPos(styleIdx) {
  switch (styleIdx) {
    case 1: return { x: -0.9, z: 2.75 };
    case 2: return { x: 0, z: 2.85 };
    case 3: return { x: -1.2, z: 2.75 };
    case 4: return { x: 0, z: 2.85 };
    case 0:
    default: return { x: 0, z: 2.95 };
  }
}

function getDoorWorldPos(raw, styleIdx = getHouseStyleIndex(raw)) {
  const local = getHouseDoorLocalPos(styleIdx);
  const rot = raw.rot || 0;
  const sin = Math.sin(rot);
  const cos = Math.cos(rot);
  return [
    raw.x + local.x * cos + local.z * sin,
    raw.z - local.x * sin + local.z * cos,
  ];
}

function addGableRoof(g, { x = 0, y = 0, z = 0, w, h, d, ridgeAlong = 'x', roofMat, res, includeSnow = true }) {
  const span = ridgeAlong === 'x' ? d : w;
  const len = ridgeAlong === 'x' ? w : d;
  const geoKey = `gable:${span}:${h}:${len}:${ridgeAlong}`;
  const geo = cachedGeo(geoKey, () => {
    const shape = new THREE.Shape();
    shape.moveTo(-span / 2, 0);
    shape.lineTo(span / 2, 0);
    shape.lineTo(0, h);
    shape.closePath();
    const extrude = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    extrude.translate(0, 0, -len / 2);
    if (ridgeAlong === 'x') {
      extrude.rotateY(Math.PI / 2);
    }
    return extrude;
  });
  const roofMesh = new THREE.Mesh(geo, roofMat);
  roofMesh.position.set(x, y, z);
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;
  if (res) roofMesh.userData.resident = res;
  g.add(roofMesh);
  housePickers.push(roofMesh);

  if (includeSnow) {
    const snowGroup = new THREE.Group();
    snowGroup.position.set(x, y, z);
    if (ridgeAlong === 'z') snowGroup.rotation.y = Math.PI / 2;
    const theta = Math.atan2(h, span / 2);
    const slopeLen = Math.hypot(span / 2, h) + 0.08;
    const snowGeo = cachedGeo(`gablesnow:${len}:${slopeLen}`, () => new THREE.BoxGeometry(len + 0.05, 0.09, slopeLen));
    const snowM = mat(0xf2f7fb);
    const offN = 0.038;
    for (const sign of [1, -1]) {
      const slab = new THREE.Mesh(snowGeo, snowM);
      slab.position.set(0, h / 2 + Math.cos(theta) * offN, sign * (span / 4 + Math.sin(theta) * offN));
      slab.rotation.x = sign * theta;
      slab.receiveShadow = true;
      snowGroup.add(slab);
    }
    snowGroup.visible = currentSeason === 'tel';
    g.add(snowGroup);
    envRefs.snowRoofs.push(snowGroup);
  }
  return roofMesh;
}

function addHouseWindow(g, x, y, z, w, h, winMat, rotY = 0, withPlanter = false, blossomColor = 0xe63946) {
  const geo = cachedGeo(`win:${w}:${h}:0.12`, () => new THREE.BoxGeometry(w, h, 0.12));
  const win = new THREE.Mesh(geo, winMat);
  win.position.set(x, y, z);
  win.rotation.y = rotY;
  g.add(win);
  if (withPlanter) {
    const pGroup = new THREE.Group();
    pGroup.position.set(x, y, z);
    pGroup.rotation.y = rotY;
    pGroup.add(box(w + 0.06, 0.20, 0.24, 0x5a3a22, 0, -h / 2 - 0.08, 0.08));
    pGroup.add(box(w - 0.02, 0.15, 0.18, blossomColor, 0, -h / 2 + 0.05, 0.08));
    g.add(pGroup);
  }
  return win;
}

function addHouseWall(g, w, h, d, wallMat, x, y, z, res) {
  const geo = cachedGeo(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
  const mesh = new THREE.Mesh(geo, wallMat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.resident = res;
  g.add(mesh);
  housePickers.push(mesh);
  return mesh;
}

function addGardenWalkway(startX, startZ, endX, endZ, width, height, elevOffset, surfaceMat, curbColor = 0x8f8474, targetGroup = scene) {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const dist = Math.hypot(dx, dz);
  if (dist <= 0.25) return null;
  const grp = new THREE.Group();
  addTerrainSlopedSpan(grp, startX, startZ, endX, endZ, width, height, elevOffset, surfaceMat, 1.8);
  if (curbColor !== null) {
    const curbMat = mat(curbColor);
    const nx = -dz / dist;
    const nz = dx / dist;
    const curbOff = width / 2 + 0.06;
    addTerrainSlopedSpan(
      grp,
      startX + nx * curbOff, startZ + nz * curbOff,
      endX + nx * curbOff, endZ + nz * curbOff,
      0.11, height + 0.02, elevOffset + 0.005, curbMat, 1.8
    );
    addTerrainSlopedSpan(
      grp,
      startX - nx * curbOff, startZ - nz * curbOff,
      endX - nx * curbOff, endZ - nz * curbOff,
      0.11, height + 0.02, elevOffset + 0.005, curbMat, 1.8
    );
  }
  targetGroup.add(grp);
  return grp;
}

function traceForwardRoadEdge(ox, oz, rot, stopFromRoadCenter) {
  const fx = Math.sin(rot);
  const fz = Math.cos(rot);
  let bestT = Infinity;
  for (const r of VILLAGE_ROADS) {
    const ex = r.x2 - r.x1;
    const ez = r.z2 - r.z1;
    const denom = fx * ez - fz * ex;
    if (Math.abs(denom) < 1e-6) continue;
    const ax = r.x1 - ox;
    const az = r.z1 - oz;
    const t = (ax * ez - az * ex) / denom;
    const u = (ax * fz - az * fx) / denom;
    if (t > 0.2 && t < bestT && u >= -0.02 && u <= 1.02) {
      bestT = t;
    }
  }
  const nr = getClosestPointOnRoads(ox, oz);
  const proj = (nr.x - ox) * fx + (nr.z - oz) * fz;
  let roadDist = bestT;
  if (!Number.isFinite(roadDist) || (proj > 1.0 && roadDist > proj + 4.5)) {
    roadDist = Math.max(0.6, proj);
  }
  const len = Math.max(0.45, roadDist - stopFromRoadCenter);
  return {
    endX: ox + fx * len,
    endZ: oz + fz * len,
    len,
  };
}

function createHouseWalkway(res, styleIdx, hasDriveway, targetGroup = scene) {
  const walkGrp = new THREE.Group();
  const rot = res.rot || 0;
  const sin = Math.sin(rot);
  const cos = Math.cos(rot);

  // Kerti gyalogjárda a bejárattól közvetlenül előre a közterületi járdáig (oldalazás nélkül)
  const [doorX, doorZ] = getDoorWorldPos(res, styleIdx);
  const frontWalk = traceForwardRoadEdge(doorX, doorZ, rot, SIDEWALK_OFFSET);
  addGardenWalkway(
    doorX, doorZ,
    frontWalk.endX, frontWalk.endZ,
    hasDriveway ? 1.0 : 1.35,
    0.055, 0.03,
    envRefs.sidewalkMat || mat(0xd2cab8),
    0x8f8474,
    walkGrp
  );

  // Kocsifeljáró a garázstól / carporttól közvetlenül előre az aszfaltút széléig
  if (hasDriveway) {
    const mouthLX = styleIdx === 1 ? 2.05 : 2.25;
    const mouthLZ = styleIdx === 1 ? 2.38 : -1.55;
    const mouthX = res.x + mouthLX * cos + mouthLZ * sin;
    const mouthZ = res.z - mouthLX * sin + mouthLZ * cos;
    const driveTarget = traceForwardRoadEdge(mouthX, mouthZ, rot, CAR_ROAD_WIDTH * 0.5 - 0.10);
    if (driveTarget.len > 0.4) {
      const driveMat = styleIdx === 1 ? (envRefs.roadMat || mat(0x3e4248)) : mat(0x8e959e);
      addGardenWalkway(mouthX, mouthZ, driveTarget.endX, driveTarget.endZ, 2.1, 0.098, 0.049, driveMat, 0x6f757e, walkGrp);
    }
  }

  targetGroup.add(walkGrp);
  return walkGrp;
}

function createHouseGroup(res, options = {}) {
  const styleIdx = getHouseStyleIndex(res);
  const hasDriveway = styleIdx === 1 || styleIdx === 3;
  const g = new THREE.Group();
  const wallMat = new THREE.MeshLambertMaterial({ color: res.wall || '#f5eedc', flatShading: true });
  const roofMat = new THREE.MeshLambertMaterial({ color: res.roof || '#c8523b', flatShading: true });
  const winMat = new THREE.MeshBasicMaterial({ color: 0x3a2e24 });
  const pickerStart = housePickers.length;
  const snowStart = envRefs.snowRoofs.length;

  if (styleIdx === 0) {
    // Stílus 0: Tornácos parasztház (country_porch)
    addHouseWall(g, 4.6, 2.2, 3.6, wallMat, 0, 1.1, -0.1, res);
    addGableRoof(g, { x: 0, y: 2.2, z: -0.1, w: 5.05, h: 1.55, d: 4.1, ridgeAlong: 'x', roofMat, res });
    g.add(box(0.52, 1.15, 0.52, 0x7a6f64, 1.35, 3.05, -0.7));
    // Tornác alapzat, tető és oszlopok
    g.add(box(3.8, 0.16, 1.2, 0xa89b89, 0, 0.08, 2.28));
    const porchRoof = new THREE.Mesh(
      cachedGeo('box:4.0:0.12:1.35', () => new THREE.BoxGeometry(4.0, 0.12, 1.35)),
      roofMat
    );
    porchRoof.position.set(0, 2.02, 2.28);
    porchRoof.rotation.x = 0.20;
    porchRoof.castShadow = true;
    porchRoof.userData.resident = res;
    g.add(porchRoof);
    housePickers.push(porchRoof);
    const porchSnow = box(3.96, 0.07, 1.30, 0xf2f7fb, 0, 2.11, 2.28);
    porchSnow.rotation.x = 0.20;
    porchSnow.visible = currentSeason === 'tel';
    g.add(porchSnow);
    envRefs.snowRoofs.push(porchSnow);
    for (const px of [-1.72, 1.72]) {
      g.add(box(0.16, 1.85, 0.16, 0x5a3a22, px, 1.04, 2.74, true));
    }
    for (const rx of [-1.15, 1.15]) {
      g.add(box(1.15, 0.08, 0.08, 0x6e472a, rx, 0.72, 2.74));
    }
    g.add(box(0.86, 1.56, 0.12, 0x5a3a22, 0, 0.88, 1.72));
    addHouseWindow(g, -1.35, 1.25, 1.72, 0.70, 0.62, winMat, 0, true, 0xe63946);
    addHouseWindow(g, 1.35, 1.25, 1.72, 0.70, 0.62, winMat, 0, true, 0xffb703);
    addHouseWindow(g, -2.32, 1.25, -0.1, 0.65, 0.60, winMat, Math.PI / 2);
    addHouseWindow(g, 2.32, 1.25, -0.1, 0.65, 0.60, winMat, Math.PI / 2);
    for (const side of [-2.65, 2.65]) {
      g.add(box(0.12, 0.75, 0.12, 0x5a3a22, side, 0.375, 1.8));
      g.add(box(0.12, 0.75, 0.12, 0x5a3a22, side, 0.375, -0.6));
      g.add(box(0.08, 0.09, 2.4, 0x6e472a, side, 0.52, 0.6));
      g.add(box(0.08, 0.09, 2.4, 0x6e472a, side, 0.25, 0.6));
    }
    g.add(cyl(0.22, 0.16, 0.3, 0xa65228, 1.05, 0.28, 2.45));
    g.add(cone(0.30, 0.50, 0x8338ec, 1.05, 0.62, 2.45));
  } else if (styleIdx === 1) {
    // Stílus 1: L-alakú ház garázzsal és KOCSIFELJÁRÓVAL (l_shape_garage)
    addHouseWall(g, 3.4, 2.3, 3.8, wallMat, -0.9, 1.15, -0.1, res);
    addGableRoof(g, { x: -0.9, y: 2.3, z: -0.1, w: 3.85, h: 1.45, d: 4.25, ridgeAlong: 'z', roofMat, res });
    addHouseWall(g, 2.5, 2.0, 4.4, wallMat, 2.05, 1.0, 0.2, res);
    addGableRoof(g, { x: 2.05, y: 2.0, z: 0.2, w: 2.85, h: 1.05, d: 4.75, ridgeAlong: 'z', roofMat, res });
    g.add(box(0.48, 1.1, 0.48, 0x7a6f64, -1.7, 3.15, -0.9));
    // Fehér szekcionált garázskapu
    g.add(box(2.08, 1.70, 0.10, 0xe8edf2, 2.05, 0.85, 2.41));
    for (const gy of [0.45, 0.85, 1.25]) {
      g.add(box(1.98, 0.04, 0.12, 0xb8c2cc, 2.05, gy, 2.41));
    }
    // Lakrész bejárat + ablakok
    g.add(box(0.82, 1.54, 0.12, 0x5a3a22, -0.9, 0.78, 1.82));
    g.add(box(1.25, 0.14, 0.62, 0x857a6e, -0.9, 0.07, 2.06));
    addHouseWindow(g, -1.85, 1.28, 1.82, 0.68, 0.62, winMat, 0, true, 0xe63946);
    addHouseWindow(g, 0.05, 1.28, 1.82, 0.62, 0.62, winMat, 0, true, 0xffb703);
    addHouseWindow(g, -2.62, 1.28, -0.1, 0.72, 0.62, winMat, Math.PI / 2);
  } else if (styleIdx === 2) {
    // Stílus 2: Kétszintes polgári villa (two_story_villa)
    addHouseWall(g, 4.2, 2.1, 3.6, wallMat, 0, 1.05, -0.1, res);
    g.add(box(4.36, 0.14, 3.76, 0xdfd6c7, 0, 2.08, -0.1));
    addHouseWall(g, 3.8, 1.8, 3.2, wallMat, 0, 2.95, -0.15, res);
    const villaRoof = new THREE.Mesh(cachedGeo('cone:3.18:1.65:4', () => new THREE.ConeGeometry(3.18, 1.65, 4)), roofMat);
    villaRoof.position.set(0, 4.66, -0.15);
    villaRoof.rotation.y = Math.PI / 4;
    villaRoof.castShadow = true;
    villaRoof.userData.resident = res;
    g.add(villaRoof);
    housePickers.push(villaRoof);
    const snowRoof = new THREE.Mesh(cachedGeo('cone:3.08:1.35:4', () => new THREE.ConeGeometry(3.08, 1.35, 4)), mat(0xf2f7fb));
    snowRoof.position.set(0, 4.86, -0.15);
    snowRoof.rotation.y = Math.PI / 4;
    snowRoof.visible = currentSeason === 'tel';
    g.add(snowRoof);
    envRefs.snowRoofs.push(snowRoof);
    g.add(box(0.50, 1.1, 0.50, 0x7a6f64, 1.15, 4.92, -0.75));
    // Emeleti erkély és korlát
    g.add(box(1.95, 0.12, 0.72, 0x6e472a, 0, 2.15, 1.78, true));
    g.add(box(1.95, 0.08, 0.08, 0x4a2e1b, 0, 2.66, 2.10));
    for (const bx of [-0.90, -0.45, 0, 0.45, 0.90]) {
      g.add(box(0.06, 0.48, 0.06, 0x4a2e1b, bx, 2.42, 2.10));
    }
    g.add(box(0.76, 1.40, 0.10, 0x4e6475, 0, 2.90, 1.47));
    addHouseWindow(g, -1.22, 2.98, 1.47, 0.62, 0.62, winMat, 0);
    addHouseWindow(g, 1.22, 2.98, 1.47, 0.62, 0.62, winMat, 0);
    // Földszinti ajtó, lépcső, ablakok
    g.add(box(0.86, 1.56, 0.12, 0x5a3a22, 0, 0.78, 1.72));
    g.add(box(1.32, 0.14, 0.66, 0x857a6e, 0, 0.07, 1.98));
    addHouseWindow(g, -1.35, 1.15, 1.72, 0.68, 0.62, winMat, 0, true, 0xe63946);
    addHouseWindow(g, 1.35, 1.15, 1.72, 0.68, 0.62, winMat, 0, true, 0xffb703);
  } else if (styleIdx === 3) {
    // Stílus 3: Modern ház pergola kocsibeállóval és KOCSIFELJÁRÓVAL (modern_carport)
    addHouseWall(g, 3.8, 2.4, 3.6, wallMat, -0.7, 1.2, -0.1, res);
    const modRoof = new THREE.Mesh(
      cachedGeo('box:4.35:0.22:4.15', () => new THREE.BoxGeometry(4.35, 0.22, 4.15)),
      roofMat
    );
    modRoof.position.set(-0.7, 2.52, -0.1);
    modRoof.rotation.z = -0.14;
    modRoof.castShadow = true;
    modRoof.receiveShadow = true;
    modRoof.userData.resident = res;
    g.add(modRoof);
    housePickers.push(modRoof);
    const modSnow = box(4.30, 0.09, 4.10, 0xf2f7fb, -0.68, 2.67, -0.1);
    modSnow.rotation.z = -0.14;
    modSnow.visible = currentSeason === 'tel';
    g.add(modSnow);
    envRefs.snowRoofs.push(modSnow);
    // Nyitott fa-fém pergola kocsibeálló (x = +2.25)
    for (const [px, pz] of [[1.35, -1.55], [3.15, -1.55], [1.35, 1.55], [3.15, 1.55]]) {
      g.add(box(0.13, 2.2, 0.13, 0x3a3f47, px, 1.1, pz, true));
    }
    g.add(box(2.2, 0.12, 0.12, 0x3a3f47, 2.25, 2.22, -1.55, true));
    g.add(box(2.2, 0.12, 0.12, 0x3a3f47, 2.25, 2.22, 1.55, true));
    g.add(box(0.12, 0.12, 3.4, 0x3a3f47, 1.35, 2.22, 0, true));
    g.add(box(0.12, 0.12, 3.4, 0x3a3f47, 3.15, 2.22, 0, true));
    for (let bz = -1.2; bz <= 1.25; bz += 0.6) {
      g.add(box(2.15, 0.10, 0.09, 0x7a5130, 2.25, 2.28, bz));
    }
    // Modern bejárat + panoráma ablak + virágláda
    g.add(box(0.84, 1.62, 0.12, 0x383e46, -1.2, 0.81, 1.72));
    g.add(box(1.15, 0.12, 0.56, 0x9ba0a6, -1.2, 0.06, 1.98));
    addHouseWindow(g, 0.25, 1.25, 1.72, 1.22, 0.86, winMat, 0);
    addHouseWindow(g, -2.62, 1.32, -0.1, 0.80, 0.72, winMat, Math.PI / 2);
    g.add(box(1.10, 0.26, 0.32, 0x5a3a22, 0.25, 0.13, 1.90));
    g.add(box(1.02, 0.18, 0.24, 0x52b788, 0.25, 0.34, 1.90));
  } else {
    // Stílus 4: Meredek tetős alpesi ház tetőtéri ablakkal (steep_cottage)
    addHouseWall(g, 4.0, 2.0, 3.8, wallMat, 0, 1.0, -0.1, res);
    addGableRoof(g, { x: 0, y: 2.0, z: -0.1, w: 4.45, h: 2.55, d: 4.35, ridgeAlong: 'x', roofMat, res });
    g.add(box(0.48, 1.2, 0.48, 0x7a6f64, -1.25, 3.75, -0.65));
    // Tetőtéri ablak (dormer)
    addHouseWall(g, 1.08, 0.86, 1.15, wallMat, 0, 2.78, 1.02, res);
    addGableRoof(g, { x: 0, y: 3.21, z: 1.05, w: 1.28, h: 0.46, d: 1.32, ridgeAlong: 'z', roofMat, res });
    addHouseWindow(g, 0, 2.75, 1.61, 0.62, 0.54, winMat, 0);
    // Földszinti ajtó, lépcső, ablakok és kerítés
    g.add(box(0.84, 1.54, 0.12, 0x5a3a22, 0, 0.77, 1.82));
    g.add(box(1.25, 0.14, 0.62, 0x857a6e, 0, 0.07, 2.06));
    addHouseWindow(g, -1.22, 1.12, 1.82, 0.62, 0.60, winMat, 0, true, 0xe63946);
    addHouseWindow(g, 1.22, 1.12, 1.82, 0.62, 0.60, winMat, 0, true, 0xffb703);
    for (const side of [-2.42, 2.42]) {
      g.add(box(0.11, 0.75, 0.11, 0x5a3a22, side, 0.375, 1.9));
      g.add(box(0.11, 0.75, 0.11, 0x5a3a22, side, 0.375, -0.1));
      g.add(box(0.08, 0.09, 2.0, 0x6e472a, side, 0.52, 0.9));
      g.add(box(0.08, 0.09, 2.0, 0x6e472a, side, 0.25, 0.9));
    }
  }

  const baseY = getTerrainElevation(res.x, res.z);
  const rot = res.rot || 0;
  const sin = Math.sin(rot);
  const cos = Math.cos(rot);
  const PLINTH_DIMS = [
    [4.75, 4.9, 0, 0.45],
    [6.05, 4.55, 0.35, 0.20],
    [4.35, 3.8, 0, -0.05],
    [4.25, 3.85, -0.6, -0.05],
    [4.18, 4.0, 0, -0.05],
  ];
  const [pw, pd, pcx, pcz] = PLINTH_DIMS[styleIdx] || PLINTH_DIMS[0];
  let minCornerY = baseY;
  for (const sx of [-0.5, 0, 0.5]) {
    for (const sz of [-0.5, 0, 0.5]) {
      const lx = pcx + sx * pw;
      const lz = pcz + sz * pd;
      const wx = res.x + lx * cos + lz * sin;
      const wz = res.z - lx * sin + lz * cos;
      const cy = getTerrainElevation(wx, wz);
      if (cy < minCornerY) minCornerY = cy;
    }
  }
  const plinthH = Math.max(1.15, (baseY - minCornerY) + 0.55);
  const plinth = box(pw, plinthH, pd, 0x7c756b, pcx, -plinthH / 2 + 0.04, pcz, true);
  plinth.receiveShadow = true;
  g.add(plinth);

  const ownedPickers = housePickers.slice(pickerStart);
  const ownedSnowRoofs = envRefs.snowRoofs.slice(snowStart);
  if (options.unclaimedPlot) {
    for (const pMesh of ownedPickers) {
      delete pMesh.userData.resident;
      pMesh.userData.unclaimedPlot = options.unclaimedPlot;
    }
  }

  g.position.set(res.x, baseY, res.z);
  g.rotation.y = rot;
  const walkwayGroup = createHouseWalkway(res, styleIdx, hasDriveway, scene);
  g.userData = {
    wallMat,
    roofMat,
    winMat,
    resident: options.unclaimedPlot ? null : res,
    unclaimedPlot: options.unclaimedPlot || null,
    houseStyle: styleIdx,
    hasDriveway,
    ownedPickers,
    ownedSnowRoofs,
    walkwayGroup,
  };
  scene.add(g);

  return g;
}

const VILLAGER_GEOS = {
  body: new THREE.CylinderGeometry(0.23, 0.30, 0.66, 7),
  head: new THREE.SphereGeometry(0.26, 8, 6),
  hatBrim: new THREE.CylinderGeometry(0.42, 0.42, 0.06, 8),
  hatTop: new THREE.CylinderGeometry(0.24, 0.27, 0.25, 8),
  pants: new THREE.CylinderGeometry(0.08, 0.07, 0.36, 6),
  boot: new THREE.BoxGeometry(0.13, 0.10, 0.21),
  sleeve: new THREE.CylinderGeometry(0.07, 0.06, 0.36, 6),
  hand: new THREE.SphereGeometry(0.07, 6, 5),
};

function createVillagerGroup(res) {
  const g = new THREE.Group();
  const clothMat = new THREE.MeshLambertMaterial({ color: res.cloth || '#c8343a', flatShading: true });

  const body = new THREE.Mesh(VILLAGER_GEOS.body, clothMat);
  body.position.y = 0.75;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(VILLAGER_GEOS.head, mat(0xf4cbb2));
  head.position.y = 1.30;
  head.castShadow = true;
  g.add(head);

  const hatBrim = new THREE.Mesh(VILLAGER_GEOS.hatBrim, mat(0x3b2818));
  hatBrim.position.y = 1.50;
  const hatTop = new THREE.Mesh(VILLAGER_GEOS.hatTop, mat(0x3b2818));
  hatTop.position.y = 1.63;
  g.add(hatBrim, hatTop);

  const createLegPivot = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.44, 0);
    const pants = new THREE.Mesh(VILLAGER_GEOS.pants, mat(0x3e352f));
    pants.position.y = -0.18;
    const boot = new THREE.Mesh(VILLAGER_GEOS.boot, mat(0x261a10));
    boot.position.set(0, -0.38, 0.03);
    pivot.add(pants, boot);
    g.add(pivot);
    return pivot;
  };
  const leftLegPivot = createLegPivot(-0.11);
  const rightLegPivot = createLegPivot(0.11);

  const createArmPivot = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.98, 0);
    const sleeve = new THREE.Mesh(VILLAGER_GEOS.sleeve, clothMat);
    sleeve.position.y = -0.16;
    const hand = new THREE.Mesh(VILLAGER_GEOS.hand, mat(0xf4cbb2));
    hand.position.y = -0.36;
    pivot.add(sleeve, hand);
    g.add(pivot);
    return pivot;
  };
  const leftArmPivot = createArmPivot(-0.29);
  const rightArmPivot = createArmPivot(0.29);

  g.userData = {
    clothMat,
    resident: res,
    limbs: { leftLegPivot, rightLegPivot, leftArmPivot, rightArmPivot },
  };
  body.userData.residentFigure = res;
  head.userData.residentFigure = res;
  figurePickers.push(body, head);
  scene.add(g);
  return g;
}

function animateCharacterLimbs(figGroup, phase, speedNorm) {
  const limbs = figGroup?.userData?.limbs;
  if (!limbs) return;
  const { leftLegPivot, rightLegPivot, leftArmPivot, rightArmPivot } = limbs;
  const targetSwing = speedNorm > 0.02
    ? Math.sin(phase) * 0.72 * Math.min(1.25, speedNorm)
    : 0;
  const current = leftLegPivot.rotation.x;
  const swing = speedNorm > 0.02
    ? THREE.MathUtils.lerp(current, targetSwing, 0.42)
    : (Math.abs(current) < 0.004 ? 0 : current * 0.75);
  leftLegPivot.rotation.x = swing;
  rightLegPivot.rotation.x = -swing;
  leftArmPivot.rotation.x = -swing * 0.85;
  rightArmPivot.rotation.x = swing * 0.85;
}

function updatePlotCapacityUI() {
  const maxHouses = villageData.maxHouses || 48;
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
    capSub.textContent = isFull
      ? 'Lezárva'
      : (pendingClaimPlot ? `${free} szabad telek · #${pendingClaimPlot.index}. ház kijelölve` : `${free} szabad telek`);
  }
  if (fullWarn) fullWarn.hidden = !isFull;
  if (submitBtn) {
    submitBtn.disabled = isFull;
    submitBtn.textContent = isFull
      ? `🔒 A falu megtelt (${maxHouses}/${maxHouses})`
      : (pendingClaimPlot ? `🏡 Beköltözés a #${pendingClaimPlot.index}. házba!` : '🏡 Telek generálása és Beköltözés!');
  }
}

const NPC_SLICE_SEC = 7;
const NPC_CYCLE_SLICES = 240;
const NPC_CYCLE_SEC = NPC_SLICE_SEC * NPC_CYCLE_SLICES; // 1680s (28 min) ciklus

function ensureNpcScheduleProfile(res) {
  if (res.npcSchedule) return res.npcSchedule;
  const prefixDist = new Float32Array(NPC_CYCLE_SLICES + 1);
  const pauseDurs = new Float32Array(NPC_CYCLE_SLICES);
  const sliceModes = new Uint8Array(NPC_CYCLE_SLICES); // 0 = walk, 1 = idle->walk, 2 = run
  const preSpeeds = new Float32Array(NPC_CYCLE_SLICES);

  let acc = 0;
  for (let i = 0; i < NPC_CYCLE_SLICES; i++) {
    prefixDist[i] = acc;
    const h = hash(res.name, 500 + i);
    if (h < 0.16) {
      // Megállás (3 - 7 másodpercig nézelődik a járdán), majd a szelet végén továbbindul
      const pauseDur = 3.0 + hash(res.name, 600 + i) * 4.0;
      const walkAfter = Math.max(0, NPC_SLICE_SEC - pauseDur);
      const speed = Math.min(MAX_NPC_SPEED, 1.25 + hash(res.name, 700 + i) * 0.90);
      sliceModes[i] = 1;
      pauseDurs[i] = pauseDur;
      preSpeeds[i] = speed;
      acc += walkAfter * speed;
    } else if (h < 0.34) {
      // Futás / sietés (3.2 - 4.5 m/s, max MAX_NPC_SPEED)
      const speed = Math.min(MAX_NPC_SPEED, 3.2 + hash(res.name, 900 + i) * 1.3);
      sliceModes[i] = 2;
      pauseDurs[i] = 0;
      preSpeeds[i] = speed;
      acc += NPC_SLICE_SEC * speed;
    } else {
      // Dinamikus séta (1.15 - 2.50 m/s)
      const speed = Math.min(MAX_NPC_SPEED, 1.15 + hash(res.name, 700 + i) * 1.35);
      sliceModes[i] = 0;
      pauseDurs[i] = 0;
      preSpeeds[i] = speed;
      acc += NPC_SLICE_SEC * speed;
    }
  }
  prefixDist[NPC_CYCLE_SLICES] = acc;
  res.npcSchedule = {
    prefixDist,
    pauseDurs,
    sliceModes,
    preSpeeds,
    cycleTotalDist: acc,
  };
  return res.npcSchedule;
}

function addResidentToWorld(raw) {
  const styleIdx = getHouseStyleIndex(raw);
  const door = getDoorWorldPos(raw, styleIdx);
  const res = {
    ...raw,
    houseStyle: styleIdx,
    door,
    speed: 1.8 + hash(raw.name, 3) * 0.6,
  };
  ensureNpcScheduleProfile(res);
  res.houseGroup = createHouseGroup(res);
  res.figureGroup = createVillagerGroup(res);
  residents.push(res);
  byName.set(res.name.toLowerCase(), res);
  if (!housePrivacyMap[res.name.toLowerCase()]) {
    housePrivacyMap[res.name.toLowerCase()] = 'public';
  }
  updatePlotCapacityUI();
  renderer.shadowMap.needsUpdate = true;
  return res;
}

const FREE_HOUSE_WALLS = ['#efe7d6', '#e6ded0', '#ece3d5', '#e4dfd7', '#f0e8da'];
const FREE_HOUSE_ROOFS = ['#9b6b52', '#8e624d', '#7c6552', '#8a5a44', '#7f5b48'];

function getFreePlots() {
  const maxHouses = villageData.maxHouses || 48;
  const remainingSlots = Math.max(0, maxHouses - residents.length);
  if (remainingSlots <= 0) return [];
  return STREET_PLOTS
    .map((p, idx) => ({ ...p, index: idx + 1, houseStyle: p.houseStyle ?? ((idx * 3 + 1) % 5) }))
    .filter((p) => !residents.some((r) => Math.hypot(r.x - p.x, r.z - p.z) < 6.0))
    .slice(0, remainingSlots);
}

function syncUnclaimedHouses() {
  for (const uh of unclaimedHouses) {
    if (uh.houseGroup) scene.remove(uh.houseGroup);
    if (uh.walkwayGroup) scene.remove(uh.walkwayGroup);
    if (uh.ownedPickers && uh.ownedPickers.length) {
      const rmSet = new Set(uh.ownedPickers);
      for (let i = housePickers.length - 1; i >= 0; i--) {
        if (rmSet.has(housePickers[i])) housePickers.splice(i, 1);
      }
    }
    if (uh.ownedSnowRoofs && uh.ownedSnowRoofs.length) {
      const rmSnow = new Set(uh.ownedSnowRoofs);
      for (let i = envRefs.snowRoofs.length - 1; i >= 0; i--) {
        if (rmSnow.has(envRefs.snowRoofs[i])) envRefs.snowRoofs.splice(i, 1);
      }
    }
  }
  unclaimedHouses.length = 0;

  const freePlots = getFreePlots();
  for (let i = 0; i < freePlots.length; i++) {
    const fp = freePlots[i];
    const styleIdx = fp.houseStyle ?? ((fp.index - 1) % 5);
    const proxyRes = {
      name: `free_plot_${fp.index}`,
      x: fp.x,
      z: fp.z,
      rot: fp.rot,
      houseStyle: styleIdx,
      wall: FREE_HOUSE_WALLS[(fp.index - 1) % FREE_HOUSE_WALLS.length],
      roof: FREE_HOUSE_ROOFS[(fp.index - 1) % FREE_HOUSE_ROOFS.length],
    };
    const hg = createHouseGroup(proxyRes, { unclaimedPlot: fp });
    unclaimedHouses.push({
      plot: fp,
      x: fp.x,
      z: fp.z,
      rot: fp.rot,
      houseStyle: styleIdx,
      houseGroup: hg,
      walkwayGroup: hg.userData.walkwayGroup,
      ownedPickers: hg.userData.ownedPickers,
      ownedSnowRoofs: hg.userData.ownedSnowRoofs,
    });
  }
  if (renderer && renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
}

villageData.residents.forEach(addResidentToWorld);
syncUnclaimedHouses();
updatePlotCapacityUI();
updateClaimButtonUI();
updateMyHomeBeaconPosition();

// --- 7. Determinisztikus Falusi Élet, Automatikus Csatlakozó Járdagráf (Kizárólag Járda/Híd) ---
function segmentCrossesRiverOffBridge(ax, az, bx, bz) {
  const SAMPLES = 12;
  for (let s = 1; s < SAMPLES; s++) {
    const t = s / SAMPLES;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    if (Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 0.6 && Math.abs(x - BRIDGE.x) > 3.1) {
      return true;
    }
  }
  return false;
}

const { SIDEWALK_GRAPH_NODES, SIDEWALK_GRAPH_EDGES, SIDEWALK_ADJ } = (() => {
  const nodes = {
    B_SW: [-2.1, -8.5],
    B_SE: [2.1, -8.5],
    B_NW: [-2.1, -19.5],
    B_NE: [2.1, -19.5],
  };
  const bridgeNodeSet = new Set(['B_SW', 'B_SE', 'B_NW', 'B_NE']);
  const edges = [];
  const edgeKeys = new Set();
  let autoIdx = 0;

  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push([a, b]);
  };

  const addSwNode = (x, z) => {
    const north = z < riverZ(x);
    for (const [id, pt] of Object.entries(nodes)) {
      if (bridgeNodeSet.has(id)) continue;
      if ((pt[1] < riverZ(pt[0])) !== north) continue;
      if (Math.hypot(pt[0] - x, pt[1] - z) <= 0.25) return id;
    }
    const id = `SW_${autoIdx++}`;
    nodes[id] = [Number(x.toFixed(3)), Number(z.toFixed(3))];
    return id;
  };

  // 1. Minden járdaszegmens végpontjai és belső élei
  for (const seg of SIDEWALK_SEGMENTS) {
    const id1 = addSwNode(seg.x1, seg.z1);
    const id2 = addSwNode(seg.x2, seg.z2);
    addEdge(id1, id2);
  }

  // 2. Híd gyalogos járdái (kizárólag ez a két átkelő vezet át a folyón!)
  addEdge('B_SW', 'B_NW');
  addEdge('B_SE', 'B_NE');
  addEdge('B_SW', 'B_SE');
  addEdge('B_NW', 'B_NE');

  // 3. Kereszteződések és zebrák összekötése ugyanazon a folyóparton (<= 7.8m, folyókeresztezés nélkül)
  const swIds = Object.keys(nodes).filter((id) => !bridgeNodeSet.has(id));
  for (let i = 0; i < swIds.length; i++) {
    const a = swIds[i];
    const ptA = nodes[a];
    const northA = ptA[1] < riverZ(ptA[0]);
    for (let j = i + 1; j < swIds.length; j++) {
      const b = swIds[j];
      const ptB = nodes[b];
      if ((ptB[1] < riverZ(ptB[0])) !== northA) continue;
      const d = Math.hypot(ptB[0] - ptA[0], ptB[1] - ptA[1]);
      if (d > 0.05 && d <= 7.8 && !segmentCrossesRiverOffBridge(ptA[0], ptA[1], ptB[0], ptB[1])) {
        addEdge(a, b);
      }
    }
  }

  // 4. Hídvégpontok bekötése a legközelebbi parti járdacsomópontokhoz
  for (const bId of bridgeNodeSet) {
    const ptB = nodes[bId];
    const northB = ptB[1] < riverZ(ptB[0]);
    const cands = swIds
      .filter((id) => (nodes[id][1] < riverZ(nodes[id][0])) === northB)
      .filter((id) => !segmentCrossesRiverOffBridge(ptB[0], ptB[1], nodes[id][0], nodes[id][1]))
      .map((id) => ({ id, d: Math.hypot(nodes[id][0] - ptB[0], nodes[id][1] - ptB[1]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const c of cands) addEdge(bId, c.id);
  }

  // 5. Szomszédsági lista felépítése és összefüggőség garantálása az azonos parton
  const buildAdj = () => {
    const adj = {};
    for (const id of Object.keys(nodes)) adj[id] = [];
    for (const [a, b] of edges) {
      const w = Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]);
      adj[a].push({ to: b, w });
      adj[b].push({ to: a, w });
    }
    return adj;
  };

  let adj = buildAdj();
  const visited = new Set(['B_SW']);
  const queue = ['B_SW'];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of adj[cur]) {
      if (!visited.has(e.to)) {
        visited.add(e.to);
        queue.push(e.to);
      }
    }
  }
  const allIds = Object.keys(nodes);
  while (visited.size < allIds.length) {
    let bestU = null;
    let bestV = null;
    let bestDist = Infinity;
    for (const u of visited) {
      const pu = nodes[u];
      const nu = pu[1] < riverZ(pu[0]);
      for (const v of allIds) {
        if (visited.has(v)) continue;
        const pv = nodes[v];
        if ((pv[1] < riverZ(pv[0])) !== nu) continue;
        if (segmentCrossesRiverOffBridge(pu[0], pu[1], pv[0], pv[1])) continue;
        const d = Math.hypot(pv[0] - pu[0], pv[1] - pu[1]);
        if (d < bestDist) {
          bestDist = d;
          bestU = u;
          bestV = v;
        }
      }
    }
    if (!bestU || !bestV) break;
    addEdge(bestU, bestV);
    const q = [bestV];
    visited.add(bestV);
    while (q.length) {
      const c = q.shift();
      for (const e of buildAdj()[c]) {
        if (!visited.has(e.to)) {
          visited.add(e.to);
          q.push(e.to);
        }
      }
    }
    adj = buildAdj();
  }

  return { SIDEWALK_GRAPH_NODES: nodes, SIDEWALK_GRAPH_EDGES: edges, SIDEWALK_ADJ: adj };
})();

function findSidewalkNodeId(x, z, bankIsNorth) {
  let bestId = null;
  let bestDist = Infinity;
  for (const [id, pt] of Object.entries(SIDEWALK_GRAPH_NODES)) {
    if (bankIsNorth !== undefined && (pt[1] < riverZ(pt[0])) !== bankIsNorth) continue;
    const d = Math.hypot(pt[0] - x, pt[1] - z);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}

function findSidewalkEntryNodeId(sw) {
  const bankIsNorth = sw.z < riverZ(sw.x);
  if (sw.seg) {
    const id1 = findSidewalkNodeId(sw.seg.x1, sw.seg.z1, bankIsNorth);
    const id2 = findSidewalkNodeId(sw.seg.x2, sw.seg.z2, bankIsNorth);
    const d1 = id1 ? Math.hypot(SIDEWALK_GRAPH_NODES[id1][0] - sw.x, SIDEWALK_GRAPH_NODES[id1][1] - sw.z) : Infinity;
    const d2 = id2 ? Math.hypot(SIDEWALK_GRAPH_NODES[id2][0] - sw.x, SIDEWALK_GRAPH_NODES[id2][1] - sw.z) : Infinity;
    if (id1 && d1 <= d2) return id1;
    if (id2) return id2;
  }
  return findSidewalkNodeId(sw.x, sw.z, bankIsNorth);
}

function findSidewalkGraphPath(startId, endId, restrictNorth = null) {
  if (!startId || !endId) return [];
  if (startId === endId) return [SIDEWALK_GRAPH_NODES[startId].slice()];
  const dist = { [startId]: 0 };
  const prev = {};
  const unvisited = new Set(Object.keys(SIDEWALK_GRAPH_NODES));
  while (unvisited.size > 0) {
    let u = null;
    let uDist = Infinity;
    for (const id of unvisited) {
      const d = dist[id] !== undefined ? dist[id] : Infinity;
      if (d < uDist) {
        uDist = d;
        u = id;
      }
    }
    if (!u || !Number.isFinite(uDist) || u === endId) break;
    unvisited.delete(u);
    for (const edge of SIDEWALK_ADJ[u]) {
      if (!unvisited.has(edge.to)) continue;
      if (restrictNorth !== null) {
        const ptTo = SIDEWALK_GRAPH_NODES[edge.to];
        if ((ptTo[1] < riverZ(ptTo[0])) !== restrictNorth) continue;
      }
      const alt = uDist + edge.w;
      if (alt < (dist[edge.to] !== undefined ? dist[edge.to] : Infinity)) {
        dist[edge.to] = alt;
        prev[edge.to] = u;
      }
    }
  }
  if (prev[endId] === undefined) return [];
  const chain = [];
  let cur = endId;
  while (cur) {
    chain.push(SIDEWALK_GRAPH_NODES[cur].slice());
    cur = prev[cur];
  }
  chain.reverse();
  return chain;
}

function dedupeRoutePoints(pts) {
  const out = [];
  for (const pt of pts) {
    if (!pt) continue;
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 0.05) {
      out.push([pt[0], pt[1]]);
    }
  }
  return out;
}

function ensureBridgeOnlySidewalkPath(pts) {
  if (!pts || pts.length < 2) return pts || [];
  const safe = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = safe[safe.length - 1];
    const [bx, bz] = pts[i];
    const aNorth = az < riverZ(ax);
    const bNorth = bz < riverZ(bx);
    if (aNorth !== bNorth || segmentCrossesRiverOffBridge(ax, az, bx, bz)) {
      if (Math.abs(ax - BRIDGE.x) > 3.1 || Math.abs(bx - BRIDGE.x) > 3.1) {
        const swA = getClosestSidewalkPoint(ax, az);
        const swB = getClosestSidewalkPoint(bx, bz);
        const sideX = (ax + bx) >= 0 ? SIDEWALK_OFFSET : -SIDEWALK_OFFSET;
        const nA = findSidewalkEntryNodeId(swA) || (aNorth ? (sideX < 0 ? 'B_NW' : 'B_NE') : (sideX < 0 ? 'B_SW' : 'B_SE'));
        const nB = findSidewalkEntryNodeId(swB) || (bNorth ? (sideX < 0 ? 'B_NW' : 'B_NE') : (sideX < 0 ? 'B_SW' : 'B_SE'));
        const bridgeDetour = findSidewalkGraphPath(nA, nB);
        if (Math.hypot(swA.x - ax, swA.z - az) > 0.1) safe.push([swA.x, swA.z]);
        for (const p of bridgeDetour) safe.push(p);
        if (Math.hypot(bx - swB.x, bz - swB.z) > 0.1) safe.push([swB.x, swB.z]);
        safe.push([bx, bz]);
        continue;
      }
    }
    safe.push([bx, bz]);
  }
  return dedupeRoutePoints(safe);
}

function getResidentStreetRoute(res) {
  if (res.cachedRoute) return res.cachedRoute;
  const doorX = res.door[0];
  const doorZ = res.door[1];
  const sw = getClosestSidewalkPoint(doorX, doorZ);
  const resIsNorth = res.z < riverZ(res.x);
  const entryNodeId = findSidewalkEntryNodeId(sw);

  const waypoints = [entryNodeId];
  const crossesBridge = (Number(res.id) || 0) % 3 === 0;
  if (crossesBridge) {
    const destChoices = resIsNorth
      ? [
          [PLACES.tuz.x, PLACES.tuz.z],
          [PLACES.kocsma.x, PLACES.kocsma.z],
          [PLACES.malom.x, PLACES.malom.z],
          [0, 44],
        ]
      : [
          [PLACES.piac.x, PLACES.piac.z],
          [PLACES.vadaszhaz.x, PLACES.vadaszhaz.z],
          [16, -42],
          [-26, -34],
        ];
    const dest = destChoices[Math.floor(hash(res.name, 73) * destChoices.length)];
    const otherBankNode = findSidewalkNodeId(dest[0], dest[1], !resIsNorth);
    const secondNode = findSidewalkNodeId(res.x >= 0 ? 18 : -18, resIsNorth ? 22 : -36, !resIsNorth);
    if (otherBankNode && otherBankNode !== entryNodeId) waypoints.push(otherBankNode);
    if (secondNode && secondNode !== otherBankNode) waypoints.push(secondNode);
  } else {
    const sameSideTargets = resIsNorth
      ? [
          [0, -29], [28, -32], [-28, -32], [44, -52],
          [-44, -48], [PLACES.piac.x, PLACES.piac.z], [PLACES.vadaszhaz.x, PLACES.vadaszhaz.z],
        ]
      : [
          [PLACES.tuz.x, PLACES.tuz.z], [PLACES.kocsma.x, PLACES.kocsma.z],
          [-34, 4], [34, 4], [-32, 30], [32, 30], [0, 46], [-24, 52], [24, 52],
        ];
    const idxA = Math.floor(hash(res.name, 75) * sameSideTargets.length);
    const idxB = (idxA + 2 + Math.floor(hash(res.name, 79) * (sameSideTargets.length - 3))) % sameSideTargets.length;
    const wpA = findSidewalkNodeId(sameSideTargets[idxA][0], sameSideTargets[idxA][1], resIsNorth);
    const wpB = findSidewalkNodeId(sameSideTargets[idxB][0], sameSideTargets[idxB][1], resIsNorth);
    if (wpA && wpA !== entryNodeId) waypoints.push(wpA);
    if (wpB && wpB !== wpA && wpB !== entryNodeId) waypoints.push(wpB);
  }
  waypoints.push(entryNodeId);

  const loopPts = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const leg = findSidewalkGraphPath(a, b, crossesBridge ? null : resIsNorth);
    if (leg.length) loopPts.push(...leg);
  }

  const rawPts = [
    [doorX, doorZ],
    [sw.x, sw.z],
    ...loopPts,
    [sw.x, sw.z],
    [doorX, doorZ],
  ];
  const pts = ensureBridgeOnlySidewalkPath(dedupeRoutePoints(rawPts));
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
  const sideX = (x1 + x2) >= 0 ? SIDEWALK_OFFSET : -SIDEWALK_OFFSET;
  const firstBridgeZ = side1 ? BRIDGE.southZ + 0.6 : BRIDGE.northZ - 0.6;
  const secondBridgeZ = side1 ? BRIDGE.northZ - 0.6 : BRIDGE.southZ + 0.6;
  return ensureBridgeOnlySidewalkPath([
    [x1, z1],
    [sideX, firstBridgeZ],
    [sideX, secondBridgeZ],
    [x2, z2],
  ]);
}

function measureRoute(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    lengths.push(lengths[i - 1] + d);
  }
  const total = lengths[lengths.length - 1] || 0.01;
  const entryDist = lengths.length >= 2 ? lengths[1] : 0;
  const exitDist = lengths.length >= 2 ? lengths[lengths.length - 2] : total;
  const loopSpan = Math.max(0.01, exitDist - entryDist);
  return { points, lengths, total, entryDist, exitDist, loopSpan };
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

function computeDynamicProgress(res, elapsedSec) {
  const sched = ensureNpcScheduleProfile(res);
  const t = Math.max(0, elapsedSec);
  const cycleIdx = Math.floor(t / NPC_CYCLE_SEC);
  const modT = t - cycleIdx * NPC_CYCLE_SEC;
  const slot = Math.min(NPC_CYCLE_SLICES - 1, Math.floor(modT / NPC_SLICE_SEC));
  const dt = modT - slot * NPC_SLICE_SEC;

  const baseDist = cycleIdx * sched.cycleTotalDist + sched.prefixDist[slot];
  const sMode = sched.sliceModes[slot];
  const preSpeed = sched.preSpeeds[slot];

  if (sMode === 1) {
    const pauseDur = sched.pauseDurs[slot];
    if (dt < pauseDur) {
      return { mode: 'idle', speed: 0, dist: baseDist };
    }
    const moveDt = dt - pauseDur;
    return { mode: 'walk', speed: preSpeed, dist: baseDist + moveDt * preSpeed };
  }
  return {
    mode: sMode === 2 ? 'run' : 'walk',
    speed: preSpeed,
    dist: baseDist + dt * preSpeed,
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
      returning: false,
      x: res.door[0],
      z: res.door[1],
      heading: res.rot || 0,
      speed: 0,
      dist: 0,
      visible: false,
    };
  }

  const route = getResidentStreetRoute(res);
  const halfSpan = route.loopSpan * 0.5 + route.entryDist;
  const returnWindow = Math.max(90, Math.ceil(halfSpan / 2.2));
  const returnStart = Math.max(wakeSec + 60, bedtimeSec - returnWindow);

  // 2. Reggeli ébredéskor az első 60 másodpercben a házból kilép a kerti járdán a közterületi járdára
  if (sec >= wakeSec && sec < wakeSec + 60) {
    const pDoor = route.points[0];
    const pRoad = route.points[1] || route.points[0];
    const t = (sec - wakeSec) / 60;
    const x = pDoor[0] + (pRoad[0] - pDoor[0]) * t;
    const z = pDoor[1] + (pRoad[1] - pDoor[1]) * t;
    return {
      mode: 'walk',
      returning: false,
      x,
      z,
      heading: Math.atan2(pRoad[0] - pDoor[0], pRoad[1] - pDoor[1]),
      speed: route.entryDist / 60,
      dist: route.entryDist * t,
      visible: true,
    };
  }

  // 3. Esti ugrásmentes, szigorúan járda/híd-alapú hazatérés a legrövidebb irányban
  if (sec >= returnStart && sec < bedtimeSec) {
    const progSwitch = computeDynamicProgress(res, Math.max(0, returnStart - (wakeSec + 60)));
    const posAtSwitch = route.entryDist + (progSwitch.dist % route.loopSpan);
    const fwdDist = route.total - posAtSwitch;
    const bwdDist = posAtSwitch;
    const goForward = fwdDist <= bwdDist;
    const remDist = goForward ? fwdDist : bwdDist;
    const t = Math.max(0, Math.min(1, (sec - returnStart) / returnWindow));
    const distNow = goForward ? (posAtSwitch + remDist * t) : (posAtSwitch - remDist * t);
    const p = positionAlong(route, distNow);
    const retSpeed = Math.min(MAX_NPC_SPEED, remDist / returnWindow);
    return {
      mode: 'walk',
      returning: true,
      x: p.x,
      z: p.z,
      heading: goForward ? p.heading : (p.heading + Math.PI),
      speed: retSpeed,
      dist: progSwitch.dist + remDist * t,
      visible: true,
    };
  }

  // 4. Nappali dinamikus járdaséta, megállások és futás (kizárólag közterületi járdán és hídon)
  const elapsed = Math.max(0, sec - (wakeSec + 60));
  const prog = computeDynamicProgress(res, elapsed);
  const routeDist = route.entryDist + (prog.dist % route.loopSpan);
  const p = positionAlong(route, routeDist);
  return {
    mode: prog.mode,
    returning: false,
    x: p.x,
    z: p.z,
    heading: p.heading,
    speed: prog.speed,
    dist: prog.dist,
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
function setView(x, z, dist, azimuth = camAzimuth, polar = camPolar, targetY = null) {
  camAzimuth = azimuth;
  camPolar = polar;
  const groundY = targetY !== null ? targetY : getTerrainElevation(x, z);
  controls.target.set(x, groundY, z);
  const sinP = Math.sin(polar);
  const cosP = Math.cos(polar);
  camera.position.set(
    x + dist * sinP * Math.sin(azimuth),
    groundY + dist * cosP,
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
    fromY: controls.target.y,
    fromZ: controls.target.z,
    fromDist,
    fromAzimuth: camAzimuth,
    fromPolar: camPolar,
    x,
    y: getTerrainElevation(x, z),
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
let lastShadowSunIntensity = -1;

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
  if (Math.abs(sun.intensity - lastShadowSunIntensity) > 0.04) {
    lastShadowSunIntensity = sun.intensity;
    renderer.shadowMap.needsUpdate = true;
  }

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
  const clockEl = el('clock-text');
  const nextClockText = `${hh}:${mm} · ${outsideCount} lakos van kint`;
  if (clockEl._lastClockText !== nextClockText) {
    clockEl._lastClockText = nextClockText;
    clockEl.textContent = nextClockText;
  }
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
  renderer.shadowMap.needsUpdate = true;
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

const DRAWER_IDS = ['activities-drawer', 'claim-drawer', 'add-drawer', 'chronicle-drawer', 'supabase-modal'];
let canSyncResponsiveUI = false;

function isMobileViewport() {
  return (
    window.innerWidth <= 1180 ||
    Boolean(window.matchMedia?.('(pointer: coarse)').matches) ||
    Boolean(window.matchMedia?.('(hover: none)').matches) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth <= 1366)
  );
}

function closeAllDrawers(exceptId = null) {
  for (const id of DRAWER_IDS) {
    if (id === exceptId) continue;
    const node = el(id);
    if (node) node.hidden = true;
  }
}

function prepareDrawerOpen(drawerId) {
  closeAllDrawers(drawerId);
  if (isMobileViewport()) {
    if (canSyncResponsiveUI && walker) setWalker(false);
    if (el('card') && !el('card').hidden) closeCard();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
}

function syncResponsiveUIState() {
  if (!canSyncResponsiveUI) return;
  const isMobile = isMobileViewport();
  document.body.classList.toggle('is-mobile-ui', isMobile);
  if (!isMobile && el('search')) {
    el('search').hidden = false;
  }
  const anyDrawerOpen = DRAWER_IDS.some((id) => Boolean(el(id) && !el(id).hidden));
  const cardOpen = Boolean(el('card') && !el('card').hidden);

  if (isMobile && anyDrawerOpen && cardOpen) {
    closeCard();
    return;
  }

  const showBackdrop = isMobile && (anyDrawerOpen || cardOpen);
  const backdrop = el('drawer-backdrop');
  if (backdrop) {
    backdrop.hidden = !showBackdrop;
    backdrop.classList.toggle('open', showBackdrop);
  }

  const isWalkActive = Boolean(walker);
  const isActivitiesOpen = Boolean(el('activities-drawer') && !el('activities-drawer').hidden);
  const isLeaderboardActive = isActivitiesOpen && activeMenuTab === 'leaderboard';
  const isMenuActive = isActivitiesOpen && activeMenuTab !== 'leaderboard';
  const isHomeActive = Boolean(
    (el('claim-drawer') && !el('claim-drawer').hidden) ||
    (el('add-drawer') && !el('add-drawer').hidden) ||
    (cardOpen && currentConnectedUser && selectedRes?.name?.toLowerCase() === currentConnectedUser.toLowerCase())
  );
  const isMapActive = !isWalkActive && !isLeaderboardActive && !isMenuActive && !isHomeActive;

  el('mob-nav-walk')?.classList.toggle('active', isWalkActive);
  el('mob-nav-leaderboard')?.classList.toggle('active', isLeaderboardActive);
  el('mob-nav-menu')?.classList.toggle('active', isMenuActive);
  el('mob-nav-home')?.classList.toggle('active', isHomeActive);
  el('mob-nav-map')?.classList.toggle('active', isMapActive);
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
  closeAllDrawers();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  if (el('mobile-bottom-nav')) el('mobile-bottom-nav').hidden = true;
  document.body.classList.add('room-mode');
  el('room-hud').hidden = false;
  el('room-title').textContent = `🏠 @${data.owner} szobája`;

  controls.enabled = false;
  roomControls.enabled = true;
  roomCamera.position.set(5.5, 5.2, 6.5);
  roomControls.target.set(0, 0.6, 0);
  roomControls.update();

  rebuildRoom3D();
  renderRoomEditorUI();
  syncResponsiveUIState();
  renderer.shadowMap.needsUpdate = true;
}

function exitRoomInterior() {
  inRoomMode = false;
  activeRoomData = null;
  draggingFurnitureMesh = null;
  roomControls.enabled = false;
  controls.enabled = true;

  el('room-hud').hidden = true;
  document.body.classList.remove('room-mode');
  if (el('mobile-bottom-nav')) el('mobile-bottom-nav').hidden = false;
  el('zen-toggle-btn').hidden = false;
  el('top').hidden = false;
  el('vote').hidden = false;
  el('cam-widget').hidden = false;
  el('labels').hidden = false;
  syncResponsiveUIState();
  renderer.shadowMap.needsUpdate = true;
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
  prepareDrawerOpen('claim-drawer');
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
  syncResponsiveUIState();
}

el('claim-open').addEventListener('click', () => {
  if (el('claim-drawer').hidden) openClaimDrawer();
  else {
    el('claim-drawer').hidden = true;
    syncResponsiveUIState();
  }
});
el('claim-close').addEventListener('click', () => {
  el('claim-drawer').hidden = true;
  syncResponsiveUIState();
});

el('claim-quick-btn').addEventListener('click', async () => {
  const chosen = el('claim-quick-select').value;
  if (!chosen || chosen.toLowerCase() === 'gulyas_mester') return;
  await bindUserQuickly(chosen);
  flyToMyOwnHouse();
});

if (el('claim-to-add-btn')) {
  el('claim-to-add-btn').addEventListener('click', () => {
    openAddDrawer();
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

  const st = whereIs(res, sec);
  if (st.mode === 'sleep') {
    return `🌙 Otthon alszik a házában (${bStr} - ${wStr})`;
  }

  if (st.returning) {
    return `🏡 Épp a járdán hazafelé sétál aludni (${bStr})`;
  }

  if (sec >= wakeSec && sec < wakeSec + 60) {
    return `☀️ Épp kilép a házából az utcára sétálni (${wStr})`;
  }

  if (st.mode === 'idle') {
    return '👀 Épp megállt körülnézni a járdán';
  }
  if (st.mode === 'run') {
    return '🏃 Épp kocog / siet a járdán';
  }
  return '🚶 Épp sétál a falusi járdán';
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
  const lower = res.name.toLowerCase();
  const priv = housePrivacyMap[lower] || 'public';
  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === lower;
  const isDev = lower === DEVELOPER_HANDLE;
  badge.hidden = false;
  if (isDev) {
    badge.textContent = `${isMine ? '🏠 Saját házam · ' : ''}👑 Fejlesztői Domb (Fenntartott)`;
    badge.className = 'badge open';
  } else {
    badge.textContent = `${isMine ? '🏠 Saját házam · ' : ''}${priv === 'private' ? '🔒 Zárt ház' : '🌍 Nyitott ház'}`;
    badge.className = `badge ${priv === 'private' ? 'locked' : 'open'}`;
  }
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
  queueCloudLeaderboardPush();
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

// --- 11.3 SUPABASE VALÓS IDEJŰ (REALTIME WEBSOCKET) & FELHŐ SZINKRONIZÁCIÓ ---
// A Supabase Realtime csatornája valós időben (WebSocketen) továbbítja a szavazatokat és a ranglistát,
// így minden látogató azonnal látja a változásokat!
const DEFAULT_SUPABASE_CONFIG = {
  url: '',
  anonKey: ''
};

function getActiveSupabaseConfig() {
  try {
    const saved = localStorage.getItem('kisfalu_supabase_config');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.url && parsed.anonKey) return parsed;
    }
  } catch { /* fallback */ }
  const params = new URLSearchParams(window.location.search);
  const qUrl = params.get('supabase_url');
  const qKey = params.get('supabase_key');
  if (qUrl && qKey) {
    return { url: qUrl, anonKey: qKey };
  }
  return DEFAULT_SUPABASE_CONFIG;
}

const CLOUD_SYNC_URL = 'https://api.restful-api.dev/objects/ff808181a09d98f701a1c6cb684f00d7';

let supabase = null;
let supabaseRealtimeChannel = null;
let supabaseStatus = 'unconfigured'; // 'connected' | 'connecting' | 'error' | 'unconfigured'

let cloudState = {
  votes: { pekseg: 52, ortorony: 40, konyvtar: 28 },
  leaderboard: {}
};
let cloudLastSyncedAt = null;
let leaderboardMetric = 'xp'; // 'xp' vagy 'coins'

// A falu 24 kanonikus lakója saját kiinduló XP-vel és Tallérral a Ranglistán
const CANONICAL_LEADERBOARD = [
  { name: 'gulyas_mester', displayName: 'Gulyás Mester (Dev)', title: 'Főszakács & Fejlesztő', xp: 950, coins: 680, isNpc: true },
  { name: 'csapos_bela', displayName: 'Csapos Béla', title: 'Kocsmáros', xp: 580, coins: 490, isNpc: true },
  { name: 'solyom_bence', displayName: 'Sólyom Bence', title: 'Fősolymász', xp: 520, coins: 410, isNpc: true },
  { name: 'vadasz_dani', displayName: 'Vadász Dani', title: 'Fővadász', xp: 480, coins: 360, isNpc: true },
  { name: 'langos_laci', displayName: 'Lángos Laci', title: 'Piacos Pékmester', xp: 440, coins: 390, isNpc: true },
  { name: 'harcsa_huba', displayName: 'Harcsa Huba', title: 'Öreg Főhorgász', xp: 410, coins: 340, isNpc: true },
  { name: 'piacos_marika', displayName: 'Piacos Marika', title: 'Kofaasszony', xp: 390, coins: 430, isNpc: true },
  { name: 'mehesz_mate', displayName: 'Méhész Máté', title: 'Méhészmester', xp: 370, coins: 310, isNpc: true },
  { name: 'szaki_jani', displayName: 'Szaki Jani', title: 'Kovács & Ezermester', xp: 350, coins: 300, isNpc: true },
  { name: 'almabor_akos', displayName: 'Almabor Ákos', title: 'Falusi Borász', xp: 320, coins: 280, isNpc: true },
  { name: 'citeras_csabi', displayName: 'Citerás Csabi', title: 'Falusi Dalnok', xp: 310, coins: 250, isNpc: true },
  { name: 'kalandor_lili', displayName: 'Kalandor Lili', title: 'Vándor Felfedező', xp: 290, coins: 220, isNpc: true },
  { name: 'pecas_peti', displayName: 'Pecás Peti', title: 'Horgásztanonc', xp: 270, coins: 210, isNpc: true },
  { name: 'sajtos_bandi', displayName: 'Sajtos Bandi', title: 'Sajtmester', xp: 250, coins: 260, isNpc: true },
  { name: 'kukta_kata', displayName: 'Kukta Kata', title: 'Segédszakács', xp: 240, coins: 190, isNpc: true },
  { name: 'bogyos_zsuzsi', displayName: 'Bogyós Zsuzsi', title: 'Füvesasszony', xp: 220, coins: 230, isNpc: true },
  { name: 'tulparti_tomi', displayName: 'Túlparti Tomi', title: 'Révészlegény', xp: 200, coins: 180, isNpc: true },
  { name: 'kandallo_krisz', displayName: 'Kandalló Krisz', title: 'Fahasogató', xp: 190, coins: 170, isNpc: true },
  { name: 'pipas_pista', displayName: 'Pipás Pista', title: 'Öreg Krónikás', xp: 180, coins: 160, isNpc: true },
  { name: 'vadmalac_viki', displayName: 'Vadmalac Viki', title: 'Erdei Nyomolvasó', xp: 170, coins: 150, isNpc: true },
  { name: 'erdo_betyar', displayName: 'Erdő Betyár', title: 'Betyárvezér', xp: 160, coins: 240, isNpc: true },
  { name: 'torzsvendeg_feri', displayName: 'Törzsvendég Feri', title: 'Kocsmai Szónok', xp: 140, coins: 120, isNpc: true },
  { name: 'kobor_kevin', displayName: 'Kóbor Kevin', title: 'Falusi Csalavér', xp: 120, coins: 110, isNpc: true },
  { name: 'szundi_szabi', displayName: 'Szundi Szabi', title: 'Főtéri Álomszuszék', xp: 90, coins: 80, isNpc: true }
];

function getVoteLabel(key) {
  if (key === 'pekseg') return '🥐 Falusi Pékség és Kemence';
  if (key === 'ortorony') return '🗼 Magas Fenyő Őrtorony';
  if (key === 'konyvtar') return '📚 Falusi Könyvtár és Olvasókör';
  return key;
}

function updateVoteBannerUI() {
  const v = (cloudState && cloudState.votes) || (playerRpg && playerRpg.votes) || { pekseg: 52, ortorony: 40, konyvtar: 28 };
  const txt = el('vote-text');
  if (txt) {
    txt.innerHTML = `Szavazás állása: <b>Pékség (${v.pekseg || 0})</b> · <b>Őrtorony (${v.ortorony || 0})</b> · <b>Könyvtár (${v.konyvtar || 0})</b>`;
  }
}

function updateSupabaseStatusUI() {
  const badge = el('sb-badge-pill');
  if (badge) {
    if (supabaseStatus === 'connected') {
      badge.textContent = '⚡ Supabase Realtime: Csatlakozva';
      badge.style.color = '#15803d';
      badge.style.background = '#dcfce7';
      badge.style.border = '1px solid #86efac';
    } else if (supabaseStatus === 'connecting') {
      badge.textContent = '⏳ Supabase: Csatlakozás...';
      badge.style.color = '#854d0e';
      badge.style.background = '#fef9c3';
      badge.style.border = '1px solid #fde047';
    } else if (supabaseStatus === 'error') {
      badge.textContent = '⚠️ Supabase: Kapcsolódási hiba';
      badge.style.color = '#991b1b';
      badge.style.background = '#fee2e2';
      badge.style.border = '1px solid #fca5a5';
    } else {
      badge.textContent = '⚙️ Supabase: Nincs beállítva';
      badge.style.color = 'var(--muted)';
      badge.style.background = 'var(--paper-hover)';
      badge.style.border = '1px solid #d4c29d';
    }
  }
  updateSupabaseModalStatus();
}

function updateSupabaseModalStatus() {
  const box = el('sb-status-box');
  if (!box) return;
  if (supabaseStatus === 'connected') {
    box.style.color = '#15803d';
    box.innerHTML = '🟢 <b>Csatlakoztatva:</b> Valós idejű WebSocket Realtime kapcsolat aktív!';
  } else if (supabaseStatus === 'connecting') {
    box.style.color = '#854d0e';
    box.innerHTML = '⏳ <b>Csatlakozás folyamatban...</b>';
  } else if (supabaseStatus === 'error') {
    box.style.color = '#991b1b';
    box.innerHTML = '⚠️ <b>Hiba történt:</b> Ellenőrizd a megadott Project URL-t és Anon kulcsot!';
  } else {
    box.style.color = 'var(--muted)';
    box.innerHTML = '⚪ <b>Nincs Supabase beállítva:</b> Jelenleg az automatikus REST felhő DB szinkronizáció aktív.';
  }
}

async function fetchSupabaseData() {
  if (!supabase) return;
  try {
    const { data: vData, error: vErr } = await supabase.from('community_votes').select('*');
    if (!vErr && vData && vData.length) {
      for (const row of vData) {
        cloudState.votes[row.option_key] = row.votes_count;
      }
      if (playerRpg) playerRpg.votes = { ...playerRpg.votes, ...cloudState.votes };
      updateVoteBannerUI();
    }

    const { data: lbData, error: lbErr } = await supabase.from('village_leaderboard').select('*');
    if (!lbErr && lbData && lbData.length) {
      for (const row of lbData) {
        cloudState.leaderboard[row.username] = {
          name: row.username,
          displayName: row.display_name,
          title: row.title,
          xp: row.xp,
          coins: row.coins,
          lastActive: Date.now()
        };
      }
      if (!el('activities-drawer').hidden && activeMenuTab === 'leaderboard') {
        renderActivitiesContent();
      }
    }
    cloudLastSyncedAt = Date.now();
  } catch (err) {
    console.warn('fetchSupabaseData hiba:', err);
  }
}

async function initSupabase() {
  const cfg = getActiveSupabaseConfig();
  if (!cfg.url || !cfg.anonKey) {
    supabaseStatus = 'unconfigured';
    updateSupabaseStatusUI();
    return;
  }

  try {
    supabaseStatus = 'connecting';
    updateSupabaseStatusUI();
    supabase = createClient(cfg.url, cfg.anonKey, {
      realtime: {
        params: {
          eventsPerSecond: 10
        }
      }
    });

    // Feliratkozás valós idejű WebSocket csatornára
    supabaseRealtimeChannel = supabase.channel('bogracsfalva_realtime', {
      config: { broadcast: { self: false } }
    });

    supabaseRealtimeChannel
      // A) Postgres Changes események (Adatbázis táblák valós idejű változásai)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'community_votes' }, (payload) => {
        console.log('⚡ [Supabase Realtime] Szavazat tábla változás:', payload);
        if (payload.new && payload.new.option_key) {
          cloudState.votes[payload.new.option_key] = payload.new.votes_count;
          if (playerRpg) playerRpg.votes[payload.new.option_key] = payload.new.votes_count;
          updateVoteBannerUI();
          if (!el('activities-drawer').hidden) renderActivitiesContent();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'village_leaderboard' }, (payload) => {
        console.log('⚡ [Supabase Realtime] Ranglista tábla változás:', payload);
        if (payload.new && payload.new.username) {
          cloudState.leaderboard[payload.new.username] = {
            name: payload.new.username,
            displayName: payload.new.display_name || payload.new.username,
            title: payload.new.title,
            xp: payload.new.xp,
            coins: payload.new.coins,
            lastActive: Date.now()
          };
          if (!el('activities-drawer').hidden && activeMenuTab === 'leaderboard') {
            renderActivitiesContent();
          }
        }
      })
      // B) Realtime Broadcast események (Azonnali kliens-közti WebSocket üzenetek)
      .on('broadcast', { event: 'vote_cast' }, ({ payload }) => {
        console.log('⚡ [Supabase Broadcast] Szavazat érkezett:', payload);
        if (payload && payload.votes) {
          cloudState.votes = { ...cloudState.votes, ...payload.votes };
          if (playerRpg) playerRpg.votes = { ...playerRpg.votes, ...cloudState.votes };
          updateVoteBannerUI();
          if (!el('activities-drawer').hidden) renderActivitiesContent();
        }
      })
      .on('broadcast', { event: 'leaderboard_update' }, ({ payload }) => {
        console.log('⚡ [Supabase Broadcast] Ranglista frissítés érkezett:', payload);
        if (payload && payload.user) {
          cloudState.leaderboard[payload.user.name] = payload.user;
          if (!el('activities-drawer').hidden && activeMenuTab === 'leaderboard') {
            renderActivitiesContent();
          }
        }
      })
      .subscribe((status) => {
        console.log('⚡ Supabase Realtime állapot:', status);
        if (status === 'SUBSCRIBED') {
          supabaseStatus = 'connected';
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          supabaseStatus = 'error';
        }
        updateSupabaseStatusUI();
      });

    // Kezdeti adatok lekérése a Supabase adatbázisból
    await fetchSupabaseData();
  } catch (err) {
    console.warn('Supabase inicializálási hiba:', err);
    supabaseStatus = 'error';
    updateSupabaseStatusUI();
  }
}

async function fetchCloudState() {
  if (supabase && supabaseStatus === 'connected') {
    await fetchSupabaseData();
    return;
  }
  try {
    const res = await fetch(CLOUD_SYNC_URL);
    if (!res.ok) return;
    const body = await res.json();
    if (body && body.data) {
      if (body.data.votes) {
        cloudState.votes = { ...cloudState.votes, ...body.data.votes };
        if (playerRpg) {
          playerRpg.votes = { ...playerRpg.votes, ...cloudState.votes };
        }
        updateVoteBannerUI();
      }
      if (body.data.leaderboard) {
        cloudState.leaderboard = { ...cloudState.leaderboard, ...body.data.leaderboard };
      }
      cloudLastSyncedAt = Date.now();
      if (!el('activities-drawer').hidden && (activeMenuTab === 'community' || activeMenuTab === 'leaderboard')) {
        renderActivitiesContent();
      }
    }
  } catch (err) {
    console.warn('Cloud sync hiba:', err);
  }
}

async function pushCloudVote(voteKey, prevKey = null) {
  // 1. Optimistic lokális frissítés
  cloudState.votes[voteKey] = (cloudState.votes[voteKey] || 0) + 1;
  if (prevKey && cloudState.votes[prevKey] !== undefined) {
    cloudState.votes[prevKey] = Math.max(0, cloudState.votes[prevKey] - 1);
  }
  updateVoteBannerUI();

  // 2. Ha van aktív Supabase kapcsolat: Realtime Broadcast + DB mentés
  if (supabase) {
    try {
      if (supabaseRealtimeChannel) {
        supabaseRealtimeChannel.send({
          type: 'broadcast',
          event: 'vote_cast',
          payload: { votes: cloudState.votes, voteKey, voter: currentConnectedUser }
        });
      }

      await supabase.from('community_votes').upsert([
        { option_key: voteKey, label: getVoteLabel(voteKey), votes_count: cloudState.votes[voteKey], updated_at: new Date().toISOString() },
        ...(prevKey ? [{ option_key: prevKey, label: getVoteLabel(prevKey), votes_count: cloudState.votes[prevKey], updated_at: new Date().toISOString() }] : [])
      ]);
    } catch (sbErr) {
      console.warn('Supabase szavazat mentési hiba:', sbErr);
    }
  }

  // 3. Tartalék REST szinkronizáció
  try {
    let currentData = { votes: cloudState.votes, leaderboard: cloudState.leaderboard };
    try {
      const getRes = await fetch(CLOUD_SYNC_URL);
      if (getRes.ok) {
        const body = await getRes.json();
        if (body && body.data) currentData = body.data;
      }
    } catch { /* fallback */ }

    currentData.votes = currentData.votes || {};
    if (prevKey && currentData.votes[prevKey] !== undefined) {
      currentData.votes[prevKey] = Math.max(0, currentData.votes[prevKey] - 1);
    }
    currentData.votes[voteKey] = (currentData.votes[voteKey] || 0) + 1;

    await fetch(CLOUD_SYNC_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: currentData })
    });
  } catch (err) {
    console.warn('REST fallback hiba:', err);
  }
}

let pushLeaderboardTimeout = null;
function queueCloudLeaderboardPush() {
  if (!playerRpg) return;
  const username = currentConnectedUser || 'vendeg_jatekos';
  if (pushLeaderboardTimeout) clearTimeout(pushLeaderboardTimeout);
  pushLeaderboardTimeout = setTimeout(async () => {
    try {
      const { title } = getPlayerLevelInfo();
      const patchObj = {
        name: username,
        displayName: currentConnectedUser ? `@${currentConnectedUser}` : 'Vándor (Te)',
        title,
        xp: playerRpg.xp,
        coins: playerRpg.coins,
        lastActive: Date.now()
      };
      cloudState.leaderboard[username] = patchObj;

      // 1. Supabase Realtime Broadcast + DB mentés
      if (supabase) {
        try {
          if (supabaseRealtimeChannel) {
            supabaseRealtimeChannel.send({
              type: 'broadcast',
              event: 'leaderboard_update',
              payload: { user: patchObj }
            });
          }

          await supabase.from('village_leaderboard').upsert({
            username,
            display_name: patchObj.displayName,
            title: patchObj.title,
            xp: patchObj.xp,
            coins: patchObj.coins,
            updated_at: new Date().toISOString()
          });
        } catch (sbErr) {
          console.warn('Supabase leaderboard mentési hiba:', sbErr);
        }
      }

      // 2. Tartalék REST szinkronizáció
      let currentData = { votes: cloudState.votes, leaderboard: cloudState.leaderboard };
      try {
        const res = await fetch(CLOUD_SYNC_URL);
        if (res.ok) {
          const body = await res.json();
          if (body && body.data) currentData = body.data;
        }
      } catch { /* fallback */ }

      currentData.leaderboard = currentData.leaderboard || {};
      currentData.leaderboard[username] = patchObj;

      await fetch(CLOUD_SYNC_URL, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: currentData })
      });
      cloudLastSyncedAt = Date.now();
    } catch (err) {
      console.warn('Leaderboard küldési hiba:', err);
    }
  }, 1200);
}

function openSupabaseModal() {
  const modal = el('supabase-modal');
  if (!modal) return;
  prepareDrawerOpen('supabase-modal');
  const cfg = getActiveSupabaseConfig();
  el('sb-input-url').value = cfg.url || '';
  el('sb-input-key').value = cfg.anonKey || '';
  updateSupabaseModalStatus();
  modal.hidden = false;
  syncResponsiveUIState();
}

el('supabase-modal-close')?.addEventListener('click', () => {
  el('supabase-modal').hidden = true;
  syncResponsiveUIState();
});

el('sb-save-btn')?.addEventListener('click', async () => {
  const url = el('sb-input-url').value.trim();
  const key = el('sb-input-key').value.trim();
  if (!url || !key) {
    alert('Kérlek add meg a Supabase Project URL-t és az Anon kulcsot!');
    return;
  }
  localStorage.setItem('kisfalu_supabase_config', JSON.stringify({ url, anonKey: key }));
  showMenuToast('⚡ Supabase kapcsolat mentve! Csatlakozás...');
  await initSupabase();
  updateSupabaseModalStatus();
  setTimeout(() => {
    if (supabaseStatus === 'connected') {
      showMenuToast('🎉 Sikeresen csatlakozva a Supabase Realtime-hoz!');
      el('supabase-modal').hidden = true;
      if (!el('activities-drawer').hidden) renderActivitiesContent();
      syncResponsiveUIState();
    }
  }, 800);
});

el('sb-clear-btn')?.addEventListener('click', () => {
  localStorage.removeItem('kisfalu_supabase_config');
  el('sb-input-url').value = '';
  el('sb-input-key').value = '';
  supabase = null;
  supabaseRealtimeChannel = null;
  supabaseStatus = 'unconfigured';
  updateSupabaseStatusUI();
  updateSupabaseModalStatus();
  showMenuToast('Supabase kapcsolat törölve. Fallback REST szinkron aktív.');
});

// Kezdeti Supabase inicializálás és háttér-lekérés
initSupabase();
fetchCloudState();
setInterval(fetchCloudState, 8000);

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
    // 1. Szavazás szekció (Élő felhő DB szinkronizációval!)
    const voteOptions = [
      { key: 'pekseg', label: '🥐 Falusi Pékség és Kemence' },
      { key: 'ortorony', label: '🗼 Magas Fenyő Őrtorony' },
      { key: 'konyvtar', label: '📚 Falusi Könyvtár és Olvasókör' },
    ];
    const liveVotes = (cloudState && cloudState.votes) || playerRpg.votes;
    for (const vo of voteOptions) {
      const count = liveVotes[vo.key] || 0;
      const isChosen = playerRpg.stats.votedOption === vo.key;
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.innerHTML = `
        <div class="menu-item-info">
          <b>${vo.label}</b>
          <span>Jelenlegi szavazatok: <b>${count} db</b> <small style="color:var(--muted); font-size:11px;">(Élő felhő DB)</small></span>
          ${isChosen ? '<span class="reward-tag">✓ Erre szavaztál!</span>' : ''}
        </div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-act-btn';
      btn.textContent = isChosen ? '✓ Szavazatod' : '🗳️ Szavazok';
      btn.addEventListener('click', async () => {
        if (playerRpg.stats.votedOption === vo.key) return;
        const prev = playerRpg.stats.votedOption;
        if (!playerRpg.stats.votedOption) {
          playerRpg.xp += 15;
        }
        playerRpg.stats.votedOption = vo.key;
        savePlayerRpg();
        showMenuToast(`🗳️ Szavazatodat beküldtük a felhőbe: ${vo.label}!`);
        await pushCloudVote(vo.key, prev);
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
    return;
  }

  if (activeMenuTab === 'leaderboard') {
    // 1. Metrika választó fülek (XP vagy Tallér)
    const subtabs = document.createElement('div');
    subtabs.className = 'lb-subtabs';
    subtabs.innerHTML = `
      <button class="lb-subtab ${leaderboardMetric === 'xp' ? 'active' : ''}" type="button" data-metric="xp">✨ Legtöbb XP (Tapasztalat)</button>
      <button class="lb-subtab ${leaderboardMetric === 'coins' ? 'active' : ''}" type="button" data-metric="coins">🪙 Legtöbb Tallér (Vagyon)</button>
    `;
    subtabs.querySelectorAll('.lb-subtab').forEach((b) => {
      b.addEventListener('click', () => {
        leaderboardMetric = b.dataset.metric;
        renderActivitiesContent();
      });
    });
    container.append(subtabs);

    // 2. Adatok összeállítása: 24 kanonikus lakos + Cloud játékosok + Aktív látogató
    const map = new Map();
    for (const c of CANONICAL_LEADERBOARD) {
      map.set(c.name, { ...c });
    }
    if (cloudState && cloudState.leaderboard) {
      for (const [k, v] of Object.entries(cloudState.leaderboard)) {
        if (map.has(k)) {
          const ex = map.get(k);
          ex.xp = Math.max(ex.xp, v.xp || 0);
          ex.coins = Math.max(ex.coins, v.coins || 0);
          if (v.title) ex.title = v.title;
        } else {
          map.set(k, {
            name: k,
            displayName: v.displayName || k,
            title: v.title || 'Falusi Polgár',
            xp: v.xp || 0,
            coins: v.coins || 0,
            isNpc: false
          });
        }
      }
    }

    const activeUser = currentConnectedUser || 'vendeg_jatekos';
    const { title: myTitle } = getPlayerLevelInfo();
    const myEntry = map.get(activeUser) || {
      name: activeUser,
      displayName: currentConnectedUser ? `@${currentConnectedUser}` : 'Vándor (Te)',
      title: myTitle,
      xp: playerRpg.xp,
      coins: playerRpg.coins,
      isNpc: false
    };
    myEntry.xp = playerRpg.xp;
    myEntry.coins = playerRpg.coins;
    myEntry.title = myTitle;
    map.set(activeUser, myEntry);

    const list = Array.from(map.values());
    list.sort((a, b) => {
      const valA = leaderboardMetric === 'xp' ? a.xp : a.coins;
      const valB = leaderboardMetric === 'xp' ? b.xp : b.coins;
      if (valB !== valA) return valB - valA;
      return leaderboardMetric === 'xp' ? b.coins - a.coins : b.xp - a.xp;
    });

    // 3. Kiemelve a három toplistásat (Podium / Dobogó: 2. Hely - 1. Hely - 3. Hely)
    const top1 = list[0];
    const top2 = list[1];
    const top3 = list[2];

    const podiumWrap = document.createElement('div');
    podiumWrap.className = 'podium-wrap';

    const renderPodiumCard = (entry, rank, cls, badge) => {
      if (!entry) return '';
      const isMe = entry.name === currentConnectedUser || (!currentConnectedUser && entry.name === 'vendeg_jatekos');
      const primaryVal = leaderboardMetric === 'xp' ? `${entry.xp} XP` : `${entry.coins} 🪙`;
      const secondaryVal = leaderboardMetric === 'xp' ? `${entry.coins} Tallér` : `${entry.xp} XP`;
      return `
        <div class="podium-card ${cls} ${isMe ? 'is-me' : ''}">
          <div class="podium-badge">${badge}</div>
          <div class="podium-name" title="${entry.displayName}">${entry.displayName}${isMe ? ' (Te)' : ''}</div>
          <div class="podium-title">${entry.title}</div>
          <div class="podium-score">${primaryVal}</div>
          <div class="podium-subscore">${secondaryVal}</div>
        </div>
      `;
    };

    podiumWrap.innerHTML = `
      <div class="podium-col">${renderPodiumCard(top2, 2, 'rank-2', '🥈 2. Hely')}</div>
      <div class="podium-col">${renderPodiumCard(top1, 1, 'rank-1', '👑 1. Hely')}</div>
      <div class="podium-col">${renderPodiumCard(top3, 3, 'rank-3', '🥉 3. Hely')}</div>
    `;
    container.append(podiumWrap);

    // 4. További ranglista sorok (4. helytől kezdve)
    const listWrap = document.createElement('div');
    listWrap.className = 'menu-card-list';
    for (let i = 3; i < list.length; i++) {
      const it = list[i];
      const isMe = it.name === currentConnectedUser || (!currentConnectedUser && it.name === 'vendeg_jatekos');
      const primaryVal = leaderboardMetric === 'xp' ? `${it.xp} XP` : `${it.coins} Tallér`;
      const secondaryVal = leaderboardMetric === 'xp' ? `${it.coins} Tallér` : `${it.xp} XP`;

      const row = document.createElement('div');
      row.className = `lb-row ${isMe ? 'is-me' : ''}`;
      row.innerHTML = `
        <span class="lb-rank-num">${i + 1}.</span>
        <div class="lb-user-info">
          <b>${it.displayName}${isMe ? ' <span class="reward-tag" style="display:inline-block; margin-left:4px;">(Te)</span>' : ''}</b>
          <span>${it.title}</span>
        </div>
        <div class="lb-scores">
          <span class="primary-score">${primaryVal}</span>
          <span class="secondary-score">${secondaryVal}</span>
        </div>
      `;
      listWrap.append(row);
    }
    container.append(listWrap);

    // 5. Élő Felhő & Supabase Realtime lábléc és beállítások
    const footer = document.createElement('div');
    footer.className = 'lb-footer-bar';
    const lastSyncTxt = cloudLastSyncedAt ? `Frissítve: ${new Date(cloudLastSyncedAt).toLocaleTimeString('hu-HU')}` : 'Élő szinkron aktív';
    footer.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <span id="sb-badge-pill" style="font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px; cursor:pointer;" title="Kattints a Supabase beállításokhoz!">⚙️ Supabase Realtime</span>
        <span style="font-size:10.5px; color:var(--muted);">${lastSyncTxt}</span>
      </div>
      <div style="display:flex; gap:4px;">
        <button id="sb-config-btn" class="mini-btn" type="button" title="Supabase Projekt Beállítások">⚙️ Supabase</button>
        <button id="lb-refresh-btn" class="mini-btn" type="button">🔄 Frissítés</button>
      </div>
    `;
    footer.querySelector('#lb-refresh-btn').addEventListener('click', async () => {
      const b = footer.querySelector('#lb-refresh-btn');
      b.textContent = '⏳ Frissül...';
      b.disabled = true;
      if (supabase && supabaseStatus === 'connected') await fetchSupabaseData();
      else await fetchCloudState();
      b.textContent = '✓ Kész';
      setTimeout(() => renderActivitiesContent(), 300);
    });
    footer.querySelector('#sb-config-btn').addEventListener('click', () => openSupabaseModal());
    footer.querySelector('#sb-badge-pill').addEventListener('click', () => openSupabaseModal());
    container.append(footer);
    updateSupabaseStatusUI();
    return;
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

function renderHousesDirectory() {
  const summaryEl = el('houses-directory-summary');
  const listEl = el('houses-directory-list');
  if (!summaryEl || !listEl) return;

  const freePlots = getFreePlots();
  const maxHouses = villageData.maxHouses || 48;
  summaryEl.textContent = `🏘️ Összes telek: ${residents.length + freePlots.length} / ${maxHouses} · Foglalt: ${residents.length} · Szabad: ${freePlots.length}`;

  const entries = [];
  if (houseFilterMode === 'all' || houseFilterMode === 'claimed') {
    const sortedRes = [...residents].sort((a, b) => compareStr(a.name, b.name));
    for (const r of sortedRes) {
      const lower = r.name.toLowerCase();
      const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === lower;
      const isDev = lower === DEVELOPER_HANDLE;
      const priv = housePrivacyMap[lower] === 'private' ? '🔒 Zárt' : '🌍 Nyitott';
      entries.push({
        claimed: true,
        isMine,
        isDev,
        title: `🏡 @${r.name} háza${isDev ? ' · 👑 Fejlesztői Domb' : ''}`,
        sub: `${r.title} · ${priv} · (${r.x}, ${r.z})`,
        badge: isMine ? '🏠 Saját' : (isDev ? '👑 Fejlesztő' : 'Foglalt'),
        onClick: () => {
          el('activities-drawer').hidden = true;
          selectHouse(r);
        },
      });
    }
  }
  if (houseFilterMode === 'all' || houseFilterMode === 'free') {
    for (const fp of freePlots) {
      entries.push({
        claimed: false,
        title: `🔓 Szabad ház #${fp.index}`,
        sub: `Beköltözhető telek · (${fp.x}, ${fp.z})`,
        badge: 'Szabad',
        onClick: () => {
          el('activities-drawer').hidden = true;
          selectUnclaimedPlot(fp);
        },
      });
    }
  }

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-card';
    empty.textContent = 'Nincs megjeleníthető ház ebben a szűrőben.';
    listEl.replaceChildren(empty);
    return;
  }

  listEl.replaceChildren(...entries.map((entry) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `house-dir-item ${entry.claimed ? 'is-claimed' : 'is-free'}${entry.isMine ? ' is-mine' : ''}`;
    const main = document.createElement('div');
    main.className = 'house-dir-main';
    const b = document.createElement('b');
    b.className = 'house-dir-title';
    b.textContent = entry.title;
    const sub = document.createElement('small');
    sub.className = 'house-dir-sub';
    sub.textContent = entry.sub;
    main.append(b, sub);
    const tag = document.createElement('span');
    tag.className = `item-tag ${entry.claimed ? (entry.isDev ? 'house-badge-dev' : 'house-badge-claimed') : 'house-badge-free'}`;
    tag.textContent = entry.badge;
    card.append(main, tag);
    card.addEventListener('click', entry.onClick);
    return card;
  }));
}

function setHouseFilterMode(mode) {
  houseFilterMode = (mode === 'claimed' || mode === 'free') ? mode : 'all';
  document.querySelectorAll('.house-filter-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.houseFilter === houseFilterMode);
  });
  renderSearchList();
  if (el('activities-drawer') && !el('activities-drawer').hidden && activeMenuTab === 'houses') {
    renderHousesDirectory();
  }
}

document.querySelectorAll('.house-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => setHouseFilterMode(btn.dataset.houseFilter));
});

function openActivitiesDrawer(tab = 'work') {
  prepareDrawerOpen('activities-drawer');
  el('activities-drawer').hidden = false;
  el('menu-toast').hidden = true;
  activeMenuTab = tab;
  document.querySelectorAll('.act-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.acttab === tab);
  });
  const isHousesTab = activeMenuTab === 'houses';
  if (el('tab-houses')) el('tab-houses').hidden = !isHousesTab;
  if (el('activities-content')) el('activities-content').hidden = isHousesTab;
  if (isHousesTab) renderHousesDirectory();
  else renderActivitiesContent();
  syncResponsiveUIState();
}

el('activities-open').addEventListener('click', () => {
  if (el('activities-drawer').hidden) openActivitiesDrawer('work');
  else {
    el('activities-drawer').hidden = true;
    syncResponsiveUIState();
  }
});
el('activities-open-top').addEventListener('click', () => openActivitiesDrawer('work'));
el('leaderboard-open-btn')?.addEventListener('click', () => {
  if (el('activities-drawer').hidden || activeMenuTab !== 'leaderboard') openActivitiesDrawer('leaderboard');
  else {
    el('activities-drawer').hidden = true;
    syncResponsiveUIState();
  }
});
el('vote-open-menu-btn').addEventListener('click', () => openActivitiesDrawer('community'));
el('activities-close').addEventListener('click', () => {
  el('activities-drawer').hidden = true;
  syncResponsiveUIState();
});

document.querySelectorAll('.act-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeMenuTab = btn.dataset.acttab;
    el('menu-toast').hidden = true;
    document.querySelectorAll('.act-tab').forEach((b) => b.classList.toggle('active', b === btn));
    const isHousesTab = activeMenuTab === 'houses';
    if (el('tab-houses')) el('tab-houses').hidden = !isHousesTab;
    if (el('activities-content')) el('activities-content').hidden = isHousesTab;
    if (isHousesTab) renderHousesDirectory();
    else renderActivitiesContent();
    syncResponsiveUIState();
  });
});

function selectResident(res, fly = true) {
  setWalker(false);
  if (isMobileViewport()) {
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
  selectedRes = res;
  selectedPlaceKey = null;
  followMode = true;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('custom-box').hidden = true;

  const lower = res.name.toLowerCase();
  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === lower;
  const isDev = lower === DEVELOPER_HANDLE;
  el('card-name').textContent = `@${res.name}`;
  updateCardPrivacyBadge(res);
  el('card-role').textContent = res.title;
  el('card-story').textContent = `Beköltözött a ${res.day || 1}. napon.`;
  el('card-people').replaceChildren();

  el('btn-enter-room').hidden = false;
  el('btn-set-mine').hidden = isMine || isDev;
  el('btn-follow').hidden = false;
  el('btn-behind').hidden = false;
  el('btn-house').hidden = false;
  el('btn-person').hidden = true;
  el('btn-custom').hidden = false;
  el('diary-box').hidden = false;

  const actions = [
    { id: 'rest_home', label: '🛌 Pihenés a házban (+55% Energia, 5p Cooldown)', deltaEnergy: 55, deltaXp: 5, cooldownSec: 300, msg: `@${res.name} kipihente magát otthon! (+55% Energia)` },
    { label: `🔨 Munkába küldés (${PLACES[res.place]?.name || 'Falu'})`, onClick: () => selectLandmark(res.place === 'szabad' ? 'tuz' : res.place) },
  ];
  if (isMine) {
    actions.push({ label: '⚙️ Fiók / Másik ház választása', onClick: () => openClaimDrawer() });
  }
  renderActionButtonsOnCard(actions, '⚡ Karakter akciók:');

  refreshCardLive(currentSec());

  const s = whereIs(res, currentSec());
  const isHome = s.mode === 'home' || s.mode === 'sleep';
  const tx = isHome ? res.x : s.x;
  const tz = isHome ? res.z : s.z;
  const tyBase = isHome ? getTerrainElevation(tx, tz) : getGroundHeight(tx, tz, false);
  pin.visible = true;
  pin.position.set(tx, tyBase + (isHome ? 4.8 : 2.5), tz);
  if (fly) flyTo(tx, tz, 30);
  syncResponsiveUIState();
}

function selectHouse(res) {
  setWalker(false);
  setBehind(false);
  if (isMobileViewport()) {
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
  selectedRes = res;
  selectedPlaceKey = null;
  followMode = false;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('custom-box').hidden = true;

  const lower = res.name.toLowerCase();
  const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === lower;
  const isDev = lower === DEVELOPER_HANDLE;
  el('card-name').textContent = `@${res.name} háza`;
  updateCardPrivacyBadge(res);
  el('card-role').textContent = res.title;
  el('card-status').textContent = statusTextFor(res, currentSec());
  el('card-story').textContent = `Koordináták: (${res.x}, ${res.z}) · Kattints a „🚪 Belépés a házba” gombra a szoba megtekintéséhez!`;
  el('card-people').replaceChildren();

  el('btn-enter-room').hidden = false;
  el('btn-set-mine').hidden = isMine || isDev;
  el('btn-follow').hidden = true;
  el('btn-behind').hidden = true;
  el('btn-house').hidden = true;
  el('btn-person').hidden = false;
  el('btn-custom').hidden = false;
  el('diary-box').hidden = true;

  const actions = [
    { id: 'rest_home', label: '🛌 Pihenés / Alvás (+55% Energia, 5p Cooldown)', deltaEnergy: 55, deltaXp: 5, cooldownSec: 300, msg: 'Kipihented magad otthon! (+55% Energia)' },
    { label: '🛋️ Szoba berendezése', onClick: () => enterHouseInterior(res.name) },
    { label: '🛍️ Új bútor vásárlása (Bútorbolt)', onClick: () => openActivitiesDrawer('shop') },
  ];
  if (isMine) {
    actions.push({ label: '⚙️ Fiók / Másik ház választása', onClick: () => openClaimDrawer() });
  }
  renderActionButtonsOnCard(actions, '⚡ Otthoni akciók:');

  pin.visible = true;
  pin.position.set(res.x, getTerrainElevation(res.x, res.z) + 4.9, res.z);
  flyTo(res.x, res.z, 30);
  syncResponsiveUIState();
}

function selectUnclaimedPlot(freePlot) {
  if (!freePlot) return;
  setWalker(false);
  setBehind(false);
  if (isMobileViewport()) {
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
  selectedRes = null;
  selectedPlaceKey = null;
  followMode = false;
  el('card').hidden = false;
  el('vote').hidden = true;
  el('custom-box').hidden = true;
  el('diary-box').hidden = true;
  el('card-people').replaceChildren();

  const privBadge = el('card-privacy-badge');
  if (privBadge) {
    privBadge.hidden = false;
    privBadge.textContent = '🔓 Szabad ház';
    privBadge.className = 'badge open';
  }
  el('card-name').textContent = `🔓 Szabad ház #${freePlot.index}`;
  el('card-role').textContent = 'Beköltözhető, igényelhető telek';
  el('card-status').textContent = 'Szabad ház · Készen áll az azonnali beköltözésre';
  el('card-story').textContent = `Koordináták: (${freePlot.x}, ${freePlot.z}) · Kattints az alábbi gombra, és költözz be ebbe a házba!`;

  el('btn-enter-room').hidden = true;
  el('btn-set-mine').hidden = true;
  el('btn-follow').hidden = true;
  el('btn-behind').hidden = true;
  el('btn-house').hidden = true;
  el('btn-person').hidden = true;
  el('btn-custom').hidden = true;

  renderActionButtonsOnCard([
    {
      label: '🏡 Ház befoglalása (Beköltözés ide)',
      onClick: () => {
        pendingClaimPlot = freePlot;
        openAddDrawer();
      },
    },
    {
      label: '🏘️ Összes szabad ház böngészése',
      onClick: () => openActivitiesDrawer('houses'),
    },
  ], '⚡ Szabad telek:');

  pin.visible = true;
  pin.position.set(freePlot.x, getTerrainElevation(freePlot.x, freePlot.z) + 4.9, freePlot.z);
  flyTo(freePlot.x, freePlot.z, 30);
  syncResponsiveUIState();
}

function selectLandmark(placeKey) {
  setWalker(false);
  setBehind(false);
  if (isMobileViewport()) {
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
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
  const pBaseY = (placeKey === 'hid' || placeKey === 'steg') ? 0 : getTerrainElevation(p.x, p.z);
  pin.visible = true;
  pin.position.set(p.x, pBaseY + (placeKey === 'uzenotabla' ? 3.6 : 5.2), p.z);
  flyTo(p.x, p.z, 36);
  syncResponsiveUIState();
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
  if (el('card')) el('card').hidden = true;
  if (!walker && !inRoomMode && el('vote')) el('vote').hidden = false;
  syncResponsiveUIState();
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
  const searchBox = el('search');
  const nextHidden = !row.hidden;
  row.hidden = nextHidden;
  if (isMobileViewport()) {
    if (searchBox) searchBox.hidden = nextHidden;
    if (stats) stats.hidden = false;
    if (nextHidden && el('search-dropdown')) el('search-dropdown').hidden = true;
  } else {
    if (stats) stats.hidden = nextHidden;
    if (searchBox) searchBox.hidden = false;
  }
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

// Az Idő/Táj csúszka panel alapból összecsukva indul asztali és mobil nézetben is, hogy a felső sáv kompakt maradjon,
// mobilon pedig a fő gombsor és a kereső alapból összecsukva indul (a státusz sáv viszont látható marad),
// valamint a Kamera részleteket is alapból összecsukjuk.
if (el('time-box') && el('brand-toggle-btn')) {
  el('time-box').hidden = true;
  el('brand-toggle-btn').textContent = '⚙️ Idő/Táj ▸';
}
if (isMobileViewport()) {
  if (el('main-btn-row')) el('main-btn-row').hidden = true;
  if (el('search')) el('search').hidden = true;
  if (el('player-stats-bar')) el('player-stats-bar').hidden = false;
  if (el('pills-toggle-btn')) el('pills-toggle-btn').textContent = '☰ Menü ▸';
}
if (isMobileViewport() && el('cam-widget-body') && el('cam-collapse-btn')) {
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

const MAX_JOY_RADIUS = 62;
const JOY_DEADZONE = 6;
const SPRINT_THRESHOLD = 0.78;
const MAX_WALK_SPEED = 8.0;
const MAX_SPRINT_SPEED = 14.0;

let walker = null;
const pressedKeys = new Set();
const playerMesh = createVillagerGroup({ name: 'Te', cloth: '#ffcf55' });
playerMesh.visible = false;
let dragLook = null;
const joyState = {
  pointerId: null,
  originX: 0,
  originY: 0,
  dx: 0,
  dy: 0,
  normDist: 0,
  isSprinting: false,
};

function resetJoystick() {
  joyState.pointerId = null;
  joyState.originX = 0;
  joyState.originY = 0;
  joyState.dx = 0;
  joyState.dy = 0;
  joyState.normDist = 0;
  joyState.isSprinting = false;
  const base = el('cod-joystick-base');
  const knob = el('cod-joystick-knob');
  if (base) {
    base.classList.remove('active', 'sprinting');
    base.style.left = '';
    base.style.top = '';
  }
  if (knob) {
    knob.style.transform = '';
  }
}

function setWalker(on) {
  if (Boolean(walker) === on) return;
  if (on) {
    closeCard();
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
    const spawn = findSafeWalkSpawn(controls.target.x, controls.target.z, camAzimuth + Math.PI);
    const startY = getGroundHeight(spawn.x, spawn.z);
    walker = {
      x: spawn.x,
      z: spawn.z,
      y: startY,
      heading: spawn.heading,
      camYaw: spawn.heading,
      camPitch: 0.14,
      step: 0,
    };
    playerMesh.visible = true;
    animateCharacterLimbs(playerMesh, 0, 0);
    controls.enabled = false;
    document.body.classList.add('walk-mode');
    el('walk-hud').hidden = false;
    el('vote').hidden = true;
    if (isMobileViewport()) {
      if (el('cam-widget')) el('cam-widget').hidden = true;
      if (el('zen-toggle-btn')) el('zen-toggle-btn').hidden = true;
    }
    dragLook = null;
    resetJoystick();
  } else {
    setView(walker.x, walker.z, 42);
    walker = null;
    playerMesh.visible = false;
    animateCharacterLimbs(playerMesh, 0, 0);
    controls.enabled = true;
    document.body.classList.remove('walk-mode');
    el('walk-hud').hidden = true;
    if (!inRoomMode) {
      if (el('vote')) el('vote').hidden = false;
      if (el('cam-widget')) el('cam-widget').hidden = false;
      if (el('zen-toggle-btn')) el('zen-toggle-btn').hidden = false;
    }
    pressedKeys.clear();
    dragLook = null;
    resetJoystick();
  }
  syncResponsiveUIState();
}

el('walk-open').addEventListener('click', () => setWalker(true));
el('walk-exit').addEventListener('click', () => setWalker(false));

// --- 12.1 Mobil Alsó Navigáció, Backdrop, Bottom Sheet Swipe-Down és Reszponzív Állapot-Szinkron ---
canSyncResponsiveUI = true;

el('mob-nav-map')?.addEventListener('click', () => {
  if (inRoomMode) return;
  if (walker) setWalker(false);
  closeAllDrawers();
  closeCard();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  if (!walker && !inRoomMode && el('vote')) el('vote').hidden = false;
  syncResponsiveUIState();
});

el('mob-nav-menu')?.addEventListener('click', () => {
  if (inRoomMode) return;
  if (walker) setWalker(false);
  closeCard();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  const actDrawer = el('activities-drawer');
  if (!actDrawer || actDrawer.hidden || activeMenuTab === 'leaderboard') {
    openActivitiesDrawer('work');
  } else {
    actDrawer.hidden = true;
    syncResponsiveUIState();
  }
});

el('mob-nav-leaderboard')?.addEventListener('click', () => {
  if (inRoomMode) return;
  if (walker) setWalker(false);
  closeCard();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  const actDrawer = el('activities-drawer');
  if (!actDrawer || actDrawer.hidden || activeMenuTab !== 'leaderboard') {
    openActivitiesDrawer('leaderboard');
  } else {
    actDrawer.hidden = true;
    syncResponsiveUIState();
  }
});

el('mob-nav-home')?.addEventListener('click', () => {
  if (inRoomMode) return;
  if (walker) setWalker(false);
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  const claimDrawer = el('claim-drawer');
  if (claimDrawer && !claimDrawer.hidden) {
    claimDrawer.hidden = true;
    syncResponsiveUIState();
  } else {
    closeAllDrawers('claim-drawer');
    const myRes = currentConnectedUser ? byName.get(currentConnectedUser.toLowerCase()) : null;
    if (
      myRes &&
      !el('card').hidden &&
      selectedRes &&
      selectedRes.name.toLowerCase() === myRes.name.toLowerCase()
    ) {
      openClaimDrawer();
    } else {
      flyToMyOwnHouse();
    }
  }
});

el('mob-nav-walk')?.addEventListener('click', () => {
  if (inRoomMode) return;
  closeAllDrawers();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  setWalker(!walker);
  syncResponsiveUIState();
});

el('drawer-backdrop')?.addEventListener('click', () => {
  closeAllDrawers();
  closeCard();
  if (el('search-dropdown')) el('search-dropdown').hidden = true;
  if (!walker && !inRoomMode && el('vote')) el('vote').hidden = false;
  syncResponsiveUIState();
});

document.querySelectorAll('.sheet-handle').forEach((handle) => {
  let startY = null;
  handle.addEventListener('touchstart', (e) => {
    startY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  handle.addEventListener('touchend', (e) => {
    if (startY === null) return;
    const endY = e.changedTouches[0]?.clientY;
    const deltaY = typeof endY === 'number' ? endY - startY : 0;
    startY = null;
    if (deltaY > 60) {
      const sheet = handle.closest('#card, .drawer');
      if (!sheet) return;
      if (sheet.id === 'card') closeCard();
      else {
        sheet.hidden = true;
        syncResponsiveUIState();
      }
    }
  }, { passive: true });
  handle.addEventListener('touchcancel', () => {
    startY = null;
  }, { passive: true });
});

const uiStateObserver = new MutationObserver(() => {
  syncResponsiveUIState();
});
for (const id of ['card', 'walk-hud', ...DRAWER_IDS]) {
  const node = el(id);
  if (node) {
    uiStateObserver.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  }
}
window.addEventListener('resize', syncResponsiveUIState);
syncResponsiveUIState();

// CoD Mobile stílusú virtuális analóg joystick (#cod-joystick-zone) + Multi-touch kameraforgatás
const joyZone = el('cod-joystick-zone');
const joyBase = el('cod-joystick-base');
const joyKnob = el('cod-joystick-knob');

if (joyZone) {
  joyZone.addEventListener('pointerdown', (e) => {
    if (!walker || joyState.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      joyZone.setPointerCapture?.(e.pointerId);
    } catch {
      // Szintetikus vagy nem támogatott események esetén figyelmen kívül hagyható
    }
    joyState.pointerId = e.pointerId;
    joyState.originX = e.clientX;
    joyState.originY = e.clientY;
    joyState.dx = 0;
    joyState.dy = 0;
    joyState.normDist = 0;
    joyState.isSprinting = false;
    if (joyBase) {
      joyBase.style.left = `${joyState.originX}px`;
      joyBase.style.top = `${joyState.originY}px`;
      joyBase.classList.add('active');
      joyBase.classList.remove('sprinting');
    }
    if (joyKnob) {
      joyKnob.style.transform = 'translate3d(0px, 0px, 0)';
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const isFormField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
    if (isFormField) e.target.blur?.();
    if (inRoomMode && !isFormField) exitRoomInterior();
    else if (walker) setWalker(false);
    else if (!inRoomMode) closeCard();
    closeAllDrawers();
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
    syncResponsiveUIState();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (!walker && !inRoomMode) {
    if (e.code === 'KeyQ') el('cam-rot-left').click();
    if (e.code === 'KeyE') el('cam-rot-right').click();
    if (e.code === 'KeyH') toggleZenMode();
  }
  if (walker) pressedKeys.add(e.code);
});
window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));

window.addEventListener('pointerdown', (e) => {
  if (!walker || inRoomMode) return;
  if (e.pointerId === joyState.pointerId || dragLook) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const targetEl = e.target instanceof Element ? e.target : null;
  if (targetEl?.closest('#walk-exit, #walk-desktop-hint, #cod-joystick-zone, #top, .drawer, #card, #cam-widget, #vote, #zen-toggle-btn')) {
    return;
  }
  dragLook = { x: e.clientX, y: e.clientY, id: e.pointerId };
});

window.addEventListener('pointermove', (e) => {
  if (!walker) return;
  if (e.pointerId === joyState.pointerId) {
    const rawDx = e.clientX - joyState.originX;
    const rawDy = e.clientY - joyState.originY;
    const dist = Math.hypot(rawDx, rawDy);
    const clampedDist = Math.min(dist, MAX_JOY_RADIUS);
    const knobX = dist > 0 ? (rawDx / dist) * clampedDist : 0;
    const knobY = dist > 0 ? (rawDy / dist) * clampedDist : 0;

    joyState.dx = knobX;
    joyState.dy = knobY;
    joyState.normDist = dist <= JOY_DEADZONE
      ? 0
      : Math.min(1, (dist - JOY_DEADZONE) / (MAX_JOY_RADIUS - JOY_DEADZONE));
    joyState.isSprinting = joyState.normDist >= SPRINT_THRESHOLD;

    if (joyKnob) {
      joyKnob.style.transform = `translate3d(${knobX}px, ${knobY}px, 0)`;
    }
    if (joyBase) {
      joyBase.classList.toggle('sprinting', joyState.isSprinting);
    }
  } else if (dragLook && e.pointerId === dragLook.id) {
    walker.camYaw -= (e.clientX - dragLook.x) * 0.0065;
    walker.camPitch = THREE.MathUtils.clamp(
      (walker.camPitch ?? 0.14) + (e.clientY - dragLook.y) * 0.0045,
      -0.30,
      0.55
    );
    dragLook.x = e.clientX;
    dragLook.y = e.clientY;
  }
});

function handleWalkPointerEnd(e) {
  if (e.pointerId === joyState.pointerId) {
    resetJoystick();
  }
  if (dragLook && e.pointerId === dragLook.id) {
    dragLook = null;
  }
}
window.addEventListener('pointerup', handleWalkPointerEnd);
window.addEventListener('pointercancel', handleWalkPointerEnd);
window.addEventListener('blur', () => {
  pressedKeys.clear();
  dragLook = null;
  resetJoystick();
});

// --- 12.5 Ütközéskezelés (Collision Detection) és Automatikus Lépcsőzés (Auto-Stepping) ---
function getGroundHeight(x, z, includeProps = true) {
  const terrY = getTerrainElevation(x, z);

  // 1. 2 sávos híd + gyalogjárdák a folyó felett (rámpa a zebrákhoz ±0.5m-en)
  if (Math.abs(x - BRIDGE.x) < 3.4 && z <= BRIDGE.southZ + 0.5 && z >= BRIDGE.northZ - 0.5) {
    const deckY = Math.abs(x - BRIDGE.x) >= 2.3 ? 0.62 : 0.56;
    if (z <= BRIDGE.southZ && z >= BRIDGE.northZ) {
      return deckY;
    }
    const rampDist = z > BRIDGE.southZ ? (z - BRIDGE.southZ) : (BRIDGE.northZ - z);
    const k = Math.max(0, Math.min(1, 1 - rampDist / 0.5));
    return (terrY + 0.08) + (deckY - (terrY + 0.08)) * k;
  }

  // 2. Főtér macskaköves díszemelvény és átlós padok
  const distFoter = Math.hypot(x - PLACES.tuz.x, z - PLACES.tuz.z);
  if (distFoter < 5.2) {
    if (includeProps && distFoter > 2.2) {
      const foterBenchAngles = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
      for (const a of foterBenchAngles) {
        const bx = PLACES.tuz.x + Math.cos(a) * 3.25;
        const bz = PLACES.tuz.z + Math.sin(a) * 3.25;
        const dx = x - bx;
        const dz = z - bz;
        const lx = dx * Math.sin(a) - dz * Math.cos(a);
        const lz = dx * Math.cos(a) + dz * Math.sin(a);
        if (Math.abs(lx) < 0.90 && Math.abs(lz) < 0.30) {
          return terrY + 0.41; // Felment a padra!
        }
      }
    }
    if (distFoter < 3.7) return terrY + 0.12; // Belső díszkör
    if (distFoter < 4.8) return terrY + 0.10; // Külső burkolat
  }

  // 2b. Emelt járdák és városi aszfalt burkolat
  const sw = getClosestSidewalkPoint(x, z);
  if (sw.dist <= SIDEWALK_WIDTH * 0.5 + 0.06) return terrY + 0.09;
  const nr = getClosestPointOnRoads(x, z);
  if (nr.dist <= CAR_ROAD_WIDTH * 0.5) return terrY + 0.06;

  if (!includeProps) return terrY;

  // 3. Folyóparti kövek (river rocks) — csak a folyó közelében vizsgáljuk
  if (Array.isArray(envRefs.rocks) && Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH + 3.8) {
    for (const r of envRefs.rocks) {
      const dx = x - r.x;
      const dz = z - r.z;
      if (dx * dx + dz * dz < r.radius * r.radius) {
        return Math.max(terrY, r.height); // Felmegy a kőre!
      }
    }
  }

  // 4. Házak (foglalt és szabad házak) előtti kőlépcső / küszöb
  for (const r of [...residents, ...unclaimedHouses]) {
    const styleIdx = getHouseStyleIndex(r);
    const localStepX = styleIdx === 1 ? -0.9 : (styleIdx === 3 ? -1.2 : 0);
    const localStepZ = styleIdx === 0 ? 2.28 : 2.05;
    const rot = r.rot || 0;
    const stepX = r.x + localStepX * Math.cos(rot) + localStepZ * Math.sin(rot);
    const stepZ = r.z - localStepX * Math.sin(rot) + localStepZ * Math.cos(rot);
    const dx = x - stepX;
    const dz = z - stepZ;
    if (dx * dx + dz * dz < 0.85 * 0.85) {
      return terrY + 0.12;
    }
  }

  return terrY;
}
const getGroundElevation = getGroundHeight;

function isInsideHouseFootprint(r, x, z, radius = 0.45) {
  const dx = x - r.x;
  const dz = z - r.z;
  if (dx * dx + dz * dz > 32) return false;
  const rot = r.rot || 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;

  const styleIdx = getHouseStyleIndex(r);
  const doorLocal = getHouseDoorLocalPos(styleIdx);
  if (Math.abs(lx - doorLocal.x) < 0.85 && lz >= doorLocal.z - 1.25) {
    return false;
  }

  if (styleIdx === 1) {
    if (lx > -2.6 - radius && lx < 0.8 + radius && lz > -2.0 - radius && lz < 1.8 + radius) return true;
    if (lx > 0.8 - radius && lx < 3.3 + radius && lz > -2.0 - radius && lz < 2.4 + radius) return true;
    return false;
  }
  if (styleIdx === 3) {
    if (lx > -2.6 - radius && lx < 1.2 + radius && lz > -1.9 - radius && lz < 1.7 + radius) return true;
    for (const [px, pz] of [[1.35, -1.55], [3.15, -1.55], [1.35, 1.55], [3.15, 1.55]]) {
      if (Math.hypot(lx - px, lz - pz) < 0.14 + radius) return true;
    }
    return false;
  }
  if (styleIdx === 2) {
    return Math.abs(lx) < 2.1 + radius && lz > -1.9 - radius && lz < 1.7 + radius;
  }
  if (styleIdx === 4) {
    return Math.abs(lx) < 2.0 + radius && lz > -2.0 - radius && lz < 1.8 + radius;
  }
  return Math.abs(lx) < 2.3 + radius && lz > -1.9 - radius && lz < 1.7 + radius;
}

function isObstacleBlocked(x, z, radius = 0.45) {
  // A) Házak fala és teste (foglalt + szabad házak, stílus-specifikus L-szárny / garázs / carport oszlopokkal)
  for (const r of residents) {
    if (isInsideHouseFootprint(r, x, z, radius)) {
      return true;
    }
  }
  for (const uh of unclaimedHouses) {
    if (isInsideHouseFootprint(uh, x, z, radius)) {
      return true;
    }
  }

  // B) Nagyobb nevezetes épületek, Üzenőtábla és Főtér középpont
  if (Math.abs(x - PLACES.kocsma.x) < 3.5 + radius && Math.abs(z - PLACES.kocsma.z) < 2.8 + radius) return true;
  if (Math.abs(x - PLACES.vadaszhaz.x) < 3.4 + radius && Math.abs(z - PLACES.vadaszhaz.z) < 3.0 + radius) return true;
  if (Math.hypot(x - PLACES.malom.x, z - PLACES.malom.z) < 2.3 + radius) return true;
  if (Math.hypot(x - PLACES.gemeskut.x, z - PLACES.gemeskut.z) < 1.25 + radius) return true;
  if (Math.hypot(x - PLACES.uzenotabla.x, z - PLACES.uzenotabla.z) < 0.95 + radius) return true;
  if (currentSeason === 'tel') {
    if (Math.hypot(x - (PLACES.tuz.x - 1.25), z - (PLACES.tuz.z - 0.85)) < 1.3 + radius) return true;
    if (Math.hypot(x - (PLACES.tuz.x + 1.35), z - (PLACES.tuz.z + 0.85)) < 1.0 + radius) return true;
  } else if (Math.hypot(x - PLACES.tuz.x, z - PLACES.tuz.z) < 1.55 + radius) {
    return true;
  }

  // C) Folyó mély vize (csak a 2 sávos hídon lehet átkelni, a víz blokkolva van)
  const inRiver = Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH - 0.2;
  const onBridge = Math.abs(x - BRIDGE.x) < 3.4 && z <= BRIDGE.southZ + 0.8 && z >= BRIDGE.northZ - 0.8;
  if (inRiver && !onBridge) return true;

  // D) Világhatár
  if (Math.abs(x) > 190 || Math.abs(z) > 190) return true;

  return false;
}

function findSafeWalkSpawn(rawX, rawZ, defaultHeading = Math.PI) {
  let candX = rawX;
  let candZ = rawZ;
  let heading = defaultHeading;

  // Ha egy házhoz közel vagyunk, a ház ajtaja elé a járdára spawnolunk!
  for (const r of residents) {
    if (Math.hypot(rawX - r.x, rawZ - r.z) < 4.5) {
      const rot = r.rot || 0;
      candX = r.x + Math.sin(rot) * 3.05;
      candZ = r.z + Math.cos(rot) * 3.05;
      heading = rot;
      break;
    }
  }

  // Ha a Főtér közepén/közelében indítjuk (pl. induláskor), a déli sétányra állítjuk
  if (Math.hypot(candX - PLACES.tuz.x, candZ - PLACES.tuz.z) < 2.8) {
    candX = PLACES.tuz.x;
    candZ = PLACES.tuz.z + 3.1;
  }

  if (!isObstacleBlocked(candX, candZ, 0.55)) {
    return { x: candX, z: candZ, heading };
  }

  // Kifelé irányuló gyűrűs keresés a legközelebbi garantáltan járható pontig
  for (let r = 0.75; r <= 14.0; r += 0.75) {
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      const cx = candX + Math.cos(ang) * r;
      const cz = candZ + Math.sin(ang) * r;
      if (!isObstacleBlocked(cx, cz, 0.55)) {
        return { x: cx, z: cz, heading };
      }
    }
  }

  const roadPt = getClosestPointOnRoads(rawX, rawZ);
  return { x: roadPt.x, z: roadPt.z, heading };
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

function lerpAngle(current, target, alpha) {
  const twoPi = Math.PI * 2;
  const diff = ((((target - current) % twoPi) + twoPi + Math.PI) % twoPi) - Math.PI;
  return current + diff * alpha;
}

const walkCamTarget = new THREE.Vector3();

function updateWalker(dt) {
  if (isObstacleBlocked(walker.x, walker.z, 0.42)) {
    const safe = findSafeWalkSpawn(walker.x, walker.z, walker.heading);
    walker.x = safe.x;
    walker.z = safe.z;
  }

  const has = (...codes) => codes.some((c) => pressedKeys.has(c));
  const joyActive = joyState.pointerId !== null && joyState.normDist > 0;
  let isMoving = false;
  let moveSpeed = 0;

  if (joyActive) {
    const normDist = joyState.normDist;
    if (normDist < SPRINT_THRESHOLD) {
      moveSpeed = (normDist / SPRINT_THRESHOLD) * MAX_WALK_SPEED;
    } else {
      moveSpeed = MAX_WALK_SPEED + ((normDist - SPRINT_THRESHOLD) / (1 - SPRINT_THRESHOLD)) * (MAX_SPRINT_SPEED - MAX_WALK_SPEED);
    }
    moveSpeed = Math.min(MAX_SPRINT_SPEED, moveSpeed);

    if (!dragLook) {
      const nx = Math.max(-1, Math.min(1, joyState.dx / MAX_JOY_RADIUS));
      walker.camYaw -= nx * 1.75 * dt;
    }

    const stickAngle = Math.atan2(-joyState.dx, -joyState.dy);
    const moveAngle = walker.camYaw + stickAngle;
    walker.heading = lerpAngle(walker.heading, moveAngle, Math.min(1, dt * 14));

    if (moveSpeed > 0.01) {
      const rawNx = walker.x + Math.sin(moveAngle) * moveSpeed * dt;
      const rawNz = walker.z + Math.cos(moveAngle) * moveSpeed * dt;
      const resolved = resolveWalkerMovement(walker.x, walker.z, rawNx, rawNz, 0.45);
      walker.x = resolved.x;
      walker.z = resolved.z;
      walker.step += dt * (moveSpeed * 1.35);
      isMoving = true;
    }
  } else {
    const forward = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const turn = (has('KeyA', 'ArrowLeft') ? 1 : 0) - (has('KeyD', 'ArrowRight') ? 1 : 0);
    walker.camYaw = (walker.camYaw ?? walker.heading) + turn * 2.3 * dt;
    walker.heading = walker.camYaw;

    if (forward !== 0) {
      moveSpeed = has('ShiftLeft', 'ShiftRight') ? MAX_SPRINT_SPEED : 7.5;
      const stepDist = moveSpeed * forward * dt;
      const rawNx = walker.x + Math.sin(walker.heading) * stepDist;
      const rawNz = walker.z + Math.cos(walker.heading) * stepDist;

      // Ütközésvizsgálat a házakkal és tereptárgyakkal + falmenti csúszás:
      const resolved = resolveWalkerMovement(walker.x, walker.z, rawNx, rawNz, 0.45);
      walker.x = resolved.x;
      walker.z = resolved.z;
      walker.step += dt * (moveSpeed * 1.35);
      isMoving = true;
    }
  }

  // Auto-unjam biztonsági védelem: ha a karakter valamiért mégis házfalba kerülne, kivezetjük a kerti bejárathoz
  for (const r of residents) {
    if (isInsideHouseFootprint(r, walker.x, walker.z, 0.08)) {
      walker.x = r.door[0];
      walker.z = r.door[1];
      break;
    }
  }

  // Automatikus lépcsőzés és magasságkövetés (híd, főtéri padok, kövek, kőlépcsők)
  const targetY = getGroundHeight(walker.x, walker.z);
  walker.y = THREE.MathUtils.lerp(walker.y !== undefined ? walker.y : targetY, targetY, Math.min(1, dt * 14));

  const bob = isMoving ? Math.abs(Math.sin(walker.step)) * 0.06 : 0;
  playerMesh.position.set(walker.x, walker.y + bob, walker.z);
  playerMesh.rotation.y = walker.heading;
  animateCharacterLimbs(playerMesh, walker.step, isMoving ? moveSpeed / MAX_WALK_SPEED : 0);

  const pitch = walker.camPitch ?? 0.14;
  const camDist = 6.5;
  const horizDist = camDist * Math.cos(pitch);
  const camX = walker.x - Math.sin(walker.camYaw) * horizDist;
  const camZ = walker.z - Math.cos(walker.camYaw) * horizDist;
  const camY = walker.y + 2.4 + camDist * Math.sin(pitch);
  walkCamTarget.set(camX, camY, camZ);
  camera.position.lerp(walkCamTarget, Math.min(1, dt * 8));
  camera.lookAt(
    walker.x + Math.sin(walker.camYaw) * 4,
    walker.y + 1.25 - pitch * 1.5,
    walker.z + Math.cos(walker.camYaw) * 4
  );
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
  const normText = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const needle = normText(q.value.trim().replace(/^@/, ''));
  const sec = currentSec();
  hits.replaceChildren();

  const items = [];

  // 1. Akciók és Menüpontok (Munka, Pihenés, Bútorbolt, Küldetések, Szobaberendezés stb.)
  if (activeSearchTab === 'actions' || (activeSearchTab === 'all' && houseFilterMode === 'all')) {
    const matchedActions = ACTION_MENU_ITEMS
      .filter((a) => !needle || normText(a.title).includes(needle) || normText(a.sub).includes(needle))
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

  // 2. Házak (Foglalt + Szabad házak, szűrhető a #house-filter-bar gombokkal)
  if (activeSearchTab === 'all' || activeSearchTab === 'houses') {
    if (houseFilterMode === 'all' || houseFilterMode === 'claimed') {
      const matchedHouses = residents
        .filter((r) => !needle
          || normText(r.name).includes(needle)
          || normText(r.title).includes(needle)
          || normText(r.role).includes(needle)
          || (r.name.toLowerCase() === DEVELOPER_HANDLE && normText('fejlesztői domb').includes(needle)))
        .sort((a, b) => compareStr(a.name, b.name));

      for (const r of matchedHouses) {
        const lower = r.name.toLowerCase();
        const isMine = currentConnectedUser && currentConnectedUser.toLowerCase() === lower;
        const isDev = lower === DEVELOPER_HANDLE;
        const priv = housePrivacyMap[lower] === 'private' ? '🔒 Zárt' : '🌍 Nyitott';
        items.push({
          title: `🏡 @${r.name} háza${isDev ? ' · 👑 Fejlesztői Domb' : ''}`,
          sub: `${priv} · Koordináta: (${r.x}, ${r.z})`,
          badge: isMine ? '🏠 Saját házam' : (isDev ? '👑 Fejlesztő' : 'Foglalt'),
          badgeClass: isMine ? 'mine' : (isDev ? 'house-badge-dev' : 'house-badge-claimed'),
          onClick: () => {
            searchDropdown.hidden = true;
            selectHouse(r);
          },
        });
      }
    }

    if (houseFilterMode === 'all' || houseFilterMode === 'free') {
      const freePlots = getFreePlots().filter(
        (fp) => !needle || normText(`szabad ház #${fp.index} szabad ház ${fp.index} szabad telek`).includes(needle)
      );
      for (const fp of freePlots) {
        items.push({
          title: `🔓 Szabad ház #${fp.index}`,
          sub: `Beköltözhető telek · Koordináta: (${fp.x}, ${fp.z})`,
          badge: 'Szabad',
          badgeClass: 'house-badge-free',
          onClick: () => {
            searchDropdown.hidden = true;
            selectUnclaimedPlot(fp);
          },
        });
      }
    }
  }

  // 3. Játékosok / Lakók (ABC szerint csökkenően: Z -> A)
  if (activeSearchTab === 'players' || (activeSearchTab === 'all' && houseFilterMode !== 'free')) {
    const matchedPlayers = residents
      .filter((r) => !needle || normText(r.name).includes(needle) || normText(r.title).includes(needle) || normText(r.role).includes(needle))
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
    li.textContent = 'Nincs találat ebben a szűrőben.';
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
function openAddDrawer() {
  prepareDrawerOpen('add-drawer');
  updatePlotCapacityUI();
  el('add-drawer').hidden = false;
  el('new-name')?.focus();
  syncResponsiveUIState();
}

el('add-open').addEventListener('click', () => {
  if (el('add-drawer').hidden) {
    pendingClaimPlot = null;
    openAddDrawer();
  } else {
    pendingClaimPlot = null;
    el('add-drawer').hidden = true;
    syncResponsiveUIState();
  }
});
el('add-close').addEventListener('click', () => {
  pendingClaimPlot = null;
  el('add-drawer').hidden = true;
  syncResponsiveUIState();
});

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
    const payload = { username: name, name, password, place, title };
    if (pendingClaimPlot) payload.plot = pendingClaimPlot;
    const resp = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
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
    pendingClaimPlot = null;
    const created = addResidentToWorld(data.resident);
    syncUnclaimedHouses();
    currentConnectedUser = created.name;
    localStorage.setItem('kisfalu_my_user', currentConnectedUser);
    switchActiveUserRpg(created.name, data.rpg);
    updateClaimButtonUI();
    updateMyHomeBeaconPosition();
    updatePlotCapacityUI();
    renderSearchList();
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

function openChronicleDrawer() {
  prepareDrawerOpen('chronicle-drawer');
  el('chronicle-drawer').hidden = false;
  syncResponsiveUIState();
}

el('chronicle-open').addEventListener('click', () => {
  if (el('chronicle-drawer').hidden) openChronicleDrawer();
  else {
    el('chronicle-drawer').hidden = true;
    syncResponsiveUIState();
  }
});
el('chronicle-close').addEventListener('click', () => {
  el('chronicle-drawer').hidden = true;
  syncResponsiveUIState();
});

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
  else if (hit.userData.unclaimedPlot) selectUnclaimedPlot(hit.userData.unclaimedPlot);
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

function setTagHidden(tag, hidden) {
  if (tag._lastHidden !== hidden || tag.hidden !== hidden) {
    tag._lastHidden = hidden;
    tag.hidden = hidden;
  }
}

function setTagText(tag, text) {
  if (tag._lastText !== text) {
    tag._lastText = text;
    tag.textContent = text;
  }
}

const projVec = new THREE.Vector3();
function projectToScreen(tag, x, y, z) {
  projVec.set(x, y, z).project(camera);
  if (Math.abs(projVec.x) > 1 || Math.abs(projVec.y) > 1 || projVec.z > 1) {
    setTagHidden(tag, true);
    return false;
  }
  const px = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  const py = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  setTagHidden(tag, false);
  if (
    tag._lastTx === undefined ||
    Math.abs(px - tag._lastTx) >= 0.5 ||
    Math.abs(py - tag._lastTy) >= 0.5
  ) {
    tag._lastTx = px;
    tag._lastTy = py;
    tag.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%)`;
  }
  return true;
}

// Saját házam címke + Képernyőszéli nyíl frissítése
function updateMyHomePointer(t) {
  const myTag = el('my-home-tag');
  const compassBtn = el('home-compass-pointer');
  if (!currentConnectedUser || inRoomMode) {
    setTagHidden(myTag, true);
    setTagHidden(compassBtn, true);
    return;
  }
  const myRes = byName.get(currentConnectedUser.toLowerCase());
  if (!myRes) {
    setTagHidden(myTag, true);
    setTagHidden(compassBtn, true);
    return;
  }

  // 3D jelző animálása a saját ház felett
  myHomeBeacon.children[0].position.y = 5.4 + Math.sin(t * 4.5) * 0.35;
  myHomeBeacon.children[0].rotation.y = t * 2.0;

  const myBaseY = getTerrainElevation(myRes.x, myRes.z);
  projVec.set(myRes.x, myBaseY + 6.2, myRes.z).project(camera);
  let ndcX = projVec.x;
  let ndcY = projVec.y;
  if (projVec.z > 1) {
    ndcX = -ndcX;
    ndcY = -ndcY;
  }

  const onScreen = Math.abs(projVec.x) <= 0.94 && Math.abs(projVec.y) <= 0.88 && projVec.z <= 1;
  if (onScreen) {
    setTagHidden(compassBtn, true);
    setTagHidden(myTag, false);
    setTagText(myTag, `🏠 Saját házam (@${myRes.name})`);
    const px = (projVec.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
    if (
      myTag._lastTx === undefined ||
      Math.abs(px - myTag._lastTx) >= 0.5 ||
      Math.abs(py - myTag._lastTy) >= 0.5
    ) {
      myTag._lastTx = px;
      myTag._lastTy = py;
      myTag.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  } else {
    // Ha a saját ház kívül van a képernyőn, a képernyő szélére tesszük az iránytű gombot!
    setTagHidden(myTag, true);
    setTagHidden(compassBtn, false);
    const angle = Math.atan2(-ndcY, ndcX);
    const marginX = window.innerWidth / 2 - 115;
    const marginY = window.innerHeight / 2 - 65;
    const edgeX = Math.round(window.innerWidth / 2 + Math.cos(angle) * marginX);
    const edgeY = Math.round(window.innerHeight / 2 + Math.sin(angle) * marginY);
    const nextText = `🏠 Saját házam (@${myRes.name}) erre ➔`;
    if (compassBtn._lastCompassText !== nextText) {
      compassBtn._lastCompassText = nextText;
      compassBtn.textContent = nextText;
    }
    if (compassBtn._lastCompassX !== edgeX || compassBtn._lastCompassY !== edgeY) {
      compassBtn._lastCompassX = edgeX;
      compassBtn._lastCompassY = edgeY;
      compassBtn.style.transform = `translate3d(${edgeX.toFixed(0)}px, ${edgeY.toFixed(0)}px, 0) translate(-50%, -50%)`;
    }
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
    if (frameCount % 6 === 0) {
      renderer.shadowMap.needsUpdate = true;
    }
    frameCount++;
    renderer.render(roomScene, roomCamera);
    requestAnimationFrame(tick);
    return;
  }

  const sec = currentSec();

  if (flight) {
    flight.t = Math.min(1, flight.t + dt / 0.75);
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    const curY = (flight.fromY ?? 0) + ((flight.y ?? getTerrainElevation(flight.x, flight.z)) - (flight.fromY ?? 0)) * k;
    setView(
      flight.fromX + (flight.x - flight.fromX) * k,
      flight.fromZ + (flight.z - flight.fromZ) * k,
      flight.fromDist + (flight.dist - flight.fromDist) * k,
      flight.fromAzimuth + (flight.targetAzimuth - flight.fromAzimuth) * k,
      flight.fromPolar + (flight.targetPolar - flight.fromPolar) * k,
      curY
    );
    if (flight.t >= 1) flight = null;
  } else if (walker) {
    updateWalker(dt);
  } else if (behindMode && selectedRes) {
    const st = whereIs(selectedRes, sec);
    const gy = getGroundHeight(st.x, st.z, false);
    const camX = st.x - Math.sin(st.heading) * 6.0;
    const camZ = st.z - Math.cos(st.heading) * 6.0;
    walkCamTarget.set(camX, gy + 3.2, camZ);
    camera.position.lerp(walkCamTarget, Math.min(1, dt * 6));
    camera.lookAt(st.x, gy + 1.3, st.z);
    controls.target.set(st.x, gy, st.z);
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
    a.mesh.position.y = getTerrainElevation(PLACES.legelo.x + a.mesh.position.x, PLACES.legelo.z + a.mesh.position.z) - (a.baseY || 0);
  }

  updateWeather(dt);

  let outsideCount = 0;
  for (let i = 0; i < residents.length; i++) {
    const res = residents[i];
    const st = whereIs(res, sec);
    const isSleeping = st.mode === 'sleep' || st.mode === 'home';
    if (!isSleeping) outsideCount++;

    res.figureGroup.visible = !isSleeping || res === selectedRes;
    const groundY = getGroundHeight(st.x, st.z, false);
    const isMovingNpc = st.mode === 'walk' || st.mode === 'run';
    const stepPhase = (st.dist || 0) * 2.1 + i;
    const animSpeed = st.mode === 'run'
      ? 1.25
      : (isMovingNpc ? Math.min(1.0, (st.speed || 1.8) / 2.2) : 0);
    const bobAmp = st.mode === 'run' ? 0.085 : (isMovingNpc ? 0.055 : 0);
    const bob = isMovingNpc ? Math.abs(Math.sin(stepPhase)) * bobAmp : 0;
    res.figureGroup.position.set(st.x, groundY + bob, st.z);
    res.figureGroup.rotation.y = st.heading;
    if (res.figureGroup.visible) {
      animateCharacterLimbs(res.figureGroup, stepPhase, animSpeed);
    }
  }

  if (currentSeason === 'tel') {
    if (xmasStarMesh) {
      xmasStarMesh.rotation.y = t * 1.6;
    }
    flames.forEach((f, i) => {
      f.scale.y = 0.85 + Math.sin(t * 14 + i * 2.1) * 0.25;
    });
    const foterY = getTerrainElevation(PLACES.tuz.x, PLACES.tuz.z);
    smokePuffs.forEach(({ mesh, offset }, i) => {
      const cycle = (t * 0.35 + offset) % 1;
      mesh.position.set(
        PLACES.tuz.x + 1.35 + Math.sin(t * 1.5 + i) * 0.35 * cycle,
        foterY + 1.8 + cycle * 4.5,
        PLACES.tuz.z + 0.85 + Math.cos(t * 1.2 + i) * 0.35 * cycle
      );
      mesh.scale.setScalar(0.6 + cycle * 1.4);
      mesh.material.opacity = (1 - cycle) * 0.55;
    });
  }

  if (!(walker && isMobileViewport())) {
    updateMyHomePointer(t);

    const chosenTag = el('chosen-tag');
    if (selectedRes && !el('diary-box').hidden) {
      const st = whereIs(selectedRes, sec);
      const isHomeOrSleep = st.mode === 'home' || st.mode === 'sleep';
      const tx = isHomeOrSleep ? selectedRes.x : st.x;
      const tz = isHomeOrSleep ? selectedRes.z : st.z;
      const ty = isHomeOrSleep
        ? getTerrainElevation(tx, tz) + 4.8
        : getGroundHeight(tx, tz, false) + 2.5;
      pin.position.set(tx, ty + Math.sin(t * 4) * 0.15, tz);
      setTagText(chosenTag, `@${selectedRes.name}`);
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
      setTagHidden(chosenTag, true);
    }

    for (const { key, tag } of placeTags) {
      const p = PLACES[key];
      const pBaseY = (key === 'hid' || key === 'steg') ? 0 : getTerrainElevation(p.x, p.z);
      const tagOffsetY = key === 'uzenotabla' ? 3.1 : 4.8;
      projectToScreen(tag, p.x, pBaseY + tagOffsetY, p.z);
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
          setTagText(tag, `@${res.name}`);
          if (projectToScreen(tag, res.figureGroup.position.x, res.figureGroup.position.y + 2.2, res.figureGroup.position.z)) {
            usedTags++;
          }
        }
      }
    }
    for (let i = usedTags; i < personTagPool.length; i++) setTagHidden(personTagPool[i], true);
  }

  if (frameCount % 15 === 0) {
    updateDaylight(sec, outsideCount);
    refreshCardLive(sec);
  }
  if (frameCount % 4 === 0) {
    renderer.shadowMap.needsUpdate = true;
  }
  frameCount++;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

let wasMobileViewport = isMobileViewport();
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  roomCamera.aspect = window.innerWidth / window.innerHeight;
  roomCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);

  const nowMobile = isMobileViewport();
  if (!nowMobile) {
    if (el('search')) el('search').hidden = false;
    if (wasMobileViewport) {
      if (el('main-btn-row')) el('main-btn-row').hidden = false;
      if (el('player-stats-bar')) el('player-stats-bar').hidden = false;
      if (el('pills-toggle-btn')) el('pills-toggle-btn').textContent = '☰ Menü ▾';
    }
  } else if (!wasMobileViewport) {
    if (el('main-btn-row')) el('main-btn-row').hidden = true;
    if (el('search')) el('search').hidden = true;
    if (el('player-stats-bar')) el('player-stats-bar').hidden = false;
    if (el('pills-toggle-btn')) el('pills-toggle-btn').textContent = '☰ Menü ▸';
    if (el('search-dropdown')) el('search-dropdown').hidden = true;
  }
  wasMobileViewport = nowMobile;
  syncResponsiveUIState();
});

updateDaylight(currentSec(), 0);
requestAnimationFrame(tick);
