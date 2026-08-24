const express = require('express');

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('MCI Campeonatos API funcionando!');
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada'
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: 'Erro interno do servidor'
  });
});

module.exports = app;