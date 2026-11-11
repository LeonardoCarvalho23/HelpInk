-- HelpInk — fichas de anamnese assinadas pelo cliente.
-- O link enviado ao cliente não é guardado: só o SHA-256 dele (token_hash).
-- Depois de assinada, a ficha não pode ser alterada nem apagada (triggers abaixo);
-- só o carimbo do tempo (ots) pode ser acrescentado.
CREATE TABLE IF NOT EXISTS forms (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  owner       TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'cancelled')),
  studio      TEXT NOT NULL DEFAULT '',
  client_hint TEXT NOT NULL DEFAULT '',
  term        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  opened_at   TEXT,
  signed_at   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  answers     TEXT,
  doc         TEXT,
  doc_hash    TEXT,
  evidence    TEXT,
  ots         TEXT
);

CREATE INDEX IF NOT EXISTS forms_owner ON forms (owner, client_id);

CREATE TRIGGER IF NOT EXISTS forms_lock BEFORE UPDATE ON forms
WHEN OLD.status = 'signed' AND (NEW.status IS NOT OLD.status OR NEW.doc IS NOT OLD.doc OR NEW.doc_hash IS NOT OLD.doc_hash OR NEW.answers IS NOT OLD.answers OR NEW.signed_at IS NOT OLD.signed_at OR NEW.evidence IS NOT OLD.evidence OR NEW.owner IS NOT OLD.owner OR NEW.client_id IS NOT OLD.client_id OR NEW.term IS NOT OLD.term OR (OLD.ots IS NOT NULL AND NEW.ots IS NOT OLD.ots))
BEGIN SELECT RAISE(ABORT, 'ficha assinada nao pode ser alterada'); END;

CREATE TRIGGER IF NOT EXISTS forms_nodelete BEFORE DELETE ON forms
WHEN OLD.status = 'signed'
BEGIN SELECT RAISE(ABORT, 'ficha assinada nao pode ser apagada'); END;
