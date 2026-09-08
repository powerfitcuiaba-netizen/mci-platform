#!/usr/bin/env node
/**
 * Cria o PRIMEIRO administrador da plataforma.
 *
 * Existe porque não havia caminho nenhum: o cadastro aberto recusa papel
 * privilegiado — e deve recusar mesmo —, então numa instalação nova ninguém
 * conseguiria dar o primeiro passo sem escrever direto no banco.
 *
 * Uso:
 *   ADMIN_PASSWORD='...' node scripts/criar-admin.js "Nome" email@dominio
 *
 * A senha NÃO é aceita como argumento de linha de comando de propósito:
 * argumento aparece em `ps` para qualquer usuário da máquina e fica no
 * histórico do shell. Vem por variável de ambiente ou pela entrada padrão.
 */
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const { config } = require('../src/config/environment');
const { criarPerfilSocial } = require('../src/services/authService');
const audit = require('../src/services/auditService');
const { withUserContext } = require('../src/config/rlsSession');

const SENHA_MINIMA = 8;

function encerrar(mensagem, codigo = 1) {
  console.error(mensagem);
  process.exit(codigo);
}

async function lerSenhaDaEntrada() {
  if (process.stdin.isTTY) return null;
  const partes = [];
  for await (const parte of process.stdin) partes.push(parte);
  return partes.join('').trim() || null;
}

async function main() {
  const [nome, email] = process.argv.slice(2);

  if (!nome || !email) {
    encerrar('Uso: ADMIN_PASSWORD=\'...\' node scripts/criar-admin.js "Nome Completo" email@dominio');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) encerrar(`Email inválido: ${email}`);

  const senha = process.env.ADMIN_PASSWORD || await lerSenhaDaEntrada();
  if (!senha) {
    encerrar('Senha ausente. Informe em ADMIN_PASSWORD ou pela entrada padrão — nunca como argumento.');
  }
  if (senha.length < SENHA_MINIMA) encerrar(`Senha curta demais: mínimo de ${SENHA_MINIMA} caracteres.`);

  const emailNormalizado = String(email).trim().toLowerCase();

  // Trava de bootstrap: esta ferramenta cria o PRIMEIRO administrador. Conceder
  // o papel a mais alguém é operação de administração, feita por quem já
  // administra, com registro em auditoria — não por script de terminal.
  const jaExiste = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });
  if (jaExiste) {
    encerrar(
      'Já existe administrador nesta instalação. Este script só cria o primeiro.\n'
      + 'Para conceder o papel a outra pessoa, use a administração de contas, que registra quem concedeu.'
    );
  }

  const existente = await prisma.user.findUnique({ where: { email: emailNormalizado }, select: { id: true } });
  const passwordHash = await bcrypt.hash(senha, config.bcryptRounds);

  const usuario = existente
    ? await prisma.user.update({
      where: { id: existente.id },
      data: { role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash }
    })
    : await prisma.user.create({
      data: { name: nome, email: emailNormalizado, passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' }
    });

  if (!existente) await criarPerfilSocial(usuario);

  // A auditoria passa pelo serviço do projeto e DENTRO do contexto de ator: a
  // tabela tem RLS forçado, e escrever nela por fora não enxergaria a própria
  // linha. O primeiro administrador é registrado como autor do próprio
  // bootstrap, que é o que de fato aconteceu.
  await withUserContext(usuario.id, () => audit.record({
    actor: usuario,
    action: 'ADMIN_BOOTSTRAP',
    entity: 'User',
    entityId: usuario.id,
    metadata: { via: 'scripts/criar-admin.js', promovido: Boolean(existente) }
  }));

  // A senha não é ecoada. Quem a definiu já a conhece; imprimi-la só a
  // colocaria no log do terminal e do CI.
  console.log(JSON.stringify({
    criado: !existente,
    promovido: Boolean(existente),
    email: usuario.email,
    role: usuario.role
  }));
}

main()
  .catch(erro => encerrar(`Falhou: ${erro.message}`))
  .finally(() => prisma.$disconnect());
