'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class Level4JsonStorage {
  /**
   * @param {Object} options
   * @param {string} options.baseDir
   * @param {string} [options.namespace='level4']
   * @param {boolean} [options.pretty=true]
   * @param {number} [options.backupLimit=20]
   * @param {boolean} [options.enableBackups=true]
   * @param {Console|Object} [options.logger=console]
   */
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(process.cwd(), 'data', 'level4');
    this.namespace = options.namespace || 'level4';
    this.pretty = options.pretty !== false;
    this.backupLimit = Number.isInteger(options.backupLimit) ? options.backupLimit : 20;
    this.enableBackups = options.enableBackups !== false;
    this.logger = options.logger || console;

    this._writeQueues = new Map();
    this._ready = false;

    this.dataDir = path.join(this.baseDir, this.namespace);
    this.backupDir = path.join(this.dataDir, '_backups');
    this.tempDir = path.join(this.dataDir, '_tmp');
  }

  async init() {
    if (this._ready) return;

    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.backupDir, { recursive: true });
    await fsp.mkdir(this.tempDir, { recursive: true });

    this._ready = true;
  }

  async ensureReady() {
    if (!this._ready) {
      await this.init();
    }
  }

  getCollectionPath(collection) {
    return path.join(this.dataDir, `${collection}.json`);
  }

  getTempFilePath(collection) {
    const random = crypto.randomBytes(6).toString('hex');
    return path.join(this.tempDir, `${collection}.${Date.now()}.${random}.tmp`);
  }

  getBackupFilePath(collection) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.backupDir, `${collection}.${stamp}.bak.json`);
  }

  buildEnvelope(data, meta = {}) {
    return {
      version: 1,
      namespace: this.namespace,
      updatedAt: new Date().toISOString(),
      meta: {
        createdBy: 'Level4JsonStorage',
        ...meta,
      },
      data,
    };
  }

  async exists(collection) {
    await this.ensureReady();
    try {
      await fsp.access(this.getCollectionPath(collection), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async createIfMissing(collection, defaultData = {}, meta = {}) {
    await this.ensureReady();
    const exists = await this.exists(collection);
    if (exists) return false;

    const envelope = this.buildEnvelope(defaultData, {
      schema: meta.schema || collection,
      createdAt: new Date().toISOString(),
      ...meta,
    });

    await this.write(collection, envelope);
    return true;
  }

  async read(collection, fallbackEnvelope = null) {
    await this.ensureReady();
    const filePath = this.getCollectionPath(collection);

    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Collection "${collection}" is not a valid object`);
      }

      if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) {
        throw new Error(`Collection "${collection}" missing "data" field`);
      }

      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (fallbackEnvelope) return fallbackEnvelope;
        return null;
      }

      this._safeLog('error', `[Level4JsonStorage] read() failed for "${collection}": ${error.message}`);

      if (fallbackEnvelope) {
        return fallbackEnvelope;
      }

      throw error;
    }
  }

  async readData(collection, fallbackData = null, meta = {}) {
    const fallbackEnvelope = fallbackData === null
      ? null
      : this.buildEnvelope(fallbackData, meta);

    const envelope = await this.read(collection, fallbackEnvelope);
    return envelope ? envelope.data : null;
  }

  async write(collection, envelope) {
    await this.ensureReady();

    if (!envelope || typeof envelope !== 'object' || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw new Error(`write("${collection}") expects envelope object with "data" field`);
    }

    return this._enqueueWrite(collection, async () => {
      const filePath = this.getCollectionPath(collection);
      const tempPath = this.getTempFilePath(collection);

      const payload = {
        version: envelope.version || 1,
        namespace: envelope.namespace || this.namespace,
        updatedAt: new Date().toISOString(),
        meta: envelope.meta || {},
        data: envelope.data,
      };

      const content = this.pretty
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload);

      const previousExists = await this.exists(collection);

      if (previousExists && this.enableBackups) {
        await this._createBackup(collection);
      }

      await fsp.writeFile(tempPath, content, 'utf8');
      await fsp.rename(tempPath, filePath);

      return payload;
    });
  }

  async writeData(collection, data, meta = {}) {
    const envelope = this.buildEnvelope(data, meta);
    return this.write(collection, envelope);
  }

  async update(collection, updater, options = {}) {
    if (typeof updater !== 'function') {
      throw new Error(`update("${collection}") requires updater function`);
    }

    const fallbackData = Object.prototype.hasOwnProperty.call(options, 'fallbackData')
      ? options.fallbackData
      : {};

    const meta = options.meta || {};

    return this._enqueueWrite(collection, async () => {
      await this.ensureReady();

      const currentEnvelope = await this.read(
        collection,
        this.buildEnvelope(fallbackData, meta)
      );

      const currentData = currentEnvelope ? currentEnvelope.data : fallbackData;
      const nextData = await updater(this._deepClone(currentData), this._deepClone(currentEnvelope));

      if (typeof nextData === 'undefined') {
        throw new Error(`update("${collection}") updater returned undefined`);
      }

      const nextEnvelope = this.buildEnvelope(nextData, {
        ...currentEnvelope?.meta,
        ...meta,
      });

      const filePath = this.getCollectionPath(collection);
      const tempPath = this.getTempFilePath(collection);
      const previousExists = await this.exists(collection);

      if (previousExists && this.enableBackups) {
        await this._createBackup(collection);
      }

      const content = this.pretty
        ? JSON.stringify(nextEnvelope, null, 2)
        : JSON.stringify(nextEnvelope);

      await fsp.writeFile(tempPath, content, 'utf8');
      await fsp.rename(tempPath, filePath);

      return nextEnvelope;
    });
  }

  async delete(collection) {
    await this.ensureReady();
    return this._enqueueWrite(collection, async () => {
      const filePath = this.getCollectionPath(collection);
      try {
        if (this.enableBackups && await this.exists(collection)) {
          await this._createBackup(collection);
        }
        await fsp.unlink(filePath);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  async listCollections() {
    await this.ensureReady();
    const entries = await fsp.readdir(this.dataDir, { withFileTypes: true });

    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.replace(/\.json$/i, ''))
      .sort();
  }

  async getStats(collection) {
    await this.ensureReady();
    const filePath = this.getCollectionPath(collection);

    try {
      const stat = await fsp.stat(filePath);
      return {
        exists: true,
        size: stat.size,
        createdAt: stat.birthtime?.toISOString?.() || null,
        updatedAt: stat.mtime?.toISOString?.() || null,
        filePath,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          exists: false,
          size: 0,
          createdAt: null,
          updatedAt: null,
          filePath,
        };
      }
      throw error;
    }
  }

  async compactBackups() {
    await this.ensureReady();

    const entries = await fsp.readdir(this.backupDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.bak.json'))
      .map((e) => e.name);

    const grouped = new Map();

    for (const file of files) {
      const firstDot = file.indexOf('.');
      const collection = firstDot === -1 ? 'unknown' : file.slice(0, firstDot);

      if (!grouped.has(collection)) grouped.set(collection, []);
      grouped.get(collection).push(file);
    }

    for (const [collection, fileList] of grouped.entries()) {
      fileList.sort().reverse();

      const toDelete = fileList.slice(this.backupLimit);
      for (const file of toDelete) {
        const fullPath = path.join(this.backupDir, file);
        try {
          await fsp.unlink(fullPath);
        } catch (error) {
          this._safeLog('warn', `[Level4JsonStorage] failed deleting old backup "${fullPath}": ${error.message}`);
        }
      }
    }

    return true;
  }

  async healthCheck() {
    await this.ensureReady();

    const result = {
      ok: true,
      namespace: this.namespace,
      baseDir: this.baseDir,
      dataDir: this.dataDir,
      backupDir: this.backupDir,
      tempDir: this.tempDir,
      checkedAt: new Date().toISOString(),
      writable: true,
    };

    try {
      const tempProbe = path.join(this.tempDir, `healthcheck.${Date.now()}.tmp`);
      await fsp.writeFile(tempProbe, 'ok', 'utf8');
      await fsp.unlink(tempProbe);
    } catch (error) {
      result.ok = false;
      result.writable = false;
      result.error = error.message;
    }

    return result;
  }

  async _createBackup(collection) {
    const filePath = this.getCollectionPath(collection);
    const backupPath = this.getBackupFilePath(collection);

    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      await fsp.writeFile(backupPath, raw, 'utf8');
      await this.compactBackups();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this._safeLog('warn', `[Level4JsonStorage] backup failed for "${collection}": ${error.message}`);
      }
    }
  }

  _enqueueWrite(collection, fn) {
    const prev = this._writeQueues.get(collection) || Promise.resolve();

    const next = prev
      .catch(() => null)
      .then(fn)
      .finally(() => {
        if (this._writeQueues.get(collection) === next) {
          this._writeQueues.delete(collection);
        }
      });

    this._writeQueues.set(collection, next);
    return next;
  }

  _deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  _safeLog(method, message) {
    try {
      if (this.logger && typeof this.logger[method] === 'function') {
        this.logger[method](message);
      } else if (console[method]) {
        console[method](message);
      } else {
        console.log(message);
      }
    } catch {
      // no-op
    }
  }
}

module.exports = Level4JsonStorage;
