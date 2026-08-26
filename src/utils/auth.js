const jwt = require('jsonwebtoken');

const { config } = require('../config/environment');

// O segredo vem da configuração central, que já recusou placeholder em produção.
const JWT_SECRET = config.jwtSecret;

function createToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: config.jwtExpiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    participantId: user.participant?.id || user.participantId || null
  };
}

module.exports = { JWT_SECRET, createToken, verifyToken, sanitizeUser };
