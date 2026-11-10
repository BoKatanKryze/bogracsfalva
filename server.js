import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const VILLAGE_FILE = path.join(__dirname, 'village.json');
const INTERIORS_FILE = path.join(__dirname, 'interiors.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

function randomKey(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

// GDPR-mentes (Zero-PII) jelszó hash-elés scrypt + salt segítségével
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

function createDefaultRpgProfile() {
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

function createStarterHouse(username, index = 0, passwordHash = null) {
  // Néhány ház alapból zárt (például a 2. és 6. lakosé), hogy rögtön ki lehessen próbálni a zárt házakat is
  const isPrivateDefault = index === 1 || index === 5;
  const isDev = username.toLowerCase() === 'gulyas_mester';
  return {
    owner: username,
    passwordHash: isDev ? 'PROTECTED_DEVELOPER_RESERVED' : passwordHash,
    privacy: isPrivateDefault ? 'private' : 'public',
    inviteKey: randomKey(6),
    guestList: [],
    rpg: createDefaultRpgProfile(),
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

// Utcafronti építési telkek (minden telek közvetlenül a falusi utcákhoz csatlakozik, bejárattal az út felé!)
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

function findNextPlot(houses) {
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

async function readVillage() {
  const raw = await fs.readFile(VILLAGE_FILE, 'utf-8');
  return JSON.parse(raw);
}

async function writeVillage(data) {
  await fs.writeFile(VILLAGE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function readInteriors() {
  try {
    const raw = await fs.readFile(INTERIORS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    const village = await readVillage();
    const initial = {
      sessions: {},      // tokenHash -> username
      pendingClaims: {}, // code -> { username, tokenHash, expiresAt }
      houses: {},        // usernameLower -> houseData
    };
    village.residents.forEach((r, idx) => {
      initial.houses[r.name.toLowerCase()] = createStarterHouse(r.name, idx);
    });
    await fs.writeFile(INTERIORS_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
}

async function writeInteriors(data) {
  await fs.writeFile(INTERIORS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getSessionUser(req, interiors) {
  const rawToken = req.headers['x-session-token'];
  if (!rawToken) return null;
  const h = hashToken(rawToken);
  return interiors.sessions[h] || null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. Aktuális böngésző-munkamenet lekérdezése + házak nyitott/zárt állapota + RPG profil + telek-limit
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const interiors = await readInteriors();
    const village = await readVillage();
    const username = getSessionUser(req, interiors);
    const privacyMap = {};
    for (const [k, h] of Object.entries(interiors.houses)) {
      privacyMap[k] = h.privacy;
    }
    let rpg = null;
    if (username) {
      const h = interiors.houses[username.toLowerCase()];
      if (h) {
        if (!h.rpg) h.rpg = createDefaultRpgProfile();
        rpg = h.rpg;
      }
    }
    sendJson(res, 200, {
      username,
      privacyMap,
      rpg,
      maxHouses: village.maxHouses || 40,
      claimedCount: village.residents.length,
    });
    return;
  }

  // 1.5 GDPR-mentes (Zero-PII) Belépés: Becenév + Jelszó
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const rawToken = req.headers['x-session-token'];
    const rawName = String(body.username || '').trim().replace(/^@/, '');
    const password = String(body.password || '');

    if (!rawName || !password) {
      return sendJson(res, 400, { error: 'Add meg a játékbeli karakternévedet és a jelszavadat!' });
    }

    if (rawName.toLowerCase() === 'gulyas_mester') {
      return sendJson(res, 403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
    }

    const village = await readVillage();
    const resident = village.residents.find((r) => r.name.toLowerCase() === rawName.toLowerCase());
    if (!resident) {
      return sendJson(res, 404, { error: 'Ezzel a névvel még nincs ház a faluban! Foglalj magadnak új telket.' });
    }

    const interiors = await readInteriors();
    const key = resident.name.toLowerCase();
    if (!interiors.houses[key]) {
      interiors.houses[key] = createStarterHouse(resident.name);
    }
    const house = interiors.houses[key];

    if (house.passwordHash) {
      if (!verifyPassword(password, house.passwordHash)) {
        return sendJson(res, 401, { error: 'Hibás jelszó ehhez a házhoz!' });
      }
    } else {
      // Ha egy alap (még jelszó nélküli) falusi házba lép be először jelszóval, lefoglalja vele:
      if (password.length < 4) {
        return sendJson(res, 400, { error: 'A jelszónak legalább 4 karakternek kell lennie!' });
      }
      house.passwordHash = hashPassword(password);
    }

    if (!house.rpg) house.rpg = createDefaultRpgProfile();
    if (rawToken) {
      interiors.sessions[hashToken(rawToken)] = resident.name;
    }
    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, username: resident.name, rpg: house.rpg });
    return;
  }

  // 1.6 Felhasználóhoz kötött RPG profil & Cooldown mentése
  if (url.pathname === '/api/rpg/sync' && req.method === 'POST') {
    const body = await parseBody(req);
    const interiors = await readInteriors();
    const currentUser = getSessionUser(req, interiors) || String(body.username || '').trim();
    if (!currentUser) return sendJson(res, 403, { error: 'Nincs kiválasztott karakter.' });

    const key = currentUser.toLowerCase();
    const house = interiors.houses[key];
    if (!house) return sendJson(res, 404, { error: 'Ház nem található.' });

    if (body.rpg && typeof body.rpg === 'object') {
      house.rpg = {
        ...(house.rpg || createDefaultRpgProfile()),
        ...body.rpg,
      };
      await writeInteriors(interiors);
    }
    sendJson(res, 200, { ok: true, rpg: house.rpg });
    return;
  }

  // 2. Instagram / TikTok DM Kódkérés (Claim indítása)
  if (url.pathname === '/api/claim/request' && req.method === 'POST') {
    const body = await parseBody(req);
    const rawToken = req.headers['x-session-token'];
    if (!rawToken) return sendJson(res, 400, { error: 'Hiányzó böngésző token.' });

    const name = String(body.username || '').trim().replace(/^@/, '');
    if (name.toLowerCase() === 'gulyas_mester') {
      return sendJson(res, 403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
    }
    const village = await readVillage();
    const resident = village.residents.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!resident) {
      return sendJson(res, 404, { error: 'Ezzel a névvel még nincs ház a faluban! Először költöztesd be.' });
    }

    const interiors = await readInteriors();
    const code = `BF-${Math.floor(1000 + Math.random() * 9000)}`;
    interiors.pendingClaims[code] = {
      username: resident.name,
      tokenHash: hashToken(rawToken),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    await writeInteriors(interiors);
    sendJson(res, 200, { code, username: resident.name, expiresInSec: 600 });
    return;
  }

  // 3. Instagram / TikTok DM Webhook szimulátor (Localhost teszteléshez)
  if (url.pathname === '/api/claim/simulate-dm' && req.method === 'POST') {
    const body = await parseBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    const interiors = await readInteriors();
    const pending = interiors.pendingClaims[code];

    if (!pending || pending.expiresAt < Date.now()) {
      return sendJson(res, 400, { error: 'Érvénytelen vagy lejárt kód.' });
    }

    interiors.sessions[pending.tokenHash] = pending.username;
    delete interiors.pendingClaims[code];

    const key = pending.username.toLowerCase();
    if (!interiors.houses[key]) {
      interiors.houses[key] = createStarterHouse(pending.username);
    }
    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, username: pending.username });
    return;
  }

  // 4. Böngésző leválasztása
  if (url.pathname === '/api/claim/logout' && req.method === 'POST') {
    const rawToken = req.headers['x-session-token'];
    if (rawToken) {
      const interiors = await readInteriors();
      delete interiors.sessions[hashToken(rawToken)];
      await writeInteriors(interiors);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // 5. Belépés egy ház belsejébe (Jogosultság-ellenőrzés: Tulajdonos / Publikus / Meghívókulcs / Vendéglista)
  if (url.pathname === '/api/house' && req.method === 'GET') {
    const targetName = String(url.searchParams.get('name') || '').trim().toLowerCase();
    const providedKey = String(url.searchParams.get('key') || '').trim();

    const interiors = await readInteriors();
    let house = interiors.houses[targetName];
    if (!house) {
      const village = await readVillage();
      const resObj = village.residents.find((r) => r.name.toLowerCase() === targetName);
      if (!resObj) return sendJson(res, 404, { error: 'A ház nem található.' });
      house = createStarterHouse(resObj.name);
      interiors.houses[targetName] = house;
      await writeInteriors(interiors);
    }

    const currentUser = getSessionUser(req, interiors);
    const isOwner = Boolean(currentUser && currentUser.toLowerCase() === targetName);
    const hasValidKey = Boolean(providedKey && providedKey === house.inviteKey);
    const onGuestList = Boolean(currentUser && house.guestList.some((g) => g.toLowerCase() === currentUser.toLowerCase()));
    const isPublic = house.privacy === 'public';

    if (!isOwner && !isPublic && !hasValidKey && !onGuestList) {
      return sendJson(res, 403, {
        allowed: false,
        privacy: house.privacy,
        owner: house.owner,
        message: 'Ez a ház zárt. Csak a tulajdonos meghívó linkjével vagy a vendéglistán szerepelve léphetsz be!',
      });
    }

    sendJson(res, 200, {
      allowed: true,
      owner: house.owner,
      isOwner,
      privacy: house.privacy,
      inviteKey: isOwner ? house.inviteKey : undefined,
      guestList: isOwner ? house.guestList : undefined,
      items: house.items,
    });
    return;
  }

  // 6. Szobaberendezés, nyitott/zárt állapot és vendéglista mentése (Csak a tulajdonosnak!)
  if (url.pathname === '/api/house/save' && req.method === 'POST') {
    const body = await parseBody(req);
    const interiors = await readInteriors();
    const currentUser = getSessionUser(req, interiors);
    if (!currentUser) return sendJson(res, 403, { error: 'Nincs összekötött Instagram/TikTok fiók.' });

    const key = currentUser.toLowerCase();
    const house = interiors.houses[key];
    if (!house) return sendJson(res, 404, { error: 'Ház nem található.' });

    if (body.privacy === 'public' || body.privacy === 'private') {
      house.privacy = body.privacy;
    }
    if (Array.isArray(body.guestList)) {
      house.guestList = body.guestList
        .map((g) => String(g).trim().replace(/^@/, ''))
        .filter(Boolean)
        .slice(0, 20);
    }
    if (Array.isArray(body.items)) {
      const updatedMap = new Map(body.items.map((i) => [i.id, i]));
      let placedCount = 0;
      for (const item of house.items) {
        const incoming = updatedMap.get(item.id);
        if (!incoming) continue;
        item.placed = Boolean(incoming.placed) && placedCount < 12;
        if (item.placed) placedCount++;
        // Szoba falain belüli koordinátákra korlátozzuk (-2.6 .. +2.6)
        item.x = Math.max(-2.6, Math.min(2.6, Number(incoming.x) || 0));
        item.z = Math.max(-2.6, Math.min(2.6, Number(incoming.z) || 0));
        item.rot = Number(incoming.rot) || 0;
        item.unboxed = incoming.unboxed !== false;
      }
    }

    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, house });
    return;
  }

  // 7. Zárcsere (Új meghívó kulcs generálása, a régiek érvénytelenítése)
  if (url.pathname === '/api/house/rekey' && req.method === 'POST') {
    const interiors = await readInteriors();
    const currentUser = getSessionUser(req, interiors);
    if (!currentUser) return sendJson(res, 403, { error: 'Nem vagy bejelentkezve.' });

    const house = interiors.houses[currentUser.toLowerCase()];
    if (!house) return sendJson(res, 404, { error: 'Ház nem található.' });

    house.inviteKey = randomKey(6);
    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, inviteKey: house.inviteKey });
    return;
  }

  // 8. Ajándékozás másik lakosnak (@név alapján)
  if (url.pathname === '/api/house/gift' && req.method === 'POST') {
    const body = await parseBody(req);
    const interiors = await readInteriors();
    const currentUser = getSessionUser(req, interiors);
    if (!currentUser) return sendJson(res, 403, { error: 'Ajándékozáshoz kösd össze a fiókod!' });

    const targetName = String(body.toUsername || '').trim().replace(/^@/, '').toLowerCase();
    const itemId = String(body.itemId || '');
    if (!targetName || targetName === currentUser.toLowerCase()) {
      return sendJson(res, 400, { error: 'Adj meg egy másik lakost címzettként!' });
    }

    const myHouse = interiors.houses[currentUser.toLowerCase()];
    const targetHouse = interiors.houses[targetName];
    if (!targetHouse) {
      return sendJson(res, 404, { error: 'A címzett lakosnak még nincs háza a faluban!' });
    }

    const idx = myHouse.items.findIndex((i) => i.id === itemId);
    if (idx === -1) {
      return sendJson(res, 404, { error: 'A kiválasztott tárgy nem található a raktáradban.' });
    }

    const [giftedItem] = myHouse.items.splice(idx, 1);
    giftedItem.id = `${targetName}_gift_${Date.now()}`;
    giftedItem.placed = true;
    giftedItem.x = (Math.random() - 0.5) * 1.6;
    giftedItem.z = (Math.random() - 0.5) * 1.6;
    giftedItem.rot = 0;
    giftedItem.giftFrom = currentUser;
    giftedItem.unboxed = false; // Becsukott ajándékdobozként jelenik meg a címzett szobájában!

    targetHouse.items.push(giftedItem);
    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, items: myHouse.items, giftedTo: targetHouse.owner });
    return;
  }

  // 8.5 Új bútor vásárlása / barkácsolása a saját ház raktárába
  if (url.pathname === '/api/house/add-item' && req.method === 'POST') {
    const body = await parseBody(req);
    const interiors = await readInteriors();
    const currentUser = getSessionUser(req, interiors);
    if (!currentUser) return sendJson(res, 403, { error: 'Vásárláshoz válaszd ki a karaktered!' });

    const myHouse = interiors.houses[currentUser.toLowerCase()];
    if (!myHouse) return sendJson(res, 404, { error: 'Ház nem található.' });

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
    await writeInteriors(interiors);
    sendJson(res, 200, { ok: true, item: newItem, items: myHouse.items });
    return;
  }

  // 9. Új lakos és procedurális ház/telek lefoglalása (GDPR-mentes: Becenév + Jelszó + maxHouses limit)
  if ((url.pathname === '/api/resident' || url.pathname === '/api/auth/register') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const rawName = String(body.username || body.name || '').trim().replace(/^@/, '');
      const password = String(body.password || '');

      if (!rawName || !/^[a-zA-Z0-9._huőúöüóéáűíŐÚÖÜÓÉÁŰÍ-]{2,28}$/.test(rawName)) {
        return sendJson(res, 400, { error: 'Adj meg egy érvényes játékbeli nevet (2–28 karakter)!' });
      }
      if (rawName.toLowerCase() === 'gulyas_mester') {
        return sendJson(res, 403, { error: '🔒 @gulyas_mester a falu fejlesztői karaktere és le van foglalva!' });
      }
      if (password && password.length < 4) {
        return sendJson(res, 400, { error: 'A jelszónak legalább 4 karakternek kell lennie!' });
      }

      const data = await readVillage();
      const exists = data.residents.find((r) => r.name.toLowerCase() === rawName.toLowerCase());
      if (exists) {
        return sendJson(res, 409, {
          error: 'Ezzel a névvel már áll egy ház a faluban! Lépj be a jelszavaddal a „🔑 Belépés / Saját házam” menüben!',
          resident: exists,
        });
      }

      const maxHouses = data.maxHouses || 40;
      if (data.residents.length >= maxHouses) {
        return sendJson(res, 403, {
          error: `🔒 Bográcsfalva megtelt (${maxHouses}/${maxHouses} telek)! Új ház már nem építhető, de a meglévő lakók beléphetnek.`,
          full: true,
          maxHouses,
          claimedCount: data.residents.length,
        });
      }

      const plot = findNextPlot(data.residents);
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
      const chosenRole = ROLES.find((r) => r.place === body.place) || ROLES[data.residents.length % ROLES.length];
      const ROOFS = ['#c8523b', '#d99b26', '#4a7c59', '#5b6e8c', '#8c4a6b'];

      const newResident = {
        id: data.residents.length + 1,
        name: rawName,
        title: body.title?.trim() || chosenRole.title,
        place: chosenRole.place,
        x: plot.x,
        z: plot.z,
        rot: plot.rot,
        roof: body.roof || ROOFS[data.residents.length % ROOFS.length],
        wall: body.wall || '#f5eedc',
        cloth: body.cloth || chosenRole.cloth,
        day: data.day || 1,
      };

      data.residents.push(newResident);
      await writeVillage(data);

      const interiors = await readInteriors();
      const pwHash = password ? hashPassword(password) : null;
      const newHouse = createStarterHouse(rawName, data.residents.length - 1, pwHash);
      interiors.houses[rawName.toLowerCase()] = newHouse;

      const rawToken = req.headers['x-session-token'];
      if (rawToken) {
        interiors.sessions[hashToken(rawToken)] = rawName;
      }
      await writeInteriors(interiors);

      sendJson(res, 201, {
        ok: true,
        resident: newResident,
        rpg: newHouse.rpg,
        maxHouses,
        claimedCount: data.residents.length,
      });
    } catch {
      sendJson(res, 500, { error: 'Szerverhiba történt.' });
    }
    return;
  }

  // 10. Ház és karakter külső átszínezése
  if (url.pathname === '/api/customize' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const data = await readVillage();
      const target = data.residents.find((r) => r.name.toLowerCase() === String(body.name || '').toLowerCase());
      if (!target) return sendJson(res, 404, { error: 'Lakos nem található.' });
      if (body.roof) target.roof = body.roof;
      if (body.wall) target.wall = body.wall;
      if (body.cloth) target.cloth = body.cloth;
      await writeVillage(data);
      sendJson(res, 200, { ok: true, resident: target });
    } catch {
      sendJson(res, 500, { error: 'Nem sikerült menteni.' });
    }
    return;
  }

  // Statikus fájlok kiszolgálása
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Nem található');
  }
});

server.listen(PORT, () => {
  console.log(`🏡 Kisfalu szerver fut: http://localhost:${PORT}`);
});
