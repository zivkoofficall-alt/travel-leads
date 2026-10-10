import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const OWNER_EMAIL = "zivkoofficall@gmail.com";
const OWNER_ID = "1e070b66-c1a5-4865-b98f-3e0b12aca8e6";
const HAIKU = "claude-haiku-5-5";
const PRICE = [0.10, 0.50];
const BATCH = 20;
const AM = "https://api.agentmail.to/v0";
function json(status: number, payload: unknown) {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://www.waylen.travel", "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-key" } });
}
function extractJson(text: string): any {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    for (const c of [fence ? fence[1] : "", text]) {
        if (!c)
            continue;
        const i = c.indexOf("{");
        if (i < 0)
            continue;
        for (let end = c.length; end > i; end--) {
            if (c[end - 1] !== "}")
                continue;
            try {
                return JSON.parse(c.slice(i, end));
            }
            catch (_) { }
        }
    }
    return null;
}
function stripHtml(h: string): string {
    return String(h || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}
async function amGet(key: string, path: string): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
        const r = await fetch(AM + path, { signal: ctl.signal, headers: { Authorization: "Bearer " + key } });
        if (!r.ok)
            throw new Error("agentmail " + r.status);
        return await r.json();
    }
    finally {
        clearTimeout(t);
    }
}
Deno.serve(async (req) => {
    if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "https://www.waylen.travel", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-key", "Vary": "Origin" } });
    if (req.method !== "POST")
        return json(405, { ok: false });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: secrets } = await db.from("agent_secrets").select("name,value");
    const sec: Record<string, string> = {};
    for (const s of secrets || [])
        sec[s.name] = s.value;
    const key = req.headers.get("x-agent-key");
    if (!key || key !== sec.cron_key) {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const { data: u } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
        if (!u?.user || u.user.email !== OWNER_EMAIL || u.user.id !== OWNER_ID)
            return json(401, { ok: false, error: "unauthorized" });
    }
    if (!sec.anthropic_api_key)
        return json(200, { ok: true, skipped: "no_key" });
    const { data: st } = await db.from("agent_settings").select("monthly_budget_usd").eq("id", 1).single();
    const ms = new Date();
    const monthStart = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth(), 1)).toISOString();
    const { data: runs } = await db.from("agent_runs").select("cost_usd").gte("created_at", monthStart);
    const spentM = (runs || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
    if (Number(st?.monthly_budget_usd) && spentM >= Number(st!.monthly_budget_usd))
        return json(200, { ok: true, skipped: "budget" });
    const { data: accounts } = await db.from("mail_accounts").select("id,address,provider");
    const accOf: Record<string, any> = {};
    for (const a of accounts || [])
        accOf[a.id] = a;
    const { data: mails } = await db.from("emails").select("id,subject,body,direction,external_id,account_id,from_addr,to_addr").neq("folder", "draft").is("enriched_at", null).order("created_at", { ascending: false }).limit(BATCH);
    if (!mails || !mails.length)
        return json(200, { ok: true, done: 0, left: 0 });
    let done = 0, cost = 0, tin = 0, tout = 0, failed = 0, fetched = 0;
    const work = async (m: any) => {
        let body = String(m.body || "");
        const acc = accOf[m.account_id];
        if (sec.agentmail_api_key && m.external_id && acc && acc.provider === "agentmail" && body.length <= 220) {
            try {
                const full = await amGet(sec.agentmail_api_key, `/inboxes/${encodeURIComponent(acc.address)}/messages/${encodeURIComponent(m.external_id)}`);
                const t = full.extracted_text || full.text || (full.html ? stripHtml(full.html) : "") || full.preview || "";
                if (t && t.length > body.length) {
                    body = String(t);
                    fetched++;
                }
            }
            catch (_) { }
        }
        const text = body.slice(0, 9000);
        const who = m.direction === "out" ? "Это ИСХОДЯЩЕЕ письмо: его написали мы (Waylen Travel, сервис перевозки питомцев) партнёру или клиенту." : "Это ВХОДЯЩЕЕ письмо от партнёра, клиента или сервиса нам (Waylen Travel).";
        const prompt = `${who} Проанализируй его и верни только JSON:
{"lang":"двухбуквенный код языка письма, например ru, en, tr","summary_ru":"суть письма на русском в 1–2 коротких предложениях: ${m.direction === "out" ? "что мы предложили или спросили" : "кто пишет, что просит или предлагает"}, есть ли сроки, цены, вопросы","body_ru":"полный точный перевод текста на русский, если письмо не на русском; если на русском — null"}
Техническая рассылка, ошибка доставки (mailer-daemon) или уведомление сервиса — тоже кратко опиши по-русски, что случилось.

От: ${m.from_addr || ""}
Кому: ${m.to_addr || ""}
Тема: ${m.subject || ""}
Текст:
${text || "(пусто)"}`;
        try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 60000);
            const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal, headers: { "x-api-key": sec.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: HAIKU, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }) });
            clearTimeout(t);
            const d = await r.json().catch(() => ({}));
            if (!r.ok)
                throw new Error("Claude " + r.status + " " + (d?.error?.message || ""));
            const out = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
            const j = extractJson(out) || {};
            const u = d.usage || {};
            tin += u.input_tokens || 0;
            tout += u.output_tokens || 0;
            cost += (u.input_tokens || 0) / 1e6 * PRICE[0] + (u.output_tokens || 0) / 1e6 * PRICE[1];
            const lang = String(j.lang || "").toLowerCase().slice(0, 5) || null;
            const summary = j.summary_ru ? String(j.summary_ru).slice(0, 600) : null;
            const body_ru = lang && lang !== "ru" && j.body_ru ? String(j.body_ru).slice(0, 20000) : null;
            if (!summary)
                throw new Error("empty");
            const patch: any = { lang, summary_ru: summary, body_ru, enriched_at: new Date().toISOString() };
            if (body !== String(m.body || ""))
                patch.body = body;
            await db.from("emails").update(patch).eq("id", m.id);
            done++;
        }
        catch (e) {
            failed++;
            const patch: any = String(e).includes("empty") ? { enriched_at: new Date().toISOString() } : {};
            if (body !== String(m.body || ""))
                patch.body = body;
            if (Object.keys(patch).length)
                await db.from("emails").update(patch).eq("id", m.id);
        }
    };
    for (let i = 0; i < mails.length; i += 5)
        await Promise.all(mails.slice(i, i + 5).map(work));
    if (done || failed)
        await db.from("agent_runs").insert({ kind: "mail_check", summary: `Перевод и краткое содержание: писем ${done}${fetched ? ", полный текст догружен для " + fetched : ""}${failed ? ", ошибок " + failed : ""}`, details: "", ok: failed === 0, cost_usd: +cost.toFixed(5), model: HAIKU, tokens_in: tin, tokens_out: tout });
    const { count } = await db.from("emails").select("id", { count: "exact", head: true }).neq("folder", "draft").is("enriched_at", null);
    return json(200, { ok: true, done, failed, fetched, left: count || 0, cost: +cost.toFixed(4) });
});
