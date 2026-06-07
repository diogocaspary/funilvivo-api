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

async function getMonitorKey() {
  const { data } = await admin.from("agent_config").select("valor").eq("chave", "monitor_key").single();
  return data && data.valor;
}

// ---- auth middleware: aceita JWT (admin/equipe) OU x-agent-key ----
async function auth(req, res, next) {
  try {
    const ak = req.headers["x-agent-key"];
    if (ak) {
      const mk = await getMonitorKey();
      if (mk && ak === mk) { req.agent = true; return next(); }
      return res.status(401).json({ error: "agent key inválida" });
    }
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
            uid: m.uid,
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

// ============================================================
// MONITOR DE RESPOSTAS (24/7) — lê a caixa, identifica o lead,
// gera resposta com IA e envia. Travas: só responde leads
// conhecidos; assuntos sensíveis vão para aprovação humana.
// ============================================================

async function sendViaCanal(canal, to, subject, text) {
  const transporter = nodemailer.createTransport({
    host: canal.smtp_host, port: canal.smtp_port || 587,
    secure: (canal.smtp_port || 587) === 465,
    auth: { user: canal.smtp_user, pass: canal.smtp_senha },
  });
  await transporter.sendMail({ from: `"${canal.from_nome || "Funil Vivo"}" <${canal.from_email}>`, to, subject, text });
}

async function gerarResposta(lead, msgText) {
  const ds = process.env.DEEPSEEK_API_KEY;
  const anth = process.env.ANTHROPIC_API_KEY;
  const oai = process.env.OPENAI_API_KEY;
  const sys = "Você é um SDR da Funil Vivo, agência de marketing (tráfego pago, social media e chatbots) focada em clínicas de saúde e estética. Responda ao e-mail do lead em português, de forma cordial, curta e consultiva. Objetivo: avançar para uma conversa ou reunião rápida. Não prometa resultados garantidos. Não invente preços; se perguntarem valor, diga que depende do escopo e proponha uma call de 15 min. Assine como 'Equipe Funil Vivo'. Escreva apenas o corpo do e-mail, sem assunto e sem placeholders.";
  const user = `Nome do lead: ${(lead && lead.nome) || "(desconhecido)"}\nMensagem recebida do lead:\n"""${(msgText || "").slice(0, 4000)}"""`;
  if (ds) {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + ds, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", max_tokens: 600, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error("IA: " + JSON.stringify(j.error));
    return (j.choices && j.choices[0] && j.choices[0].message.content || "").trim();
  }
  if (anth) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anth, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-haiku-latest", max_tokens: 600, system: sys, messages: [{ role: "user", content: user }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error("IA: " + JSON.stringify(j.error));
    return (j.content && j.content[0] && j.content[0].text || "").trim();
  }
  if (oai) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + oai, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 600, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error("IA: " + JSON.stringify(j.error));
    return (j.choices && j.choices[0] && j.choices[0].message.content || "").trim();
  }
  throw new Error("sem chave de IA configurada (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY ou OPENAI_API_KEY)");
}

const SENSIVEIS = ["cancel", "reclama", "process", "advogad", "reembols", "descadastr", "remover", "juridic", "denunc"];
let monitorRunning = false;

async function runMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const { data: canais } = await admin.from("canais_email").select("*").eq("ativo", true).not("imap_host", "is", null);
    for (const canal of (canais || [])) {
      let client;
      try {
        client = await imapConnect(canal);
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = await client.search({ seen: false }, { uid: true });
          for (const uid of (uids || []).slice(-20)) {
            try {
              const msg = await client.fetchOne(uid, { source: true }, { uid: true });
              const parsed = await simpleParser(msg.source);
              const from = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); // marca lido (evita reprocessar)
              if (!from || from === String(canal.from_email).toLowerCase()) continue;

              const { data: leads } = await admin.from("leads").select("*").eq("contato->>email", from).limit(1);
              const lead = leads && leads[0];
              if (!lead) {
                await admin.from("agent_logs").insert({ agente: "Monitor de Respostas", acao: "ignorado", resultado: "remetente não é lead: " + from });
                continue;
              }
              const body = (parsed.text || "").toLowerCase();
              if (SENSIVEIS.some((k) => body.includes(k))) {
                await admin.from("aprovacoes").insert({ tipo: "envio_externo", titulo: "Resposta sensível de " + (lead.nome || from), solicitante: "Monitor de Respostas", cliente_id: null, detalhe: { lead_id: lead.id, assunto: parsed.subject, trecho: (parsed.text || "").slice(0, 400) } });
                await admin.from("atividades").insert({ tipo: "resposta_sensivel", lead_id: lead.id, responsavel: "Monitor de Respostas", resumo: "Resposta marcada para revisão humana" });
                continue;
              }
              const reply = await gerarResposta(lead, parsed.text || "");
              if (!reply) continue;
              const subj = (parsed.subject || "").toLowerCase().startsWith("re:") ? parsed.subject : ("Re: " + (parsed.subject || "Contato"));
              await sendViaCanal(canal, from, subj, reply);
              await admin.from("outreach").insert({ lead_id: lead.id, canal: "email", etapa: "resposta_auto", assunto: subj, corpo: reply, status: "enviado", enviado_em: new Date().toISOString() });
              await admin.from("atividades").insert({ tipo: "resposta_enviada", lead_id: lead.id, responsavel: "Monitor de Respostas", resumo: "Resposta automática enviada" });
              await admin.from("agent_logs").insert({ agente: "Monitor de Respostas", acao: "respondido", resultado: "lead " + (lead.nome || from) });
              if (!lead.canal_email_id) await admin.from("leads").update({ canal_email_id: canal.id }).eq("id", lead.id);
            } catch (inner) {
              await admin.from("agent_logs").insert({ agente: "Monitor de Respostas", acao: "erro_msg", resultado: String(inner.message || inner) });
            }
          }
        } finally { lock.release(); }
        await client.logout();
      } catch (e) {
        try { if (client) await client.close(); } catch (_) {}
        await admin.from("agent_logs").insert({ agente: "Monitor de Respostas", acao: "erro", resultado: String(e.message || e) });
      }
    }
  } finally { monitorRunning = false; }
}

// ============================================================
// FILA DE AGENTE — produtor (lê e-mails -> enfileira) e
// consumidor (resultados prontos do Claude -> envia). Sem IA aqui:
// quem escreve a resposta é o worker (tarefa do Claude no Cowork).
// ============================================================
let queueRunning = false;
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // ---- PRODUTOR: lê e-mails novos e cria tarefas 'responder_email' ----
    const { data: canais } = await admin.from("canais_email").select("*").eq("ativo", true).not("imap_host", "is", null);
    for (const canal of (canais || [])) {
      let client;
      try {
        client = await imapConnect(canal);
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = await client.search({ seen: false }, { uid: true });
          for (const uid of (uids || []).slice(-20)) {
            try {
              const msg = await client.fetchOne(uid, { source: true }, { uid: true });
              const parsed = await simpleParser(msg.source);
              const from = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
              if (!from || from === String(canal.from_email).toLowerCase()) continue;
              const { data: leads } = await admin.from("leads").select("id,nome").eq("contato->>email", from).limit(1);
              const lead = leads && leads[0];
              if (!lead) { await admin.from("agent_logs").insert({ agente: "Fila", acao: "ignorado", resultado: "não é lead: " + from }); continue; }
              const body = (parsed.text || "").toLowerCase();
              if (SENSIVEIS.some((k) => body.includes(k))) {
                await admin.from("aprovacoes").insert({ tipo: "envio_externo", titulo: "Resposta sensível de " + (lead.nome || from), solicitante: "Fila", detalhe: { lead_id: lead.id, assunto: parsed.subject, trecho: (parsed.text || "").slice(0, 400) } });
                await admin.from("atividades").insert({ tipo: "resposta_sensivel", lead_id: lead.id, responsavel: "Fila", resumo: "Marcada para revisão humana" });
                continue;
              }
              await admin.from("fila_agente").insert({
                tipo: "responder_email", titulo: "Responder " + (lead.nome || from),
                lead_id: lead.id, canal_id: canal.id, ref_uid: String(uid), status: "novo",
                payload: { from, subject: parsed.subject || "", text: (parsed.text || "").slice(0, 4000), lead_nome: lead.nome || "" },
              });
              await admin.from("agent_logs").insert({ agente: "Fila", acao: "enfileirado", resultado: "responder_email p/ " + (lead.nome || from) });
              await admin.from("mensagens").insert({ lead_id: lead.id, direcao: "entrada", canal: "email", de: from, para: canal.from_email, assunto: parsed.subject || "", corpo: (parsed.text || "").slice(0, 8000), status: "nao_lida" });
            } catch (inner) {
              await admin.from("agent_logs").insert({ agente: "Fila", acao: "erro_msg", resultado: String(inner.message || inner) });
            }
          }
        } finally { lock.release(); }
        await client.logout();
      } catch (e) {
        try { if (client) await client.close(); } catch (_) {}
        await admin.from("agent_logs").insert({ agente: "Fila", acao: "erro_imap", resultado: String(e.message || e) });
      }
    }

    // ---- CONSUMIDOR: tarefas de e-mail concluídas pelo Claude -> envia ----
    const { data: prontos } = await admin.from("fila_agente").select("*").eq("tipo", "responder_email").eq("status", "concluido").limit(10);
    for (const t of (prontos || [])) {
      const texto = t.resultado && t.resultado.texto;
      if (!texto) { await admin.from("fila_agente").update({ status: "erro", erro: "sem texto no resultado", atualizado_em: new Date().toISOString() }).eq("id", t.id); continue; }
      try {
        const { data: canal } = await admin.from("canais_email").select("*").eq("id", t.canal_id).single();
        if (!canal) throw new Error("canal não encontrado");
        const to = t.payload.from;
        const subj = (t.payload.subject || "").toLowerCase().startsWith("re:") ? t.payload.subject : ("Re: " + (t.payload.subject || "Contato"));
        await sendViaCanal(canal, to, subj, texto);
        await admin.from("outreach").insert({ lead_id: t.lead_id, canal: "email", etapa: "resposta_auto", assunto: subj, corpo: texto, status: "enviado", enviado_em: new Date().toISOString() });
        await admin.from("atividades").insert({ tipo: "resposta_enviada", lead_id: t.lead_id, responsavel: "Closer (Claude)", resumo: "Resposta enviada via fila" });
        await admin.from("mensagens").insert({ lead_id: t.lead_id, direcao: "saida", canal: "email", de: canal.from_email, para: to, assunto: subj, corpo: texto, status: "lida" });
        if (t.lead_id) await admin.from("leads").update({ canal_email_id: t.canal_id }).eq("id", t.lead_id).is("canal_email_id", null);
        await admin.from("fila_agente").update({ status: "enviado", atualizado_em: new Date().toISOString() }).eq("id", t.id);
        await admin.from("agent_logs").insert({ agente: "Fila", acao: "enviado", resultado: "para " + to });
      } catch (e) {
        await admin.from("fila_agente").update({ status: "erro", erro: String(e.message || e), atualizado_em: new Date().toISOString() }).eq("id", t.id);
      }
    }

    // ---- OUTBOUND: rascunhos de outreach aprovados -> enviar ----
    const { data: aprovados } = await admin.from("outreach").select("*").eq("status", "aprovado").limit(10);
    for (const o of (aprovados || [])) {
      try {
        const { data: lead } = await admin.from("leads").select("*").eq("id", o.lead_id).single();
        const dest = lead && lead.contato && lead.contato.email;
        if (!dest) { await admin.from("outreach").update({ status: "descartado" }).eq("id", o.id); continue; }
        let canalId = lead.canal_email_id;
        if (!canalId) {
          const { data: at } = await admin.from("canais_email").select("id").eq("ativo", true).limit(1).single();
          if (!at) continue; // sem canal ativo: tenta de novo no próximo ciclo
          canalId = at.id;
          await admin.from("leads").update({ canal_email_id: canalId }).eq("id", lead.id);
        }
        const { data: canal } = await admin.from("canais_email").select("*").eq("id", canalId).single();
        await sendViaCanal(canal, dest, o.assunto || "Funil Vivo", o.corpo || "");
        await admin.from("outreach").update({ status: "enviado", enviado_em: new Date().toISOString() }).eq("id", o.id);
        await admin.from("atividades").insert({ tipo: "outreach_enviado", lead_id: o.lead_id, responsavel: "Closer", resumo: "Primeiro contato enviado" });
        await admin.from("mensagens").insert({ lead_id: o.lead_id, direcao: "saida", canal: "email", de: canal.from_email, para: dest, assunto: o.assunto, corpo: o.corpo, status: "lida" });
        await admin.from("leads").update({ status: "contatado" }).eq("id", o.lead_id).eq("status", "novo");
        await admin.from("agent_logs").insert({ agente: "Fila", acao: "outreach_enviado", resultado: "para " + dest });
      } catch (e) {
        await admin.from("agent_logs").insert({ agente: "Fila", acao: "erro_outreach", resultado: String(e.message || e) });
      }
    }

    // ---- CONSUMIDOR WhatsApp: respostas prontas -> enviar via Evolution ----
    const { data: waProntos } = await admin.from("fila_agente").select("*").eq("tipo", "responder_whatsapp").eq("status", "concluido").limit(10);
    for (const t of (waProntos || [])) {
      const texto = t.resultado && t.resultado.texto;
      if (!texto) { await admin.from("fila_agente").update({ status: "erro", erro: "sem texto", atualizado_em: new Date().toISOString() }).eq("id", t.id); continue; }
      try {
        const { data: canal } = await admin.from("canais_whatsapp").select("*").eq("id", t.canal_id).single();
        if (!canal) throw new Error("canal whatsapp não encontrado");
        await sendWhatsapp(canal, t.payload.from, texto);
        await admin.from("mensagens").insert({ lead_id: t.lead_id, direcao: "saida", canal: "whatsapp", para: t.payload.from, corpo: texto, status: "lida" });
        await admin.from("atividades").insert({ tipo: "whatsapp_enviado", lead_id: t.lead_id, responsavel: "Atendente (Claude)", resumo: "Resposta WhatsApp enviada" });
        await admin.from("fila_agente").update({ status: "enviado", atualizado_em: new Date().toISOString() }).eq("id", t.id);
        await admin.from("agent_logs").insert({ agente: "Fila", acao: "wa_enviado", resultado: "para " + t.payload.from });
      } catch (e) {
        await admin.from("fila_agente").update({ status: "erro", erro: String(e.message || e), atualizado_em: new Date().toISOString() }).eq("id", t.id);
      }
    }
  } finally { queueRunning = false; }
}

const QUEUE_MIN = Math.max(1, parseInt(process.env.MONITOR_INTERVAL_MIN || "1"));
if ((process.env.MONITOR_ENABLED || "true") !== "false") {
  setInterval(() => { runQueue().catch(() => {}); }, QUEUE_MIN * 60 * 1000);
  setTimeout(() => { runQueue().catch(() => {}); }, 15000);
  console.log(`fila de agente ativa (a cada ${QUEUE_MIN} min)`);
}

// disparo manual do monitor (para testar)
app.post("/monitor/run", auth, async (_req, res) => {
  runQueue().catch(() => {});
  res.json({ ok: true, msg: "fila disparada" });
});

// ---- endpoints para a tarefa do Claude (Cowork) ----
// envia uma resposta e (opcional) marca o e-mail original como lido
app.post("/send-raw", auth, async (req, res) => {
  let c;
  try {
    const { canal_id, to, subject, text, uid, lead_id } = req.body || {};
    if (!canal_id || !to || !text) return res.status(400).json({ error: "canal_id, to e text são obrigatórios" });
    const { data: canal } = await admin.from("canais_email").select("*").eq("id", canal_id).single();
    if (!canal) return res.status(404).json({ error: "canal não encontrado" });
    await sendViaCanal(canal, to, subject || "Re: contato", text);
    if (uid) {
      try { c = await imapConnect(canal); const lock = await c.getMailboxLock("INBOX"); try { await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } finally { lock.release(); } await c.logout(); }
      catch (_) { try { if (c) await c.close(); } catch (__) {} }
    }
    if (lead_id) {
      await admin.from("outreach").insert({ lead_id, canal: "email", etapa: "resposta_auto", assunto: subject, corpo: text, status: "enviado", enviado_em: new Date().toISOString() });
      await admin.from("atividades").insert({ tipo: "resposta_enviada", lead_id, responsavel: "Monitor (Claude)", resumo: "Resposta automática enviada" });
      await admin.from("leads").update({ canal_email_id: canal.id }).eq("id", lead_id).is("canal_email_id", null);
    }
    await admin.from("agent_logs").insert({ agente: "Monitor (Claude)", acao: "respondido", resultado: "para " + to });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// marca um e-mail como lido (para mensagens que a tarefa decidiu ignorar)
app.post("/email/:id/seen", auth, async (req, res) => {
  let c;
  try {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid obrigatório" });
    const { data: canal } = await admin.from("canais_email").select("*").eq("id", req.params.id).single();
    if (!canal) return res.status(404).json({ error: "canal não encontrado" });
    c = await imapConnect(canal); const lock = await c.getMailboxLock("INBOX");
    try { await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } finally { lock.release(); }
    await c.logout(); res.json({ ok: true });
  } catch (e) { try { if (c) await c.close(); } catch (_) {} res.status(400).json({ error: String(e.message || e) }); }
});

// ---- WhatsApp: enviar e receber (Evolution) ----
async function sendWhatsapp(canal, number, text) {
  return evo(canal, `/message/sendText/${encodeURIComponent(canal.instancia)}`, "POST", { number, text });
}

// configura o webhook da instância para apontar pro nosso backend
app.post("/wa/:id/webhook", auth, async (req, res) => {
  try {
    const { data: canal } = await admin.from("canais_whatsapp").select("*").eq("id", req.params.id).single();
    if (!canal) return res.status(404).json({ error: "canal não encontrado" });
    const mk = await getMonitorKey();
    const url = `https://api.funilvivo.com.br/webhook/evolution/${mk}`;
    const data = await evo(canal, `/webhook/set/${encodeURIComponent(canal.instancia)}`, "POST", {
      webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events: ["MESSAGES_UPSERT"] },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// recebe mensagens da Evolution
app.post("/webhook/evolution/:token", async (req, res) => {
  try {
    const mk = await getMonitorKey();
    if (!mk || req.params.token !== mk) return res.status(401).json({ error: "token" });
    const body = req.body || {};
    if (!/messages.upsert/i.test(body.event || "")) return res.json({ ok: true, ignored: body.event });
    const data = body.data || {};
    const key = data.key || {};
    if (key.fromMe) return res.json({ ok: true, self: true });
    const jid = key.remoteJid || "";
    if (jid.endsWith("@g.us")) return res.json({ ok: true, group: true });
    const phone = jid.split("@")[0];
    const m = data.message || {};
    const text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption) || "";
    if (!text || !phone) return res.json({ ok: true, notext: true });
    const { data: canal } = await admin.from("canais_whatsapp").select("*").eq("instancia", body.instance || "").maybeSingle();
    const canalId = canal ? canal.id : null;
    let { data: leads } = await admin.from("leads").select("*").or(`contato->>telefone.eq.${phone},contato->>whatsapp.eq.${phone}`).limit(1);
    let lead = leads && leads[0];
    if (!lead) {
      const { data: nl } = await admin.from("leads").insert({ nome: data.pushName || phone, canal_origem: "whatsapp", contato: { telefone: phone }, status: "novo", responsavel: "SDR" }).select().single();
      lead = nl;
    }
    if (lead) {
      await admin.from("mensagens").insert({ lead_id: lead.id, direcao: "entrada", canal: "whatsapp", de: phone, corpo: text, status: "nao_lida" });
      const low = text.toLowerCase();
      if (SENSIVEIS.some((k) => low.includes(k))) {
        await admin.from("aprovacoes").insert({ tipo: "envio_externo", titulo: "WhatsApp sensível de " + (lead.nome || phone), solicitante: "Fila", detalhe: { lead_id: lead.id, trecho: text.slice(0, 400) } });
      } else {
        await admin.from("fila_agente").insert({ tipo: "responder_whatsapp", titulo: "Responder WhatsApp " + (lead.nome || phone), lead_id: lead.id, canal_id: canalId, payload: { from: phone, text, lead_nome: lead.nome || "", canal: "whatsapp" }, status: "novo" });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(200).json({ ok: false, error: String(e.message || e) }); }
});

app.listen(PORT, () => console.log(`funilvivo-api on :${PORT}`));
