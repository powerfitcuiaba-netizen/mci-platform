const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const { AppError } = require('../utils/errors');
const { createToken, sanitizeUser } = require('../utils/auth');
const { isValidRole } = require('../utils/roles');

async function register(data) {
  const email = (data.email || '').trim().toLowerCase();
  const name = (data.name || '').trim();
  const password = String(data.password || '');
  const role = data.role || 'ATHLETE';

  if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'Nome é obrigatório');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'VALIDATION_ERROR', 'Email inválido');
  if (password.length < 8) throw new AppError(400, 'VALIDATION_ERROR', 'Senha deve ter pelo menos 8 caracteres');
  if (!isValidRole(role)) throw new AppError(400, 'VALIDATION_ERROR', 'Perfil inválido');

  const existing = await userRepository.findByEmail(email);
  if (existing) throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email já cadastrado');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await userRepository.create({ name, email, passwordHash, role, status: 'ACTIVE' });
  const token = createToken(user);

  return { token, user: sanitizeUser(user) };
}

async function login(data) {
  const email = (data.email || '').trim().toLowerCase();
  const password = String(data.password || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'VALIDATION_ERROR', 'Email inválido');
  if (password.length < 8) throw new AppError(400, 'VALIDATION_ERROR', 'Senha deve ter pelo menos 8 caracteres');

  const user = await userRepository.findByEmail(email);
  if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');

  const token = createToken(user);
  return { token, user: sanitizeUser(user) };
}

async function me(id) {
  const user = await userRepository.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  return { user: sanitizeUser(user) };
}

module.exports = { register, login, me };
