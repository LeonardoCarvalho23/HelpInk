-- HelpInk — banco D1 (SQLite)
-- Cada cliente, sessão, custo pessoal, material e compra é uma linha,
-- separada por usuário (e-mail validado pelo Cloudflare Access).
CREATE TABLE IF NOT EXISTS records (
  user_id    TEXT NOT NULL,
  col        TEXT NOT NULL CHECK (col IN ('meta', 'clients', 'sessions', 'personal', 'stock', 'buys')),
  id         TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, col, id)
);
