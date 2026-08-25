const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const apiRoutes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const health = require('./controllers/healthController');
const asyncHandler = require('./utils/asyncHandler');
const { rateLimit } = require('./middlewares/rateLimit');
const { config } = require('./config/environment');

const app = express();

// Atrás de proxy, o IP real vem em X-Forwarded-For. Sem isto o limitador
// contaria todo o tráfego como vindo de um único endereço.
if (config.isProduction) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet());

// O corpo cru é guardado para que a assinatura do webhook possa ser conferida
// sobre os bytes originais: reserializar o JSON mudaria o HMAC.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Origens explícitas. Em produção a lista vem do ambiente e não há curinga.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (config.corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida pelo CORS'), false);
  },
  credentials: true
}));

// Teto geral, bem acima do uso normal: serve para conter enxurrada, não para
// atrapalhar quem está usando o sistema.
app.use(rateLimit({ windowMs: 60_000, max: 600, nome: 'global' }));

app.get('/', (req, res) => {
  res.send('MCI Campeonatos API funcionando!');
});

// Sondas de infraestrutura ficam fora do prefixo versionado: quem as consulta
// é o orquestrador, não o cliente da API.
app.get('/health', asyncHandler(health.health));
app.get('/ready', asyncHandler(health.ready));

app.use('/api/v1', apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada' }
  });
});

app.use(errorHandler);

module.exports = app;
