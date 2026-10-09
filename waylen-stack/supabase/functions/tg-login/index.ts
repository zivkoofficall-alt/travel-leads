// Supabase Edge Function: tg-login
// Вход в панель из Telegram Mini App: проверяем подпись initData (HMAC с токеном бота)
// и выдаём одноразовый токен входа только владельцу (его Telegram id = chat id в секретах).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OWNER_EMAIL = "zivkoofficall@gmail.com";
const ORIGINS = ["https://waylen.travel", "https://www.waylen.travel"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function reply(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const enc = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}
function hex(b: ArrayBuffer): string { return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false; let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { ok: false });
  try {
    const { initData } = await req.json();
    if (typeof initData !== "string" || initData.length < 20 || initData.length > 4096) return reply(req, 400, { ok: false });

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: rows } = await db.from("agent_secrets").select("name,value").in("name", ["telegram_bot_token", "telegram_chat_id"]);
    const sec: Record<string, string> = {}; for (const r of rows || []) sec[r.name] = r.value;
    if (!sec.telegram_bot_token || !sec.telegram_chat_id) return reply(req, 403, { ok: false });

    const params = new URLSearchParams(initData);
    const hash = params.get("hash") || ""; params.delete("hash");
    const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = await hmac(enc.encode("WebAppData"), sec.telegram_bot_token);
    const sign = hex(await hmac(secret, check));
    if (!hash || !safeEq(sign, hash)) return reply(req, 401, { ok: false });

    const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
    if (!(age >= -60 && age < 86400)) return reply(req, 401, { ok: false });

    let uid = ""; try { uid = String(JSON.parse(params.get("user") || "{}").id || ""); } catch (_) { /* пусто */ }
    if (!uid || uid !== String(sec.telegram_chat_id).trim()) return reply(req, 403, { ok: false });

    const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email: OWNER_EMAIL });
    const th = data?.properties?.hashed_token;
    if (error || !th) return reply(req, 500, { ok: false });
    return reply(req, 200, { ok: true, token_hash: th });
  } catch (_) { return reply(req, 400, { ok: false }); }
});
