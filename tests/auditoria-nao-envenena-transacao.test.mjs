import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, comoAtor, unico } from './helpers.mjs';
import audit from '../src/services/auditService.js';
import { withUserContext } from '../src/config/rlsSession.js';
import prismaBase from '../src/config/prismaPublico.js';

// ============================================================================
// AUDITORIA QUE FALHA NÃO PODE DESFAZER O TRABALHO DE NINGUÉM.
//
// O `try/catch` de `record` prometia isso e não cumpria. No PostgreSQL,
// QUALQUER statement recusado aborta a transação INTEIRA — capturar o erro em
// JavaScript não desfaz esse fato. A transação fica envenenada, todo comando
// seguinte falha com 25P02, e no commit tudo volta atrás.
//
// COMO O DEFEITO FOI DESCOBERTO, e por que nenhum teste o pegava: o
// provisionamento da conta de serviço rodava sem ator; a política
// `auditoria_escrita` recusava o INSERT com 42501; o `catch` engolia; e
// `provisionar` devolvia a conta criada COM ID enquanto o banco ficava vazio.
// Sucesso mentiroso.
//
// Esta suíte é a prova permanente. Ela força a recusa PELO CAMINHO REAL — uma
// auditoria com `organizationId` de uma organização da qual o ator não é
// membro, que é exatamente o que a política barra — e cobra as três coisas:
//
//   1. a operação principal SOBREVIVE e está no banco depois do commit;
//   2. a transação continua UTILIZÁVEL depois da recusa;
//   3. `record` devolve null, sem lançar.
// ============================================================================

let admin, orgId, forasteiro;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  orgId = (await criarOrganizacao(admin, { name: 'Federação da Auditoria' })).id;
  // Sem vínculo com a organização: `mci_member_of` responde falso para ele, e
  // é isso que faz a política recusar o INSERT de auditoria.
  forasteiro = await criarUsuario({ name: 'Sem Vínculo' });
});

// Conta as linhas pelo cliente BASE, fora de qualquer transação: é o único
// jeito de saber o que de fato COMMITOU. Contar de dentro da transação
// mostraria o que ela ainda pode desfazer.
const contarDepoisDoCommit = where => prismaBase.post.count({ where });

describe('auditoria recusada não envenena a transação', () => {
  it('a operação principal sobrevive ao INSERT de auditoria recusado', async () => {
    const marca = unico('post');

    const devolvido = await withUserContext(forasteiro.id, async () => {
      // 1. A OPERAÇÃO PRINCIPAL — uma escrita que o forasteiro PODE fazer.
      await comoAtor(forasteiro, tx => tx.post.create({
        data: { authorId: forasteiro.profileId, content: marca, visibility: 'PUBLIC' }
      }));

      // 2. A AUDITORIA QUE A POLÍTICA RECUSA: organização de que ele não é
      //    membro. Se `record` lançar aqui, o teste falha por exceção — e
      //    lançar também seria defeito, porque auditar é efeito colateral.
      const resultado = await audit.record({
        actor: forasteiro, action: 'TESTE_RECUSADO', entity: 'Post',
        entityId: 'x', organizationId: orgId
      });

      // 3. A TRANSAÇÃO CONTINUA UTILIZÁVEL. Sem o SAVEPOINT, esta leitura
      //    falharia com 25P02 — "current transaction is aborted".
      const aindaLe = await comoAtor(forasteiro, tx => tx.post.count({ where: { content: marca } }));
      expect(aindaLe, 'a transação ficou abortada depois da auditoria recusada').toBe(1);

      return resultado;
    });

    // `record` devolve null: falhou, e disse que falhou, sem derrubar nada.
    expect(devolvido, 'a auditoria recusada não devolveu null').toBeNull();

    // E O QUE IMPORTA: a operação principal COMMITOU.
    expect(await contarDepoisDoCommit({ content: marca }),
      'A OPERAÇÃO PRINCIPAL FOI DESFEITA PELA AUDITORIA RECUSADA').toBe(1);

    // A linha de auditoria recusada NÃO existe — o SAVEPOINT desfez só ela.
    const auditorias = await comoAtor(admin, tx => tx.auditLog.count({ where: { action: 'TESTE_RECUSADO' } }));
    expect(auditorias, 'a auditoria recusada foi gravada assim mesmo').toBe(0);
  });

  it('duas auditorias recusadas seguidas não atrapalham uma à outra', async () => {
    // Os pontos de retorno precisam de nomes distintos: com um nome só, a
    // segunda chamada reaproveitaria o ponto da primeira e o rollback voltaria
    // longe demais — desfazendo trabalho que ninguém mandou desfazer.
    const marca = unico('post');

    await withUserContext(forasteiro.id, async () => {
      await comoAtor(forasteiro, tx => tx.post.create({
        data: { authorId: forasteiro.profileId, content: marca, visibility: 'PUBLIC' }
      }));

      for (const acao of ['RECUSADA_1', 'RECUSADA_2', 'RECUSADA_3']) {
        expect(await audit.record({
          actor: forasteiro, action: acao, entity: 'Post', entityId: 'x', organizationId: orgId
        })).toBeNull();
      }

      const ainda = await comoAtor(forasteiro, tx => tx.post.count({ where: { content: marca } }));
      expect(ainda).toBe(1);
    });

    expect(await contarDepoisDoCommit({ content: marca })).toBe(1);
  });

  it('a auditoria que a política ACEITA continua sendo gravada', async () => {
    // A guarda contra a correção fácil demais: um `record` que nunca grava
    // nada passaria em todos os testes acima. Este cobra o caminho feliz.
    const marca = unico('post');

    await withUserContext(admin.id, async () => {
      await comoAtor(admin, tx => tx.post.create({
        data: { authorId: admin.profileId, content: marca, visibility: 'PUBLIC' }
      }));
      const r = await audit.record({
        actor: admin, action: 'TESTE_ACEITO', entity: 'Post', entityId: 'x', organizationId: orgId
      });
      expect(r, 'a auditoria aceita devolveu null').not.toBeNull();
    });

    expect(await comoAtor(admin, tx => tx.auditLog.count({ where: { action: 'TESTE_ACEITO' } }))).toBe(1);
    expect(await contarDepoisDoCommit({ content: marca })).toBe(1);
  });

  it('fora de transação, a auditoria recusada também não lança', async () => {
    // Sem transação não há o que envenenar, e o caminho é outro no código.
    // Ele precisa continuar devolvendo null em vez de estourar na cara de quem
    // chamou — auditar é efeito colateral em qualquer contexto.
    const r = await audit.record({
      actor: forasteiro, action: 'FORA_DE_TRANSACAO', entity: 'Post',
      entityId: 'x', organizationId: orgId
    });
    expect(r).toBeNull();
  });
});
