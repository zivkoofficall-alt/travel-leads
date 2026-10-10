// Supabase Edge Function: agent-tick
// Агент Waylen Travel. Запускается по расписанию (pg_cron) каждые 30 минут
// или вручную из панели. Ищет партнёров, разбирает почту, готовит черновики,
// задаёт вопросы владельцу (панель + Telegram), собирает новости рынка.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OWNER_EMAIL = "zivkoofficall@gmail.com";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
// цена за миллион токенов, $ (вход / выход) и за один веб-поиск
const PRICE: Record<string, [number, number]> = { [SONNET]: [2, 10], [HAIKU]: [0.10, 0.50] };
const SEARCH_PRICE = 0.01;
const LOCK_MINUTES = 10;

type Settings = Record<string, any>;
type Db = SupabaseClient;

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function localHour(tz: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: tz || "Europe/Moscow" }).format(new Date()));
  } catch (_) { return new Date().getUTCHours(); }
}
function isQuiet(s: Settings): boolean {
  const h = localHour(s.timezone), a = Number(s.quiet_start ?? 22), b = Number(s.quiet_end ?? 8);
  if (a === b) return false;
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}
function monthStart(): string { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }
function dayStart(): string { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); }
function hoursAgo(iso: string | null): number { return iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : 1e9; }
function domainOf(x: string | null | undefined): string {
  x = String(x || "").trim().toLowerCase(); if (!x) return "";
  if (x.includes("@")) return x.split("@").pop()!.replace(/[>\s].*$/, "");
  return x.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[\/?#]/)[0];
}
function norm(s: string | null | undefined): string { return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
const FREE = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "mail.ru", "bk.ru", "inbox.ru", "list.ru", "yandex.ru", "yandex.com", "ya.ru", "proton.me", "protonmail.com", "gmx.com", "web.de", "aol.com"]);
function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // модель иногда ставит сырые переносы строк внутри строк JSON — пробуем и «очищенный» вариант
  const clean = (t: string) => t.replace(/[\u0000-\u001f]+/g, " ");
  const candidates = [fence ? fence[1] : "", text, fence ? clean(fence[1]) : "", clean(text)];
  for (const c of candidates) {
    if (!c) continue;
    const i = Math.min(...["{", "["].map((ch) => { const k = c.indexOf(ch); return k < 0 ? 1e9 : k; }));
    if (i === 1e9) continue;
    for (let end = c.length; end > i; end--) {
      const ch = c[end - 1]; if (ch !== "}" && ch !== "]") continue;
      try { return JSON.parse(c.slice(i, end)); } catch (_) { /* укорачиваем */ }
    }
    // ответ мог оборваться по лимиту токенов: режем до последнего целого объекта и закрываем скобки
    const body = c.slice(i);
    for (let cut = body.lastIndexOf("}"); cut > 0; cut = body.lastIndexOf("}", cut - 1)) {
      for (const tail of ["", "]}", "]}]}", "]}]}]}"]) {
        try { return JSON.parse(body.slice(0, cut + 1) + tail); } catch (_) { /* дальше */ }
      }
    }
  }
  return null;
}

/* ---------- Claude ---------- */
interface ClaudeResult { text: string; json: any; tokensIn: number; tokensOut: number; searches: number; cost: number; model: string }
async function claude(apiKey: string, opts: { model: string; system: string; prompt: string; webSearch?: number; maxTokens?: number }): Promise<ClaudeResult> {
  const body: Record<string, unknown> = {
    model: opts.model, max_tokens: opts.maxTokens || 2500, system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.webSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: opts.webSearch }];
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 110000);
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally { clearTimeout(timer); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude API " + r.status + ": " + (data?.error?.message || "").slice(0, 300));
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const u = data.usage || {};
  const tokensIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const tokensOut = u.output_tokens || 0;
  const searches = u.server_tool_use?.web_search_requests || 0;
  const p = PRICE[opts.model] || [3, 15];
  const cost = tokensIn / 1e6 * p[0] + tokensOut / 1e6 * p[1] + searches * SEARCH_PRICE;
  return { text, json: extractJson(text), tokensIn, tokensOut, searches, cost, model: opts.model };
}

/* ---------- Telegram ---------- */
async function tg(token: string, method: string, payload: Record<string, unknown>): Promise<any> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
    return await r.json().catch(() => null);
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

/* ---------- Контекст запуска ---------- */
class Ctx {
  db: Db; s: Settings; apiKey = ""; tgToken = ""; tgChat = ""; log: string[] = []; spent = 0;
  knowledge: any[] = []; partners: any[] = []; accounts: any[] = []; templates: any[] = [];
  constructor(db: Db, s: Settings) { this.db = db; this.s = s; }

  async run(kind: string, summary: string, details: string, ok: boolean, r?: ClaudeResult) {
    this.log.push((ok ? "✓ " : "✗ ") + summary);
    if (r) this.spent += r.cost;
    await this.db.from("agent_runs").insert({ kind, summary: summary.slice(0, 300), details: details.slice(0, 4000), ok, cost_usd: r ? +r.cost.toFixed(5) : 0, model: r?.model || null, tokens_in: r?.tokensIn || null, tokens_out: r?.tokensOut || null });
  }
  async notify(text: string): Promise<number | null> {
    if (!this.tgToken || !this.tgChat) return null;
    const res = await tg(this.tgToken, "sendMessage", { chat_id: this.tgChat, text: text.slice(0, 3900), disable_web_page_preview: true });
    return res?.result?.message_id ?? null;
  }
  async ask(question: string, context: string, draft: string | null, partnerId: string | null, emailId: string | null) {
    const { data: dup } = await this.db.from("questions").select("id").eq("status", "open").eq("question", question).limit(1);
    if (dup && dup.length) return;
    const { data: q } = await this.db.from("questions").insert({ question, context, draft, partner_id: partnerId, email_id: emailId, status: "open" }).select("id").single();
    const msgId = await this.notify("Вопрос от агента\n\n" + question + (context ? "\n\n" + context : "") + (draft ? "\n\nЧерновик ответа:\n" + draft : "") + "\n\nОтветьте на это сообщение (reply) или в панели waylen.travel/agentapp");
    if (q && msgId) await this.db.from("questions").update({ tg_msg_id: msgId }).eq("id", q.id);
  }
  companyContext(): string {
    const kb = this.knowledge.map((k) => `• ${k.topic}: ${k.content}`).join("\n");
    return `Компания: Waylen Travel (waylen.travel) — агентство по перевозке домашних животных между странами: документы, ветеринарные требования, маршрут, сопровождение. Клиенты переезжают или путешествуют с питомцами.
${this.s.company_summary ? "О компании от владельца: " + this.s.company_summary + "\n" : ""}База знаний (единственный источник фактов об условиях; если факта нет — не выдумывай):
${kb || "(пусто)"}
Тон писем: ${this.s.tone || "вежливо, коротко, по делу, на «вы», без воды"}.`;
  }
}

/* ---------- Telegram: входящие ответы ---------- */
async function telegramInbox(c: Ctx) {
  if (!c.tgToken) return;
  const res = await tg(c.tgToken, "getUpdates", { offset: Number(c.s.tg_offset || 0) + 1, timeout: 0, allowed_updates: ["message"] });
  const updates: any[] = res?.result || [];
  if (!updates.length) return;
  let last = Number(c.s.tg_offset || 0), answered = 0;
  for (const u of updates) {
    last = Math.max(last, u.update_id);
    const m = u.message; if (!m || !m.text) continue;
    if (String(m.chat?.id) !== String(c.tgChat)) continue; // отвечаем только владельцу
    const text = String(m.text).trim();
    if (text === "/status") {
      const { count: open } = await c.db.from("questions").select("id", { count: "exact", head: true }).eq("status", "open");
      const { count: drafts } = await c.db.from("emails").select("id", { count: "exact", head: true }).eq("folder", "draft").neq("status", "approved");
      await c.notify(`Агент ${c.s.enabled ? "работает" : "выключен"}. Открытых вопросов: ${open || 0}. Черновиков ждут утверждения: ${drafts || 0}. Партнёров в базе: ${c.partners.length}.`);
      continue;
    }
    const replyTo = m.reply_to_message?.message_id;
    let q: any = null;
    if (replyTo) { const { data } = await c.db.from("questions").select("id,question").eq("tg_msg_id", replyTo).eq("status", "open").limit(1); q = data?.[0] || null; }
    if (!q) { // без reply — берём самый свежий открытый вопрос, отправленный в Telegram
      const { data } = await c.db.from("questions").select("id,question").eq("status", "open").not("tg_msg_id", "is", null).order("created_at", { ascending: false }).limit(1); q = data?.[0] || null;
    }
    if (!q) { await c.notify("Открытых вопросов нет. Напишите /status, чтобы узнать состояние."); continue; }
    await c.db.from("questions").update({ answer: text, status: "answered", answered_at: new Date().toISOString() }).eq("id", q.id);
    await c.notify("Принял ответ на вопрос «" + q.question.slice(0, 80) + "». Спасибо!");
    answered++;
  }
  await c.db.from("agent_settings").update({ tg_offset: last }).eq("id", 1);
  if (answered) await c.run("question", `Получено ответов из Telegram: ${answered}`, "", true);
}

/* ---------- Ответы владельца → база знаний ---------- */
async function absorbAnswers(c: Ctx) {
  // ответы на вопросы, которые ещё не попали в знания, добавляем как факты (их видно и можно поправить в панели)
  const { data: qs } = await c.db.from("questions").select("id,question,answer").eq("status", "answered").gte("answered_at", new Date(Date.now() - 36e5 * 2).toISOString());
  for (const q of qs || []) {
    if (!q.answer || q.answer.length < 2) continue;
    const topic = ("Ответ владельца: " + q.question).slice(0, 120);
    const { data: ex } = await c.db.from("knowledge").select("id").eq("topic", topic).limit(1);
    if (ex && ex.length) continue;
    await c.db.from("knowledge").insert({ topic, content: q.answer, updated_at: new Date().toISOString() });
    c.knowledge.push({ topic, content: q.answer });
  }
}

/* ---------- Почта (провайдеры подключаются позже) ---------- */
let AM_KEY = "";
const AM = "https://api.agentmail.to/v0";
async function am(method: string, path: string, body?: unknown): Promise<any> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(AM + path, { method, signal: ctl.signal, headers: { Authorization: "Bearer " + AM_KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("AgentMail " + r.status + ": " + String(j?.message || j?.name || "").slice(0, 200));
    return j;
  } finally { clearTimeout(timer); }
}
function addrOf(x: unknown): string {
  const v = Array.isArray(x) ? x[0] : x; const t = String(v || "");
  const m = t.match(/<([^>]+)>/); return (m ? m[1] : t).trim().toLowerCase();
}
// ящик AgentMail создаём автоматически при первом запуске с ключом
async function ensureMailbox(c: Ctx) {
  if (!AM_KEY || c.accounts.some((a) => a.provider === "agentmail")) return;
  try {
    let inbox: any = null;
    for (const username of ["waylen.travel", "waylen-travel", "waylen.pets", "waylen"]) {
      try { inbox = await am("POST", "/inboxes", { username, display_name: "Waylen Travel" }); break; } catch (e) { if (!String(e).includes("409")) throw e; }
    }
    if (!inbox) inbox = await am("POST", "/inboxes", { display_name: "Waylen Travel" });
    const { data: acc } = await c.db.from("mail_accounts").insert({ label: "Агент (AgentMail)", address: inbox.email || inbox.inbox_id, provider: "agentmail", status: "connected" }).select("*").single();
    if (acc) c.accounts.push(acc);
    await c.run("mail_check", "Создан ящик агента: " + (inbox.email || inbox.inbox_id), "", true);
    await c.notify("Ящик агента готов: " + (inbox.email || inbox.inbox_id));
  } catch (e) { await c.run("mail_check", "Не удалось создать ящик AgentMail", String(e), false); }
}
async function fetchInbox(account: any): Promise<any[]> {
  if (account.provider !== "agentmail" || !AM_KEY) return [];
  const after = new Date(Date.now() - 3 * 864e5).toISOString();
  const list = await am("GET", `/inboxes/${encodeURIComponent(account.address)}/messages?limit=30&ascending=true&after=${encodeURIComponent(after)}`);
  const out: any[] = [];
  for (const m of list.messages || []) {
    const from = addrOf(m.from);
    if (!from || from === String(account.address).toLowerCase()) continue;
    if ((m.labels || []).includes("sent")) continue;
    let body = m.preview || "";
    try { const full = await am("GET", `/inboxes/${encodeURIComponent(account.address)}/messages/${encodeURIComponent(m.message_id)}`); body = full.extracted_text || full.text || full.preview || body; } catch (_) { /* оставляем preview */ }
    out.push({ external_id: m.message_id, from_addr: from, subject: m.subject || "(без темы)", body, date: m.timestamp || m.created_at });
  }
  return out;
}
async function sendMail(account: any, email: any): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (account.provider !== "agentmail" || !AM_KEY) return { ok: false, error: "\u042f\u0449\u0438\u043a \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d" };
  try {
    const r = await am("POST", `/inboxes/${encodeURIComponent(account.address)}/messages/send`, { to: [email.to_addr], subject: email.subject || "", text: email.body || "" });
    return { ok: true, id: r.message_id };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function mailSync(c: Ctx) {
  const connected = c.accounts.filter((a) => a.status === "connected");
  for (const a of connected) {
    try {
      const incoming = await fetchInbox(a);
      for (const m of incoming) {
        const { data: ex } = await c.db.from("emails").select("id").eq("external_id", m.external_id).limit(1);
        if (ex && ex.length) continue;
        const partner = c.partners.find((p) => p.email && p.email.toLowerCase() === String(m.from_addr).toLowerCase());
        await c.db.from("emails").insert({ account_id: a.id, partner_id: partner?.id || null, direction: "in", status: "received", folder: "inbox", is_read: false, subject: m.subject, body: m.body, from_addr: m.from_addr, to_addr: a.address, external_id: m.external_id, created_at: m.date || new Date().toISOString() });
      }
      if (incoming.length) await c.run("mail_check", `Проверка почты ${a.label}: новых писем ${incoming.length}`, "", true);
    } catch (e) { await c.run("mail_check", `Проверка почты ${a.label}: ошибка`, String(e), false); }
  }
}

async function sendQueued(c: Ctx) {
  if (isQuiet(c.s)) return;
  const { count: sentToday } = await c.db.from("emails").select("id", { count: "exact", head: true }).eq("folder", "sent").gte("sent_at", dayStart());
  let room = Math.max(0, Number(c.s.daily_email_limit || 0) - (sentToday || 0));
  if (!room) return;
  const { data: queue } = await c.db.from("emails").select("*").eq("folder", "draft").eq("status", "approved").order("created_at").limit(room);
  for (const e of queue || []) {
    const a = c.accounts.find((x) => x.id === e.account_id && x.status === "connected");
    if (!a) continue; // ящик не подключён — ждём
    const blocked = (c.s.blocked_domains || []).some((b: string) => b === String(e.to_addr).toLowerCase() || b === domainOf(e.to_addr));
    if (blocked) { await c.db.from("emails").update({ status: "failed" }).eq("id", e.id); continue; }
    const r = await sendMail(a, e);
    if (r.ok) {
      await c.db.from("emails").update({ folder: "sent", status: "sent", sent_at: new Date().toISOString(), external_id: r.id || null }).eq("id", e.id);
      if (e.partner_id) await c.db.from("partners").update({ status: "contacted", status_changed_at: new Date().toISOString(), last_contact_at: new Date().toISOString() }).eq("id", e.partner_id).eq("status", "found");
      await c.run("send", `Отправлено: ${e.subject || "(без темы)"} → ${e.to_addr}`, "", true);
      room--; if (!room) break;
    } else {
      await c.db.from("emails").update({ status: "failed" }).eq("id", e.id);
      await c.run("send", `Не отправлено: ${e.to_addr}`, r.error || "", false);
    }
  }
}

/* ---------- Разбор входящих писем ---------- */
async function processInbox(c: Ctx) {
  const { data: emails } = await c.db.from("emails").select("*").eq("direction", "in").eq("folder", "inbox").eq("agent_seen", false).eq("is_demo", false).order("created_at").limit(8);
  for (const e of emails || []) {
    const partner = c.partners.find((p) => p.id === e.partner_id) || c.partners.find((p) => p.email && p.email.toLowerCase() === String(e.from_addr || "").toLowerCase()) || null;
    const { data: hist } = await c.db.from("emails").select("direction,subject,body,created_at").eq("partner_id", partner?.id || "00000000-0000-0000-0000-000000000000").neq("id", e.id).order("created_at", { ascending: false }).limit(6);
    const thread = (hist || []).reverse().map((h) => `[${h.direction === "in" ? "ПАРТНЁР" : "МЫ"} ${h.created_at.slice(0, 10)}] ${h.subject}\n${(h.body || "").slice(0, 1200)}`).join("\n---\n");
    const prompt = `Пришло письмо. Реши, что делать, и верни только JSON.

${partner ? `Партнёр: ${partner.name} (${partner.kind}, ${partner.country || "страна не указана"}). Статус: ${partner.status}. Условия: ${partner.terms || "не записаны"}. Заметки: ${partner.notes || "-"}` : "Отправитель в базе партнёров не найден."}

Переписка ранее:
${thread || "(нет)"}

НОВОЕ ПИСЬМО
От: ${e.from_addr}
Тема: ${e.subject}
${(e.body || "").slice(0, 6000)}

Варианты action:
- "reply": можешь ответить по базе знаний → дай subject и body (готовое письмо, подпись «Команда Waylen Travel»).
- "ask": не хватает фактов (цены, комиссия, условия, сроки и т.п.) → question (один чёткий вопрос владельцу), context (суть письма в 1–2 фразах), draft (черновик ответа с пропусками в [квадратных скобках]).
- "spam": рассылка, реклама, автоответ, нерелевантно.
- "ignore": ответа не требует (например «спасибо, получили»).
Также верни partner_status, если по письму ясно: "replied" | "agreed" | "declined" | null,
и new_partner, если отправитель не в базе, но это потенциальный партнёр: {name, kind: clinic|carrier|blogger|community|other, country, website, contact_person, rating 1-5, fit_note}.

Формат: {"action":"reply|ask|spam|ignore","subject":"","body":"","question":"","context":"","draft":"","partner_status":null,"new_partner":null}`;
    try {
      const r = await claude(c.apiKey, { model: SONNET, system: c.companyContext(), prompt, maxTokens: 1800 });
      const j = r.json || {};
      let pid = partner?.id || null;
      if (!pid && j.new_partner?.name) {
        const np = j.new_partner;
        const { data: ins } = await c.db.from("partners").insert({ name: np.name, kind: ["clinic", "carrier", "blogger", "community", "other"].includes(np.kind) ? np.kind : "other", country: np.country || null, website: np.website || null, email: e.from_addr, contact_person: np.contact_person || null, status: "replied", rating: Math.min(5, Math.max(1, Number(np.rating) || 3)), fit_note: np.fit_note || null, source: "Входящее письмо", status_changed_at: new Date().toISOString() }).select("id").single();
        pid = ins?.id || null;
        if (pid) await c.db.from("emails").update({ partner_id: pid }).eq("id", e.id);
      }
      if (j.action === "spam") {
        await c.db.from("emails").update({ folder: "spam", agent_seen: true, is_read: true }).eq("id", e.id);
        await c.run("mail_check", `В спам: ${e.subject || e.from_addr}`, r.text.slice(0, 500), true, r);
        continue;
      }
      if (pid && j.partner_status && ["replied", "agreed", "declined"].includes(j.partner_status)) {
        await c.db.from("partners").update({ status: j.partner_status, status_changed_at: new Date().toISOString() }).eq("id", pid);
      } else if (pid && partner && partner.status === "contacted") {
        await c.db.from("partners").update({ status: "replied", status_changed_at: new Date().toISOString() }).eq("id", pid);
      }
      if (j.action === "reply" && j.body) {
        const auto = c.s.send_mode === "auto";
        await c.db.from("emails").insert({ account_id: e.account_id, partner_id: pid, direction: "out", status: auto ? "approved" : "draft", folder: "draft", is_read: true, author: "agent", subject: j.subject || ("Re: " + (e.subject || "")), body: j.body, from_addr: e.to_addr, to_addr: e.from_addr });
        await c.run("reply_draft", `Черновик ответа: ${e.from_addr}`, j.body.slice(0, 1500), true, r);
        if (!auto) await c.notify(`Готов черновик ответа для ${partner?.name || e.from_addr}: «${j.subject || e.subject}». Утвердите в панели.`);
      } else if (j.action === "ask" && j.question) {
        await c.ask(j.question, j.context || "", j.draft || null, pid, e.id);
        await c.run("question", `Вопрос владельцу: ${j.question.slice(0, 120)}`, j.context || "", true, r);
      } else {
        await c.run("mail_check", `Письмо без ответа: ${e.subject || e.from_addr}`, r.text.slice(0, 500), true, r);
      }
      await c.db.from("emails").update({ agent_seen: true }).eq("id", e.id);
    } catch (err) {
      await c.run("mail_check", `Ошибка разбора письма: ${e.subject || e.from_addr}`, String(err), false);
      await c.db.from("emails").update({ agent_seen: true }).eq("id", e.id);
    }
  }
}

/* ---------- Напоминания партнёрам ---------- */
async function followUps(c: Ctx) {
  const connected = c.accounts.filter((a) => a.status === "connected");
  if (!connected.length) return;
  const days = Number(c.s.followup_days || 4);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: cands } = await c.db.from("partners").select("*").eq("status", "contacted").eq("is_demo", false).lte("last_contact_at", since).limit(5);
  for (const p of cands || []) {
    if (!p.email) continue;
    const { data: hasIn } = await c.db.from("emails").select("id").eq("partner_id", p.id).eq("direction", "in").limit(1);
    if (hasIn && hasIn.length) continue;
    const { data: hasDraft } = await c.db.from("emails").select("id").eq("partner_id", p.id).eq("folder", "draft").limit(1);
    if (hasDraft && hasDraft.length) continue;
    const { data: last } = await c.db.from("emails").select("subject,body,account_id").eq("partner_id", p.id).eq("direction", "out").order("created_at", { ascending: false }).limit(1);
    const l = last?.[0]; if (!l) continue;
    try {
      const r = await claude(c.apiKey, { model: HAIKU, system: c.companyContext(), prompt: `Напиши короткое вежливое напоминание партнёру ${p.name} (${p.kind}, ${p.country || ""}), который не ответил на наше письмо «${l.subject}» ${days} дней назад. Текст прошлого письма:\n${(l.body || "").slice(0, 1500)}\n\nВерни JSON {"subject":"","body":""}. Без давления, 4–6 предложений, подпись «Команда Waylen Travel».`, maxTokens: 700 });
      const j = r.json; if (!j?.body) continue;
      const acc = connected.find((a) => a.id === l.account_id) || connected[0];
      await c.db.from("emails").insert({ account_id: acc.id, partner_id: p.id, direction: "out", status: c.s.send_mode === "auto" ? "approved" : "draft", folder: "draft", is_read: true, author: "agent", subject: j.subject || ("Re: " + l.subject), body: j.body, from_addr: acc.address, to_addr: p.email });
      await c.db.from("partners").update({ last_contact_at: new Date().toISOString() }).eq("id", p.id);
      await c.run("reply_draft", `Напоминание для ${p.name}`, j.body.slice(0, 800), true, r);
    } catch (err) { await c.run("reply_draft", `Напоминание для ${p.name}: ошибка`, String(err), false); }
  }
}

const KN: Record<string, string> = { clinic: "ветеринарные клиники, которые оформляют документы для вывоза животных (чипирование, прививки, международные ветпаспорта, справки)", carrier: "компании и сервисы по перевозке домашних животных (pet relocation, pet cargo, курьеры-сопровождающие)", blogger: "блогеры и авторы каналов о переезде, релокации и путешествиях с питомцами (Telegram, YouTube, Instagram)", community: "сообщества и чаты релокантов и владельцев животных, форумы, группы в Telegram и Facebook", other: "организации, полезные для перевозки питомцев (отели для животных, грумеры, зоомагазины, юристы по релокации)" };
const SEARCH_JSON = `[{"name":"","kind":"","country":"","website":"","email":"","contact_person":"","services":"","languages":"","countries":"","rating":3,"fit_note":"","source_url":""}]`;
// сохраняет найденных партнёров, отсеивая дубли и чёрный список; возвращает список имён
async function savePartners(c: Ctx, arr: any[], kind: string, country: string, extra: Record<string, unknown>): Promise<string[]> {
  const names: string[] = [];
  for (const x of arr || []) {
    if (!x?.name) continue;
    const em = String(x.email || "").toLowerCase(), dm = domainOf(x.email) || domainOf(x.website), nm = norm(x.name);
    if ((c.s.blocked_domains || []).includes(dm)) continue;
    const dup = c.partners.some((p) => (em && p.email && p.email.toLowerCase() === em) || (nm && norm(p.name) === nm) || (dm && !FREE.has(dm) && (domainOf(p.email) === dm || domainOf(p.website) === dm)));
    if (dup) continue;
    const rating = Math.min(5, Math.max(1, Math.round(Number(x.rating) || 3)));
    const row = { name: String(x.name).slice(0, 200), kind, country: x.country || country || null, website: x.website || null, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? em : null, contact_person: x.contact_person || null, services: x.services || null, languages: x.languages || null, countries: x.countries || null, rating, fit_score: rating * 20, fit_note: x.fit_note || null, source: "Поиск агента", source_url: x.source_url || x.website || null, status: "found", priority: rating >= 4 ? "high" : "normal", status_changed_at: new Date().toISOString(), ...extra };
    const { data: ins, error } = await c.db.from("partners").insert(row).select("id,name,email,website").single();
    if (!error && ins) { c.partners.push(ins); names.push(`${row.name} (${rating}/5)`); }
  }
  return names;
}

/* ---------- Поиск партнёров ---------- */
async function partnerSearch(c: Ctx) {
  const perDay = Number(c.s.search_runs_per_day || 0); if (!perDay) return;
  const { data: today } = await c.db.from("agent_runs").select("created_at").eq("kind", "partner_search").eq("ok", true).eq("is_demo", false).gte("created_at", dayStart()).order("created_at", { ascending: false });
  if ((today || []).length >= perDay) return;
  // между поисками выдерживаем интервал 24ч / perDay независимо от смены суток
  const { data: lastS } = await c.db.from("agent_runs").select("created_at").eq("kind", "partner_search").eq("ok", true).eq("is_demo", false).order("created_at", { ascending: false }).limit(1);
  if (lastS && lastS.length && hoursAgo(lastS[0].created_at) < 24 / perDay - 0.4) return;
  const kinds: string[] = (c.s.focus_kinds || []).filter((k: string) => ["clinic", "carrier", "blogger", "community"].includes(k));
  if (!kinds.length) return;
  if (!c.knowledge.length && !c.s.company_summary) {
    await c.ask("Что мы предлагаем партнёрам и на каких условиях? Напишите 3–5 предложений: какие страны, что мы делаем для клиента, что хотим от клиники/перевозчика/блогера и что даём взамен.", "Без этого агент не может искать подходящих партнёров и писать им.", null, null, null);
    return;
  }
  // по очереди: тип и страна, чтобы запросы были узкими
  const n = (today || []).length;
  const kind = kinds[n % kinds.length];
  const countries: string[] = (c.s.focus_countries || []).filter(Boolean);
  const country = countries.length ? countries[Math.floor(n / kinds.length) % countries.length] : "";
  const known = c.partners.map((p) => (p.website || p.email || p.name)).filter(Boolean).slice(0, 300).join("; ");
  const blocked = (c.s.blocked_domains || []).join(", ");
  const prompt = `Найди через веб-поиск 6–8 новых потенциальных партнёров: ${KN[kind]}${country ? ` в стране: ${country}` : " в странах, куда чаще всего переезжают с питомцами из СНГ (Турция, ОАЭ, Грузия, Сербия, Таиланд, Испания, Германия, Черногория, Казахстан)"}.
Нужны реальные организации с сайтом или публичной почтой. Не повторяй уже известных: ${known || "(нет)"}. Не предлагай домены: ${blocked || "(нет)"}.
Для каждого оцени rating 1–5, насколько партнёр подходит Waylen Travel (релевантность услуг, страна, активность, наличие контакта), и кратко объясни в fit_note.
Верни только JSON-массив: [{"name":"","kind":"${kind}","country":"","website":"","email":"","contact_person":"","services":"","languages":"","countries":"","rating":3,"fit_note":"","source_url":""}]`;
  try {
    const r = await claude(c.apiKey, { model: SONNET, system: c.companyContext(), prompt, webSearch: 8, maxTokens: 8000 });
    const arr: any[] = Array.isArray(r.json) ? r.json : (r.json?.partners || []);
    const names = await savePartners(c, arr, kind, country, {}); const added = names.length;
    await c.run("partner_search", `Поиск партнёров (${kind}${country ? ", " + country : ""}): найдено новых ${added}`, names.join("\n") || r.text.slice(0, 800), true, r);
    if (added) await c.notify(`Нашёл новых партнёров: ${added}\n` + names.slice(0, 6).join("\n") + "\n\nПосмотреть: waylen.travel/agentapp");
  } catch (err) { await c.run("partner_search", `Поиск партнёров (${kind}): ошибка`, String(err), false); }
}

/* ---------- Рынок: новости, страны, идеи ---------- */
async function market(c: Ctx) {
  if (hoursAgo(c.s.last_market_at) < 23) return;
  await c.db.from("agent_settings").update({ last_market_at: new Date().toISOString() }).eq("id", 1);
  const countries: string[] = (c.s.focus_countries || []);
  const prompt = `Собери через веб-поиск свежую картину рынка для агентства по перевозке домашних животных (клиенты — переезжающие из России и СНГ, а также путешественники с питомцами).
1) news: 4–6 новостей за последние 2 недели: изменения правил ввоза/вывоза животных, авиакомпании и перевозка питомцев, туризм и релокация${countries.length ? " (особенно: " + countries.join(", ") + ")" : ""}. Только реальные ссылки.
2) countries: 8 ведущих стран по потоку переездов и поездок с питомцами из СНГ, с индексом 0–100 (100 — лидер) и короткой заметкой почему.
3) ideas: 3 идеи, где искать партнёров или клиентов в ближайший месяц, с опорой на новости.
Верни только JSON: {"news":[{"title":"","summary":"","url":"","source":"","country":""}],"countries":[{"country":"","index":100,"note":""}],"ideas":[{"title":"","summary":"","country":""}]}`;
  try {
    const r = await claude(c.apiKey, { model: SONNET, system: c.companyContext(), prompt, webSearch: 8, maxTokens: 8000 });
    const j = r.json || {};
    const rows: any[] = [];
    for (const n of j.news || []) if (n?.title) rows.push({ kind: "news", title: String(n.title).slice(0, 200), summary: n.summary || null, url: /^https?:\/\//.test(n.url || "") ? n.url : null, source: n.source || null, country: n.country || null });
    for (const x of j.countries || []) if (x?.country) rows.push({ kind: "country", title: x.country, country: x.country, summary: x.note || null, metric: Math.min(100, Math.max(0, Number(x.index) || 0)), metric_label: "индекс " + Math.round(Number(x.index) || 0) });
    for (const i of j.ideas || []) if (i?.title) rows.push({ kind: "idea", title: String(i.title).slice(0, 200), summary: i.summary || null, country: i.country || null });
    if (rows.some((x) => x.kind === "country")) await c.db.from("insights").delete().eq("kind", "country").eq("is_demo", false);
    await c.db.from("insights").delete().eq("is_demo", false).neq("kind", "country").lt("created_at", new Date(Date.now() - 45 * 864e5).toISOString());
    // не дублируем новости по заголовку
    const { data: ex } = await c.db.from("insights").select("title").eq("kind", "news");
    const seen = new Set((ex || []).map((x) => norm(x.title)));
    const fresh = rows.filter((x) => x.kind !== "news" || !seen.has(norm(x.title)));
    if (fresh.length) await c.db.from("insights").insert(fresh);
    await c.run("market", `Рынок обновлён: новостей ${fresh.filter((x) => x.kind === "news").length}, стран ${fresh.filter((x) => x.kind === "country").length}, идей ${fresh.filter((x) => x.kind === "idea").length}`, r.text.slice(0, 1500), true, r);
  } catch (err) { await c.run("market", "Рынок: ошибка обновления", String(err), false); }
}

/* ---------- Утренняя сводка в Telegram ---------- */
async function digest(c: Ctx) {
  if (!c.tgToken || !c.tgChat) return;
  const h = localHour(c.s.timezone), target = Number(c.s.quiet_end ?? 8);
  if (h !== target || hoursAgo(c.s.last_digest_at) < 20) return;
  await c.db.from("agent_settings").update({ last_digest_at: new Date().toISOString() }).eq("id", 1);
  const since = new Date(Date.now() - 864e5).toISOString();
  const cnt = async (t: string, f: (q: any) => any) => { const { count } = await f(c.db.from(t).select("id", { count: "exact", head: true })); return count || 0; };
  const inbox = await cnt("emails", (q) => q.eq("folder", "inbox").eq("is_read", false));
  const drafts = await cnt("emails", (q) => q.eq("folder", "draft").neq("status", "approved"));
  const open = await cnt("questions", (q) => q.eq("status", "open"));
  const found = await cnt("partners", (q) => q.gte("created_at", since));
  const { data: runs } = await c.db.from("agent_runs").select("cost_usd").gte("created_at", monthStart());
  const cost = (runs || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  await c.notify(`Доброе утро! Сводка Waylen Travel\n\nНовых писем: ${inbox}\nЧерновиков на утверждение: ${drafts}\nВопросов ко мне: ${open}\nПартнёров найдено за сутки: ${found}\nРасход за месяц: $${cost.toFixed(2)}${c.s.monthly_budget_usd ? " из $" + c.s.monthly_budget_usd : ""}\n\nПанель: waylen.travel/agentapp`);
}

/* ---------- Задания владельца: найти партнёров и написать им ---------- */
async function missions(c: Ctx) {
  const { data: ms } = await c.db.from("missions").select("*").eq("status", "active").order("created_at");
  for (const m of ms || []) {
    const kind = ["clinic", "carrier", "blogger", "community", "other"].includes(m.kind) ? m.kind : "other";
    const { count: foundN } = await c.db.from("partners").select("id", { count: "exact", head: true }).eq("mission_id", m.id);
    const found = foundN || 0;
    // 1. поиск: не чаще, чем задано, пока не набрали цель
    if (found < Number(m.target || 0) && hoursAgo(m.last_search_at) >= 24 / Math.max(1, Number(m.searches_per_day) || 1) - 0.4) {
      await c.db.from("missions").update({ last_search_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", m.id);
      const known = c.partners.map((p) => (p.website || p.email || p.name)).filter(Boolean).slice(0, 300).join("; ");
      const prompt = `Задание владельца (это главнее любых общих настроек компании): ${m.goal}
${m.region ? `РЕГИОН ПОИСКА: ${m.region}. Ищи ТОЛЬКО организации, которые физически находятся в этом регионе. Организации из других стран не возвращай вообще.` : "Регион в задании не указан: определи его из текста задания и ищи только там."}
Найди через веб-поиск 6–8 новых ${KN[kind]}. Нужны реальные организации с сайтом и публичной почтой: обязательно ищи e-mail на сайте (страница «Контакты»), в каталогах и справочниках; организация без почты нам почти бесполезна, ставь ей rating не выше 2.
Не повторяй уже известных: ${known || "(нет)"}. Не предлагай домены: ${(c.s.blocked_domains || []).join(", ") || "(нет)"}.
Для каждого оцени rating 1–5, насколько партнёр подходит под задание, и кратко объясни в fit_note (одной строкой, без переносов). Поле in_region: true, если организация находится в регионе задания, иначе false.
Верни только JSON-массив: ${SEARCH_JSON.replace('"kind":""', `"kind":"${kind}"`).replace('"source_url":""', '"source_url":"","in_region":true')}`;
      try {
        const r = await claude(c.apiKey, { model: SONNET, system: c.companyContext(), prompt, webSearch: 8, maxTokens: 8000 });
        const raw: any[] = Array.isArray(r.json) ? r.json : (r.json?.partners || []);
        const arr = raw.filter((x) => x && x.in_region !== false && x.in_region !== "false");
        const names = await savePartners(c, arr, kind, m.region || "", { mission_id: m.id, source: "Задание: " + m.title });
        await c.run("partner_search", `Задание «${m.title}»: найдено новых ${names.length} (всего ${found + names.length} из ${m.target})`, names.join("\n") || r.text.slice(0, 800), true, r);
        if (names.length) await c.notify(`Задание «${m.title}»: нашёл ${names.length}, всего ${found + names.length} из ${m.target}\n` + names.slice(0, 6).join("\n"));
      } catch (err) { await c.run("partner_search", `Задание «${m.title}»: ошибка поиска`, String(err), false); }
    }
    // 2. письма найденным
    if (m.write_letters && !isQuiet(c.s)) {
      const { count: todayN } = await c.db.from("emails").select("id", { count: "exact", head: true }).eq("mission_id", m.id).eq("direction", "out").gte("created_at", dayStart());
      let room = Math.max(0, Number(m.letters_per_day || 0) - (todayN || 0));
      const acc = c.accounts.find((a) => a.status === "connected" && a.provider === "agentmail") || c.accounts.find((a) => a.status === "connected");
      if (room && acc) {
        const { data: cands } = await c.db.from("partners").select("*").eq("mission_id", m.id).eq("status", "found").not("email", "is", null).order("rating", { ascending: false }).limit(room * 2);
        let written = 0;
        for (const p of cands || []) {
          if (!room) break;
          const { data: has } = await c.db.from("emails").select("id").eq("partner_id", p.id).eq("direction", "out").limit(1);
          if (has && has.length) continue;
          if ((c.s.blocked_domains || []).some((b: string) => b === String(p.email).toLowerCase() || b === domainOf(p.email))) continue;
          try {
            const ru = /росси|russia|беларус|казахстан|узбекистан|кыргыз|армени|грузи|украин|молдов|снг/i.test((p.country || "") + " " + (m.region || ""));
            const r = await claude(c.apiKey, { model: SONNET, system: c.companyContext(), maxTokens: 1200, prompt: `Напиши первое письмо от имени Waylen Travel потенциальному партнёру по заданию владельца.
Кто мы: Waylen Travel — сервис сопровождения переездов и поездок с питомцами (НЕ ветеринарная клиника и НЕ перевозчик): мы ведём клиента по документам, требованиям стран, маршруту, а ветеринарную часть и оформление доверяем партнёрским клиникам.
Кто они: ${p.name} — ${KN[kind]}, ${p.country || m.region || ""}. Их услуги: ${p.services || "-"}. Контакт: ${p.contact_person || "-"}. Почему подходят: ${p.fit_note || "-"}.
Задание владельца: ${m.goal}
${m.letter_brief ? "Что обязательно сказать в письме: " + m.letter_brief + "\n" : ""}Суть предложения: мы направляем к ним своих клиентов с питомцами на оформление документов и ветеринарную подготовку; взамен просим понятные условия для наших клиентов (приоритет, скидка или комиссия — только то, что есть в базе знаний или в задании, ничего не выдумывай).
Язык письма: ${ru ? "русский" : "английский"}. 5–8 предложений, по делу, без воды. Пиши от «мы» (например «Мы — Waylen Travel…»), никогда «меня зовут». В первом письме не проси реквизиты, лицензии и юрлицо. Один конкретный следующий шаг в конце (например, короткий созвон или ответ с условиями). Подпись «Команда Waylen Travel».
Верни только JSON {"subject":"","body":""}` });
            const j = r.json; if (!j?.body) throw new Error("пустой ответ");
            const auto = c.s.send_mode === "auto";
            await c.db.from("emails").insert({ account_id: acc.id, partner_id: p.id, mission_id: m.id, direction: "out", status: auto ? "approved" : "draft", folder: "draft", is_read: true, author: "agent", subject: j.subject || ("Сотрудничество с Waylen Travel"), body: j.body, from_addr: acc.address, to_addr: p.email });
            written++; room--;
            await c.run("reply_draft", `Задание «${m.title}»: письмо для ${p.name}`, j.body.slice(0, 1200), true, r);
          } catch (err) { await c.run("reply_draft", `Задание «${m.title}»: не удалось написать ${p.name}`, String(err), false); }
        }
        if (written && c.s.send_mode !== "auto") await c.notify(`Задание «${m.title}»: готово писем на утверждение: ${written}. Панель: waylen.travel/agentapp`);
      }
    }
    // 3. завершение: цель набрана и всем, кому можно, написали
    if (found >= Number(m.target || 0)) {
      const { count: pending } = await c.db.from("partners").select("id", { count: "exact", head: true }).eq("mission_id", m.id).eq("status", "found").not("email", "is", null);
      if (!m.write_letters || !(pending || 0)) {
        await c.db.from("missions").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", m.id);
        await c.notify(`Задание «${m.title}» выполнено: найдено ${found}${m.write_letters ? ", письма подготовлены" : ""}.`);
      }
    }
  }
}

/* ---------- Вечерняя сводка в Telegram ---------- */
async function evening(c: Ctx) {
  if (!c.tgToken || !c.tgChat) return;
  const h = localHour(c.s.timezone), target = Number(c.s.quiet_start ?? 22);
  if (h !== target || hoursAgo(c.s.last_evening_at) < 20) return;
  await c.db.from("agent_settings").update({ last_evening_at: new Date().toISOString() }).eq("id", 1);
  const since = new Date(Date.now() - 864e5).toISOString();
  const cnt = async (t: string, f: (q: any) => any) => { const { count } = await f(c.db.from(t).select("id", { count: "exact", head: true })); return count || 0; };
  const sent = await cnt("emails", (q) => q.eq("folder", "sent").gte("sent_at", since));
  const recv = await cnt("emails", (q) => q.eq("direction", "in").neq("folder", "spam").gte("created_at", since));
  const drafts = await cnt("emails", (q) => q.eq("folder", "draft").neq("status", "approved"));
  const open = await cnt("questions", (q) => q.eq("status", "open"));
  const found = await cnt("partners", (q) => q.gte("created_at", since));
  const { data: runs } = await c.db.from("agent_runs").select("cost_usd,kind").gte("created_at", since);
  const cost = (runs || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const { data: mruns } = await c.db.from("agent_runs").select("cost_usd").gte("created_at", monthStart());
  const mcost = (mruns || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  await c.notify(`Итоги дня\n\nОтправлено писем: ${sent}\nПолучено: ${recv}\nНайдено партнёров: ${found}\nДействий агента: ${(runs || []).length}\nПотрачено за день: $${cost.toFixed(2)} (за месяц $${mcost.toFixed(2)}${c.s.monthly_budget_usd ? " из $" + c.s.monthly_budget_usd : ""})${drafts || open ? `\n\nЖдут вас: черновиков ${drafts}, вопросов ${open}` : "\n\nНичего не ждёт, можно отдыхать."}`);
}

/* ---------- Главный цикл ---------- */
Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // доступ: секрет планировщика или сессия владельца из панели
  const { data: secrets } = await db.from("agent_secrets").select("name,value");
  const sec: Record<string, string> = {}; for (const s of secrets || []) sec[s.name] = s.value;
  let manual = false;
  const key = req.headers.get("x-agent-key");
  if (!key || key !== sec.cron_key) {
    const auth = req.headers.get("authorization") || "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const { data: u } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
    if (!u?.user || u.user.email !== OWNER_EMAIL) return json(401, { ok: false, error: "unauthorized" });
    manual = true;
  }

  const { data: srow } = await db.from("agent_settings").select("*").eq("id", 1).single();
  const s: Settings = srow || {};
  if (!s.enabled && !manual) return json(200, { ok: true, skipped: "disabled" });

  // замок от параллельных запусков
  const lockBefore = new Date(Date.now() - LOCK_MINUTES * 60000).toISOString();
  const { data: lock } = await db.from("agent_settings").update({ running_since: new Date().toISOString() }).eq("id", 1).or(`running_since.is.null,running_since.lt.${lockBefore}`).select("id");
  if (!lock || !lock.length) return json(200, { ok: true, skipped: "busy" });

  const c = new Ctx(db, s);
  try {
    c.apiKey = sec.anthropic_api_key || ""; c.tgToken = sec.telegram_bot_token || ""; c.tgChat = sec.telegram_chat_id || "";
    const [kb, ps, ac, tp] = await Promise.all([
      db.from("knowledge").select("topic,content").eq("is_demo", false),
      db.from("partners").select("id,name,email,website,kind,status,country,terms,notes,last_contact_at").eq("is_demo", false),
      db.from("mail_accounts").select("*").eq("is_demo", false),
      db.from("templates").select("title,subject,body").eq("is_demo", false),
    ]);
    c.knowledge = kb.data || []; c.partners = ps.data || []; c.accounts = ac.data || []; c.templates = tp.data || [];

    await telegramInbox(c);
    await absorbAnswers(c);

    if (!c.apiKey) {
      c.log.push("Нет ключа Claude API");
      return json(200, { ok: true, log: c.log, note: "Добавьте ключ Claude API в настройках панели" });
    }

    // бюджет
    const { data: runs } = await db.from("agent_runs").select("cost_usd").gte("created_at", monthStart());
    const spent = (runs || []).reduce((sum, r) => sum + Number(r.cost_usd || 0), 0);
    const budget = Number(s.monthly_budget_usd || 0);
    if (budget && spent >= budget) {
      const { data: last } = await db.from("agent_runs").select("id").eq("kind", "budget").gte("created_at", dayStart()).limit(1);
      if (!last || !last.length) { await c.run("budget", `Месячный лимит $${budget} исчерпан, агент на паузе до следующего месяца`, `Потрачено $${spent.toFixed(2)}`, false); await c.notify(`Лимит расходов $${budget} исчерпан. Агент на паузе до начала месяца. Поднять лимит можно в настройках панели.`); }
      return json(200, { ok: true, skipped: "budget", log: c.log });
    }

    AM_KEY = sec.agentmail_api_key || "";
    await ensureMailbox(c);
    await mailSync(c);
    await processInbox(c);
    await sendQueued(c);
    await followUps(c);
    await missions(c);
    await partnerSearch(c);
    await market(c);
    await digest(c);
    await evening(c);

    return json(200, { ok: true, manual, log: c.log, spent_now: +c.spent.toFixed(4) });
  } catch (e) {
    await c.run("tick", "Сбой запуска агента", String(e), false);
    return json(500, { ok: false, error: String(e).slice(0, 300), log: c.log });
  } finally {
    await db.from("agent_settings").update({ running_since: null }).eq("id", 1);
  }
});
