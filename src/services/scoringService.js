const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertPermission } = require('../utils/tenant');

// Conjuntos de regra de apuração. São configuração do organizador: método,
// descarte e ordem dos desempates. O sistema não decide nenhum deles sozinho.

async function create(data, actor) {
  assertPermission(actor, 'results.calculate');

  try {
    return await prisma.scoringRuleSet.create({
      data: {
        name: data.name,
        method: data.method || 'RELATIVE_PLACEMENT_SUM',
        dropHighLow: data.dropHighLow ?? false,
        dropHighLowMinJudges: data.dropHighLowMinJudges ?? 7,
        tieBreakers: data.tieBreakers || []
      }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'RULESET_NAME_IN_USE', 'Já existe conjunto de regras com este nome');
    throw error;
  }
}

async function list() {
  return prisma.scoringRuleSet.findMany({ orderBy: { name: 'asc' } });
}

module.exports = { create, list };
