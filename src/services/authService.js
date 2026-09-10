const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const userRepository = require('../repositories/userRepository');
const { AppError } = require('../utils/errors');
const { createToken } = require('../utils/auth');
const { sanitizeUser } = require('../utils/visibility');
const { isSelfServiceRole } = require('../utils/roles');
const { config } = require('../config/environment');
const audit = require('./auditService');

// Todo usuário ganha um perfil social na criação: o feed, o messenger e as
// comunidades trabalham com perfil, e criar sob demanda deixaria contas sem
// identidade social até a primeira interação.
async function criarPerfilSocial(user) {
  const base = String(user.email).split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24) || 'atleta';

  for (let tentativa = 0; tentativa < 6; tentativa += 1) {
    const handle = tentativa === 0 ? base : `${base}${Math.floor(Math.random() * 10000)}`;
    try {
      return await prisma.socialProfile.create({
        data: { userId: user.id, handle, displayName: user.name, kind: user.role === 'COACH' ? 'COACH' : user.role === 'ATHLETE' ? 'ATHLETE' : 'FAN' }
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

  const existente = await userRepository.findByEmail(data.email);
  if (existente) throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');

  const passwordHash = await bcrypt.hash(data.password, config.bcryptRounds);

  let user;
  try {
    user = await userRepository.create({ name: data.name, email: data.email, passwordHash, role, status: 'ACTIVE' });
  } catch (error) {
    // Corrida entre dois cadastros com o mesmo email: a constraint é a
    // autoridade, a checagem anterior é só cortesia.
    if (error.code === 'P2002') throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');
    throw error;
  }

  await criarPerfilSocial(user);
  const completo = await userRepository.findById(user.id);

  await audit.record({ actor: completo, action: 'USER_REGISTER', entity: 'User', entityId: completo.id, ip: contexto.ip });

  return { token: createToken(completo), user: sanitizeUser(completo) };
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

async function login(data, contexto = {}) {
  const user = await userRepository.findByEmail(data.email);

  // Comparação executada mesmo sem usuário, contra um hash descartável, para
  // que o tempo de resposta não revele quais emails existem.
  const hash = user?.passwordHash || HASH_DESCARTAVEL;
  const senhaConfere = await bcrypt.compare(data.password, hash);

  if (!user || !senhaConfere) throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');
  if (user.status !== 'ACTIVE') throw new AppError(403, 'USER_INACTIVE', 'Conta inativa');

  await audit.record({ actor: user, action: audit.ACTIONS.LOGIN, entity: 'User', entityId: user.id, ip: contexto.ip });

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
