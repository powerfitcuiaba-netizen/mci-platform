const { z } = require('zod');
const { USER_ROLES } = require('./roles');

const authRegister = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  password: z.string().min(8),
  role: z.enum(USER_ROLES.filter(role => role !== 'PUBLIC')).optional().default('ATHLETE')
}).strict();

const authLogin = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8)
}).strict();

module.exports = { authRegister, authLogin };
