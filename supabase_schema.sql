-- =============================================================================
-- BOGRÁCSFALVA - SUPABASE REALTIME ADATBÁZIS SÉMA
-- Futtasd ezt a szkriptet a Supabase Dashboard -> SQL Editor felületén!
-- =============================================================================

-- 1. Közösségi Szavazás Tábla (Community Votes)
CREATE TABLE IF NOT EXISTS public.community_votes (
  option_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  votes_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Row Level Security (RLS) beállítása: Minden látogató olvashatja és frissítheti a szavazatokat
ALTER TABLE public.community_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Mindenki olvashatja a szavazatokat"
  ON public.community_votes FOR SELECT
  USING (true);

CREATE POLICY "Mindenki leadhat szavazatot (upsert/update)"
  ON public.community_votes FOR ALL
  USING (true)
  WITH CHECK (true);

-- Kezdeti szavazás opciók feltöltése
INSERT INTO public.community_votes (option_key, label, votes_count)
VALUES 
  ('pekseg', '🥐 Falusi Pékség és Kemence', 52),
  ('ortorony', '🗼 Magas Fenyő Őrtorony', 40),
  ('konyvtar', '📚 Falusi Könyvtár és Olvasókör', 28)
ON CONFLICT (option_key) DO UPDATE
SET votes_count = EXCLUDED.votes_count;

-- 2. Falusi Ranglista Tábla (Village Leaderboard)
CREATE TABLE IF NOT EXISTS public.village_leaderboard (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Falusi Polgár',
  xp INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  is_npc BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Row Level Security (RLS) a Ranglistához
ALTER TABLE public.village_leaderboard ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Mindenki olvashatja a ranglistát"
  ON public.village_leaderboard FOR SELECT
  USING (true);

CREATE POLICY "Mindenki frissítheti a saját ranglista rekordját"
  ON public.village_leaderboard FOR ALL
  USING (true)
  WITH CHECK (true);

-- A falu 24 kanonikus lakója kezdőértékekkel
INSERT INTO public.village_leaderboard (username, display_name, title, xp, coins, is_npc)
VALUES
  ('gulyas_mester', 'Gulyás Mester (Dev)', 'Főszakács & Fejlesztő', 950, 680, true),
  ('csapos_bela', 'Csapos Béla', 'Kocsmáros', 580, 490, true),
  ('solyom_bence', 'Sólyom Bence', 'Fősolymász', 520, 410, true),
  ('vadasz_dani', 'Vadász Dani', 'Fővadász', 480, 360, true),
  ('langos_laci', 'Lángos Laci', 'Piacos Pékmester', 440, 390, true),
  ('harcsa_huba', 'Harcsa Huba', 'Öreg Főhorgász', 410, 340, true),
  ('piacos_marika', 'Piacos Marika', 'Kofaasszony', 390, 430, true),
  ('mehesz_mate', 'Méhész Máté', 'Méhészmester', 370, 310, true),
  ('szaki_jani', 'Szaki Jani', 'Kovács & Ezermester', 350, 300, true),
  ('almabor_akos', 'Almabor Ákos', 'Falusi Borász', 320, 280, true),
  ('citeras_csabi', 'Citerás Csabi', 'Falusi Dalnok', 310, 250, true),
  ('kalandor_lili', 'Kalandor Lili', 'Vándor Felfedező', 290, 220, true),
  ('pecas_peti', 'Pecás Peti', 'Horgásztanonc', 270, 210, true),
  ('sajtos_bandi', 'Sajtos Bandi', 'Sajtmester', 250, 260, true),
  ('kukta_kata', 'Kukta Kata', 'Segédszakács', 240, 190, true),
  ('bogyos_zsuzsi', 'Bogyós Zsuzsi', 'Füvesasszony', 220, 230, true),
  ('tulparti_tomi', 'Túlparti Tomi', 'Révészlegény', 200, 180, true),
  ('kandallo_krisz', 'Kandalló Krisz', 'Fahasogató', 190, 170, true),
  ('pipas_pista', 'Pipás Pista', 'Öreg Krónikás', 180, 160, true),
  ('vadmalac_viki', 'Vadmalac Viki', 'Erdei Nyomolvasó', 170, 150, true),
  ('erdo_betyar', 'Erdő Betyár', 'Betyárvezér', 160, 240, true),
  ('torzsvendeg_feri', 'Törzsvendég Feri', 'Kocsmai Szónok', 140, 120, true),
  ('kobor_kevin', 'Kóbor Kevin', 'Falusi Csalavér', 120, 110, true),
  ('szundi_szabi', 'Szundi Szabi', 'Főtéri Álomszuszék', 90, 80, true)
ON CONFLICT (username) DO NOTHING;

-- 3. Valós idejű (Realtime) replikáció engedélyezése a Supabase-ben
ALTER PUBLICATION supabase_realtime ADD TABLE public.community_votes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.village_leaderboard;
