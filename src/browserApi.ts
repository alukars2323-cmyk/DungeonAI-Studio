import { z } from 'zod';
import type { Asset, Capabilities, GenerationInput, MapDocument, ProjectSummary } from '../shared/types';
import { referencedAssetIds } from '../shared/assets';
import { generateLocalMap } from '../shared/localGenerator';
import { GenerationError } from '../shared/generationError';
import { generationInputSchema, identifierSchema, mapDocumentSchema } from '../shared/validation';
import { IMPORT_LIMITS, IMPORT_LIMIT_TEXT, MiB } from '../shared/importLimits';
import { ApiError } from './apiError';
import { crc32, validatePng, type PreparedBrowserAsset } from './pngValidation';

const DB_NAME = 'dungeonai-studio:browser:v1';
type StoredAsset = Omit<Asset, 'url'> & { blob: Blob };
type StagedAsset = StoredAsset & { batchId: string; stagedAt: number };
const imageUrls = new Map<string, string>();
let connection: Promise<IDBDatabase> | undefined;

function storageError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') return new ApiError('В браузере недостаточно места. Экспортируйте проекты в JSON и освободите место, затем повторите сохранение.', 507);
  if (name === 'SecurityError' || name === 'InvalidStateError') {
    return new ApiError('Браузер запретил локальное хранилище. Разрешите хранение данных для этого сайта и откройте его в обычной вкладке.', 503);
  }
  return new ApiError('Не удалось выполнить операцию с хранилищем браузера. Повторите попытку; перед очисткой данных сайта экспортируйте проекты в JSON.', 500);
}

function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new ApiError('Хранилище IndexedDB недоступно в этом браузере.', 503)); return; }
    let settled = false;
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, 2); }
    catch (error) { reject(storageError(error)); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('importStaging')) {
        const staging = db.createObjectStore('importStaging', { keyPath: 'id' });
        staging.createIndex('batchId', 'batchId');
        staging.createIndex('stagedAt', 'stagedAt');
      }
    };
    request.onblocked = () => {
      settled = true;
      reject(new ApiError('Хранилище заблокировано другой вкладкой. Закройте другие вкладки DungeonAI Studio и повторите.', 503));
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => { db.close(); connection = undefined; };
      settled = true;
      resolve(db);
    };
  }).then(async db => {
    // A interrupted import stays invisible. Remove only old records, never another tab's active batch.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('importStaging', 'readwrite');
      const old = tx.objectStore('importStaging').index('stagedAt').openKeyCursor(IDBKeyRange.upperBound(Date.now() - 24 * 60 * 60 * 1000));
      old.onsuccess = () => {
        const cursor = old.result;
        if (!cursor) return;
        tx.objectStore('importStaging').delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => { db.close(); reject(storageError(tx.error)); };
    });
    return db;
  }).catch(error => { connection = undefined; throw error; });
  return connection!;
}

interface TransactionContext<T> {
  tx: IDBTransaction;
  set(value: T): void;
  request<V>(request: IDBRequest<V>, next: (value: V) => void): void;
}

/** Cross-store read/write transactions also serialize saves and asset deletion across tabs. */
async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (context: TransactionContext<T>) => void): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); }
    catch (error) { reject(storageError(error)); return; }
    let value: T;
    let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try { tx.abort(); } catch { reject(storageError(error)); }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(storageError(failure ?? tx.error));
    tx.onerror = () => { if (!failure) failure = tx.error; };
    const context: TransactionContext<T> = {
      tx,
      set: result => { value = result; },
      request(request, next) {
        request.onsuccess = () => { try { next(request.result); } catch (error) { abort(error); } };
        request.onerror = () => { failure = request.error; };
      },
    };
    try { run(context); } catch (error) { abort(error); }
  });
}

function publicAsset(stored: StoredAsset): Asset {
  const { blob, ...metadata } = stored;
  let url = imageUrls.get(stored.id);
  if (!url) { url = URL.createObjectURL(blob); imageUrls.set(stored.id, url); }
  return { ...metadata, url };
}

async function assets(): Promise<Asset[]> {
  const stored = await transaction<StoredAsset[]>(['assets'], 'readonly', context => {
    context.request(context.tx.objectStore('assets').getAll(), context.set);
  });
  return stored.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(publicAsset);
}

const assetChangesSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(['objects', 'floors', 'walls']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
}).strict().refine(changes => Object.keys(changes).length > 0, 'Укажите изменение ассета.');

interface ZipEntry {
  name: string;
  png: boolean;
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  dataOffset: number;
  directory: boolean;
}

class BlobReader {
  private start = -1;
  private buffer = new Uint8Array(0);
  constructor(private readonly blob: Blob) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.blob.size) {
      throw new ApiError('ZIP повреждён: неверные границы записи.', 400);
    }
    if (offset < this.start || offset + length > this.start + this.buffer.length) {
      this.start = offset;
      this.buffer = new Uint8Array(await this.blob.slice(offset, Math.min(this.blob.size, offset + Math.max(length, 256 * 1024))).arrayBuffer());
    }
    return this.buffer.subarray(offset - this.start, offset - this.start + length);
  }
}

function dataView(data: Uint8Array) { return new DataView(data.buffer, data.byteOffset, data.byteLength); }

/** Inspect ZIP headers using small Blob slices, including for archives larger than memory. */
async function zipEntries(file: Blob): Promise<ZipEntry[]> {
  const corrupt = () => new ApiError('ZIP повреждён или имеет неподдерживаемую структуру.', 400);
  const zip64 = () => new ApiError('ZIP64 пока не поддерживается. Используйте обычный ZIP, до 65 534 записей.', 415);
  if (file.size < 22) throw corrupt();
  const tailOffset = Math.max(0, file.size - 22 - 0xffff);
  const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
  const view = dataView(tail);
  let end = -1;
  for (let cursor = tail.length - 22; cursor >= 0; cursor--) {
    if (view.getUint32(cursor, true) === 0x06054b50 && cursor + 22 + view.getUint16(cursor + 20, true) === tail.length) { end = cursor; break; }
  }
  if (end < 0) throw corrupt();
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw zip64();
  const centralEnd = tailOffset + end;
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
    || view.getUint16(end + 8, true) !== count || centralOffset + centralSize !== centralEnd) throw corrupt();
  if (count > IMPORT_LIMITS.archiveEntries) throw new ApiError(IMPORT_LIMIT_TEXT.entries, 413);
  let cursor = centralOffset;
  let expanded = 0;
  const entries: ZipEntry[] = [];
  const ranges: [number, number][] = [];
  // Separate caches prevent jumping between catalogue and local headers from rereading big slices.
  const centralReader = new BlobReader(file);
  const localReader = new BlobReader(file);
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > centralEnd) throw corrupt();
    const header = dataView(await centralReader.read(cursor, 46));
    if (header.getUint32(0, true) !== 0x02014b50) throw corrupt();
    const flags = header.getUint16(8, true);
    const method = header.getUint16(10, true);
    const crc = header.getUint32(16, true);
    const compressedSize = header.getUint32(20, true);
    const size = header.getUint32(24, true);
    const nameLength = header.getUint16(28, true);
    const extraLength = header.getUint16(30, true);
    const commentLength = header.getUint16(32, true);
    const startDisk = header.getUint16(34, true);
    const external = header.getUint32(38, true);
    const offset = header.getUint32(42, true);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw zip64();
    if (!nameLength || cursor + 46 + nameLength + extraLength + commentLength > centralEnd || startDisk !== 0) throw corrupt();
    if (flags & (1 | 64)) throw new ApiError('Зашифрованные ZIP не поддерживаются.', 400);
    if (flags & ~(2 | 4 | 8 | 2048)) throw corrupt();
    // UTF-8 is required by modern ZIP writers; ASCII works without the UTF-8 flag too.
    const nameBytes = await centralReader.read(cursor + 46, nameLength);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new ApiError('Имена файлов ZIP должны быть в UTF-8. Пересоздайте архив с UTF-8 именами.', 400); }
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) {
      throw new ApiError('ZIP содержит небезопасный путь.', 400);
    }
    if (((external >>> 16) & 0xf000) === 0xa000) throw new ApiError('Символические ссылки в ZIP не поддерживаются.', 400);
    expanded += size;
    if (expanded > IMPORT_LIMITS.expandedBytes) throw new ApiError(IMPORT_LIMIT_TEXT.expanded, 413);
    if (offset + 30 > centralOffset) throw corrupt();
    const local = dataView(await localReader.read(offset, 30));
    if (local.getUint32(0, true) !== 0x04034b50) throw corrupt();
    const localNameLength = local.getUint16(26, true);
    const localExtraLength = local.getUint16(28, true);
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    if (local.getUint16(6, true) !== flags || local.getUint16(8, true) !== method
      || dataOffset > centralOffset || compressedSize > centralOffset - dataOffset || localNameLength !== nameLength) throw corrupt();
    const localName = await localReader.read(offset + 30, localNameLength);
    if (nameBytes.some((byte, nameIndex) => byte !== localName[nameIndex])) throw corrupt();
    if (!(flags & 8) && (local.getUint32(14, true) !== crc
      || local.getUint32(18, true) !== compressedSize || local.getUint32(22, true) !== size)) throw corrupt();
    ranges.push([offset, dataOffset + compressedSize]);
    const directory = name.endsWith('/');
    const png = !directory && /\.png$/i.test(name);
    const basename = name.split('/').at(-1)!;
    // Names are validated in full, but huge path strings need not stay in the manifest.
    const displayName = png ? (basename.length > 240 ? `${basename.slice(0, 236)}.png` : basename) : name.slice(0, 200);
    entries.push({ name: displayName, png, method, crc, size, compressedSize, dataOffset, directory });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralEnd) throw corrupt();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) throw corrupt();
  return entries;
}

async function expandPng(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > IMPORT_LIMITS.pngBytes) throw new ApiError(IMPORT_LIMIT_TEXT.png, 413);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ApiError('Размер файла ZIP не совпадает с заголовком.', 400);
    const compressed = new Uint8Array(await file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize).arrayBuffer());
    if (compressed.length !== entry.size || crc32(compressed) !== entry.crc) throw new ApiError('Контрольная сумма ZIP не совпадает: архив повреждён.', 400);
    return compressed;
  }
  if (entry.method !== 8) throw new ApiError('Метод сжатия ZIP не поддерживается. Используйте обычный ZIP (Deflate).', 415);
  const result = new Uint8Array(entry.size);
  let total = 0;
  let decoder: DecompressionStream;
  try { decoder = new DecompressionStream('deflate-raw'); }
  catch { throw new ApiError('Для распаковки ZIP нужен современный браузер с DecompressionStream (deflate-raw). Обновите браузер или загрузите PNG напрямую.', 415); }
  const reader = file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize).stream().pipeThrough(decoder).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > entry.size - total) throw new ApiError('Некорректный или слишком большой файл в ZIP.', 413);
      result.set(value, total);
      total += value.length;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Сжатый файл ZIP повреждён.', 400);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  // The native decoder verifies stream termination and rejects compressed trailing junk.
  if (total !== entry.size) throw new ApiError('Размер распакованного файла ZIP не совпадает с заголовком.', 400);
  if (crc32(result) !== entry.crc) throw new ApiError('Контрольная сумма ZIP не совпадает: архив повреждён.', 400);
  return result;
}

async function importAssets(body: RequestInit['body']): Promise<{ assets: Asset[]; warnings: string[] }> {
  if (!(body instanceof FormData)) throw new ApiError('Добавьте PNG или ZIP с PNG в поле files.', 400);
  const files = body.getAll('files');
  if (!files.length || files.some(file => !(file instanceof File)) || [...body.keys()].some(key => key !== 'files')) {
    throw new ApiError('Добавьте PNG или ZIP с PNG в поле files.', 400);
  }
  const uploadFiles = files as File[];
  if (uploadFiles.length > IMPORT_LIMITS.files) throw new ApiError(IMPORT_LIMIT_TEXT.files, 413);
  if (uploadFiles.reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.uploadBytes) throw new ApiError(IMPORT_LIMIT_TEXT.upload, 413);
  const warnings: string[] = [];
  let skipped = 0;
  let total = 0;
  let expanded = 0;
  // Preflight all budgets without retaining archive data or PNGs. Entry arrays are short-lived.
  for (const file of uploadFiles) {
    if (/\.dungeondraft_pack$/i.test(file.name)) {
      throw new ApiError('Нативный .dungeondraft_pack пока не поддерживается. Экспортируйте PNG и загрузите их напрямую или в ZIP.', 415);
    }
    if (!/\.(png|zip)$/i.test(file.name)) throw new ApiError('Поддерживаются PNG и ZIP с PNG.', 415);
    if (/\.png$/i.test(file.name)) {
      if (file.size > IMPORT_LIMITS.pngBytes) throw new ApiError(IMPORT_LIMIT_TEXT.png, 413);
      expanded += file.size;
      total++;
    } else {
      if (file.size > IMPORT_LIMITS.archiveBytes) throw new ApiError(IMPORT_LIMIT_TEXT.archive, 413);
      const entries = await zipEntries(file);
      expanded += entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (entry.directory) continue;
        if (!entry.png) {
          skipped++;
          if (warnings.length < 100) warnings.push(`Пропущен «${entry.name.slice(0, 200)}»: импортируются только PNG.`);
          continue;
        }
        if (entry.size > IMPORT_LIMITS.pngBytes) throw new ApiError(IMPORT_LIMIT_TEXT.png, 413);
        total++;
      }
    }
    if (expanded > IMPORT_LIMITS.expandedBytes || total > IMPORT_LIMITS.files) {
      throw new ApiError(IMPORT_LIMIT_TEXT.batch, 413);
    }
  }
  if (!total) throw new ApiError('В архиве не найдены PNG. Нативный набор Dungeondraft не импортируется.', 400);
  if (skipped > 100) warnings.push(`Дополнительно пропущено ${skipped - 100} файлов: импортируются только PNG.`);
  const batchId = crypto.randomUUID();
  let processed = 0;
  const progress = (phase: 'validate' | 'commit', count: number) => {
    window.dispatchEvent(new CustomEvent('dungeonai-import-progress', { detail: { processed: count, total, phase } }));
  };
  async function stage(item: PreparedBrowserAsset) {
    const staged: StagedAsset = {
      id: crypto.randomUUID(), name: item.name, filename: item.filename, width: item.width, height: item.height,
      category: 'objects', tags: [], createdAt: new Date().toISOString(), blob: item.blob,
      batchId, stagedAt: Date.now(), ...(item.pack ? { pack: item.pack } : {}),
    };
    await transaction<void>(['importStaging'], 'readwrite', context => { context.tx.objectStore('importStaging').add(staged); });
    progress('validate', ++processed);
  }
  try {
    progress('validate', 0);
    for (const file of uploadFiles) {
      if (/\.png$/i.test(file.name)) {
        await stage(await validatePng(new Uint8Array(await file.arrayBuffer()), file.name));
      } else {
        // Rereading small headers avoids retaining all manifests for a potentially huge batch.
        for (const entry of await zipEntries(file)) {
          if (entry.directory || !entry.png) continue;
          await stage(await validatePng(await expandPng(file, entry), entry.name, file.name.replace(/\.zip$/i, '')));
        }
      }
    }
    progress('commit', 0);
    const savedIds = await transaction<string[]>(['assets', 'importStaging'], 'readwrite', context => {
      const ids: string[] = [];
      const staging = context.tx.objectStore('importStaging');
      const cursorRequest = staging.index('batchId').openCursor(IDBKeyRange.only(batchId));
      context.request(cursorRequest, cursor => {
        if (!cursor) {
          if (ids.length !== total) throw new ApiError('Пакет импорта неполон. Повторите загрузку.', 500);
          context.set(ids);
          return;
        }
        const { batchId: _batch, stagedAt: _time, ...asset } = cursor.value as StagedAsset;
        context.request(context.tx.objectStore('assets').add(asset), () => {
          ids.push(asset.id);
          cursor.delete();
          progress('commit', ids.length);
          cursor.continue();
        });
      });
    });
    // Create Blob URLs only after the entire publishing transaction has committed.
    let removedAfterCommit = 0;
    const saved = await transaction<StoredAsset[]>(['assets'], 'readonly', context => {
      const records: StoredAsset[] = [];
      const store = context.tx.objectStore('assets');
      for (const id of savedIds) context.request<StoredAsset | undefined>(store.get(id), asset => {
        if (asset) records.push(asset);
        else removedAfterCommit++;
      });
      context.set(records);
    });
    if (removedAfterCommit) warnings.push(`После импорта удалено ассетов в другой вкладке: ${removedAfterCommit}.`);
    return { assets: saved.map(publicAsset), warnings };
  } catch (error) {
    await transaction<void>(['importStaging'], 'readwrite', context => {
      const staging = context.tx.objectStore('importStaging');
      context.request(staging.index('batchId').openKeyCursor(IDBKeyRange.only(batchId)), cursor => {
        if (!cursor) return;
        staging.delete(cursor.primaryKey);
        cursor.continue();
      });
    }).catch(() => undefined);
    throw error;
  }
}

function jsonBody(options?: RequestInit): unknown {
  if (typeof options?.body !== 'string') throw new ApiError('Некорректный JSON.', 400);
  if (new TextEncoder().encode(options.body).length > 2 * MiB) throw new ApiError('Слишком большой JSON-документ.', 413);
  try { return JSON.parse(options.body); } catch { throw new ApiError('Некорректный JSON.', 400); }
}

function assertId(id: string) {
  if (!identifierSchema.safeParse(id).success) throw new ApiError('Некорректный идентификатор.', 400);
}

async function route(path: string, options?: RequestInit): Promise<unknown> {
  const method = options?.method?.toUpperCase() ?? 'GET';
  if (method === 'GET' && path === '/health') return { ok: true };
  if (method === 'GET' && path === '/capabilities') {
    const capabilities: Capabilities = {
      ai: { configured: false, model: 'gpt-4.1-mini', provider: 'OpenAI' },
      formats: { png: true, pngZip: true, dungeondraftPack: false, dungeondraftExport: false },
      storage: 'browser',
    };
    return capabilities;
  }
  if (path === '/assets' && method === 'GET') return assets();
  if (path === '/assets' && method === 'POST') return importAssets(options?.body);
  const assetMatch = /^\/assets\/([^/]+)$/.exec(path);
  if (assetMatch) {
    const id = assetMatch[1]!;
    assertId(id);
    if (method === 'PATCH') {
      const changes = assetChangesSchema.parse(jsonBody(options));
      const stored = await transaction<StoredAsset>(['assets'], 'readwrite', context => {
        const store = context.tx.objectStore('assets');
        context.request<StoredAsset | undefined>(store.get(id), asset => {
          if (!asset) throw new ApiError('Ассет не найден.', 404);
          const updated = { ...asset, ...changes };
          store.put(updated);
          context.set(updated);
        });
      });
      return publicAsset(stored);
    }
    if (method === 'DELETE') {
      await transaction<void>(['assets', 'projects'], 'readwrite', context => {
        const store = context.tx.objectStore('assets');
        context.request<StoredAsset | undefined>(store.get(id), asset => {
          if (!asset) throw new ApiError('Ассет не найден.', 404);
          context.request<MapDocument[]>(context.tx.objectStore('projects').getAll(), projects => {
            const used = projects.find(project => referencedAssetIds(project).includes(id));
            if (used) throw new ApiError(`Ассет используется в сохранённом проекте «${used.name}».`, 409);
            store.delete(id);
          });
        });
      });
      const url = imageUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      imageUrls.delete(id);
      return undefined;
    }
  }
  if (path === '/projects' && method === 'GET') {
    const projects = await transaction<MapDocument[]>(['projects'], 'readonly', context => {
      context.request(context.tx.objectStore('projects').getAll(), context.set);
    });
    return projects.map((project): ProjectSummary => ({
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      width: project.width, height: project.height, elementCount: project.elements.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) {
    const id = projectMatch[1]!;
    assertId(id);
    if (method === 'GET' || method === 'DELETE') {
      return transaction<MapDocument | undefined>(['projects'], method === 'GET' ? 'readonly' : 'readwrite', context => {
        const store = context.tx.objectStore('projects');
        context.request<MapDocument | undefined>(store.get(id), document => {
          if (!document) throw new ApiError('Проект не найден.', 404);
          if (method === 'DELETE') store.delete(id); else context.set(document);
        });
      });
    }
    if (method === 'PUT') {
      const document = mapDocumentSchema.parse(jsonBody(options));
      if (document.id !== id) throw new ApiError('Идентификатор проекта не совпадает с адресом.', 400);
      return transaction<MapDocument>(['assets', 'projects'], 'readwrite', context => {
        const store = context.tx.objectStore('projects');
        context.request<MapDocument | undefined>(store.get(id), previous => {
          context.request<StoredAsset[]>(context.tx.objectStore('assets').getAll(), stored => {
            const available = new Set(stored.map(asset => asset.id));
            if (referencedAssetIds(document).some(assetId => !available.has(assetId))) {
              throw new ApiError('Проект ссылается на отсутствующий ассет. Импортируйте его перед сохранением.', 400);
            }
            const now = new Date().toISOString();
            const saved = { ...document, createdAt: previous?.createdAt ?? now, updatedAt: now };
            store.put(saved);
            context.set(saved);
          });
        });
      });
    }
  }
  if (path === '/generate' && method === 'POST') {
    const input: GenerationInput = generationInputSchema.parse(jsonBody(options));
    if (input.mode === 'ai') throw new ApiError('ИИ требует сервер с DUNGEON_AI_KEY. В версии GitHub Pages доступна локальная процедурная генерация.', 503);
    const library = await assets();
    const selected = new Set(input.assetIds);
    if (input.assetIds.some(id => !library.some(asset => asset.id === id))) throw new ApiError('Один из выбранных ассетов отсутствует.', 400);
    return mapDocumentSchema.parse(generateLocalMap(input, library.filter(asset => selected.has(asset.id))));
  }
  throw new ApiError('API маршрут не найден.', 404);
}

/** Same contract as the server API, with data stored only in this browser's IndexedDB. */
export async function browserApi<T>(path: string, options?: RequestInit): Promise<T> {
  try { return await route(path, options) as T; }
  catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof GenerationError) throw new ApiError(error.message, error.status);
    if (error instanceof z.ZodError) throw new ApiError(`Некорректные данные: ${error.issues[0]?.message ?? 'проверьте поля'}.`, 400);
    throw storageError(error);
  }
}
