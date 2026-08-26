// Identificadores de posse dizem quem criou, treina ou opera um registro. Para
// quem está autenticado eles são úteis (a interface decide o que pode editar);
// para um visitante anônimo são apenas uma forma de correlacionar participantes
// com contas de usuário. Nas leituras abertas eles saem da resposta.
const OWNERSHIP_FIELDS = Object.freeze([
  'createdById',
  'userId',
  'coachId',
  'uploadedById',
  'checkedInById',
  'judgeId'
]);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const output = {};
    for (const [key, inner] of Object.entries(value)) {
      if (OWNERSHIP_FIELDS.includes(key)) continue;
      output[key] = strip(inner);
    }
    return output;
  }
  return value;
}

// Usar somente em rotas de leitura abertas, montadas com optionalAuth: sem ator
// a resposta é reduzida, com ator segue completa.
const forViewer = (payload, actor) => (actor ? payload : strip(payload));

module.exports = { forViewer, OWNERSHIP_FIELDS };
