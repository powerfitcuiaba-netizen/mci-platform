import { describe, it, expect } from 'vitest';
import { conferirFoto, TIPOS_DE_FOTO, MAX_FOTO_BYTES } from './foto';

// O aviso antecipado da foto. Ele não protege nada — quem protege é o
// servidor, que olha os bytes. O que se testa aqui é a mensagem chegar antes
// de a pessoa esperar um envio fadado a falhar.

const falso = (tipo, tamanho) => ({ type: tipo, size: tamanho, name: 'f' });

describe('conferência da foto antes do envio', () => {
  it('aceita os três formatos que o servidor aceita — e só eles', () => {
    for (const tipo of TIPOS_DE_FOTO) {
      expect(conferirFoto(falso(tipo, 1000)).erro, `recusou ${tipo}`).toBeUndefined();
    }
    for (const tipo of ['image/svg+xml', 'application/pdf', 'text/html', 'image/gif']) {
      expect(conferirFoto(falso(tipo, 1000)).erro, `aceitou ${tipo}`).toBeTruthy();
    }
  });

  it('recusa acima do limite, e diz os dois tamanhos', () => {
    const r = conferirFoto(falso('image/png', MAX_FOTO_BYTES + 1));
    expect(r.erro).toContain('5,0 MB');
    expect(conferirFoto(falso('image/png', MAX_FOTO_BYTES)).erro).toBeUndefined();
  });

  it('recusa arquivo vazio e ausência de arquivo', () => {
    expect(conferirFoto(falso('image/png', 0)).erro).toBeTruthy();
    expect(conferirFoto(null).erro).toBeTruthy();
  });
});
