-- HelpInk — cadastro de usuários com aprovação do administrador.
-- Qualquer pessoa pode entrar pelo Cloudflare Access e pedir uma conta;
-- só quem estiver com status 'approved' acessa os dados.
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  nome       TEXT NOT NULL DEFAULT '',
  estudio    TEXT NOT NULL DEFAULT '',
  telefone   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  decided_by TEXT
);
