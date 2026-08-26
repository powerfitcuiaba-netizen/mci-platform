const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { sanitizeUser } = require('../utils/auth');
const auditService = require('./auditService');

// Lista fechada do que o próprio usuário pode alterar em si. Tudo o mais —
// role, status, id, passwordHash, vínculos de posse — é ignorado mesmo que
// venha no corpo. É a defesa contra mass assignment: não basta o schema
// rejeitar campos desconhecidos, o service escolhe explicitamente o que grava.
const CAMPOS_EDITAVEIS = Object.freeze(['name', 'email']);

async function me(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { participant: { select: { id: true } } } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  return { user: sanitizeUser(user) };
}

async function updateProfile(userId, data, actor) {
  const dados = {};
  for (const campo of CAMPOS_EDITAVEIS) {
    if (data[campo] === undefined) continue;
    dados[campo] = String(data[campo]).trim();
  }

  if (!Object.keys(dados).length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Informe ao menos um campo para atualizar');
  }

  if (dados.name !== undefined && dados.name.length < 2) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Nome deve ter pelo menos 2 caracteres');
  }

  if (dados.email !== undefined) {
    dados.email = dados.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Email inválido');
    }
    const existente = await prisma.user.findUnique({ where: { email: dados.email } });
    if (existente && existente.id !== userId) {
      throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: dados,
    include: { participant: { select: { id: true } } }
  });

  await auditService.record({
    actor, action: 'PROFILE_UPDATE', entity: 'User', entityId: userId,
    metadata: { campos: Object.keys(dados) }
  });

  return { user: sanitizeUser(user) };
}

// Trocar senha exige provar a senha atual. Sem isso, um token vazado viraria
// tomada de conta permanente.
async function changePassword(userId, { currentPassword, newPassword }, actor) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  const atual = String(currentPassword || '');
  const nova = String(newPassword || '');

  if (nova.length < 8) throw new AppError(400, 'VALIDATION_ERROR', 'A nova senha deve ter pelo menos 8 caracteres');
  if (!atual) throw new AppError(400, 'VALIDATION_ERROR', 'Informe a senha atual');

  const confere = await bcrypt.compare(atual, user.passwordHash);
  if (!confere) throw new AppError(401, 'INVALID_CREDENTIALS', 'Senha atual incorreta');

  if (await bcrypt.compare(nova, user.passwordHash)) {
    throw new AppError(422, 'PASSWORD_UNCHANGED', 'A nova senha deve ser diferente da atual');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(nova, 12) }
  });

  // A trilha registra que houve troca; jamais a senha, antiga ou nova.
  await auditService.record({ actor, action: 'PASSWORD_CHANGE', entity: 'User', entityId: userId });

  return { success: true };
}

module.exports = { me, updateProfile, changePassword, CAMPOS_EDITAVEIS };
