const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { AppError } = require('../../utils/errors');

// Implementação em disco local do contrato StorageProvider:
//
//   save(key, buffer|stream) -> { key, sizeBytes }
//   createReadStream(key)    -> Readable
//   exists(key)              -> boolean
//   remove(key)              -> boolean
//   stat(key)                -> { sizeBytes, modifiedAt } | null
//   healthCheck()            -> boolean
//
// Um provedor de nuvem implementa a mesma superfície e é registrado no
// storageService; nada acima dele muda.

class LocalStorageProvider {
  constructor({ root }) {
    this.name = 'local';
    this.root = path.resolve(root);
  }

  // Mesmo com chave gerada internamente, o caminho final é resolvido e
  // conferido contra a raiz. É a última barreira contra travessia de diretório.
  resolveKey(key) {
    const candidato = path.resolve(this.root, String(key || ''));
    const raiz = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (candidato !== this.root && !candidato.startsWith(raiz)) {
      throw new AppError(400, 'INVALID_STORAGE_KEY', 'Caminho de armazenamento inválido');
    }
    return candidato;
  }

  async #garantirDiretorio(destino) {
    await fsp.mkdir(path.dirname(destino), { recursive: true });
  }

  async saveBuffer(key, buffer) {
    const destino = this.resolveKey(key);
    await this.#garantirDiretorio(destino);
    await fsp.writeFile(destino, buffer);
    return { key, sizeBytes: buffer.length };
  }

  async saveStream(key, readable) {
    const destino = this.resolveKey(key);
    await this.#garantirDiretorio(destino);

    return new Promise((resolve, reject) => {
      let bytes = 0;
      const escrita = fs.createWriteStream(destino);
      readable.on('data', pedaco => { bytes += pedaco.length; });
      readable.on('error', reject);
      escrita.on('error', reject);
      escrita.on('finish', () => resolve({ key, sizeBytes: bytes }));
      readable.pipe(escrita);
    });
  }

  createReadStream(key) {
    return fs.createReadStream(this.resolveKey(key));
  }

  async exists(key) {
    try {
      await fsp.access(this.resolveKey(key));
      return true;
    } catch (error) {
      return false;
    }
  }

  async remove(key) {
    if (!key) return false;
    try {
      await fsp.unlink(this.resolveKey(key));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async stat(key) {
    try {
      const info = await fsp.stat(this.resolveKey(key));
      return { sizeBytes: info.size, modifiedAt: info.mtime };
    } catch (error) {
      return null;
    }
  }

  // Pronto significa: a raiz existe e aceita escrita.
  async healthCheck() {
    try {
      await fsp.mkdir(this.root, { recursive: true });
      await fsp.access(this.root, fs.constants.W_OK);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { LocalStorageProvider };
