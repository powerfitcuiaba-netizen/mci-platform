import '@testing-library/jest-dom/vitest';

// O jsdom não implementa `scrollIntoView`. Não é lacuna do produto — é lacuna
// do ambiente de teste —, e sem o esboço qualquer tela que role até o fim
// (a conversa, por exemplo) quebra antes de chegar ao que está sendo testado.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
