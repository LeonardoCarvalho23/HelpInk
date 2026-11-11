-- HelpInk — fotos do resultado das tatuagens.
-- Os arquivos ficam no R2 (bucket helpink-fotos); esta tabela só registra de quem é cada foto e o
-- tamanho, para aplicar os limites por conta e o teto geral (que mantém o R2 na faixa gratuita).
CREATE TABLE IF NOT EXISTS photos (
  owner      TEXT NOT NULL,
  id         TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, id)
);
