import { describe, it, expect } from 'vitest';
import { tabulate, checksumOf, REGRA_PADRAO } from '../src/utils/tabulation.js';
import { isValidCpf, normalizeCpf, maskCpf, formatCpf } from '../src/utils/cpf.js';
import { canTransition, assertTransition, acceptsRegistration } from '../src/utils/eventStates.js';
import { can, effectivePermissions, permissionsForRole, PERMISSIONS, ROLE_PERMISSIONS } from '../src/utils/permissions.js';
import { USER_ROLES, isSelfServiceRole } from '../src/utils/roles.js';
import { parse } from '../src/utils/musclewar/adapter.js';

// Ficha completa de um juiz: uma colocação por atleta, sem repetição.
const ficha = (judgeId, ordem, isHeadJudge = false) =>
  ordem.map((registrationItemId, indice) => ({ judgeId, registrationItemId, placing: indice + 1, isHeadJudge }));

describe('CPF', () => {
  it('valida dígito verificador', () => {
    expect(isValidCpf('111.444.777-35')).toBe(true);
    expect(isValidCpf('11144477735')).toBe(true);
    expect(isValidCpf('11144477734')).toBe(false);
  });

  it('recusa sequência de dígitos repetidos, que passa no cálculo mas não é CPF', () => {
    expect(isValidCpf('00000000000')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
  });

  it('recusa comprimento diferente de 11', () => {
    expect(isValidCpf('1114447773')).toBe(false);
    expect(isValidCpf('')).toBe(false);
  });

  it('normaliza para 11 dígitos, de modo que forma pontuada e crua sejam o mesmo atleta', () => {
    expect(normalizeCpf('111.444.777-35')).toBe('11144477735');
    expect(normalizeCpf('11144477735')).toBe('11144477735');
  });

  it('lança em CPF inválido em vez de gravar lixo', () => {
    expect(() => normalizeCpf('12345678900')).toThrowError(/CPF inválido/);
  });

  it('mascara sem revelar início e fim', () => {
    expect(maskCpf('11144477735')).toBe('***.444.777-**');
    expect(formatCpf('11144477735')).toBe('111.444.777-35');
  });
});

describe('máquina de estados do evento', () => {
  it('permite apenas transições declaradas', () => {
    expect(canTransition('DRAFT', 'PLANNED')).toBe(true);
    expect(canTransition('PLANNED', 'REGISTRATIONS_OPEN')).toBe(true);
    expect(canTransition('DRAFT', 'RESULTS_PUBLISHED')).toBe(false);
    expect(canTransition('REGISTRATIONS_OPEN', 'IN_JUDGING')).toBe(false);
  });

  it('não deixa resultado publicado retroceder por transição de estado', () => {
    expect(canTransition('RESULTS_PUBLISHED', 'IN_JUDGING')).toBe(false);
    expect(canTransition('RESULTS_PUBLISHED', 'CLOSED')).toBe(true);
  });

  it('estados finais não têm saída', () => {
    expect(canTransition('CLOSED', 'PLANNED')).toBe(false);
    expect(canTransition('CANCELLED', 'PLANNED')).toBe(false);
  });

  it('recusa transição inválida com motivo', () => {
    expect(() => assertTransition('DRAFT', 'IN_JUDGING')).toThrowError(/Transição não permitida/);
    expect(() => assertTransition('DRAFT', 'DRAFT')).toThrowError(/já está/);
    expect(() => assertTransition('DRAFT', 'INEXISTENTE')).toThrowError(/Estado desconhecido/);
  });

  it('só aceita inscrição com inscrições abertas', () => {
    expect(acceptsRegistration('REGISTRATIONS_OPEN')).toBe(true);
    expect(acceptsRegistration('PLANNED')).toBe(false);
    expect(acceptsRegistration('IN_OPERATION')).toBe(false);
  });
});

describe('RBAC', () => {
  const usuario = (role, memberships = []) => ({ id: 'u1', role, memberships });

  it('todo papel do enum tem matriz declarada', () => {
    for (const role of USER_ROLES) expect(ROLE_PERMISSIONS[role], role).toBeDefined();
  });

  it('nenhuma matriz cita permissão inexistente', () => {
    const conhecidas = new Set(PERMISSIONS);
    for (const [role, lista] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permissao of lista) expect(conhecidas.has(permissao), `${role} → ${permissao}`).toBe(true);
    }
  });

  it('SUPER_ADMIN recebe toda permissão, inclusive as criadas depois da matriz', () => {
    expect(permissionsForRole('SUPER_ADMIN').size).toBe(PERMISSIONS.length);
  });

  it('juiz pontua mas não encerra, não apura e não publica', () => {
    const juiz = usuario('JUDGE');
    expect(can(juiz, 'judging.score')).toBe(true);
    expect(can(juiz, 'judging.close')).toBe(false);
    expect(can(juiz, 'results.calculate')).toBe(false);
    expect(can(juiz, 'results.publish')).toBe(false);
  });

  it('atleta não enxerga dado sensível nem audita', () => {
    const atleta = usuario('ATHLETE');
    expect(can(atleta, 'athletes.read_sensitive')).toBe(false);
    expect(can(atleta, 'search.sensitive')).toBe(false);
    expect(can(atleta, 'audit.read')).toBe(false);
    expect(can(atleta, 'results.read_unpublished')).toBe(false);
    expect(can(atleta, 'social.write')).toBe(true);
  });

  it('papel de organização só vale naquela organização', () => {
    const operador = usuario('ATHLETE', [{ organizationId: 'org-A', role: 'CHECKIN_OPERATOR' }]);
    expect(can(operador, 'checkin.operate', 'org-A')).toBe(true);
    expect(can(operador, 'checkin.operate', 'org-B')).toBe(false);
  });

  it('sem organização informada, a permissão é a união dos vínculos — a barreira de tenant é o argumento de organização', () => {
    const operador = usuario('ATHLETE', [{ organizationId: 'org-A', role: 'EVENT_DIRECTOR' }]);

    // Sem escopo, a pergunta é "este usuário é diretor em algum lugar?".
    expect(can(operador, 'events.create')).toBe(true);
    // Com escopo, a resposta passa a ser específica — e é assim que toda
    // operação sobre recurso de um tenant pergunta.
    expect(can(operador, 'events.create', 'org-A')).toBe(true);
    expect(can(operador, 'events.create', 'org-B')).toBe(false);
  });

  it('permissão desconhecida é erro de programação, não negativa silenciosa', () => {
    expect(() => can(usuario('ADMIN'), 'nao.existe')).toThrowError(/Permissão desconhecida/);
  });

  it('usuário ausente não tem permissão alguma', () => {
    expect(effectivePermissions(null).size).toBe(0);
    expect(can(null, 'events.read')).toBe(false);
  });

  it('papel privilegiado não é autoatribuível no cadastro aberto', () => {
    expect(isSelfServiceRole('ATHLETE')).toBe(true);
    expect(isSelfServiceRole('ADMIN')).toBe(false);
    expect(isSelfServiceRole('JUDGE')).toBe(false);
  });
});

describe('motor de apuração', () => {
  it('ordena pela menor soma de colocações', () => {
    const votos = [
      ...ficha('j1', ['a', 'b', 'c']),
      ...ficha('j2', ['a', 'c', 'b']),
      ...ficha('j3', ['b', 'a', 'c'])
    ];
    const { entries, hasUnresolvedTie } = tabulate(votos, REGRA_PADRAO);

    expect(hasUnresolvedTie).toBe(false);
    expect(entries.map(e => e.registrationItemId)).toEqual(['a', 'b', 'c']);
    expect(entries.map(e => e.placing)).toEqual([1, 2, 3]);
    expect(entries[0].score).toBe(4);
  });

  it('é determinístico: a ordem em que os votos chegam não muda o resultado', () => {
    const votos = [...ficha('j1', ['a', 'b', 'c']), ...ficha('j2', ['b', 'a', 'c'])];
    const invertidos = [...votos].reverse();

    const primeiro = tabulate(votos, REGRA_PADRAO);
    const segundo = tabulate(invertidos, REGRA_PADRAO);

    expect(segundo.checksum).toBe(primeiro.checksum);
    expect(segundo.entries.map(e => [e.registrationItemId, e.placing, e.status]))
      .toEqual(primeiro.entries.map(e => [e.registrationItemId, e.placing, e.status]));
  });

  it('empate sem critério configurado sai como TIE_UNRESOLVED, sem vencedor arbitrário', () => {
    const votos = [...ficha('j1', ['a', 'b']), ...ficha('j2', ['b', 'a'])];
    const { entries, hasUnresolvedTie } = tabulate(votos, REGRA_PADRAO);

    expect(hasUnresolvedTie).toBe(true);
    expect(entries.every(e => e.status === 'TIE_UNRESOLVED')).toBe(true);
    expect(entries.every(e => e.placing === null)).toBe(true);
  });

  it('não desempata por id, ordem de cadastro nem nome', () => {
    const votos = [...ficha('j1', ['zzz', 'aaa']), ...ficha('j2', ['aaa', 'zzz'])];
    const { entries } = tabulate(votos, REGRA_PADRAO);
    // Se houvesse desempate por nome ou id, 'aaa' teria recebido o 1º lugar.
    expect(entries.every(e => e.placing === null)).toBe(true);
  });

  it('desempata por colocação do juiz-chefe quando configurado', () => {
    const votos = [...ficha('j1', ['a', 'b'], true), ...ficha('j2', ['b', 'a'])];
    const { entries, hasUnresolvedTie } = tabulate(votos, { tieBreakers: ['HEAD_JUDGE_PLACING'] });

    expect(hasUnresolvedTie).toBe(false);
    expect(entries.find(e => e.registrationItemId === 'a').placing).toBe(1);
  });

  it('critério de juiz-chefe não se aplica sem chefe declarado: o empate permanece', () => {
    const votos = [...ficha('j1', ['a', 'b']), ...ficha('j2', ['b', 'a'])];
    const { hasUnresolvedTie } = tabulate(votos, { tieBreakers: ['HEAD_JUDGE_PLACING'] });
    expect(hasUnresolvedTie).toBe(true);
  });

  it('desempata por countback: mais colocações melhores vence', () => {
    // a: 1,1,3 (soma 5) — b: 2,2,1 (soma 5)
    const votos = [
      { judgeId: 'j1', registrationItemId: 'a', placing: 1 }, { judgeId: 'j1', registrationItemId: 'b', placing: 2 },
      { judgeId: 'j2', registrationItemId: 'a', placing: 1 }, { judgeId: 'j2', registrationItemId: 'b', placing: 2 },
      { judgeId: 'j3', registrationItemId: 'a', placing: 3 }, { judgeId: 'j3', registrationItemId: 'b', placing: 1 }
    ];
    const { entries, hasUnresolvedTie } = tabulate(votos, { tieBreakers: ['COUNT_BACK'] });

    expect(hasUnresolvedTie).toBe(false);
    expect(entries.find(e => e.registrationItemId === 'a').placing).toBe(1);
  });

  it('descarte só entra com painel do tamanho configurado', () => {
    const votos = [...ficha('j1', ['a', 'b']), ...ficha('j2', ['a', 'b']), ...ficha('j3', ['b', 'a'])];

    const semDescarte = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 7 });
    expect(semDescarte.entries.find(e => e.registrationItemId === 'a').dropped).toBe(false);

    const comDescarte = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 3 });
    expect(comDescarte.entries.find(e => e.registrationItemId === 'a').dropped).toBe(true);
    // Soma bruta preservada para auditoria mesmo com descarte aplicado.
    expect(comDescarte.entries.find(e => e.registrationItemId === 'a').rawScore).toBe(4);
  });

  it('guarda o countback de cada atleta para tornar a apuração reproduzível', () => {
    const votos = [...ficha('j1', ['a', 'b']), ...ficha('j2', ['a', 'b'])];
    const { entries } = tabulate(votos, REGRA_PADRAO);
    expect(entries.find(e => e.registrationItemId === 'a').countback).toEqual([2, 0]);
  });

  it('sem votos, devolve apuração vazia em vez de quebrar', () => {
    const vazio = tabulate([], REGRA_PADRAO);
    expect(vazio.entries).toEqual([]);
    expect(vazio.hasUnresolvedTie).toBe(false);
  });

  it('o checksum muda quando a regra muda, mesmo com os mesmos votos', () => {
    const votos = ficha('j1', ['a', 'b']);
    expect(checksumOf(votos, { ...REGRA_PADRAO, tieBreakers: [] }))
      .not.toBe(checksumOf(votos, { ...REGRA_PADRAO, tieBreakers: ['COUNT_BACK'] }));
  });
});

describe('adapter MuscleWar', () => {
  it('lê CSV com ponto e vírgula e cabeçalho acentuado', () => {
    const csv = 'ID;CPF;Atleta;Filiação;Categoria;Classe;Colocação;Pontos;Data\n'
      + 'MW-1;111.444.777-35;Fulana;FED-MT;BIKINI;OPEN;1;100;03/09/2026';

    const [linha] = parse('CSV', csv);
    expect(linha.externalResultId).toBe('MW-1');
    expect(linha.cpf).toBe('11144477735');
    expect(linha.affiliationCode).toBe('FED-MT');
    expect(linha.placing).toBe(1);
    expect(linha.points).toBe(100);
    // dd/mm/aaaa não pode ser lido como mês/dia.
    expect(linha.eventDate.toISOString().slice(0, 10)).toBe('2026-09-03');
  });

  it('descarta o BOM do cabeçalho, que planilha exportada do Excel quase sempre traz', () => {
    // Sem isso, a primeira coluna do cabeçalho vira "\uFEFFid" e nenhum campo
    // é reconhecido — a importação inteira sai vazia sem explicar por quê.
    const comBom = '\uFEFFexternal_result_id,cpf,colocacao\nMW-1,11144477735,1';
    const [linha] = parse('CSV', comBom);

    expect(linha.externalResultId).toBe('MW-1');
    expect(linha.cpf).toBe('11144477735');
    expect(linha.placing).toBe(1);

    // E o arquivo sem BOM continua sendo lido igual.
    expect(parse('CSV', 'external_result_id,cpf\nMW-2,11144477735')[0].externalResultId).toBe('MW-2');
  });

  it('respeita aspas e separador dentro do campo', () => {
    const csv = 'id,cpf,atleta,colocacao\n"MW-2",11144477735,"Silva, Maria",2';
    const [linha] = parse('CSV', csv);
    expect(linha.athleteName).toBe('Silva, Maria');
    expect(linha.placing).toBe(2);
  });

  it('aceita JSON em array, em results e em data', () => {
    const esperado = 'MW-9';
    for (const corpo of [[{ id: esperado }], { results: [{ id: esperado }] }, { data: [{ id: esperado }] }]) {
      expect(parse('JSON', JSON.stringify(corpo))[0].externalResultId).toBe(esperado);
    }
  });

  it('marca CPF inválido em vez de descartar a linha em silêncio', () => {
    const [linha] = parse('JSON', JSON.stringify([{ id: 'MW-3', cpf: '12345678900' }]));
    expect(linha.cpfInvalido).toBe(true);
  });

  it('aceita mapa de colunas para um contrato diferente', () => {
    const csv = 'codigo,doc,posicao\nX-1,11144477735,3';
    const [linha] = parse('CSV', csv, { fieldMap: { externalResultId: 'codigo', cpf: 'doc', placing: 'posicao' } });
    expect(linha.externalResultId).toBe('X-1');
    expect(linha.placing).toBe(3);
  });

  it('recusa origem não suportada e arquivo sem registro', () => {
    expect(() => parse('XML', '<a/>')).toThrowError(/não suportada/);
    expect(() => parse('CSV', 'id,cpf')).toThrowError(/não contém registros/);
  });
});
