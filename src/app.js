const express = require('express');
const apiRoutes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('MCI Campeonatos API funcionando!');
});

app.use('/api/v1', apiRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada' }
  });
});

app.use(errorHandler);

module.exports = app;