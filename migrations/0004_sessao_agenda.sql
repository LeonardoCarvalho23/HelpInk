-- HelpInk — ficha de anamnese por sessão e link da agenda do cliente.
-- Rode no Console do D1 um comando por vez, nesta ordem.

-- 1) Cada ficha passa a pertencer a uma sessão (dia). Fichas antigas ficam com session_id vazio.
ALTER TABLE forms ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS forms_session ON forms (owner, session_id);

-- 2) A trava das fichas assinadas passa a proteger também a sessão a que a ficha pertence.
DROP TRIGGER IF EXISTS forms_lock;

CREATE TRIGGER forms_lock BEFORE UPDATE ON forms
WHEN OLD.status = 'signed' AND (NEW.status IS NOT OLD.status OR NEW.doc IS NOT OLD.doc OR NEW.doc_hash IS NOT OLD.doc_hash OR NEW.answers IS NOT OLD.answers OR NEW.signed_at IS NOT OLD.signed_at OR NEW.evidence IS NOT OLD.evidence OR NEW.owner IS NOT OLD.owner OR NEW.client_id IS NOT OLD.client_id OR NEW.term IS NOT OLD.term OR NEW.session_id IS NOT OLD.session_id OR (OLD.ots IS NOT NULL AND NEW.ots IS NOT OLD.ots))
BEGIN SELECT RAISE(ABORT, 'ficha assinada nao pode ser alterada'); END;

-- 3) Link da agenda: um por cliente. Mostra só as próximas sessões (sem valores nem dados de saúde).
-- O código fica guardado para o tatuador poder reenviar o mesmo link; "Gerar novo link" troca o código.
CREATE TABLE IF NOT EXISTS agenda (
  owner      TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, client_id)
);
