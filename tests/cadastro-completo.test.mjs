import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, unico, gerarCpf } from './helpers.mjs';

// ==========================================================================
// CADASTRO COMPLETO.
//
// O cadastro pedia nome, email e senha. Passou a pedir contato, endereço e
// nascimento — e, SÓ para atleta, CPF e filiação.
//
// As três coisas que este arquivo trava, porque são as que erram calado:
//
//   1. CPF NÃO vai para `User`. A decisão de mantê-lo isolado em
//      `AthleteIdentity`, sob RLS, foi tomada antes; um formulário novo não
//      pode desfazê-la de lado.
//   2. Telefone, CEP e UF são NORMALIZADOS na entrada. Guardar
//      "(65) 99999-1234" e "65999991234" como coisas diferentes quebra
//      qualquer comparação futura.
//   3. Dado pessoal não entra na resposta que descreve OUTROS usuários.
//      `sanitizeUser` é usada pelo admin para listar contas: um campo novo
//      adicionado ali sem pensar vaza endereço de todo mundo.
// ==========================================================================

const COMPLETO = {
  password: 'senha-forte-2026',
  birthDate: '1995-03-10',
  phone: '(65) 99999-1234',
  whatsapp: '65 98888-4321',
  postalCode: '78000-000',
  addressLine: 'Avenida Historiador Rubens de Mendonça',
  addressNumber: '1856',
  addressComplement: 'Sala 12',
  state: 'mt',
  city: 'Cuiabá'
};

const cadastrar = corpo => api().post('/api/v1/auth/register').send(corpo);

beforeAll(() => garantirCatalogo());
beforeEach(() => limparBanco());

describe('cadastro completo: campos de contato e endereço', () => {
  it('grava contato e endereço, normalizando telefone, CEP e UF', async () => {
    const email = `${unico('maria')}@mci.test`;
    const resposta = await cadastrar({ ...COMPLETO, name: 'Maria Silva', email });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const gravado = await prisma.user.findUnique({ where: { email } });

    // Só dígitos: a máscara é da tela, o banco guarda o que dá para comparar.
    expect(gravado.phone).toBe('65999991234');
    expect(gravado.whatsapp).toBe('65988884321');
    expect(gravado.postalCode).toBe('78000000');
    // UF sempre em maiúsculas, venha como vier.
    expect(gravado.state).toBe('MT');
    expect(gravado.city).toBe('Cuiabá');
    expect(gravado.addressLine).toBe('Avenida Historiador Rubens de Mendonça');
    expect(gravado.addressNumber).toBe('1856');
    expect(gravado.addressComplement).toBe('Sala 12');

    // Meio-dia UTC: à meia-noite a data já virou no Brasil e o nascimento
    // apareceria um dia antes na tela.
    expect(gravado.birthDate.toISOString()).toBe('1995-03-10T12:00:00.000Z');
  });

  it('complemento é o único campo de endereço opcional', async () => {
    const email = `${unico('sem-complemento')}@mci.test`;
    const { addressComplement: _ignorado, ...semComplemento } = COMPLETO;

    const resposta = await cadastrar({ ...semComplemento, name: 'Sem Complemento', email });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect((await prisma.user.findUnique({ where: { email } })).addressComplement).toBeNull();
  });

  it('recusa cadastro sem os campos obrigatórios, apontando cada um', async () => {
    const resposta = await cadastrar({ name: 'Incompleta', email: `${unico('inc')}@mci.test`, password: 'senha-forte-2026' });

    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('VALIDATION_ERROR');

    const campos = resposta.body.error.details.map(d => d.path.join('.'));
    for (const obrigatorio of ['birthDate', 'phone', 'whatsapp', 'postalCode', 'addressLine', 'addressNumber', 'state', 'city']) {
      expect(campos, `${obrigatorio} deveria ser cobrado`).toContain(obrigatorio);
    }
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('cadastro completo: validação de formato', () => {
  const cadastrarCom = (campo, valor) =>
    cadastrar({ ...COMPLETO, [campo]: valor, name: 'Formato', email: `${unico('fmt')}@mci.test` });

  it('telefone precisa de DDD e 8 ou 9 dígitos', async () => {
    for (const ruim of ['999', '6599', '1234567890123', 'abcdefghij']) {
      const r = await cadastrarCom('phone', ruim);
      expect(r.status, `aceitou telefone ${ruim}`).toBe(400);
    }
    // Fixo (10) e celular (11) passam.
    expect((await cadastrarCom('phone', '6533334444')).status).toBe(201);
    expect((await cadastrarCom('phone', '65933334444')).status).toBe(201);
  });

  it('CEP precisa de 8 dígitos', async () => {
    for (const ruim of ['7800', '780000000', 'CEP-AQUI']) {
      expect((await cadastrarCom('postalCode', ruim)).status, `aceitou CEP ${ruim}`).toBe(400);
    }
  });

  it('UF precisa de duas letras', async () => {
    for (const ruim of ['M', 'MTO', '12']) {
      expect((await cadastrarCom('state', ruim)).status, `aceitou UF ${ruim}`).toBe(400);
    }
  });

  it('nascimento: recusa data futura, inexistente e implausível', async () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    expect((await cadastrarCom('birthDate', amanha)).status, 'aceitou nascimento no futuro').toBe(400);
    // 30 de fevereiro não existe; `Date.parse` a converte em 02/03 calado.
    expect((await cadastrarCom('birthDate', '2000-02-30')).status, 'aceitou 30 de fevereiro').toBe(400);
    expect((await cadastrarCom('birthDate', '1850-01-01')).status, 'aceitou 175 anos').toBe(400);
    expect((await cadastrarCom('birthDate', '10/03/1995')).status, 'aceitou formato brasileiro').toBe(400);

    // Ano bissexto real passa.
    expect((await cadastrarCom('birthDate', '2000-02-29')).status).toBe(201);
  });
});

describe('cadastro completo: o que é DE ATLETA não entra aqui', () => {
  // Esta é a consequência honesta de duas decisões que já existiam:
  //
  //   - o CPF mora em `AthleteIdentity`, cuja chave primária é o `athleteId`;
  //   - a política `atleta_criacao` exige `mci_operator_of(organizationId)`.
  //
  // Juntas, elas significam que o autocadastro NÃO tem onde gravar CPF nem
  // filiação: sem linha de `Athlete`, não há `AthleteIdentity`, e quem acabou
  // de criar a conta não é operador de federação nenhuma para criar essa
  // linha. Atleta é criado por operador, por CPF, no fluxo de inscrição.
  //
  // Aceitar e descartar em silêncio seria o pior desfecho: o atleta digitaria
  // o CPF achando que ficou guardado. A recusa é explícita e diz para onde ir.
  it('CPF é recusado no cadastro, com a mensagem dizendo onde ele é registrado', async () => {
    const resposta = await cadastrar({
      ...COMPLETO, name: 'Atleta Nova', email: `${unico('atl')}@mci.test`, cpf: gerarCpf(123456789)
    });

    expect(resposta.status).toBe(400);
    const detalhe = resposta.body.error.details.find(d => d.path.includes('cpf'));
    expect(detalhe, 'o CPF passou sem reclamação').toBeTruthy();
    expect(detalhe.message).toMatch(/perfil de atleta/i);
  });

  it('filiação, número de registro e sexo também são recusados', async () => {
    for (const [campo, valor] of [['affiliationId', 'abc'], ['affiliationNumber', '123'], ['sex', 'FEMALE']]) {
      const r = await cadastrar({ ...COMPLETO, name: 'Atleta', email: `${unico('a')}@mci.test`, [campo]: valor });
      expect(r.status, `aceitou ${campo} no cadastro`).toBe(400);
      expect(r.body.error.details.some(d => d.path.includes(campo))).toBe(true);
    }
  });

  it('o cadastro padrão continua nascendo ATHLETE, sem exigir dado de competição', async () => {
    const resposta = await cadastrar({ ...COMPLETO, name: 'Atleta Padrão', email: `${unico('pad')}@mci.test` });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.user.role).toBe('ATHLETE');

    // A conta existe; o PERFIL de atleta não — ele nasce no fluxo operado.
    expect(await prisma.athlete.count()).toBe(0);
    expect(await prisma.athleteIdentity.count()).toBe(0);
  });
});

describe('cadastro completo: o CPF não migra para User', () => {
  // A coluna não existe, e não pode passar a existir por descuido. Se alguém
  // acrescentar `cpf` a `User` numa migration futura, este teste cai — que é
  // exatamente o momento de reabrir a decisão, em vez de descobrir depois.
  it('a tabela User NÃO tem coluna de CPF', async () => {
    const colunas = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'User'
    `;
    const nomes = colunas.map(c => c.column_name.toLowerCase());
    expect(nomes, 'CPF apareceu em User: a decisão de isolá-lo foi desfeita').not.toContain('cpf');
  });

  it('nenhum dado pessoal novo entra na resposta que descreve outros usuários', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
    const email = `${unico('alvo')}@mci.test`;
    expect((await cadastrar({ ...COMPLETO, name: 'Pessoa Alvo', email })).status).toBe(201);

    // `sanitizeUser` é usada tanto para o próprio usuário quanto pela
    // listagem administrativa. Endereço e telefone de terceiros não podem
    // sair por aí.
    const lista = await api().get('/api/v1/admin/users?limit=50').set(admin.auth());
    expect(lista.status).toBe(200);

    const texto = JSON.stringify(lista.body);
    expect(texto, 'telefone vazou na listagem de usuários').not.toContain('65999991234');
    expect(texto, 'endereço vazou na listagem de usuários').not.toContain('Rubens de Mendonça');
    expect(texto, 'CEP vazou na listagem de usuários').not.toContain('78000000');
  });
});

describe('cadastro completo: o que continua valendo', () => {
  it('email repetido continua sendo 409', async () => {
    const email = `${unico('rep')}@mci.test`;
    expect((await cadastrar({ ...COMPLETO, name: 'Primeira', email })).status).toBe(201);

    const segunda = await cadastrar({ ...COMPLETO, name: 'Segunda', email });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('papel privilegiado continua não sendo autoatribuível', async () => {
    for (const papel of ['SUPER_ADMIN', 'ADMIN', 'EVENT_DIRECTOR', 'JUDGE']) {
      const r = await cadastrar({ ...COMPLETO, role: papel, name: 'Tentativa', email: `${unico('esc')}@mci.test` });
      expect([400, 403], `${papel} foi aceito no cadastro aberto`).toContain(r.status);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  // As colunas novas são anuláveis justamente por isto: em produção existe
  // conta criada antes delas. A linha é escrita DIRETO no banco porque é
  // assim que ela está lá — sem passar pelo cadastro novo, que exigiria os
  // campos que ela nunca teve.
  it('as contas criadas ANTES destes campos continuam entrando e operando', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const email = `${unico('antiga')}@mci.test`;

    const antiga = await prisma.user.create({
      data: {
        name: 'Conta Antiga', email,
        passwordHash: await bcrypt.hash('senha-de-teste-123', 4),
        role: 'ATHLETE', status: 'ACTIVE'
      }
    });

    expect(antiga.phone, 'coluna nova deveria nascer nula').toBeNull();
    expect(antiga.postalCode).toBeNull();
    expect(antiga.birthDate).toBeNull();

    // E a conta continua funcionando: login e sessão não olham para os campos
    // novos.
    const entrada = await api().post('/api/v1/auth/login').send({ email, password: 'senha-de-teste-123' });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);
    expect(entrada.body.token).toBeTruthy();

    const eu = await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${entrada.body.token}` });
    expect(eu.status).toBe(200);
  });
});
