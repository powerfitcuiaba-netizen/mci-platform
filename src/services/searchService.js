const prisma = require('../config/prisma');
const { can } = require('../utils/permissions');
const { somenteDigitos, isValidCpf } = require('../utils/cpf');
const { athletePublic, profilePublic } = require('../utils/visibility');
const { isCrossTenant, organizationIdsOf } = require('../utils/permissions');
const audit = require('./auditService');

// Busca global.
//
// CPF NUNCA aparece em resultado de busca — nem mascarado. O número só serve
// como termo de consulta, e apenas para quem tem `search.sensitive`; para
// todos os demais, digitar um CPF simplesmente não encontra ninguém.

const TIPOS = Object.freeze(['athletes', 'profiles', 'events', 'teams', 'gyms', 'coaches', 'brands', 'sponsors', 'communities', 'posts']);

function escopoDoAtor(actor) {
  if (!actor || isCrossTenant(actor)) return {};
  const ids = organizationIdsOf(actor);
  return { organizationId: { in: ids.length ? ids : ['__nenhuma__'] } };
}

async function search({ q, types, limit }, actor) {
  const termo = q.trim();
  const alvos = types ? types.split(',').map(item => item.trim()).filter(item => TIPOS.includes(item)) : TIPOS;
  const contem = { contains: termo, mode: 'insensitive' };

  const resultado = {};
  const escopo = escopoDoAtor(actor);

  const digitos = somenteDigitos(termo);
  const buscaPorCpf = digitos.length === 11 && isValidCpf(digitos) && can(actor, 'search.sensitive');

  if (alvos.includes('athletes')) {
    // Sem autenticação, atleta não entra na busca: é dado de pessoa física.
    if (actor) {
      const atletas = await prisma.athlete.findMany({
        where: {
          ...escopo,
          OR: buscaPorCpf ? [{ cpf: digitos }] : [{ fullName: contem }, { stageName: contem }, { athleteNumber: contem }]
        },
        include: { team: { select: { id: true, name: true } }, gym: { select: { id: true, name: true } }, coach: { select: { id: true, name: true } }, affiliation: { select: { id: true, name: true, code: true } } },
        take: limit
      });
      // athletePublic não inclui CPF em nenhuma hipótese.
      resultado.athletes = atletas.map(athletePublic);

      if (buscaPorCpf) {
        await audit.record({
          actor, action: audit.ACTIONS.ATHLETE_CPF_VIEW, entity: 'Athlete',
          entityId: atletas[0]?.id || null, metadata: { via: 'search', found: atletas.length }
        });
      }
    } else {
      resultado.athletes = [];
    }
  }

  if (alvos.includes('profiles')) {
    const perfis = await prisma.socialProfile.findMany({
      where: { OR: [{ handle: contem }, { displayName: contem }] },
      take: limit
    });
    resultado.profiles = perfis.map(profilePublic);
  }

  if (alvos.includes('events')) {
    resultado.events = await prisma.event.findMany({
      where: {
        name: contem,
        ...(actor ? escopo : {}),
        // Rascunho e cancelado ficam fora da busca de quem não opera o evento.
        ...(actor ? {} : { status: { notIn: ['DRAFT', 'CANCELLED'] } })
      },
      select: { id: true, name: true, slug: true, status: true, startDate: true, city: true, state: true },
      take: limit
    });
  }

  if (alvos.includes('teams')) {
    resultado.teams = await prisma.team.findMany({ where: { ...escopo, name: contem }, select: { id: true, name: true, city: true, state: true }, take: limit });
  }
  if (alvos.includes('gyms')) {
    resultado.gyms = await prisma.gym.findMany({ where: { ...escopo, name: contem }, select: { id: true, name: true, city: true, state: true }, take: limit });
  }
  if (alvos.includes('coaches')) {
    resultado.coaches = await prisma.coach.findMany({ where: { name: contem }, select: { id: true, name: true, city: true, state: true }, take: limit });
  }
  if (alvos.includes('brands')) {
    resultado.brands = await prisma.brand.findMany({ where: { ...escopo, name: contem, active: true }, select: { id: true, name: true, slug: true, website: true }, take: limit });
  }
  if (alvos.includes('sponsors')) {
    resultado.sponsors = await prisma.sponsor.findMany({ where: { ...escopo, name: contem, active: true }, select: { id: true, name: true }, take: limit });
  }
  if (alvos.includes('communities')) {
    resultado.communities = await prisma.community.findMany({
      where: { visibility: 'PUBLIC', OR: [{ name: contem }, { slug: contem }] },
      select: { id: true, name: true, slug: true, description: true },
      take: limit
    });
  }
  if (alvos.includes('posts')) {
    // Só publicação pública entra na busca: incluir FOLLOWERS exigiria
    // resolver seguidores por linha e abriria caminho para vazamento.
    const posts = await prisma.post.findMany({
      where: { deletedAt: null, visibility: 'PUBLIC', content: contem },
      include: { author: true },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    resultado.posts = posts.map(post => ({ id: post.id, content: post.content.slice(0, 240), createdAt: post.createdAt, author: profilePublic(post.author) }));
  }

  // O termo volta na resposta para que a interface o exiba — exceto quando é
  // um CPF: devolver o número seria reintroduzi-lo no payload, em log de
  // acesso e em histórico de navegação logo depois de tê-lo protegido.
  return { query: buscaPorCpf ? '[CPF]' : termo, results: resultado };
}

module.exports = { search, TIPOS };
