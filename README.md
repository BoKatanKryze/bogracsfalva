# 🏡 Bográcsfalva – Interaktív 3D Közösségi Falu (WebGL / Three.js Portfólió Projekt)

Interaktív, valós idejű **3D közösségi falu szimuláció** böngészőben, külső build-lépés nélkül (Vanilla ES Modules + **Three.js**), regisztrációmentes szobaberendezéssel, meghívókulcsos zárt házakkal és évszak-/időjárás-szimulációval.

---

## ✨ Főbb funkciók (Features)

- **🏛️ Élő 3D Falu & Napszak-szimuláció:**
  - Determinisztikus napi rutinok: a lakók reggel elindulnak otthonról a munkahelyükre (Főtér, Falusi Kocsma, Vadászház, Piac, Horgászstég, Szélmalom, Legelő, Gémeskút), este 20:00-kor összegyűlnek a **Főtéren**, éjszaka pedig kivilágított ablakok mögött pihennek.
  - Valós idejű óra vagy kézi napszak-csúszka (`00:00 – 24:00`) dinamikus napfénnyel, árnyékokkal (`PCFSoftShadowMap`) és utcai lámpákkal.
- **🌸🌿🍂⛄ Független Évszak / Táj és ☀️🌧️❄️🌫️ Időjárás Rendszer:**
  - Külön kapcsolható a **Táj / Évszak** (*Tavasz, Nyár, Ősz, Tél/Havas*) és külön az **Időjárás** (*Derült, Eső, Havazás, Köd*).
  - **Dinamikus falevelek (`THREE.InstancedMesh`):** tavasszal cseresznyevirág-rózsaszín és rügyzöld, nyáron dús zöld, ősszel bíbor/narancs/arany lombkoronák és lehullott avar, télen pedig havas táj, hófedte háztetők, valamint a **Főtéren** megjelenő **🎄 Karácsonyfa és 🔥 Tábortűz bográccsal**.
- **🛋️ 3D Szobabelső Szerkesztő, Zárt Házak & Ajándékozás (Regisztráció nélkül):**
  - Jelszó és regisztráció nélküli **Instagram/TikTok DM kódos fiók-összekötés** (beépített szimulátorral) + böngésző token (`localStorage`).
  - **Drag & Drop 3D bútorelhelyezés** és forgatás a házon belül.
  - **🌍 Nyitott / 🔒 Zárt ház kapcsoló:** zárt házhoz egyedi **„lábtörlő alatti kulcs” meghívólink** (`#haz=nev&kulcs=xyz`), zárcsere és `@név` alapú vendéglista.
  - **🎁 3D Ajándékozás:** bútorok átküldése másik lakos szobájába becsomagolt, kibontható 3D ajándékdobozként.
- **🧭 „Saját házam” Jelző & Kategóriás Kereső (`Z → A`):**
  - 3D forgó jelzőnyíl a saját ház felett + képernyőszéli dinamikus iránytű gomb.
  - Kategóriás kereső (*Házak, Játékosok, Akciók/Menü*) ABC szerinti csökkenő (`Z → A`) vagy növekvő sorrendben.
- **🎥 Teljes 360°-os 3D Kamera + TPS / WASD Séta mód:**
  - Szabad 3D forgatás és döntés egérrel vagy a jobb alsó kamera-vezérlővel (`Q` / `E` gyorsgombok), valamint saját karakteres `WASD` séta mód.
- **⚡ 60 FPS Optimalizáció:**
  - Több száz fa, fenyő, szikla és virág mindössze néhány draw callból `THREE.InstancedMesh` segítségével + megosztott `MeshLambertMaterial` cache.
  - **Dual-Backend Architektúra:** működik helyi Node.js szerverrel (`server.js`), valamint **100%-ban statikus tárhelyen (GitHub Pages)** beépített `localStorage` API-emulációval.

---

## 🚀 Futtatás helyben (Localhost)

```bash
node server.js
```
Ezután nyisd meg a **http://localhost:3000** címet a böngészőben.
*(Statikus módban bármilyen fájlszerverről vagy közvetlenül GitHub Pages-ről is futtatható).*
