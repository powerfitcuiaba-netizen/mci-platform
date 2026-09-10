const jwt = require('jsonwebtoken');
const { config } = require('../config/environment');

const JWT_SECRET = config.jwtSecret;

function createToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: config.jwtExpiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { JWT_SECRET, createToken, verifyToken };
