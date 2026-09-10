const { AppError } = require('./errors');

// CPF é a identidade central do atleta e um dado pessoal restrito.
// Aqui ficam apenas normalização, validação de dígito e mascaramento; a
// decisão de quem pode ver o número está em permissions/serializers.

const somenteDigitos = valor => String(valor ?? '').replace(/\D/g, '');

// Sequências de dígito repetido passam no cálculo do dígito verificador, mas
// não são CPF válido. A checagem é explícita.
const REPETIDOS = new Set(['00000000000', '11111111111', '22222222222', '33333333333', '44444444444',
  '55555555555', '66666666666', '77777777777', '88888888888', '99999999999']);

function digitoVerificador(base, pesoInicial) {
  let soma = 0;
  for (let i = 0; i < base.length; i += 1) soma += Number(base[i]) * (pesoInicial - i);
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

function isValidCpf(valor) {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return false;
  if (REPETIDOS.has(cpf)) return false;

  const primeiro = digitoVerificador(cpf.slice(0, 9), 10);
  if (primeiro !== Number(cpf[9])) return false;

  const segundo = digitoVerificador(cpf.slice(0, 10), 11);
  return segundo === Number(cpf[10]);
}

// Forma canônica gravada no banco: 11 dígitos, sem pontuação. É o que torna a
// constraint de unicidade eficaz — "111.444.777-35" e "11144477735" não podem
// virar dois atletas.
function normalizeCpf(valor) {
  const cpf = somenteDigitos(valor);
  if (!isValidCpf(cpf)) throw new AppError(422, 'INVALID_CPF', 'CPF inválido');
  return cpf;
}

const formatCpf = valor => {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return '';
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
};

// Exibição para quem tem acesso operacional mas não precisa do número inteiro.
const maskCpf = valor => {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return '';
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
};

module.exports = { isValidCpf, normalizeCpf, formatCpf, maskCpf, somenteDigitos };
