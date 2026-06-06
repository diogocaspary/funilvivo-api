# Funil Vivo — API (backend de canais)

Serviço Node/Express que o portal usa para ações que precisam de segredos (token Evolution, senha SMTP). Lê os segredos do Supabase com a **service role key** (nunca expostos ao navegador).

## O que faz
- WhatsApp (Evolution): criar instância, obter QR, ver status, desconectar.
- E-mail: enviar um rascunho de outreach via o SMTP cadastrado (respeita a constância de canal por lead).

## Rotas
- `GET /health`
- `POST /wa/:id/create` — cria a instância na Evolution
- `GET /wa/:id/qr` — retorna QR (base64) para conectar
- `GET /wa/:id/status` — estado da conexão (atualiza no banco)
- `POST /wa/:id/logout` — desconecta
- `POST /send/email` — body `{ "outreach_id": "..." }`

Todas (exceto /health) exigem `Authorization: Bearer <token do usuário logado>` e papel admin/equipe.

## Deploy no EasyPanel (App via GitHub)
1. Suba este repositório no GitHub (ex: `funilvivo-api`).
2. EasyPanel → projeto `funilvivo` → **+ Service → App** → nome `api`.
3. Source: GitHub → repo `funilvivo-api`, branch `main`. Build: **Dockerfile**.
4. **Environment** (aba do serviço) — adicione:
   - `SUPABASE_URL` = https://myamzjypptifoxulahvo.supabase.co
   - `SUPABASE_SERVICE_ROLE_KEY` = (copie em Supabase → Project Settings → API → service_role; é SECRETA)
   - `ALLOWED_ORIGINS` = https://app.funilvivo.com.br
   - `PORT` = 3000
5. Deploy.
6. **Domains** → adicione `api.funilvivo.com.br` (porta 3000).
7. Cloudflare → DNS `api` → IP do servidor → proxy ligado → SSL Full.

Teste: abra `https://api.funilvivo.com.br/health` → deve responder `{"ok":true}`.

> ⚠️ A `SUPABASE_SERVICE_ROLE_KEY` dá acesso total ao banco. Ela vive **só** aqui, nas variáveis de ambiente do servidor — nunca no portal nem no GitHub.
