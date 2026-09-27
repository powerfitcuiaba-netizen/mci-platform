const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const userRepository = require('../repositories/userRepository');
const { AppError } = require('../utils/errors');
const { DOMINIO_RESERVADO } = require('./serviceAccountService');
const { createToken } = require('../utils/auth');
const { sanitizeUser } = require('../utils/visibility');
const { isSelfServiceRole } = require('../utils/roles');
const { config } = require('../config/environment');
const audit = require('./auditService');
const { withUserContext } = require('../config/rlsSession');
const { contextoAtual } = require('../config/rlsContext');

// Todo usuário ganha um perfil social na criação: o feed, o messenger e as
// comunidades trabalham com perfil, e criar sob demanda deixaria contas sem
// identidade social até a primeira interação.
// CADA TENTATIVA DE HANDLE PRECISA DO PRÓPRIO PONTO DE RETORNO.
//
// O laço abaixo descobre o handle livre TENTANDO gravar e tratando a violação de
// unicidade. Fora de transação isso funciona: um INSERT recusado não deixa
// sequela. DENTRO de uma transação — o que o cadastro passou a fazer, para que a
// auditoria obrigatória possa desfazer tudo se não persistir — o PostgreSQL
// ABORTA a transação inteira no primeiro erro, e a tentativa seguinte morreria
// com 25P02 ("current transaction is aborted"), levando o cadastro junto.
//
// O SAVEPOINT resolve: a recusa volta atrás só a si mesma. É o mesmo mecanismo
// que `auditService` já usa, pela mesma razão, e a repetição aqui é deliberada —
// o laço precisa da proteção no lugar onde tenta, não numa camada acima.
async function tentarCriarPerfil(dados) {
  const tx = contextoAtual()?.tx;
  if (!tx) return prisma.socialProfile.create({ data: dados });

  const ponto = `mci_perfil_${Math.random().toString(36).slice(2, 10)}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${ponto}`);
  try {
    const perfil = await tx.socialProfile.create({ data: dados });
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);
    return perfil;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${ponto}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);
    throw error;
  }
}

async function criarPerfilSocial(user) {
  const base = String(user.email).split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24) || 'atleta';

  for (let tentativa = 0; tentativa < 6; tentativa += 1) {
    const handle = tentativa === 0 ? base : `${base}${Math.floor(Math.random() * 10000)}`;
    try {
      return await tentarCriarPerfil({
        userId: user.id, handle, displayName: user.name,
        kind: user.role === 'COACH' ? 'COACH' : user.role === 'ATHLETE' ? 'ATHLETE' : 'FAN'
      });
    } catch (error) {
      if (error.code !== 'P2002') throw error;
    }
  }
  throw new AppError(409, 'HANDLE_UNAVAILABLE', 'Não foi possível gerar um identificador social');
}

async function register(data, contexto = {}) {
  const role = data.role || 'ATHLETE';
  if (!isSelfServiceRole(role)) {
    throw new AppError(403, 'ROLE_NOT_SELF_ASSIGNABLE', 'Este perfil só pode ser concedido por um administrador');
  }

  // O DOMÍNIO DAS CONTAS TÉCNICAS É RESERVADO.
  //
  // Sem isto, alguém registrava um endereço em `federacao.mci.local` antes de
  // a federação existir e a criação dela falhava por unicidade de e-mail —
  // impedir que a identidade técnica NASÇA é tão eficaz quanto tomá-la.
  //
  // A recusa vem ANTES da conferência de duplicidade de propósito: responder
  // "e-mail já cadastrado" aqui contaria quais endereços técnicos existem.
  // `EMAIL_DOMAIN_RESERVED` não confirma nem nega nenhum cadastro.
  if (String(data.email).toLowerCase().endsWith(`@${DOMINIO_RESERVADO}`)) {
    throw new AppError(422, 'EMAIL_DOMAIN_RESERVED', 'Este domínio de e-mail é reservado pelo sistema');
  }

  const existente = await userRepository.findByEmail(data.email);
  if (existente) throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');

  const passwordHash = await bcrypt.hash(data.password, config.bcryptRounds);

  // ============================================================================
  // O CADASTRO É ATÔMICO — TRILHA GRAVADA OU CONTA NENHUMA.
  //
  // Decisão aprovada: se a auditoria obrigatória não persistir, o cadastro não
  // pode ser dado por concluído nem emitir sessão. Ficava a pergunta do que
  // fazer com a conta já criada, e a resposta honesta é não criá-la: as três
  // escritas passam a acontecer numa transação só, e a recusa da trilha desfaz
  // conta, perfil e tudo o mais. Nada de compensação por DELETE depois — apagar
  // conta é ato administrativo, e usá-lo como conserto de meia-falha seria
  // construir exatamente o caminho que a plataforma não quer ter.
  //
  // A TRANSAÇÃO É ABERTA COM ATOR VAZIO, o mesmo que o cadastro sempre teve:
  // quem se cadastra não é ninguém ainda. O ator só passa a existir na linha da
  // auditoria, e é `registrarObrigatorio` quem o define — reaproveitando esta
  // MESMA transação, porque `withUserContext` detecta que já há uma em curso.
  //
  // O QUE FICOU DE FORA DA TRANSAÇÃO, de propósito: o `bcrypt.hash` (custo de
  // CPU, não de banco — dentro, ele gastaria o prazo da transação segurando uma
  // conexão do pool) e o `createToken`, que só acontece depois do commit. Um
  // token criado dentro da transação existiria antes de a linha existir para
  // qualquer outra conexão, e é justamente o sucesso parcial que a decisão
  // proíbe.
  // ============================================================================
  const completo = await withUserContext(null, async () => {
    const criado = await criarUsuarioComPerfil(data, role, passwordHash);

    // A CONFERÊNCIA DA TRILHA VEM ANTES DA CREDENCIAL. Se não persistir, esta
    // função levanta 503 e a transação inteira volta atrás: nenhuma conta, nenhum
    // perfil, nenhuma sessão.
    await audit.registrarObrigatorio({
      actor: criado, action: audit.ACTIONS.USER_REGISTER, entity: 'User', entityId: criado.id, ip: contexto.ip
    });

    return criado;
  });

  return { token: createToken(completo), user: sanitizeUser(completo) };
}

// A criação em si, separada para que a transação acima leia como o que é: três
// escritas e uma conferência.
async function criarUsuarioComPerfil(data, role, passwordHash) {
  let user;
  try {
    user = await userRepository.create({
      name: data.name, email: data.email, passwordHash, role, status: 'ACTIVE',
      // Campos do cadastro completo. Listados um a um de propósito: espalhar
      // `...data` aqui deixaria o cliente gravar qualquer coluna de `User`
      // que o Zod viesse a aceitar no futuro — inclusive `role` e `status`.
      birthDate: data.birthDate ? new Date(`${data.birthDate}T12:00:00.000Z`) : undefined,
      phone: data.phone,
      whatsapp: data.whatsapp,
      postalCode: data.postalCode,
      addressLine: data.addressLine,
      addressNumber: data.addressNumber,
      addressComplement: data.addressComplement,
      state: data.state,
      city: data.city
    });
  } catch (error) {
    // Corrida entre dois cadastros com o mesmo email: a constraint é a
    // autoridade, a checagem anterior é só cortesia.
    if (error.code === 'P2002') throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');
    throw error;
  }

  await criarPerfilSocial(user);
  return userRepository.findById(user.id);
}

// Hash descartável usado quando o email não existe, para que a comparação
// custe o MESMO tempo dos dois lados.
//
// Aqui havia um literal de custo fixo 04. A comparação acontecia, o comentário
// prometia tempo constante — e o tempo não era constante coisa nenhuma:
// medido, um `compare` contra custo 04 leva 0,03 ms e contra os hashes reais
// de custo 10 leva 80 ms; em custo 12, 313 ms. Três ordens de grandeza de
// diferença entre "este email existe" e "não existe", em cima de uma rota
// anônima. A defesa estava escrita, mas não funcionava.
//
// Gerado uma vez, na carga do módulo, com o MESMO custo dos hashes reais. A
// senha não abre conta nenhuma: o hash existe só para gastar o tempo certo.
const HASH_DESCARTAVEL = bcrypt.hashSync(
  'nenhuma-conta-usa-esta-senha-ela-existe-so-para-igualar-o-tempo',
  config.bcryptRounds
);

// ============================================================================
// A TENTATIVA RECUSADA TAMBÉM ENTRA NA TRILHA.
//
// Decisão aprovada: credencial inválida deixava de deixar rastro nenhum, e uma
// varredura de senhas contra uma conta era invisível para quem audita.
//
// O QUE A LINHA CARREGA, e por que tão pouco:
//
//   `userId` NULO. É a única ação da tabela em que `userId` não é "quem fez":
//   quem tentou é DESCONHECIDO — é isso que a tentativa recusada significa. Pôr
//   ali a conta alvo faria a trilha dizer que a vítima fez a ação, e abriria uma
//   segunda porta: gravar linhas atribuídas a outra pessoa por um pedido
//   anônimo, que é exatamente o que a política `auditoria_escrita` existe para
//   impedir. Com `userId` nulo a política aceita a linha SEM contexto de ator e
//   SEM afrouxamento nenhum — medido na sonda P4 do diagnóstico.
//
//   A CONTA ALVO em `entityId`, por IDENTIFICADOR INTERNO. Nunca o e-mail
//   tentado: e-mail é dado pessoal, e de alguém que pode nem ser usuário.
//
//   `contaExistente` em `metadata`, booleano. Diz se havia conta do outro lado,
//   que é a diferença entre "alguém erra a senha desta pessoa" e "alguém varre
//   endereços". Não vaza para fora: `organizationId` é nulo, então só
//   administrador de plataforma lê esta linha — e ele já podia consultar `User`.
//
//   O QUE NUNCA ENTRA: senha, parte de senha, hash, token, cabeçalho, cookie,
//   corpo da requisição, e-mail tentado. O IP já é coluna da tabela e é o que
//   permite ligar tentativas de uma mesma origem.
//
// A RESPOSTA AO CLIENTE NÃO MUDA: 401 `INVALID_CREDENTIALS` para conta
// inexistente, senha errada e conta de serviço — a mesma de antes, pelas mesmas
// razões de não confirmar a existência de endereço.
async function registrarTentativaRecusada({ user, motivo, ip }) {
  await audit.registrarObrigatorio({
    actor: null,
    action: audit.ACTIONS.LOGIN_FAILED,
    entity: 'User',
    entityId: user?.id ?? null,
    ip,
    metadata: { motivo, contaExistente: Boolean(user) }
  });
}

async function login(data, contexto = {}) {
  const user = await userRepository.findByEmail(data.email);

  // Comparação executada mesmo sem usuário, contra um hash descartável, para
  // que o tempo de resposta não revele quais emails existem.
  const hash = user?.passwordHash || HASH_DESCARTAVEL;
  const senhaConfere = await bcrypt.compare(data.password, hash);

  if (!user || !senhaConfere) {
    // A ORDEM IMPORTA, e é a mesma dos outros caminhos: primeiro a trilha,
    // depois a recusa. Se a trilha não persistir, `registrarObrigatorio` levanta
    // 503 e ESTA linha nunca é alcançada — a resposta passa a ser de
    // indisponibilidade, igual à de um login correto na mesma situação. É o que
    // impede a falha de auditoria de virar oráculo de senha: com a trilha
    // indisponível, acerto e erro respondem igual.
    await registrarTentativaRecusada({ user, motivo: 'INVALID_CREDENTIALS', ip: contexto.ip });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');
  }

  // NINGUÉM ENTRA COMO A FEDERAÇÃO.
  //
  // A conta de serviço é identidade de EXECUÇÃO: o backend a assume para
  // concluir um autocadastro e conciliar histórico, e nada mais. Ter senha
  // impossível já a protegeria, mas senha é acidente — esta conferência é a
  // regra, e ela vale mesmo que um dia alguém grave um hash conhecido ali.
  //
  // A recusa usa o MESMO código de credencial inválida: dizer "esta é uma
  // conta de serviço" confirmaria a existência do endereço para quem estivesse
  // procurando por ele.
  if (user.isServiceAccount) {
    await registrarTentativaRecusada({ user, motivo: 'SERVICE_ACCOUNT', ip: contexto.ip });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');
  }

  if (user.status !== 'ACTIVE') {
    await registrarTentativaRecusada({ user, motivo: 'USER_INACTIVE', ip: contexto.ip });
    throw new AppError(403, 'USER_INACTIVE', 'Conta inativa');
  }

  // A TRILHA VEM ANTES DO TOKEN, e agora isso é garantia e não ordem casual.
  //
  // Duas coisas nesta chamada. A primeira, já de antes: a entrada é rota aberta,
  // o ator só passa a existir depois de a senha ser conferida, e o registro
  // precisa do contexto DELE para a política aceitar.
  //
  // A segunda é a decisão aprovada agora: `registrarObrigatorio` e não
  // `registrarComContextoDoAtor`. Se a trilha não persistir, esta função levanta
  // 503 e `createToken` NUNCA é alcançado — sem token, sem sessão, sem
  // credencial utilizável. O sucesso do login passou a depender da confirmação
  // de gravação, e não de uma tentativa de gravação.
  await audit.registrarObrigatorio({
    actor: user, action: audit.ACTIONS.LOGIN, entity: 'User', entityId: user.id, ip: contexto.ip
  });

  return { token: createToken(user), user: sanitizeUser(user) };
}

async function me(id) {
  const user = await userRepository.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  return { user: sanitizeUser(user) };
}

async function updateProfile(id, data) {
  if (data.email) {
    const outro = await userRepository.findByEmail(data.email);
    if (outro && outro.id !== id) throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');
  }
  const user = await userRepository.update(id, data);
  return { user: sanitizeUser(user) };
}

async function changePassword(id, { currentPassword, newPassword }) {
  const user = await userRepository.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  const confere = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!confere) throw new AppError(401, 'INVALID_CREDENTIALS', 'Senha atual incorreta');
  if (currentPassword === newPassword) throw new AppError(422, 'SAME_PASSWORD', 'A nova senha precisa ser diferente da atual');

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  await userRepository.update(id, { passwordHash });

  return { success: true };
}

module.exports = { register, login, me, updateProfile, changePassword, criarPerfilSocial };
