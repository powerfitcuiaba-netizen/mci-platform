import { describe, it, expect, vi } from 'vitest';
import {
  digitos, mascararCpfEntrada, mascararTelefone, mascararCep,
  cpfValido, cpfResumido, telefoneValido, cepValido, nascimentoValido,
  errosDaEtapa, errosDaSolicitacao, corpoDoCadastro, corpoDaSolicitacao
} from './formulario';
import { buscarCep } from './cep';

// ==========================================================================
// As peças puras do cadastro.
//
// Elas são testadas aqui, fora da tela, porque é onde erram de verdade: uma
// máscara que perde dígito, um CPF inválido que passa, um corpo que leva CPF
// para uma rota que o recusa. A tela só as usa.
//
// A regra que atravessa o arquivo inteiro: o que SAI para a API vai
// normalizado, e o CPF não viaja junto do cadastro da conta.
// ==========================================================================

const FORM_BASE = {
  name: 'Maria Silva',
  birthDate: '1995-03-10',
  email: 'maria@mci.test',
  password: 'senha-forte-2026',
  phone: '(65) 99999-1234',
  whatsapp: '(65) 98888-4321',
  postalCode: '78000-000',
  addressLine: 'Avenida Rubens de Mendonça',
  addressNumber: '1856',
  addressComplement: '',
  state: 'mt',
  city: 'Cuiabá',
  role: 'MEDIA'
};

describe('máscaras', () => {
  it('CPF ganha pontuação conforme a pessoa digita, e para em 11 dígitos', () => {
    expect(mascararCpfEntrada('111')).toBe('111');
    expect(mascararCpfEntrada('111444')).toBe('111.444');
    expect(mascararCpfEntrada('11144477735')).toBe('111.444.777-35');
    // Dígito a mais é descartado, não empurrado para frente.
    expect(mascararCpfEntrada('111444777359999')).toBe('111.444.777-35');
  });

  it('telefone acompanha o TAMANHO: fixo e celular têm formatos diferentes', () => {
    expect(mascararTelefone('6533334444')).toBe('(65) 3333-4444');
    expect(mascararTelefone('65999991234')).toBe('(65) 99999-1234');
  });

  it('CEP ganha o hífen no lugar certo', () => {
    expect(mascararCep('78000')).toBe('78000');
    expect(mascararCep('78000000')).toBe('78000-000');
  });

  it('mascarar é reversível: os dígitos sobrevivem', () => {
    expect(digitos(mascararCpfEntrada('11144477735'))).toBe('11144477735');
    expect(digitos(mascararTelefone('65999991234'))).toBe('65999991234');
  });
});

describe('CPF', () => {
  it('aceita CPF com dígito verificador correto', () => {
    expect(cpfValido('111.444.777-35')).toBe(true);
    expect(cpfValido('11144477735')).toBe(true);
  });

  it('recusa dígito verificador errado, tamanho errado e repetição', () => {
    expect(cpfValido('111.444.777-36')).toBe(false);
    expect(cpfValido('1114447773')).toBe(false);
    // Todos iguais passam na conta dos verificadores e não são CPF de ninguém.
    for (const repetido of ['00000000000', '11111111111', '99999999999']) {
      expect(cpfValido(repetido), `aceitou ${repetido}`).toBe(false);
    }
  });

  it('o resumo esconde início e fim — reconhecível pelo dono, inútil para terceiro', () => {
    expect(cpfResumido('11144477735')).toBe('***.444.777-**');
    expect(cpfResumido('111')).toBe('');
  });
});

describe('telefone e CEP', () => {
  // O limite é o que erra: fixo tem 10 dígitos, celular 11, e qualquer outro
  // tamanho é digitação pela metade.
  it('telefone aceita 10 e 11 dígitos, e recusa os vizinhos', () => {
    expect(telefoneValido('(65) 3333-4444')).toBe(true);
    expect(telefoneValido('(65) 99999-1234')).toBe(true);
    expect(telefoneValido('653334444')).toBe(false);
    expect(telefoneValido('659999912345')).toBe(false);
  });

  it('CEP exige exatamente 8 dígitos', () => {
    expect(cepValido('78000-000')).toBe(true);
    expect(cepValido('7800000')).toBe(false);
    expect(cepValido('780000000')).toBe(false);
  });
});

describe('nascimento', () => {
  it('recusa data que não existe no calendário', () => {
    // `new Date('2000-02-30')` vira 02/03 em silêncio.
    expect(nascimentoValido('2000-02-30')).toBe(false);
    expect(nascimentoValido('2001-02-29')).toBe(false);
    expect(nascimentoValido('2000-02-29')).toBe(true);
  });

  it('recusa data futura e idade implausível', () => {
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    expect(nascimentoValido(amanha)).toBe(false);
    expect(nascimentoValido('1850-01-01')).toBe(false);
    expect(nascimentoValido('1995-03-10')).toBe(true);
  });

  it('recusa formato brasileiro — o campo é uma data ISO', () => {
    expect(nascimentoValido('10/03/1995')).toBe(false);
  });
});

describe('validação por etapa', () => {
  it('cada etapa cobra SÓ os campos dela', () => {
    // Formulário vazio: a etapa 1 reclama de nome e nascimento, e não de CEP.
    const vazio = { role: 'MEDIA' };
    expect(Object.keys(errosDaEtapa(1, vazio)).sort()).toEqual(['birthDate', 'name']);
    expect(Object.keys(errosDaEtapa(3, vazio)).sort())
      .toEqual(['addressLine', 'addressNumber', 'city', 'postalCode', 'state']);
  });

  // As etapas 4 e 5 são informativas. Cobrar campo nelas travaria o avanço de
  // quem não é atleta numa tela que não pede nada.
  it('etapas 4 e 5 não cobram campo de ninguém — nem de atleta', () => {
    for (const papel of ['MEDIA', 'SPONSOR', 'ATHLETE']) {
      expect(errosDaEtapa(4, { ...FORM_BASE, role: papel })).toEqual({});
      expect(errosDaEtapa(5, { ...FORM_BASE, role: papel })).toEqual({});
    }
  });

  // O ponto: o CADASTRO nunca pede CPF. Ele é pedido na solicitação de atleta,
  // depois de existir sessão — e é por isso que são duas validações.
  it('o cadastro não cobra CPF nem filiação em etapa nenhuma', () => {
    const vazio = { role: 'ATHLETE' };
    const cobrados = [1, 2, 3, 4, 5].flatMap(etapa => Object.keys(errosDaEtapa(etapa, vazio)));
    for (const sensivel of ['cpf', 'sex', 'affiliationId', 'affiliationNumber']) {
      expect(cobrados, `o cadastro cobrou ${sensivel}`).not.toContain(sensivel);
    }
  });

  it('etapa completa não acusa nada', () => {
    expect(errosDaEtapa(1, FORM_BASE)).toEqual({});
    expect(errosDaEtapa(2, FORM_BASE)).toEqual({});
    expect(errosDaEtapa(3, FORM_BASE)).toEqual({});
  });

  it('senha curta é barrada na etapa de contato, não no envio', () => {
    expect(errosDaEtapa(2, { ...FORM_BASE, password: 'curta' }).password).toBeTruthy();
  });
});

describe('validação da solicitação de atleta', () => {
  const PEDIDO = {
    name: 'Maria Silva', cpf: '111.444.777-35', sex: 'FEMALE',
    affiliationId: 'fil-1', affiliationNumber: 'NPC-123', birthDate: '1995-03-10'
  };

  it('pedido completo não acusa nada', () => {
    expect(errosDaSolicitacao(PEDIDO)).toEqual({});
  });

  it('cobra todos os campos obrigatórios quando o formulário está vazio', () => {
    expect(Object.keys(errosDaSolicitacao({})).sort())
      .toEqual(['affiliationId', 'affiliationNumber', 'cpf', 'name', 'sex']);
  });

  // O nome vem preenchido com o da conta, mas é editável: a ficha da federação
  // usa o nome do documento. Apagá-lo daria 400 no servidor.
  it('nome apagado é acusado aqui, e não pelo servidor', () => {
    expect(errosDaSolicitacao({ ...PEDIDO, name: '   ' }).name).toBeTruthy();
    expect(errosDaSolicitacao({ ...PEDIDO, name: 'A' }).name).toBeTruthy();
  });

  it('CPF com dígito verificador errado é recusado antes de sair da tela', () => {
    expect(errosDaSolicitacao({ ...PEDIDO, cpf: '111.444.777-36' }).cpf).toBeTruthy();
  });

  // Nascimento é opcional no servidor. Ausente não é erro; presente e inválido é.
  it('nascimento ausente passa; nascimento impossível não', () => {
    expect(errosDaSolicitacao({ ...PEDIDO, birthDate: '' })).toEqual({});
    expect(errosDaSolicitacao({ ...PEDIDO, birthDate: '2000-02-30' }).birthDate).toBeTruthy();
  });
});

describe('o que é enviado', () => {
  it('o cadastro da conta vai normalizado e SEM CPF', () => {
    const corpo = corpoDoCadastro({ ...FORM_BASE, role: 'ATHLETE', cpf: '111.444.777-35', affiliationId: 'abc' });

    expect(corpo.phone).toBe('65999991234');
    expect(corpo.whatsapp).toBe('65988884321');
    expect(corpo.postalCode).toBe('78000000');
    expect(corpo.state).toBe('MT');

    // O ponto: o servidor RECUSA cadastro que traga CPF ou filiação, porque
    // não há onde guardá-los antes de existir um atleta. Mandá-los daqui
    // transformaria todo cadastro de atleta num 400.
    expect(corpo).not.toHaveProperty('cpf');
    expect(corpo).not.toHaveProperty('affiliationId');
    expect(corpo).not.toHaveProperty('affiliationNumber');
    expect(corpo).not.toHaveProperty('sex');
  });

  it('complemento vazio não é enviado como string vazia', () => {
    expect(corpoDoCadastro({ ...FORM_BASE, addressComplement: '   ' })).not.toHaveProperty('addressComplement');
    expect(corpoDoCadastro({ ...FORM_BASE, addressComplement: 'Sala 12' }).addressComplement).toBe('Sala 12');
  });

  it('a solicitação de atleta leva o CPF normalizado, e é outro corpo', () => {
    const corpo = corpoDaSolicitacao({
      ...FORM_BASE, role: 'ATHLETE', cpf: '111.444.777-35', sex: 'FEMALE',
      affiliationId: 'fil-1', affiliationNumber: ' NPC-123 '
    });

    expect(corpo).toEqual({
      fullName: 'Maria Silva',
      cpf: '11144477735',
      sex: 'FEMALE',
      birthDate: '1995-03-10',
      affiliationId: 'fil-1',
      affiliationNumber: 'NPC-123'
    });

    // A organização NÃO é escolhida pela tela: o servidor a deriva da
    // filiação. Mandá-la daqui seria deixar o cliente escolher a federação.
    expect(corpo).not.toHaveProperty('organizationId');
  });

  // `birthDate` é opcional no schema do servidor; string vazia viraria 400.
  it('nascimento em branco não é enviado como string vazia', () => {
    const corpo = corpoDaSolicitacao({
      ...FORM_BASE, birthDate: '', cpf: '111.444.777-35', sex: 'MALE',
      affiliationId: 'fil-1', affiliationNumber: 'NPC-9'
    });
    expect(corpo).not.toHaveProperty('birthDate');
  });
});

describe('busca de CEP', () => {
  const resposta = (corpo, ok = true) => ({ ok, json: async () => corpo });

  it('preenche endereço, cidade e UF quando encontra', async () => {
    const buscador = vi.fn(async () => resposta({
      logradouro: 'Avenida Historiador Rubens de Mendonça', bairro: 'Bosque da Saúde',
      localidade: 'Cuiabá', uf: 'mt'
    }));

    const r = await buscarCep('78000-000', { buscador });

    expect(r.situacao).toBe('encontrado');
    expect(r.endereco.addressLine).toBe('Avenida Historiador Rubens de Mendonça');
    expect(r.endereco.city).toBe('Cuiabá');
    expect(r.endereco.state).toBe('MT');
    // O CEP vai só com dígitos na URL.
    expect(buscador.mock.calls[0][0]).toContain('78000000');
  });

  // O ViaCEP responde 200 com `{ erro: true }` para CEP inexistente. Tratar só
  // o status HTTP daria "encontrado" para um CEP que não existe.
  it('CEP inexistente é "não encontrado", mesmo com HTTP 200', async () => {
    const buscador = vi.fn(async () => resposta({ erro: true }));
    expect((await buscarCep('99999999', { buscador })).situacao).toBe('nao_encontrado');
  });

  it('CEP incompleto nem chega a consultar a rede', async () => {
    const buscador = vi.fn();
    expect((await buscarCep('7800', { buscador })).situacao).toBe('invalido');
    expect(buscador).not.toHaveBeenCalled();
  });

  // O ponto mais importante deste arquivo: serviço fora NÃO derruba cadastro.
  it('serviço fora, erro HTTP ou JSON quebrado viram "indisponível" — nunca exceção', async () => {
    const derrubado = vi.fn(async () => { throw new Error('rede fora'); });
    expect((await buscarCep('78000000', { buscador: derrubado })).situacao).toBe('indisponivel');

    const erroHttp = vi.fn(async () => resposta({}, false));
    expect((await buscarCep('78000000', { buscador: erroHttp })).situacao).toBe('indisponivel');

    const jsonQuebrado = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('json'); } }));
    expect((await buscarCep('78000000', { buscador: jsonQuebrado })).situacao).toBe('indisponivel');
  });

  it('rede pendurada é abandonada no tempo limite, e não trava o campo', async () => {
    const pendurado = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('abortado')));
    }));

    const r = await buscarCep('78000000', { buscador: pendurado, tempoLimite: 20 });
    expect(r.situacao).toBe('indisponivel');
  });
});
