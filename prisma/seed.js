/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Catálogo oficial de categorias do Campeonato Brasileiro Muscle Contest.
// WOMEN'S BODYBUILDING e FITMODEL são obrigatórias e não podem ser removidas.
// A lista é dado, não código: novas categorias entram por nova linha aqui ou
// pela rota POST /categories, sem alteração de lógica.
const CATEGORIAS = [
  { code: 'MENS_BODYBUILDING', name: "Men's Bodybuilding", sex: 'MALE', sortOrder: 10 },
  { code: 'MENS_PHYSIQUE', name: "Men's Physique", sex: 'MALE', sortOrder: 20 },
  { code: 'CLASSIC_PHYSIQUE', name: 'Classic Physique', sex: 'MALE', sortOrder: 30 },
  { code: 'BODYBUILDING_212', name: '212 Bodybuilding', sex: 'MALE', sortOrder: 40 },
  { code: 'WOMENS_BODYBUILDING', name: "Women's Bodybuilding", sex: 'FEMALE', sortOrder: 50 },
  { code: 'WOMENS_PHYSIQUE', name: "Women's Physique", sex: 'FEMALE', sortOrder: 60 },
  { code: 'WELLNESS', name: 'Wellness', sex: 'FEMALE', sortOrder: 70 },
  { code: 'BIKINI', name: 'Bikini', sex: 'FEMALE', sortOrder: 80 },
  { code: 'FITNESS', name: 'Fitness', sex: 'FEMALE', sortOrder: 90 },
  { code: 'FIGURE', name: 'Figure', sex: 'FEMALE', sortOrder: 100 },
  { code: 'FITMODEL', name: 'Fitmodel', sex: 'FEMALE', sortOrder: 110 }
];

// Classes iniciais. A estrutura é extensível: cada evento cria as suas
// divisões e classes, e estas são apenas os códigos de referência.
const CLASSES_INICIAIS = ['JUNIOR', 'NOVICE', 'OPEN', 'MASTER'];

// Comunidades iniciais da MCI Social.
const COMUNIDADES = [
  { slug: 'campeonato-brasileiro', name: 'Campeonato Brasileiro', description: 'Comunidade oficial do Campeonato Brasileiro Muscle Contest.' },
  { slug: 'bodybuilding', name: 'Bodybuilding', description: 'Bodybuilding masculino e feminino.' },
  { slug: 'wellness', name: 'Categoria Wellness', description: 'Tudo sobre Wellness.' },
  { slug: 'bikini', name: 'Bikini', description: 'Comunidade da categoria Bikini.' },
  { slug: 'fitmodel', name: 'FitModel', description: 'Comunidade da categoria FitModel.' },
  { slug: 'atletas-pro', name: 'Atletas PRO', description: 'Espaço dos atletas PRO da plataforma.' },
  { slug: 'coaches', name: 'Coaches', description: 'Preparadores e técnicos.' },
  { slug: 'academias', name: 'Academias', description: 'Academias parceiras.' }
];

// Critérios de avaliação por categoria. São descritivos e servem à ficha do
// juiz; a apuração oficial usa colocação, não a soma destes valores.
const CRITERIOS = {
  MENS_BODYBUILDING: ['Massa muscular', 'Definição', 'Simetria', 'Apresentação'],
  CLASSIC_PHYSIQUE: ['Proporção clássica', 'Definição', 'Simetria', 'Apresentação'],
  MENS_PHYSIQUE: ['Formato em V', 'Condição', 'Apresentação'],
  BODYBUILDING_212: ['Massa muscular', 'Definição', 'Simetria', 'Apresentação'],
  WOMENS_BODYBUILDING: ['Massa muscular', 'Definição', 'Simetria', 'Apresentação'],
  WOMENS_PHYSIQUE: ['Tônus', 'Definição', 'Simetria', 'Apresentação'],
  WELLNESS: ['Proporção inferior', 'Condição', 'Apresentação'],
  BIKINI: ['Equilíbrio', 'Condição', 'Apresentação'],
  FITNESS: ['Rotina', 'Condição', 'Apresentação'],
  FIGURE: ['Simetria', 'Condição', 'Apresentação'],
  FITMODEL: ['Silhueta', 'Condição', 'Apresentação']
};

async function seedCategorias() {
  for (const categoria of CATEGORIAS) {
    await prisma.category.upsert({ where: { code: categoria.code }, create: categoria, update: { name: categoria.name, sex: categoria.sex, sortOrder: categoria.sortOrder, active: true } });
  }

  for (const [code, criterios] of Object.entries(CRITERIOS)) {
    const categoria = await prisma.category.findUnique({ where: { code } });
    if (!categoria) continue;

    for (const [indice, nome] of criterios.entries()) {
      const criterionCode = nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, '_');
      await prisma.scoreCriterion.upsert({
        where: { categoryId_code: { categoryId: categoria.id, code: criterionCode } },
        create: { categoryId: categoria.id, code: criterionCode, name: nome, sortOrder: indice * 10 },
        update: { name: nome, sortOrder: indice * 10 }
      });
    }
  }
}

async function seedRegraDeApuracao() {
  // Regra padrão conservadora: soma de colocações, sem descarte e com
  // desempate por countback. Nenhuma regra esportiva é presumida além do que
  // está declarado aqui — o organizador escolhe outra se o regulamento pedir.
  await prisma.scoringRuleSet.upsert({
    where: { name: 'Padrão MCI' },
    create: { name: 'Padrão MCI', method: 'RELATIVE_PLACEMENT_SUM', dropHighLow: false, tieBreakers: ['COUNT_BACK'] },
    update: {}
  });
}

async function seedComunidades() {
  for (const comunidade of COMUNIDADES) {
    await prisma.community.upsert({ where: { slug: comunidade.slug }, create: comunidade, update: { name: comunidade.name, description: comunidade.description } });
  }
}

async function main() {
  await seedCategorias();
  await seedRegraDeApuracao();
  await seedComunidades();

  const categorias = await prisma.category.count();
  const criterios = await prisma.scoreCriterion.count();
  const comunidades = await prisma.community.count();

  console.log(JSON.stringify({ categorias, criterios, comunidades, classesIniciais: CLASSES_INICIAIS }));
}

main()
  .catch(erro => { console.error(erro); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

module.exports = { CATEGORIAS, CLASSES_INICIAIS, COMUNIDADES, CRITERIOS };
