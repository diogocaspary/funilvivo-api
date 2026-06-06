import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ALLOWED_ORIGINS = "https://app.funilvivo.com.br",
  PORT = 3000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

// cliente admin (service role) — ignora RLS, lê segredos
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(express.json({ limit: "1mb" }));

const origins = ALLOWED_ORIGINS.split(",").map((s) => s.trim());
app.use(cors({ origin: origins, methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Authorization"] }));

// ---- helpers Evolution ----
async function evo(canal, path, method = "GET", body) {
  const url = canal.evolution_url.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", apikey: canal.evolution_token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Evolution ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function getCanalWa(id) {
  const { data, error } = await admin.from("canais_whatsapp").select("*").eq("id", id).single();
  if (error || !data) throw new Error("Canal de WhatsApp não encontrado");
  return data;
}
async function setWaStatus(id, status) {
  await admin.from("canais_whatsapp").update({ status }).eq("id", id);
}

// ---- auth middleware (verifica JWT do Supabase + papel) ----
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: "sem token" });
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "token inválido" });
    const { data: perfil } = await admin.from("perfis").select("papel").eq("id", user.id).single();
    if (!perfil || !["admin", "equipe"].includes(perfil.papel))
      return res.status(403).json({ error: "sem permissão" });
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// ---- rotas ----
app.get("/health", (_req, res) => res.json({ ok: true, service: "funilvivo-api" }));

// criar instância
app.post("/wa/:id/create", auth, async (req, res) => {
  try {
    const canal = await getCanalWa(req.params.id);
    const data = await evo(canal, "/instance/create", "POST", {
      instanceName: canal.instancia,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });
    await setWaStatus(canal.id, "desconectado");
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// conectar / obter QR
app.get("/wa/:id/qr", auth, async (req, res) => {
  try {
    const canal = await getCanalWa(req.params.id);
    const data = await evo(canal, `/instance/connect/${encodeURIComponent(canal.instancia)}`, "GET");
    // data.base64 (qr) ou data.code (pairing)
    res.json({ ok: true, qr: data.base64 || null, code: data.code || data.pairingCode || null, raw: data });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// status de conexão
app.get("/wa/:id/status", auth, async (req, res) => {
  try {
    const canal = await getCanalWa(req.params.id);
    const data = await evo(canal, `/instance/connectionState/${encodeURIComponent(canal.instancia)}`, "GET");
    const state = (data.instance && data.instance.state) || data.state || "desconhecido";
    const status = state === "open" ? "conectado" : state === "connecting" ? "desconectado" : "desconectado";
    await setWaStatus(canal.id, status);
    res.json({ ok: true, state, status });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// desconectar (logout)
app.post("/wa/:id/logout", auth, async (req, res) => {
  try {
    const canal = await getCanalWa(req.params.id);
    await evo(canal, `/instance/logout/${encodeURIComponent(canal.instancia)}`, "DELETE");
    await setWaStatus(canal.id, "desconectado");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// enviar e-mail de um outreach (respeita constância do canal por lead)
app.post("/send/email", auth, async (req, res) => {
  try {
    const { outreach_id } = req.body || {};
    if (!outreach_id) return res.status(400).json({ error: "outreach_id obrigatório" });

    const { data: out } = await admin.from("outreach").select("*").eq("id", outreach_id).single();
    if (!out) return res.status(404).json({ error: "outreach não encontrado" });

    const { data: lead } = await admin.from("leads").select("*").eq("id", out.lead_id).single();
    if (!lead) return res.status(404).json({ error: "lead não encontrado" });

    // constância: usa o canal já vinculado ao lead, ou escolhe um ativo e grava
    let canalId = lead.canal_email_id;
    if (!canalId) {
      const { data: ativo } = await admin.from("canais_email").select("id").eq("ativo", true).limit(1).single();
      if (!ativo) return res.status(400).json({ error: "nenhum canal de e-mail ativo" });
      canalId = ativo.id;
      await admin.from("leads").update({ canal_email_id: canalId }).eq("id", lead.id);
    }
    const { data: canal } = await admin.from("canais_email").select("*").eq("id", canalId).single();
    if (!canal) return res.status(400).json({ error: "canal de e-mail inválido" });

    const dest = lead.contato && lead.contato.email;
    if (!dest) return res.status(400).json({ error: "lead sem e-mail" });

    const transporter = nodemailer.createTransport({
      host: canal.smtp_host, port: canal.smtp_port || 587,
      secure: (canal.smtp_port || 587) === 465,
      auth: { user: canal.smtp_user, pass: canal.smtp_senha },
    });
    await transporter.sendMail({
      from: `"${canal.from_nome || "Funil Vivo"}" <${canal.from_email}>`,
      to: dest, subject: out.assunto || "Funil Vivo", text: out.corpo || "",
    });

    await admin.from("outreach").update({ status: "enviado", enviado_em: new Date().toISOString() }).eq("id", out.id);
    await admin.from("canais_email").update({ status: "testado" }).eq("id", canal.id);
    await admin.from("atividades").insert({ tipo: "email_enviado", lead_id: lead.id, responsavel: "Closer", resumo: `E-mail enviado via ${canal.nome}` });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- leitura de e-mails (IMAP) ----
async function imapConnect(canal) {
  const client = new ImapFlow({
    host: canal.imap_host,
    port: canal.imap_port || 993,
    secure: true,
    auth: { user: canal.smtp_user, pass: canal.smtp_senha },
    logger: false,
  });
  await client.connect();
  return client;
}

// lista os últimos e-mails recebidos na caixa do canal
app.get("/email/:id/inbox", auth, async (req, res) => {
  let client;
  try {
    const { data: canal } = await admin.from("canais_email").select("*").eq("id", req.params.id).single();
    if (!canal) return res.status(404).json({ error: "canal não encontrado" });
    if (!canal.imap_host) return res.status(400).json({ error: "IMAP não configurado neste canal" });
    client = await imapConnect(canal);
    const lock = await client.getMailboxLock("INBOX");
    const out = [];
    try {
      const status = await client.status("INBOX", { messages: true });
      const total = status.messages || 0;
      if (total > 0) {
        const start = Math.max(1, total - 24);
        for await (const m of client.fetch(`${start}:*`, { envelope: true, internalDate: true, flags: true })) {
          const from = (m.envelope.from && m.envelope.from[0]) || {};
          out.push({
            seq: m.seq,
            from: from.address || "",
            fromName: from.name || "",
            subject: m.envelope.subject || "(sem assunto)",
            date: m.internalDate,
            unseen: !(m.flags && m.flags.has && m.flags.has("\\Seen")),
          });
        }
      }
    } finally { lock.release(); }
    await client.logout();
    res.json({ ok: true, total: out.length, messages: out.reverse() });
  } catch (e) {
    try { if (client) await client.close(); } catch (_) {}
    res.status(400).json({ error: String(e.message || e) });
  }
});

// lê o conteúdo de um e-mail específico
app.get("/email/:id/message", auth, async (req, res) => {
  let client;
  try {
    const seq = parseInt(req.query.seq);
    if (!seq) return res.status(400).json({ error: "parâmetro seq obrigatório" });
    const { data: canal } = await admin.from("canais_email").select("*").eq("id", req.params.id).single();
    if (!canal || !canal.imap_host) return res.status(400).json({ error: "canal/IMAP inválido" });
    client = await imapConnect(canal);
    const lock = await client.getMailboxLock("INBOX");
    let message = {};
    try {
      const msg = await client.fetchOne(String(seq), { source: true });
      const parsed = await simpleParser(msg.source);
      message = {
        from: (parsed.from && parsed.from.text) || "",
        to: (parsed.to && parsed.to.text) || "",
        subject: parsed.subject || "",
        date: parsed.date,
        text: parsed.text || "",
      };
    } finally { lock.release(); }
    await client.logout();
    res.json({ ok: true, message });
  } catch (e) {
    try { if (client) await client.close(); } catch (_) {}
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`funilvivo-api on :${PORT}`));
