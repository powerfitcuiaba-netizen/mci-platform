const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const apiRoutes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const asyncHandler = require('./utils/asyncHandler');
const controllers = require('./controllers');
const { rateLimit } = require('./middlewares/rateLimit');
const { config } = require('./config/environment');

const app = express();

// Atrás de proxy, o endereço real vem em X-Forwarded-For — mas SÓ os saltos
// que a gente confia. `trustProxyHops` tem de ser o número real de proxies na
// frente deste processo: o Express descarta essa quantidade a partir da
// direita e usa o próximo endereço.
//
// Se o número for maior que a realidade, sobra cabeçalho escrito pelo cliente
// dentro da faixa confiável, e ele passa a escolher o próprio endereço — que é
// como o limitador de login foi contornado no ensaio do gate final, 60 de 60
// tentativas aceitas. Com a aplicação exposta direto, use 0.
if (config.isProduction && config.trustProxyHops > 0) {
  app.set('trust proxy', config.trustProxyHops);
}

app.disable('x-powered-by');
app.use(helmet());

// A importação MuscleWar envia o arquivo inteiro no corpo; o teto acomoda um
// lote grande sem abrir espaço para envio arbitrário.
app.use(express.json({ limit: '8mb' }));

// Origens explícitas. Em produção a lista vem do ambiente e não há curinga.
//
// Origem não listada NÃO vira erro: a resposta sai sem os cabeçalhos de CORS,
// e é o navegador que barra a leitura — que é como o mecanismo funciona.
// Devolver um `Error` no callback, como estava aqui, transformava cada
// requisição com Origin desconhecido num 500 INTERNAL_ERROR e numa linha de
// log em nível `error`. Duas consequências ruins: o monitoramento passava a
// acusar falha de servidor onde não há falha nenhuma, e qualquer um na
// internet podia inundar o log de erro só mandando um cabeçalho Origin —
// afogando erro de verdade no meio do ruído.
//
// Isto NÃO é uma barreira de autorização: CORS protege o navegador da vítima,
// não o servidor. Quem impede acesso indevido é autenticação, RBAC e RLS.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, config.corsOrigins.includes(origin));
  },
  credentials: true
}));

// Teto geral, bem acima do uso normal: serve para conter enxurrada, não para
// atrapalhar quem está usando o sistema.
app.use(rateLimit({ windowMs: 60_000, max: 600, nome: 'global' }));

app.get('/', (req, res) => {
  res.json({ name: 'MCI Platform', description: 'Campeonato Brasileiro Muscle Contest', api: '/api/v1' });
});

// Sondas de infraestrutura ficam fora do prefixo versionado: quem as consulta
// é o orquestrador, não o cliente da API.
app.get('/health', asyncHandler(controllers.health.health));
app.get('/ready', asyncHandler(controllers.health.ready));

app.use('/api/v1', apiRoutes);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada' } });
});

app.use(errorHandler);

module.exports = app;
