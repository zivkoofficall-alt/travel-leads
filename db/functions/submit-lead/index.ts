import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const RATE_LIMIT_SECONDS = 60;
function allowedOrigin(origin: string | null): boolean {
    if (!origin)
        return true;
    try {
        const h = new URL(origin).hostname;
        return h === "waylen.travel" || h === "www.waylen.travel" ||
            /^waylen-travel[a-z0-9-]*\.vercel\.app$/.test(h);
    }
    catch (_) {
        return false;
    }
}
function cors(origin: string | null) {
    return {
        "Access-Control-Allow-Origin": origin && allowedOrigin(origin) ? origin : "https://waylen.travel",
        "Vary": "Origin",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
}
function isValidTelegram(value: string) {
    const cleaned = value.trim().replace(/^@/, "");
    return /^[a-zA-Z0-9_]{5,32}$/.test(cleaned);
}
function isValidPhone(value: string) {
    if (!/^[+\d\s().-]+$/.test(value))
        return false;
    const digits = value.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
}
function json(status: number, payload: Record<string, unknown>, origin: string | null) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { ...cors(origin), "Content-Type": "application/json" },
    });
}
async function notifyTelegram(lead: Record<string, string>): Promise<boolean> {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chat = Deno.env.get("TELEGRAM_CHAT_ID");
    if (!token || !chat)
        return false;
    const text = "Новая заявка с лендинга\n\n" +
        `Имя: ${lead.name || "—"}\n` +
        (lead.phone ? `Телефон: ${lead.phone}\n` : "") +
        (lead.telegram ? `Telegram: ${lead.telegram}\n` : "") +
        (lead.pet ? `Питомец: ${lead.pet}\n` : "") +
        (lead.message ? `Комментарий: ${lead.message}\n` : "");
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text }),
            signal: ctl.signal,
        });
        clearTimeout(timer);
        return r.ok;
    }
    catch (_) {
        return false;
    }
}
Deno.serve(async (req) => {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: cors(origin) });
    }
    if (!allowedOrigin(origin))
        return json(403, { ok: false, error: "forbidden" }, origin);
    if (req.method !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" }, origin);
    }
    try {
        const body = await req.json().catch(() => null);
        if (!body)
            return json(400, { ok: false, error: "invalid_json" }, origin);
        if ((body.company || "").toString().trim() !== "")
            return json(200, { ok: true }, origin);
        const name = (body.name || "").toString().trim();
        const contactTelegram = (body.contact_telegram || "").toString().trim();
        const contactPhone = (body.contact_phone || "").toString().trim();
        const pet = (body.pet || "").toString().trim();
        const message = (body.message || "").toString().trim();
        if (!name || name.length < 2)
            return json(400, { ok: false, error: "invalid_name" }, origin);
        if (!contactTelegram && !contactPhone)
            return json(400, { ok: false, error: "contact_required" }, origin);
        if (contactPhone && !isValidPhone(contactPhone))
            return json(400, { ok: false, error: "invalid_phone" }, origin);
        if (contactTelegram && !isValidTelegram(contactTelegram))
            return json(400, { ok: false, error: "invalid_telegram" }, origin);
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
            req.headers.get("cf-connecting-ip") ||
            "unknown";
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        if (ip !== "unknown") {
            const since = new Date(Date.now() - RATE_LIMIT_SECONDS * 1000).toISOString();
            const { data: recent, error: rateErr } = await supabase
                .from("leads")
                .select("id")
                .eq("ip_address", ip)
                .gte("created_at", since)
                .limit(1);
            if (rateErr) {
                console.error("rate check error:", rateErr);
            }
            else if (recent && recent.length > 0) {
                return json(429, { ok: false, error: "rate_limited" }, origin);
            }
        }
        const row = {
            name: name.slice(0, 200),
            contact_telegram: contactTelegram ? contactTelegram.slice(0, 100) : null,
            contact_phone: contactPhone ? contactPhone.slice(0, 40) : null,
            pet: pet.slice(0, 100) || null,
            message: message.slice(0, 2000) || null,
            source: "pets-landing",
            ip_address: ip,
        };
        const { error: insertErr } = await supabase.from("leads").insert(row);
        if (insertErr) {
            console.error("insert error:", insertErr);
            return json(500, { ok: false, error: "insert_failed" }, origin);
        }
        const notified = await notifyTelegram({
            name: row.name,
            phone: row.contact_phone || "",
            telegram: row.contact_telegram || "",
            pet: row.pet || "",
            message: row.message || "",
        });
        return json(200, { ok: true, notified }, origin);
    }
    catch (e) {
        console.error("unexpected error:", e);
        return json(500, { ok: false, error: "unexpected" }, origin);
    }
});
