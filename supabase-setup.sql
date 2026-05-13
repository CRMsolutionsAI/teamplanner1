-- ═══════════════════════════════════════════════════════════
-- TeamPlanner — Supabase Setup SQL
-- Выполните этот файл в Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Таблица хранилища данных (недели, конфиг)
CREATE TABLE IF NOT EXISTS storage (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_updated_at
  BEFORE UPDATE ON storage
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2. Таблица логов активности
CREATE TABLE IF NOT EXISTS activity_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_name   TEXT NOT NULL,
  user_emoji  TEXT DEFAULT '👤',
  user_color  TEXT DEFAULT '#A8D8EA',
  action      TEXT NOT NULL,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Индекс для быстрой фильтрации по дате и пользователю
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_user ON activity_logs(user_name);

-- 3. RLS (Row Level Security) — разрешаем всё для anon
-- (доступ контролируется через Netlify/Cloudflare Access)
ALTER TABLE storage ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_storage" ON storage
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "allow_all_logs" ON activity_logs
  FOR ALL USING (true) WITH CHECK (true);

-- 4. Realtime — включаем для таблиц
ALTER PUBLICATION supabase_realtime ADD TABLE storage;
ALTER PUBLICATION supabase_realtime ADD TABLE activity_logs;

-- ═══════════════════════════════════════════════════════════
-- Готово! После выполнения:
-- 1. Скопируйте Project URL и anon key из Settings → API
-- 2. Добавьте в Netlify как переменные окружения:
--    VITE_SUPABASE_URL = https://xxx.supabase.co
--    VITE_SUPABASE_ANON_KEY = eyJ...
-- ═══════════════════════════════════════════════════════════
