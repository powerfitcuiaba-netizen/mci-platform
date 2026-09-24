const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const audit = require('./auditService');

// ============================================================================
// A CONTA DE SERVIÇO DA FEDERAÇÃO.
//
// Identidade TÉCNICA, uma por organização, criada pelo sistema e por mais
// ninguém. Ela existe para que a conclusão automática do autocadastro possa
// escrever no ledger sem que o ATLETA ganhe esse direito.
//
// O QUE ELA PODE
//
//   No banco: o que um operador daquela federação pode, e só naquela
//   federação — `mci_operator_of` a reconhece, e o RLS confere a organização
//   linha a linha.
//
// O QUE ELA NÃO PODE
//
//   Autenticar. `login` a recusa por `isServiceAccount`, e a senha é um
//   segredo aleatório que ninguém nunca vê — nem quem a criou, porque ela é
//   gerada, usada como hash e descartada na mesma linha.
//
//   Receber permissão de aplicação. No `ROLE_PERMISSIONS` o papel
//   `FEDERATION_SERVICE` tem a base autenticada e NADA além. Toda operação que
//   passa por `assertCan` lhe é negada.
//
//   Sair da própria federação. `serviceOrganizationId` é único e há restrição
//   de coerência: não existe conta de serviço sem organização, nem duas na
//   mesma.
//
// COMO A IDENTIDADE É ESCOLHIDA
//
// Pelo BACKEND, a partir da organização que já foi resolvida no servidor —
// no autocadastro, a organização vem da FILIAÇÃO escolhida, nunca do corpo da
// requisição. Não existe parâmetro de entrada que nomeie a conta de serviço,
// o operador ou a organização a usar. Quem quiser operar como outra federação
// precisa de um `affiliationId` daquela federação, e aí a organização é a
// daquela federação — que é o comportamento correto, não um contorno.
// ============================================================================

const PAPEL = 'FEDERATION_SERVICE';

// O DOMÍNIO É RESERVADO, e a recusa mora em `authService.register`: nenhuma
// pessoa cadastra endereço aqui. É a barreira que fecha a classe inteira do
// problema — não só este endereço, todos.
const DOMINIO_RESERVADO = 'federacao.mci.local';

// O ENDEREÇO VEM DO ID, E NÃO DO SLUG.
//
// Com o slug, o endereço era ADIVINHÁVEL antes de a federação existir: quem
// soubesse o slug planejado registrava `servico.<slug>@…` primeiro, e a
// criação da organização falhava por unicidade de e-mail. Não dava para
// assumir a identidade — `contaDaOrganizacao` busca por `serviceOrganizationId`
// e `isServiceAccount`, que só `provisionar` escreve —, mas dava para IMPEDIR
// que ela nascesse.
//
// O id é um cuid gerado pelo servidor no instante da criação. Ninguém o
// conhece antes, então não há o que registrar antes. Junto com o domínio
// reservado, são duas barreiras independentes: uma torna o alvo desconhecido,
// a outra fecha a porta mesmo para quem o conhecesse.
const emailDaConta = organizationId => `servico.${organizationId}@${DOMINIO_RESERVADO}`;

/**
 * Garante que a federação tenha a sua conta de serviço. Idempotente: rodar de
 * novo devolve a mesma identidade, sem criar outra e sem tocar na existente.
 */
async function provisionar(organizationId, actor = null, tx = prisma) {
  const organizacao = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, slug: true, name: true }
  });
  if (!organizacao) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');

  const existente = await tx.user.findFirst({
    where: { serviceOrganizationId: organizationId, isServiceAccount: true },
    select: { id: true, name: true, email: true, serviceOrganizationId: true }
  });
  if (existente) return existente;

  // A senha nasce aleatória, vira hash e morre nesta linha. Não há caminho —
  // nem para quem administra a plataforma — que a recupere: entrar como a
  // conta de serviço não é "difícil", é impossível por construção, e o `login`
  // a recusa mesmo que alguém adivinhasse.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10);

  const conta = await tx.user.create({
    data: {
      name: `Sistema · ${organizacao.name}`,
      email: emailDaConta(organizacao.id),
      passwordHash,
      // O papel GLOBAL não concede nada: a matriz de permissões dá a
      // `FEDERATION_SERVICE` apenas a base autenticada.
      role: PAPEL,
      isServiceAccount: true,
      serviceOrganizationId: organizationId
    },
    select: { id: true, name: true, email: true, serviceOrganizationId: true }
  });

  // A MEMBRESIA é o que o RLS enxerga — e ela é de UMA organização.
  await tx.organizationMember.create({
    data: { organizationId, userId: conta.id, role: PAPEL }
  });

  await audit.record({
    actor, action: 'SERVICE_ACCOUNT_PROVISIONED', entity: 'User', entityId: conta.id,
    organizationId,
    metadata: { actorType: 'SYSTEM_SERVICE_ACCOUNT', serviceAccountId: conta.id, role: PAPEL }
  });

  return conta;
}

/**
 * A identidade que vai executar a conciliação desta federação.
 *
 * Recusa em vez de improvisar: sem conta de serviço, o autocadastro NÃO cai
 * de volta para um ator privilegiado qualquer — ele para. Um fallback aqui
 * seria a porta dos fundos que esta arquitetura inteira existe para não ter.
 */
async function contaDaOrganizacao(organizationId) {
  const conta = await prisma.user.findFirst({
    where: { serviceOrganizationId: organizationId, isServiceAccount: true },
    select: { id: true, name: true, email: true, serviceOrganizationId: true }
  });
  if (!conta) {
    throw new AppError(503, 'SERVICE_ACCOUNT_MISSING',
      'A federação ainda não está preparada para concluir autocadastro automaticamente.');
  }
  return conta;
}

module.exports = { provisionar, contaDaOrganizacao, PAPEL, emailDaConta, DOMINIO_RESERVADO };
