import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { params: { eventsPerSecond: 10 } },
});
