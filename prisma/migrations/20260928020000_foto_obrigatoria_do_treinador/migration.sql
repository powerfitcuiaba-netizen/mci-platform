-- ============================================================================
-- FOTO DE PERFIL DO TREINADOR — obrigatória para concluir o cadastro.
--
-- ADITIVA, e a coluna é ANULÁVEL. As duas coisas de propósito:
--
--   * `NOT NULL` recusaria toda linha de `Coach` que já existe sem foto, e há
--     treinadores reais cadastrados antes desta decisão. A regra nova vale para
--     o cadastro NOVO; o antigo é avisado e regulariza — nenhum vínculo,
--     resultado, ponto ou histórico é apagado por falta de foto;
--   * a obrigatoriedade mora no SERVIÇO e na ROTA, que recusam o autocadastro
--     sem arquivo. Uma restrição de banco não saberia distinguir "cadastro novo
--     chegando sem foto" de "cadastro antigo que ainda não regularizou", e
--     transformaria a segunda numa falha de escrita.
--
-- `Coach.photoKey` segue exatamente o desenho de `Athlete.photoKey`: a CHAVE do
-- objeto no armazenamento, nunca a URL. Quem resolve a chave é o servidor, ao
-- servir `GET /media/coaches/:id/photo` — não existe parâmetro por onde o
-- cliente passar uma chave, que é o que impede trocar o id na URL de alcançar
-- arquivo alheio.
--
-- O índice parcial serve ao aviso do painel e ao gate do ranking: "quais
-- treinadores ainda estão sem foto" é a consulta que a regularização precisa, e
-- ela pergunta por ausência.
-- ============================================================================

ALTER TABLE "Coach" ADD COLUMN "photoKey" TEXT;

CREATE INDEX "Coach_sem_foto_idx" ON "Coach" ("status")
  WHERE "photoKey" IS NULL;
