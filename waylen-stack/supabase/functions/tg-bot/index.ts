import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const PANEL = "https://www.waylen.travel/agentapp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function tg(token: string, method: string, payload: Record<string, unknown>): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
        return await r.json().catch(() => null);
    }
    catch (_) {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
function ok() { return new Response("ok", { status: 200 }); }
function draftKb(id: string) {
    return { inline_keyboard: [[{ text: "Утвердить", callback_data: "ap:" + id }, { text: "Удалить", callback_data: "dl:" + id }], [{ text: "Открыть панель", url: PANEL }]] };
}
function draftText(e: any, who: string) {
    return `Черновик для ${who}\n«${e.subject || "(без темы)"}»\n\n${String(e.body || "").slice(0, 2500)}${e.risk_note ? "\n\nПроверьте: " + e.risk_note : ""}`;
}
Deno.serve(async (req) => {
    if (req.method !== "POST")
        return new Response("", { status: 405 });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: secrets } = await db.from("agent_secrets").select("name,value").in("name", ["telegram_bot_token", "telegram_chat_id", "tg_webhook_secret"]);
    const sec: Record<string, string> = {};
    for (const s of secrets || [])
        sec[s.name] = s.value;
    if (!sec.tg_webhook_secret || req.headers.get("x-telegram-bot-api-secret-token") !== sec.tg_webhook_secret)
        return new Response("", { status: 401 });
    const token = sec.telegram_bot_token, chat = String(sec.telegram_chat_id || "");
    if (!token || !chat)
        return ok();
    const u = await req.json().catch(() => null);
    if (!u)
        return ok();
    const cb = u.callback_query;
    if (cb) {
        if (String(cb.from?.id) !== chat && String(cb.message?.chat?.id) !== chat) {
            await tg(token, "answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа" });
            return ok();
        }
        const [act, id] = String(cb.data || "").split(":");
        const msg = cb.message;
        const done = async (note: string, toast: string) => {
            await tg(token, "answerCallbackQuery", { callback_query_id: cb.id, text: toast });
            if (msg)
                await tg(token, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: String(msg.text || "").slice(0, 3600) + "\n\n" + note, reply_markup: { inline_keyboard: [[{ text: "Открыть панель", url: PANEL }]] } });
        };
        if (!UUID.test(id || "")) {
            await tg(token, "answerCallbackQuery", { callback_query_id: cb.id });
            return ok();
        }
        if (act === "ap") {
            const { data: e } = await db.from("emails").select("id,to_addr").eq("id", id).single();
            if (e && (await db.from("agent_settings").select("blocked_domains").eq("id", 1).single()).data?.blocked_domains?.some((b: string) => String(e.to_addr || "").toLowerCase().endsWith(b))) {
                await done("Не утверждено: адрес в чёрном списке", "Адрес в чёрном списке");
                return ok();
            }
            const { data: r } = await db.from("emails").update({ status: "approved" }).eq("id", id).eq("folder", "draft").eq("status", "draft").select("id");
            if (r && r.length) {
                await db.from("agent_runs").insert({ kind: "send", summary: "Утверждено в Telegram", details: "", ok: true, cost_usd: 0 });
                await done("✓ Утверждено — уйдёт при ближайшем запуске агента (до 30 минут)", "Утверждено");
            }
            else
                await done("Этот черновик уже утверждён, отправлен или удалён", "Уже неактуально");
        }
        else if (act === "dl") {
            const { data: r } = await db.from("emails").delete().eq("id", id).eq("folder", "draft").neq("status", "approved").select("id");
            if (r && r.length)
                await done("✗ Удалено. Напоминаний этому партнёру не будет", "Удалено");
            else
                await done("Этот черновик уже утверждён, отправлен или удалён", "Уже неактуально");
        }
        else
            await tg(token, "answerCallbackQuery", { callback_query_id: cb.id });
        return ok();
    }
    const m = u.message;
    if (!m || !m.text || String(m.chat?.id) !== chat)
        return ok();
    const text = String(m.text).trim();
    if (text === "/status" || text === "/start") {
        const { data: st } = await db.from("agent_settings").select("enabled,paused_until").eq("id", 1).single();
        const { count: open } = await db.from("questions").select("id", { count: "exact", head: true }).eq("status", "open");
        const { count: drafts } = await db.from("emails").select("id", { count: "exact", head: true }).eq("folder", "draft").eq("status", "draft");
        const paused = st?.paused_until && new Date(st.paused_until) > new Date();
        await tg(token, "sendMessage", { chat_id: chat, text: `Агент ${!st?.enabled ? "выключен" : paused ? "на паузе" : "работает"}. Черновиков ждут: ${drafts || 0}. Вопросов ко мне: ${open || 0}.\n\n/drafts — показать черновики с кнопками`, reply_markup: { inline_keyboard: [[{ text: "Открыть панель", url: PANEL }]] } });
        return ok();
    }
    if (text === "/drafts") {
        const { data: ds } = await db.from("emails").select("id,subject,body,to_addr,partner_id,risk_note").eq("folder", "draft").eq("status", "draft").order("created_at").limit(10);
        if (!ds || !ds.length) {
            await tg(token, "sendMessage", { chat_id: chat, text: "Черновиков нет." });
            return ok();
        }
        const pids = ds.map((e) => e.partner_id).filter(Boolean);
        const { data: ps } = pids.length ? await db.from("partners").select("id,name").in("id", pids) : { data: [] };
        for (const e of ds) {
            const who = (ps || []).find((p: any) => p.id === e.partner_id)?.name || e.to_addr || "партнёра";
            await tg(token, "sendMessage", { chat_id: chat, text: draftText(e, who), reply_markup: draftKb(e.id), disable_web_page_preview: true });
        }
        return ok();
    }
    const replyTo = m.reply_to_message?.message_id;
    let q: any = null;
    if (replyTo) {
        const { data } = await db.from("questions").select("id,question").eq("tg_msg_id", replyTo).eq("status", "open").limit(1);
        q = data?.[0] || null;
    }
    if (!q) {
        const { data } = await db.from("questions").select("id,question").eq("status", "open").not("tg_msg_id", "is", null).order("created_at", { ascending: false }).limit(1);
        q = data?.[0] || null;
    }
    if (!q) {
        await tg(token, "sendMessage", { chat_id: chat, text: "Открытых вопросов нет.\n/status — состояние агента\n/drafts — черновики с кнопками" });
        return ok();
    }
    await db.from("questions").update({ answer: text.slice(0, 4000), status: "answered", answered_at: new Date().toISOString() }).eq("id", q.id);
    await tg(token, "sendMessage", { chat_id: chat, text: "Принял ответ на вопрос «" + String(q.question).slice(0, 80) + "». Спасибо!" });
    return ok();
});
