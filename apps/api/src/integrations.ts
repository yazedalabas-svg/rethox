import "./env.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = (
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL
)?.trim();
const supabaseAnonKey = (
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)?.trim();
const supabaseServiceKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
)?.trim();

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// Server-only client. Never expose this key to the web application.
export const supabaseAdmin: SupabaseClient | null =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

export async function integrationStatus() {
  let databaseReady = false;
  let databaseMessage = "Supabase غير مضبوط";
  if (supabase) {
    const { error } = await supabase.from("app_settings").select("key").limit(1);
    databaseReady = !error;
    databaseMessage = error
      ? "الاتصال موجود؛ نفّذ ملف SQL لإنشاء الجداول"
      : "متصل وجاهز";
  }
  return {
    supabase: {
      configured: Boolean(supabase),
      databaseReady,
      message: databaseMessage,
    },
    openrouter: {
      configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
    },
  };
}
