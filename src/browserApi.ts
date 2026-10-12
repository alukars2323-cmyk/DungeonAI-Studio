import { Inflate } from 'fflate';
import { z } from 'zod';
import type { Asset, Capabilities, GenerationInput, MapDocument, ProjectSummary } from '../shared/types';
import { referencedAssetIds } from '../shared/assets';
import { generateLocalMap } from '../shared/localGenerator';
import { GenerationError } from '../shared/generationError';
import { generationInputSchema, identifierSchema, mapDocumentSchema } from '../shared/validation';
import { ApiError } from './apiError';
import { crc32, MAX_FILE_BYTES, MiB, validatePng, type PreparedBrowserAsset } from './pngValidation';

const MAX_UPLOAD_BYTES = 16 * MiB;
const MAX_EXPANDED_BYTES = 64 * MiB;
const MAX_ENTRIES = 200;
const DB_NAME = 'dungeonai-studio:browser:v1';
type StoredAsset = Omit<Asset, 'url'> & { blob: Blob };
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
    try { request = indexedDB.open(DB_NAME, 1); }
    catch (error) { reject(storageError(error)); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
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
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  dataOffset: number;
  directory: boolean;
}

/** The central directory supplies verified entry boundaries before any decompression. */
function zipEntries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const corrupt = () => new ApiError('ZIP повреждён или имеет неподдерживаемую структуру.', 400);
  if (data.length < 22) throw corrupt();
  let end = -1;
  for (let cursor = data.length - 22; cursor >= Math.max(0, data.length - 22 - 0xffff); cursor--) {
    if (view.getUint32(cursor, true) === 0x06054b50 && cursor + 22 + view.getUint16(cursor + 20, true) === data.length) { end = cursor; break; }
  }
  if (end < 0) throw corrupt();
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
    || view.getUint16(end + 8, true) !== count || count === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== end) throw corrupt();
  if (count > MAX_ENTRIES) throw new ApiError('В ZIP допускается не больше 200 записей.', 413);
  let cursor = centralOffset;
  let expanded = 0;
  const entries: ZipEntry[] = [];
  const ranges: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw corrupt();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const startDisk = view.getUint16(cursor + 34, true);
    const external = view.getUint32(cursor + 38, true);
    const offset = view.getUint32(cursor + 42, true);
    if (!nameLength || cursor + 46 + nameLength + extraLength + commentLength > end
      || startDisk !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw corrupt();
    if (flags & (1 | 64)) throw new ApiError('Зашифрованные ZIP не поддерживаются.', 400);
    if (flags & ~(2 | 4 | 8 | 2048)) throw corrupt();
    // UTF-8 is required by modern ZIP writers; ASCII works without the UTF-8 flag too.
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new ApiError('Имена файлов ZIP должны быть в UTF-8. Пересоздайте архив с UTF-8 именами.', 400); }
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) {
      throw new ApiError('ZIP содержит небезопасный путь.', 400);
    }
    if (((external >>> 16) & 0xf000) === 0xa000) throw new ApiError('Символические ссылки в ZIP не поддерживаются.', 400);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) throw new ApiError('Распакованный ZIP превышает 64 МиБ.', 413);
    if (offset + 30 > centralOffset || view.getUint32(offset, true) !== 0x04034b50) throw corrupt();
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    if (view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method
      || dataOffset > centralOffset || compressedSize > centralOffset - dataOffset || localNameLength !== nameLength
      || nameBytes.some((byte, nameIndex) => byte !== data[offset + 30 + nameIndex])) throw corrupt();
    if (!(flags & 8) && (view.getUint32(offset + 14, true) !== crc
      || view.getUint32(offset + 18, true) !== compressedSize || view.getUint32(offset + 22, true) !== size)) throw corrupt();
    ranges.push([offset, dataOffset + compressedSize]);
    entries.push({ name, method, crc, size, compressedSize, dataOffset, directory: name.endsWith('/') });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw corrupt();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) throw corrupt();
  return entries;
}

async function expandPng(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > MAX_FILE_BYTES) throw new ApiError('PNG в ZIP превышает 8 МиБ.', 413);
  const compressed = data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    if (compressed.length !== entry.size || crc32(compressed) !== entry.crc) throw new ApiError('Контрольная сумма ZIP не совпадает: архив повреждён.', 400);
    return compressed;
  }
  if (entry.method !== 8) throw new ApiError('Метод сжатия ZIP не поддерживается. Используйте обычный ZIP (Deflate).', 415);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  const inflate = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > entry.size || total > MAX_FILE_BYTES) throw new ApiError('Некорректный или слишком большой файл в ZIP.', 413);
    chunks.push(chunk);
    complete ||= final;
  });
  try {
    // Bounded input chunks prevent one dishonest stream from expanding unboundedly.
    for (let offset = 0; offset < compressed.length; offset += 1024) {
      inflate.push(compressed.subarray(offset, offset + 1024), offset + 1024 >= compressed.length);
      if (offset && offset % (64 * 1024) === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!compressed.length) inflate.push(compressed, true);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Сжатый файл ZIP повреждён.', 400);
  }
  if (!complete || total !== entry.size) throw new ApiError('Размер распакованного файла ZIP не совпадает с заголовком.', 400);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
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
  if (uploadFiles.length > 32 || uploadFiles.some(file => file.size > MAX_FILE_BYTES)
    || uploadFiles.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
    throw new ApiError('Превышен лимит загрузки: до 32 файлов, 8 МиБ на файл и 16 МиБ суммарно.', 413);
  }
  const prepared: PreparedBrowserAsset[] = [];
  const warnings: string[] = [];
  let expanded = 0;
  for (const file of uploadFiles) {
    if (/\.dungeondraft_pack$/i.test(file.name)) {
      throw new ApiError('Нативный .dungeondraft_pack пока не поддерживается. Экспортируйте PNG и загрузите их напрямую или в ZIP.', 415);
    }
    if (!/\.(png|zip)$/i.test(file.name)) throw new ApiError('Поддерживаются PNG и ZIP с PNG.', 415);
    const data = new Uint8Array(await file.arrayBuffer());
    if (/\.png$/i.test(file.name)) {
      expanded += data.length;
      prepared.push(await validatePng(data, file.name));
    } else {
      const entries = zipEntries(data);
      expanded += entries.reduce((sum, entry) => sum + entry.size, 0);
      if (expanded > MAX_EXPANDED_BYTES) throw new ApiError('Одна загрузка допускает до 200 PNG и до 64 МиБ после распаковки.', 413);
      for (const entry of entries) {
        if (entry.directory) continue;
        if (!/\.png$/i.test(entry.name)) { warnings.push(`Пропущен «${entry.name.slice(0, 200)}»: импортируются только PNG.`); continue; }
        if (prepared.length >= MAX_ENTRIES) throw new ApiError('Одна загрузка допускает до 200 PNG и до 64 МиБ после распаковки.', 413);
        prepared.push(await validatePng(await expandPng(data, entry), entry.name, file.name.replace(/\.zip$/i, '')));
      }
    }
    if (expanded > MAX_EXPANDED_BYTES || prepared.length > MAX_ENTRIES) {
      throw new ApiError('Одна загрузка допускает до 200 PNG и до 64 МиБ после распаковки.', 413);
    }
  }
  if (!prepared.length) throw new ApiError('В архиве не найдены PNG. Нативный набор Dungeondraft не импортируется.', 400);
  const saved = prepared.map(item => ({
    id: crypto.randomUUID(), name: item.name, filename: item.filename, width: item.width, height: item.height,
    category: 'objects' as const, tags: [], createdAt: new Date().toISOString(), blob: item.blob,
    ...(item.pack ? { pack: item.pack } : {}),
  }));
  await transaction<void>(['assets'], 'readwrite', context => {
    for (const asset of saved) context.tx.objectStore('assets').add(asset);
  });
  return { assets: saved.map(publicAsset), warnings };
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
