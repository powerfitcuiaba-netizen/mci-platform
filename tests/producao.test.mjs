import { describe, it, expect } from 'vitest';
import { config, validar, assertPronto, PLACEHOLDERS } from '../src/config/environment.js';

// A validação de produção é a última barreira antes de o processo abrir a
// porta. Falhar no deploy é melhor do que servir tráfego real com segredo de
// desenvolvimento, banco errado, CORS aberto ou disco efêmero — e uma barreira
// sem teste é uma barreira que ninguém sabe se ainda existe.

// Ambiente de produção completo e correto, usado como ponto de partida: cada
// teste estraga exatamente um item e confere que a validação reclama dele.
// Nenhum teste mexe em process.env — validar() julga o objeto que recebe, e é
// exatamente isso que precisa estar sob teste.
const producaoValida = (sobrescritas = {}) => ({
  isProduction: true,

  jwtSecret: 'a'.repeat(48),
  jwtSecretDefinido: true,

  databaseUrl: 'postgresql://usuario:senha@host:5432/mci?schema=public',
  databaseKind: 'postgresql',

  corsOrigins: ['https://musclecontest.com.br'],
  corsOriginsDefinido: true,

  bcryptRounds: 12,
  storageDriver: 's3',
  allowLocalStorage: false,

  ...sobrescritas
});

describe('validação de produção', () => {
  it('aprova um ambiente completo e correto', () => {
    expect(validar(producaoValida())).toEqual([]);
    expect(assertPronto(producaoValida())).toBe(true);
  });

  it('não valida nada fora de produção — desenvolvimento não precisa de segredo forte', () => {
    expect(validar({ isProduction: false })).toEqual([]);
  });

  it('recusa JWT ausente', () => {
    const problemas = validar(producaoValida({ jwtSecret: 'development-secret-change-me', jwtSecretDefinido: false }));
    expect(problemas.join(' ')).toMatch(/JWT_SECRET não está definido/);
  });

  it('recusa cada placeholder conhecido — a lista inteira, não uma amostra', () => {
    for (const placeholder of PLACEHOLDERS) {
      const problemas = validar(producaoValida({ jwtSecret: placeholder }));
      expect(problemas.join(' '), `placeholder aceito: ${placeholder}`).toMatch(/valor de desenvolvimento/);
    }
  });

  it('recusa JWT curto demais', () => {
    expect(validar(producaoValida({ jwtSecret: 'curto' })).join(' ')).toMatch(/32 caracteres/);
    // A fronteira exata importa: 31 reprova, 32 passa.
    expect(validar(producaoValida({ jwtSecret: 'a'.repeat(31) })).join(' ')).toMatch(/32 caracteres/);
    expect(validar(producaoValida({ jwtSecret: 'a'.repeat(32) }))).toEqual([]);
  });

  it('exige PostgreSQL: o RLS da plataforma depende dele', () => {
    const problemas = validar(producaoValida({ databaseKind: 'sqlite' }));
    expect(problemas.join(' ')).toMatch(/PostgreSQL/);
  });

  it('recusa DATABASE_URL ausente', () => {
    expect(validar(producaoValida({ databaseUrl: '' })).join(' ')).toMatch(/DATABASE_URL não está definido/);
  });

  it('recusa CORS ausente ou com curinga', () => {
    expect(validar(producaoValida({ corsOriginsDefinido: false })).join(' '))
      .toMatch(/CORS_ORIGINS não está definido/);

    expect(validar(producaoValida({ corsOrigins: ['*'] })).join(' ')).toMatch(/todas as origens/);
  });

  it('recusa custo de hash fraco', () => {
    expect(validar(producaoValida({ bcryptRounds: 4 })).join(' ')).toMatch(/BCRYPT_ROUNDS/);
    expect(validar(producaoValida({ bcryptRounds: 9 })).join(' ')).toMatch(/BCRYPT_ROUNDS/);
    expect(validar(producaoValida({ bcryptRounds: 10 }))).toEqual([]);
  });

  it('recusa disco efêmero sem assunção explícita do risco', () => {
    const problemas = validar(producaoValida({ storageDriver: 'local', allowLocalStorage: false }));

    expect(problemas.join(' ')).toMatch(/disco do contêiner/);
    expect(problemas.join(' ')).toMatch(/ALLOW_LOCAL_STORAGE/);
  });

  it('aceita disco local quando o operador assume o risco — há volume persistente', () => {
    expect(validar(producaoValida({ storageDriver: 'local', allowLocalStorage: true }))).toEqual([]);
  });

  it('relata todos os problemas de uma vez, não só o primeiro', () => {
    const problemas = validar(producaoValida({
      jwtSecret: 'development-secret-change-me',
      jwtSecretDefinido: false,
      databaseKind: 'sqlite',
      corsOrigins: ['*'],
      corsOriginsDefinido: false,
      bcryptRounds: 4,
      storageDriver: 'local',
      allowLocalStorage: false
    }));

    // O operador precisa ver tudo o que falta numa passada, não descobrir um
    // problema por deploy.
    expect(problemas.length).toBeGreaterThanOrEqual(6);
  });

  it('não quebra com um ambiente vazio: lista o que falta em vez de lançar', () => {
    // Um objeto incompleto tem de produzir diagnóstico, não TypeError. A
    // barreira precisa sobreviver até o fim da checagem para servir de algo.
    expect(() => validar({ isProduction: true })).not.toThrow();
    expect(validar({ isProduction: true }).length).toBeGreaterThanOrEqual(4);
  });

  it('assertPronto lança listando cada problema', () => {
    expect(() => assertPronto(producaoValida({ storageDriver: 'local', allowLocalStorage: false, bcryptRounds: 4 })))
      .toThrowError(/Configuração inválida para produção/);
  });

  it('o config real expõe os campos que validar() consulta', () => {
    // Sem isto o teste acima estaria validando um formato imaginário: bastaria
    // renomear um campo do config para a barreira parar de enxergar o problema
    // em produção enquanto a suíte continua verde.
    for (const campo of [
      'isProduction', 'jwtSecret', 'jwtSecretDefinido', 'databaseUrl', 'databaseKind',
      'corsOrigins', 'corsOriginsDefinido', 'bcryptRounds', 'storageDriver', 'allowLocalStorage'
    ]) {
      expect(config, `config não expõe ${campo}`).toHaveProperty(campo);
    }
  });
});
