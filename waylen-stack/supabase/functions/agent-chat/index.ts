// Supabase Edge Function: agent-chat
// Чат владельца с агентом Waylen Travel: отвечает на вопросы по данным панели
// и выполняет поручения (создать задание, задачу, запись в базе знаний, изменить настройки, запустить агента).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OWNER_EMAIL = "zivkoofficall@gmail.com";
const MODEL = "claude-sonnet-5-5";
const PRICE = [2, 10]; // $ за млн токенов: вход / выход
const HISTORY = 16;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function monthStart(): string { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }
function dayStart(): string { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); }
function extractActions(text: string): { reply: string; actions: any[] } {
  const m = text.match(/<actions>([\s\S]*?)<\/actions>/);
  if (!m) return { reply: text.trim(), actions: [] };
  let actions: any[] = [];
  try { const j = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " ")); actions = Array.isArray(j) ? j : []; } catch (_) { actions = []; }
  return { reply: text.replace(m[0], "").trim(), actions };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // только владелец
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (!u?.user || u.user.email !== OWNER_EMAIL) return json(401, { ok: false, error: "unauthorized" });

  const body = await req.json().catch(() => ({}));
  const message = String(body.message || "").trim().slice(0, 4000);
  if (!message) return json(400, { ok: false, error: "empty" });

  const { data: secrets } = await db.from("agent_secrets").select("name,value");
  const sec: Record<string, string> = {}; for (const s of secrets || []) sec[s.name] = s.value;
  if (!sec.anthropic_api_key) return json(200, { ok: false, error: "Нет ключа Claude API — добавьте его в настройках" });

  await db.from("chat_messages").insert({ role: "user", content: message });

  // ---- снимок данных для контекста ----
  const [st, kb, ps, ms, qs, ts, runs, mruns, ins, em, hist] = await Promise.all([
    db.from("agent_settings").select("*").eq("id", 1).single(),
    db.from("knowledge").select("topic,content").eq("is_demo", false),
    db.from("partners").select("name,kind,country,status,email,rating,priority,fit_note,last_contact_at,created_at,mission_id").eq("is_demo", false).order("created_at", { ascending: false }).limit(80),
    db.from("missions").select("id,title,goal,kind,region,target,write_letters,letters_per_day,searches_per_day,status,last_search_at,created_at"),
    db.from("questions").select("question,context,status,created_at").eq("status", "open").limit(10),
    db.from("tasks").select("title,due_at,done").eq("done", false).eq("is_demo", false).limit(20),
    db.from("agent_runs").select("created_at,kind,ok,summary,cost_usd").eq("is_demo", false).order("created_at", { ascending: false }).limit(25),
    db.from("agent_runs").select("cost_usd,kind").gte("created_at", monthStart()),
    db.from("insights").select("kind,title,summary,metric,metric_label,country").eq("is_demo", false).order("created_at", { ascending: false }).limit(30),
    db.from("emails").select("direction,folder,status,is_read,subject,from_addr,to_addr,summary_ru,created_at,partner_id").eq("is_demo", false).order("created_at", { ascending: false }).limit(40),
    db.from("chat_messages").select("role,content").order("created_at", { ascending: false }).limit(HISTORY + 1),
  ]);
  const s = st.data || {};
  const partners = ps.data || [];
  const byStatus: Record<string, number> = {}; for (const p of partners) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  const { count: pTotal } = await db.from("partners").select("id", { count: "exact", head: true }).eq("is_demo", false);
  const spentM = (mruns.data || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  const spentByKind: Record<string, number> = {}; for (const r of mruns.data || []) spentByKind[r.kind] = (spentByKind[r.kind] || 0) + Number(r.cost_usd || 0);
  const emails = em.data || [];
  const inboxUnread = emails.filter((e) => e.folder === "inbox" && !e.is_read).length;
  const drafts = emails.filter((e) => e.folder === "draft" && e.status !== "approved").length;
  const missionsById: Record<string, number> = {}; for (const p of partners) if (p.mission_id) missionsById[p.mission_id] = (missionsById[p.mission_id] || 0) + 1;

  const snapshot = `ДАТА: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Часовой пояс владельца: ${s.timezone || "Europe/Moscow"}.
НАСТРОЙКИ АГЕНТА: включён=${!!s.enabled}; режим отправки=${s.send_mode || "approve"} (approve — черновики ждут утверждения владельца); лимит писем/день=${s.daily_email_limit}; поисков/день=${s.search_runs_per_day}; типы партнёров=${(s.focus_kinds || []).join(",") || "-"}; страны=${(s.focus_countries || []).join(",") || "-"}; бюджет/мес=$${s.monthly_budget_usd || 0}; тихие часы ${s.quiet_start}–${s.quiet_end}; напоминание через ${s.followup_days} дн.
РАСХОДЫ: за месяц $${spentM.toFixed(2)}${Object.keys(spentByKind).length ? " (" + Object.entries(spentByKind).map(([k, v]) => k + " $" + v.toFixed(2)).join(", ") + ")" : ""}.
ПАРТНЁРЫ: всего ${pTotal || 0}; по статусам: ${Object.entries(byStatus).map(([k, v]) => k + "=" + v).join(", ") || "-"} (found — найден, contacted — написали, replied — ответил, agreed — договорились, declined — отказ).
Последние партнёры (до 80): ${partners.map((p) => `${p.name} [${p.kind}, ${p.country || "?"}, ${p.status}, ${p.rating || "-"}/5${p.email ? ", есть почта" : ", без почты"}]`).join("; ")}
ПОЧТА (последние 40): непрочитанных входящих ${inboxUnread}, черновиков на утверждение ${drafts}. ${emails.slice(0, 15).map((e) => `${e.created_at.slice(0, 10)} ${e.direction === "in" ? "ВХ" : "ИСХ"} [${e.folder}/${e.status}] ${e.direction === "in" ? e.from_addr : e.to_addr}: ${e.subject || ""}${e.summary_ru ? " — " + e.summary_ru : ""}`).join(" | ")}
ЗАДАНИЯ (missions): ${(ms.data || []).map((m) => `«${m.title}» [${m.status}] цель ${m.goal} | регион ${m.region || "-"} | тип ${m.kind} | найдено ${missionsById[m.id] || 0} из ${m.target} | письма ${m.write_letters ? "да, " + m.letters_per_day + "/день" : "нет"} | поисков/день ${m.searches_per_day} | последний поиск ${m.last_search_at || "-"}`).join("; ") || "нет"}
ОТКРЫТЫЕ ВОПРОСЫ АГЕНТА К ВЛАДЕЛЬЦУ: ${(qs.data || []).map((q) => q.question).join(" | ") || "нет"}
ЗАДАЧИ ВЛАДЕЛЬЦА (не сделаны): ${(ts.data || []).map((t) => t.title + (t.due_at ? " до " + t.due_at.slice(0, 10) : "")).join("; ") || "нет"}
ЖУРНАЛ ДЕЙСТВИЙ (последние 25): ${(runs.data || []).map((r) => `${r.created_at.slice(5, 16).replace("T", " ")} ${r.ok ? "✓" : "✗"} ${r.summary} ($${Number(r.cost_usd || 0).toFixed(2)})`).join(" | ")}
РЫНОК: ${(ins.data || []).filter((i) => i.kind === "country").map((i) => `${i.title} ${i.metric}% (${i.metric_label || ""})`).join("; ")}. Новости: ${(ins.data || []).filter((i) => i.kind === "news").slice(0, 6).map((i) => i.title).join(" | ")}
БАЗА ЗНАНИЙ:
${(kb.data || []).map((k) => `• ${k.topic}: ${k.content}`).join("\n") || "(пусто)"}`;

  const system = `Ты — ИИ-агент компании Waylen Travel (waylen.travel), сервиса сопровождения переездов и поездок с питомцами. Ты общаешься с владельцем компании Филиппом в его панели управления. Твоя работа в фоне: ищешь партнёров (ветклиники, перевозчики, блогеры), пишешь им письма, разбираешь входящую почту, собираешь новости рынка. Ниже — актуальный снимок данных панели: отвечай на вопросы ТОЛЬКО по нему, не выдумывай цифры; если чего-то нет в снимке — так и скажи.

Стиль: по-русски, коротко, по делу, без воды и без приветствий в каждом сообщении. Цифры и имена — конкретные. Можно короткие списки. Без эмодзи.

Ты умеешь ВЫПОЛНЯТЬ поручения. Если владелец просит что-то сделать — сделай это через блок действий в самом конце ответа (после текста), строго в формате:
<actions>[{...},{...}]</actions>
Поддерживаемые действия:
- {"type":"mission","title":"","goal":"подробная цель","kind":"clinic|carrier|blogger|community|other","region":"страна/город","target":20,"write_letters":true,"letters_per_day":5,"searches_per_day":1,"letter_brief":"что обязательно сказать в письме"} — создать задание на поиск партнёров и рассылку (поиск стоит ~$0.3 за запуск, письмо ~$0.01).
- {"type":"mission_update","title":"точное название существующего задания","patch":{"status":"active|paused|done","region":"","target":30,"write_letters":true,"letters_per_day":5,"letter_brief":""}} — изменить задание.
- {"type":"task","title":"","due":"YYYY-MM-DD или null"} — задача владельцу в список дел.
- {"type":"knowledge","topic":"","content":""} — добавить факт в базу знаний (из него ты потом пишешь письма).
- {"type":"settings","patch":{"enabled":true,"send_mode":"approve|auto","daily_email_limit":10,"search_runs_per_day":1,"monthly_budget_usd":20,"focus_countries":["Вьетнам"],"focus_kinds":["clinic"],"followup_days":4}} — изменить настройки (только перечисленные ключи).
- {"type":"run_now"} — запустить рабочий цикл агента прямо сейчас.
Правила: действие выполняй только когда просьба однозначна; если не хватает данных (например, регион или цель задания) — задай один уточняющий вопрос и НЕ добавляй блок actions. В тексте ответа перечисли, что именно сделал, одной-двумя фразами. Не обещай того, что не можешь сделать (например, отправить письмо напрямую — письма идут через очередь и утверждение).`;

  const history = (hist.data || []).reverse().filter((m) => m.content).slice(0, -1); // без только что сохранённого сообщения
  const messages: any[] = [];
  for (const h of history) messages.push({ role: h.role, content: h.content });
  if (messages.length && messages[0].role !== "user") messages.shift();
  messages.push({ role: "user", content: message });

  let text = "", tin = 0, tout = 0;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": sec.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: [{ type: "text", text: system }, { type: "text", text: snapshot, cache_control: { type: "ephemeral" } }], messages }),
    });
    clearTimeout(t);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Claude " + r.status + ": " + (d?.error?.message || "").slice(0, 200));
    text = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const us = d.usage || {}; tin = (us.input_tokens || 0) + (us.cache_read_input_tokens || 0) + (us.cache_creation_input_tokens || 0); tout = us.output_tokens || 0;
  } catch (e) {
    return json(200, { ok: false, error: String(e).slice(0, 300) });
  }
  const cost = tin / 1e6 * PRICE[0] + tout / 1e6 * PRICE[1];
  const { reply, actions } = extractActions(text);

  // ---- выполняем действия ----
  const done: string[] = [];
  for (const a of actions.slice(0, 6)) {
    try {
      if (a.type === "mission" && a.title && a.goal) {
        const kind = ["clinic", "carrier", "blogger", "community", "other"].includes(a.kind) ? a.kind : "other";
        await db.from("missions").insert({ title: String(a.title).slice(0, 120), goal: String(a.goal).slice(0, 2000), kind, region: a.region || null, target: Math.max(1, Math.min(200, Number(a.target) || 20)), write_letters: a.write_letters !== false, letters_per_day: Math.max(0, Math.min(30, Number(a.letters_per_day) || 5)), searches_per_day: Math.max(1, Math.min(4, Number(a.searches_per_day) || 1)), letter_brief: a.letter_brief || null, status: "active" });
        done.push("Создано задание «" + a.title + "»");
      } else if (a.type === "mission_update" && a.title && a.patch) {
        const p: any = {}; for (const k of ["status", "region", "target", "write_letters", "letters_per_day", "searches_per_day", "letter_brief", "goal"]) if (a.patch[k] !== undefined) p[k] = a.patch[k];
        if (p.status && !["active", "paused", "done"].includes(p.status)) delete p.status;
        p.updated_at = new Date().toISOString();
        const { data: upd } = await db.from("missions").update(p).ilike("title", String(a.title)).select("id");
        done.push(upd && upd.length ? "Задание «" + a.title + "» обновлено" : "Задание «" + a.title + "» не найдено");
      } else if (a.type === "task" && a.title) {
        await db.from("tasks").insert({ title: String(a.title).slice(0, 300), due_at: a.due && /^\d{4}-\d{2}-\d{2}/.test(a.due) ? new Date(a.due).toISOString() : null, done: false });
        done.push("Добавлена задача «" + a.title + "»");
      } else if (a.type === "knowledge" && a.topic && a.content) {
        await db.from("knowledge").insert({ topic: String(a.topic).slice(0, 120), content: String(a.content).slice(0, 4000), updated_at: new Date().toISOString() });
        done.push("В базу знаний добавлено «" + a.topic + "»");
      } else if (a.type === "settings" && a.patch) {
        const allowed = ["enabled", "send_mode", "daily_email_limit", "search_runs_per_day", "monthly_budget_usd", "focus_countries", "focus_kinds", "followup_days", "quiet_start", "quiet_end"];
        const p: any = {}; for (const k of allowed) if (a.patch[k] !== undefined) p[k] = a.patch[k];
        if (p.send_mode && !["approve", "auto"].includes(p.send_mode)) delete p.send_mode;
        if (Object.keys(p).length) { p.updated_at = new Date().toISOString(); await db.from("agent_settings").update(p).eq("id", 1); done.push("Настройки изменены: " + Object.keys(p).filter((k) => k !== "updated_at").join(", ")); }
      } else if (a.type === "run_now") {
        const url = Deno.env.get("SUPABASE_URL") + "/functions/v1/agent-tick";
        fetch(url, { method: "POST", headers: { "x-agent-key": sec.cron_key || "", "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
        done.push("Агент запущен");
      }
    } catch (e) { done.push("Не удалось: " + String(e).slice(0, 120)); }
  }

  await db.from("chat_messages").insert({ role: "assistant", content: reply || "(пусто)", actions: done.length ? done : null, cost_usd: +cost.toFixed(5) });
  await db.from("agent_runs").insert({ kind: "chat", summary: ("Чат: " + message).slice(0, 300), details: (reply + (done.length ? "\n\nДействия: " + done.join("; ") : "")).slice(0, 4000), ok: true, cost_usd: +cost.toFixed(5), model: MODEL, tokens_in: tin, tokens_out: tout });
  return json(200, { ok: true, reply, actions: done, cost: +cost.toFixed(4) });
});
