import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl } from "./url";

export function createClient() {
  return createBrowserClient(supabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
