import { describe, it, expect } from 'vitest';
import { isValidCpf, normalizeCpf, maskCpf, formatCpf } from '../src/utils/cpf.js';
import { canTransition, assertTransition, acceptsRegistration } from '../src/utils/eventStates.js';
import { can, effectivePermissions, permissionsForRole, PERMISSIONS, ROLE_PERMISSIONS } from '../src/utils/permissions.js';
import { USER_ROLES, isSelfServiceRole } from '../src/utils/roles.js';
import { parse } from '../src/utils/musclewar/adapter.js';

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

  // O julgamento é EXTERNO: não existe permissão de julgar no MCI, e o papel
  // JUDGE — que segue no enum do banco — não lança nem publica resultado.
  it('nenhuma permissão de julgamento existe na matriz', () => {
    expect(PERMISSIONS.filter(permissao => permissao.startsWith('judging.'))).toEqual([]);
  });

  it('o papel JUDGE não lança o resultado oficial nem publica', () => {
    const juiz = usuario('JUDGE');
    expect(can(juiz, 'results.receive')).toBe(false);
    expect(can(juiz, 'results.publish')).toBe(false);
    expect(can(juiz, 'results.override')).toBe(false);
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
