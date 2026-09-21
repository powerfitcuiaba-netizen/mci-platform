import { somenteDigitos as digitos } from './format';

// Máscaras e validações do cadastro.
//
// Elas existem para o campo ficar legível enquanto a pessoa digita — NÃO para
// decidir o que entra no sistema. Quem decide é o servidor: o mesmo CPF, o
// mesmo telefone e o mesmo CEP são revalidados lá, e a tela não tem como (nem
// deve tentar) ser autoridade sobre isso.
//
// O que sai daqui para a API vai sempre NORMALIZADO — só dígitos —, porque é
// assim que o banco guarda. A máscara é enfeite de tela e morre aqui.

// `digitos` e a máscara de CPF já existiam em `format.js` e são usadas no
// credenciamento (`adminEvent.jsx`). Reexportadas em vez de reescritas: duas
// máscaras de CPF no mesmo aplicativo divergem na primeira correção que só uma
// delas receber. Verificado que as implementações concordavam antes de unir.
export { somenteDigitos as digitos, mascararCpf as mascararCpfEntrada } from './format';

// Celular (11) e fixo (10) têm formatos diferentes; a máscara acompanha o
// tamanho em vez de assumir celular sempre.
export function mascararTelefone(valor) {
  const d = digitos(valor).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function mascararCep(valor) {
  const d = digitos(valor).slice(0, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

// Dígito verificador do CPF. É a mesma regra do servidor, repetida aqui só
// para avisar a pessoa antes de ela enviar — o servidor confere de novo.
export function cpfValido(valor) {
  const d = digitos(valor);
  if (d.length !== 11) return false;
  // Todos os dígitos iguais passam na conta dos verificadores e não são CPF.
  if (/^(\d)\1{10}$/.test(d)) return false;

  const verificador = ate => {
    let soma = 0;
    for (let i = 0; i < ate; i += 1) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return verificador(9) === Number(d[9]) && verificador(10) === Number(d[10]);
}

// Mascarado para o resumo: a pessoa reconhece o próprio documento sem ele
// aparecer inteiro na tela — e sem sobrar nada útil numa captura de tela.
export function cpfResumido(valor) {
  const d = digitos(valor);
  if (d.length !== 11) return '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

export const telefoneValido = valor => [10, 11].includes(digitos(valor).length);
export const cepValido = valor => digitos(valor).length === 8;

// Nascimento: as mesmas três recusas do servidor — data que não existe no
// calendário, data futura e idade implausível. Nenhuma idade MÍNIMA é imposta:
// o domínio não define uma, e inventá-la barraria atleta legítimo.
export function nascimentoValido(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''))) return false;

  const [ano, mes, dia] = valor.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  // `2000-02-30` vira 02/03 em silêncio; comparar de volta é o que acusa.
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return false;

  const agora = new Date();
  if (data > agora) return false;
  return ano >= agora.getUTCFullYear() - 120;
}

export const UFS = Object.freeze([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
]);

// Os sete perfis que o cadastro aberto cria. A lista reflete o que o SERVIDOR
// aceita (`PAPEIS_DE_CADASTRO_ABERTO`); esconder uma opção aqui não protegeria
// nada, a proteção é de lá.
// SÓ O CÓDIGO. O rótulo e a descrição de cada perfil vivem no dicionário, sob
// as chaves `papel.<CÓDIGO>` e `papel.<CÓDIGO>.descricao`. Manter a frase aqui
// significaria formulário em português dentro de uma tela em espanhol — e o
// código é justamente a parte que não pode mudar de idioma, porque é ele que
// vai para a API.
export const PAPEIS_ABERTOS = Object.freeze([
  'ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'MEDIA'
]);

// Campos exigidos por etapa. A validação por etapa existe para NÃO bloquear o
// avanço por causa de um campo que ainda nem foi mostrado — o erro precisa
// aparecer onde a pessoa está, não três telas adiante.
// O VALOR DE CADA ERRO É UMA CHAVE DE TRADUÇÃO, e não a frase. Quem desenha o
// erro na tela chama `t(chave)`. Devolver português daqui deixaria a mensagem
// em português numa interface em inglês — e este módulo, por não ser
// componente, não tem como saber o idioma em vigor.
export function errosDaEtapa(etapa, form) {
  const erros = {};
  const vazio = campo => !String(form[campo] ?? '').trim();

  if (etapa === 1) {
    if (vazio('name') || form.name.trim().length < 2) erros.name = 'form.erro.nome';
    if (!nascimentoValido(form.birthDate)) erros.birthDate = 'form.erro.nascimento';
  }

  if (etapa === 2) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email || '')) erros.email = 'form.erro.email';
    if ((form.password || '').length < 8) erros.password = 'form.erro.senha';
    if (!telefoneValido(form.phone)) erros.phone = 'form.erro.telefone';
    if (!telefoneValido(form.whatsapp)) erros.whatsapp = 'form.erro.whatsapp';
  }

  if (etapa === 3) {
    if (!cepValido(form.postalCode)) erros.postalCode = 'form.erro.cep';
    if (vazio('addressLine')) erros.addressLine = 'form.erro.endereco';
    if (vazio('addressNumber')) erros.addressNumber = 'form.erro.numero';
    if (!UFS.includes(String(form.state || '').toUpperCase())) erros.state = 'form.erro.uf';
    if (vazio('city')) erros.city = 'form.erro.cidade';
  }

  // As etapas 4 (PERFIL ESPORTIVO) e 5 (REVISÃO) não cobram campo nenhum: a
  // 4 explica o que vem depois e a 5 confere o que já foi preenchido. CPF e
  // filiação NÃO são pedidos aqui — ver `errosDaSolicitacao`.
  return erros;
}

// Validação da SOLICITAÇÃO de perfil de atleta, que é outro formulário, noutra
// tela, depois da conta existir.
//
// Ela está separada da validação do cadastro por um motivo concreto: a lista
// de entidades de filiação vem de `GET /affiliations`, que exige autenticação.
// Não há como escolher a federação antes de a conta existir, e carregar o CPF
// pela travessia (sessionStorage, query string) seria pôr documento em
// armazenamento de navegador para contornar isso. O CPF só é digitado quando
// já existe sessão, e vai direto para a API.
export function errosDaSolicitacao(form) {
  const erros = {};
  const vazio = campo => !String(form[campo] ?? '').trim();

  // O nome vem preenchido com o da conta, mas é editável — a ficha da
  // federação usa o nome do documento, que nem sempre é o do cadastro. Se a
  // pessoa apagar, o servidor recusa com 400; acusar aqui é mais barato.
  if (vazio('name') || form.name.trim().length < 2) erros.name = 'form.erro.nomeDocumento';
  if (!cpfValido(form.cpf)) erros.cpf = 'form.erro.cpf';
  if (!form.sex) erros.sex = 'form.erro.sexo';
  if (vazio('affiliationId')) erros.affiliationId = 'form.erro.filiacao';
  if (vazio('affiliationNumber')) erros.affiliationNumber = 'form.erro.matricula';
  if (form.birthDate && !nascimentoValido(form.birthDate)) erros.birthDate = 'form.erro.nascimento';

  return erros;
}

// O corpo do cadastro da CONTA. CPF, sexo e filiação ficam de fora: eles vão
// na solicitação de perfil de atleta, depois, e o servidor RECUSA o cadastro
// que os traga — não há onde guardá-los antes de existir um atleta.
export function corpoDoCadastro(form) {
  return {
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    password: form.password,
    role: form.role,
    birthDate: form.birthDate,
    phone: digitos(form.phone),
    whatsapp: digitos(form.whatsapp),
    postalCode: digitos(form.postalCode),
    addressLine: form.addressLine.trim(),
    addressNumber: form.addressNumber.trim(),
    ...(String(form.addressComplement || '').trim() ? { addressComplement: form.addressComplement.trim() } : {}),
    state: String(form.state).toUpperCase(),
    city: form.city.trim()
  };
}

// O corpo da solicitação. `organizationId` NÃO vai aqui: o servidor deriva a
// federação da filiação escolhida. Mandá-lo daqui deixaria o cliente escolher
// a que federação endereçar o próprio pedido.
export function corpoDaSolicitacao(form) {
  return {
    fullName: form.name.trim(),
    cpf: digitos(form.cpf),
    sex: form.sex,
    // `birthDate` é opcional no servidor: mandar string vazia viraria 400.
    ...(form.birthDate ? { birthDate: form.birthDate } : {}),
    affiliationId: form.affiliationId,
    affiliationNumber: form.affiliationNumber.trim()
  };
}
