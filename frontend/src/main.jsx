import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// A fonte da marca é carregada por JavaScript, e não por `@import` no CSS,
// porque o `@import` bloqueia a primeira pintura: enquanto o Google Fonts não
// responde, a tela fica branca. Medido neste ambiente sem rede: 12.988ms de
// FCP com o import, 120ms sem ele. Em ginásio com rede ruim isso é a diferença
// entre o sistema abrir e o operador achar que travou.
// A pilha de reserva do CSS já garante a leitura; a fonte da marca entra
// depois, quando (e se) chegar.
function carregarFonteDaMarca() {
  const elo = document.createElement('link');
  elo.rel = 'stylesheet';
  elo.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700;800&display=swap';
  elo.crossOrigin = 'anonymous';
  document.head.appendChild(elo);
}

carregarFonteDaMarca();

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);