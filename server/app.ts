import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import yauzl from 'yauzl';
import { PNG } from 'pngjs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import type { Asset, Capabilities, GenerationInput } from '../shared/types.js';
import { generationInputSchema, mapDocumentSchema } from '../shared/validation.js';
import { generateAIMap, generateLocalMap, GenerationError } from './generator.js';
import { HttpError, Storage, type PreparedAsset } from './storage.js';

const MiB = 1024 * 1024;
const MAX_FILE_BYTES = 8 * MiB;
const MAX_UPLOAD_BYTES = 16 * MiB;
const MAX_EXPANDED_BYTES = 64 * MiB;
const MAX_ZIP_ENTRIES = 200;
const MAX_PIXELS = 16 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface AppOptions {
  dataDir: string;
  aiKey?: string;
  aiModel?: string;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function multipartFilename(original: string): string {
  // Browser multipart headers use UTF-8, while Busboy defaults plain filename parameters to Latin-1.
  // Preserve already decoded Unicode and actual legacy Latin-1 names that are not valid UTF-8.
  if (![...original].every((character) => character.charCodeAt(0) <= 255)) return original;
  const bytes = Buffer.from(original, 'latin1');
  return isUtf8(bytes) ? bytes.toString('utf8') : original;
}

function imageAsset(data: Buffer, filename: string, pack?: string): PreparedAsset {
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, 'PNG превышает лимит 8 МиБ.');
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature) || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw new HttpError(400, `«${filename}» не является PNG.`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new HttpError(400, 'PNG должен быть не больше 8192 пикселей по стороне и 16 мегапикселей.');
  }
  try {
    // pngjs bounds ordinary PNG inflation internally; interlaced PNGs need an explicit bound.
    if (data[28] === 1) {
      const idatChunks: Buffer[] = [];
      let cursor = 8;
      while (cursor + 12 <= data.length) {
        const length = data.readUInt32BE(cursor);
        if (length > data.length - cursor - 12) throw new Error('Truncated PNG chunk');
        if (data.toString('ascii', cursor + 4, cursor + 8) === 'IDAT') {
          idatChunks.push(data.subarray(cursor + 8, cursor + 8 + length));
        }
        cursor += length + 12;
      }
      // At most eight bytes per pixel for 16-bit RGBA, plus Adam7 filter-row overhead.
      inflateSync(Buffer.concat(idatChunks), { maxOutputLength: width * height * 8 + height * 8 + 1024 });
    }
    // Decode the image, including PNG chunk CRC checks. A filename or signature alone is insufficient.
    const decoded = PNG.sync.read(data, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) throw new Error('PNG dimension mismatch');
  } catch {
    throw new HttpError(400, `PNG «${filename}» повреждён или имеет неподдерживаемую структуру.`);
  }
  const basename = path.posix.basename(filename.replaceAll('\\', '/'));
  return {
    name: basename.replace(/\.png$/i, '').trim().slice(0, 120) || 'Без названия',
    filename: basename.slice(0, 240), width, height, data,
    ...(pack ? { pack: pack.slice(0, 120) } : {}),
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

async function unzipAssets(buffer: Buffer, filename: string): Promise<{ assets: PreparedAsset[]; warnings: string[]; bytes: number }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error || !archive) reject(new HttpError(400, `ZIP «${filename}» повреждён.`));
      else resolve(archive);
    });
  });
  return new Promise((resolve, reject) => {
    const assets: PreparedAsset[] = [];
    const warnings: string[] = [];
    let entries = 0;
    let bytes = 0;
    let finished = false;
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(error instanceof HttpError ? error : new HttpError(400, `ZIP «${filename}» повреждён.`));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (finished) return;
      finished = true;
      resolve({ assets, warnings, bytes });
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      if (finished) return;
      entries++;
      if (entries > MAX_ZIP_ENTRIES) return fail(new HttpError(413, 'В ZIP допускается не больше 200 записей.'));
      const entryName = entry.fileName;
      if (entryName.startsWith('/') || entryName.includes('\\') || entryName.split('/').includes('..') || /^[A-Za-z]:/.test(entryName)) {
        return fail(new HttpError(400, 'ZIP содержит небезопасный путь.'));
      }
      if (entry.generalPurposeBitFlag & 1) return fail(new HttpError(400, 'Зашифрованные ZIP не поддерживаются.'));
      // Inspect every declared entry, including files that will be skipped.
      bytes += entry.uncompressedSize;
      if (bytes > MAX_EXPANDED_BYTES) return fail(new HttpError(413, 'Распакованный ZIP превышает 64 МиБ.'));
      if (entryName.endsWith('/')) return zip.readEntry();
      if (!/\.png$/i.test(entryName)) {
        warnings.push(`Пропущен «${entryName.slice(0, 200)}»: импортируются только PNG.`);
        return zip.readEntry();
      }
      const unixMode = entry.externalFileAttributes >>> 16;
      if ((unixMode & 0xf000) === 0xa000) return fail(new HttpError(400, 'Символические ссылки в ZIP не поддерживаются.'));
      if (entry.uncompressedSize > MAX_FILE_BYTES) return fail(new HttpError(413, 'PNG в ZIP превышает 8 МиБ.'));
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail(error ?? new Error('Missing ZIP entry stream'));
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('error', fail);
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FILE_BYTES || size > entry.uncompressedSize) {
            stream.destroy();
            fail(new HttpError(413, 'Некорректный или слишком большой файл в ZIP.'));
          } else chunks.push(chunk);
        });
        stream.on('end', () => {
          if (finished) return;
          try {
            const data = Buffer.concat(chunks);
            if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) throw new Error('ZIP checksum mismatch');
            assets.push(imageAsset(data, entryName, filename.replace(/\.zip$/i, '')));
            zip.readEntry();
          } catch (error) { fail(error); }
        });
      });
    });
    zip.readEntry();
  });
}

// A shared request budget also applies to chunked multipart requests without Content-Length.
function uploadMiddleware() {
  const budgets = new WeakMap<Request, number>();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) callback(error);
        else callback(null, { buffer: Buffer.concat(chunks), size });
      };
      file.stream.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        const total = (budgets.get(req) ?? 0) + chunk.length;
        budgets.set(req, total);
        if (total > MAX_UPLOAD_BYTES) finish(new HttpError(413, 'Загрузка превышает общий лимит 16 МиБ.'));
        else chunks.push(chunk);
      });
      file.stream.on('error', (error) => finish(error));
      file.stream.on('end', () => finish());
    },
    _removeFile(_req, file, callback) {
      delete (file as Partial<Express.Multer.File>).buffer;
      callback(null);
    },
  };
  return multer({ storage, limits: { fileSize: MAX_FILE_BYTES, files: 32, fields: 0, parts: 32 } }).array('files', 32);
}

const assetChangesSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(['objects', 'floors', 'walls']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, 'Укажите изменение ассета.');

export function createApp(options: AppOptions) {
  const app = express();
  const storage = new Storage(options.dataDir);
  const aiKey = options.aiKey?.trim();
  const aiModel = options.aiModel?.trim() || 'gpt-4.1-mini';
  let activeGenerations = 0;
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/capabilities', (_req, res) => {
    const capabilities: Capabilities = {
      ai: { configured: Boolean(aiKey), model: aiModel, provider: 'OpenAI' },
      formats: { png: true, pngZip: true, dungeondraftPack: false, dungeondraftExport: false },
      storage: 'local',
    };
    res.json(capabilities);
  });

  app.get('/api/assets', asyncRoute(async (_req, res) => { res.json(await storage.listAssets()); }));
  app.post('/api/assets', uploadMiddleware(), asyncRoute(async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) throw new HttpError(400, 'Добавьте PNG или ZIP с PNG в поле files.');
    const prepared: PreparedAsset[] = [];
    const warnings: string[] = [];
    let expandedBytes = 0;
    for (const file of files) {
      const filename = multipartFilename(file.originalname);
      if (/\.dungeondraft_pack$/i.test(filename)) {
        throw new HttpError(415, 'Нативный .dungeondraft_pack пока не поддерживается. Экспортируйте PNG и загрузите их напрямую или в ZIP.');
      }
      if (/\.png$/i.test(filename)) {
        prepared.push(imageAsset(file.buffer, filename));
        expandedBytes += file.buffer.length;
      } else if (/\.zip$/i.test(filename)) {
        const result = await unzipAssets(file.buffer, filename);
        prepared.push(...result.assets);
        warnings.push(...result.warnings);
        expandedBytes += result.bytes;
      } else {
        throw new HttpError(415, 'Поддерживаются PNG и ZIP с PNG.');
      }
      if (expandedBytes > MAX_EXPANDED_BYTES || prepared.length > MAX_ZIP_ENTRIES) {
        throw new HttpError(413, 'Одна загрузка допускает до 200 PNG и до 64 МиБ после распаковки.');
      }
    }
    if (!prepared.length) throw new HttpError(400, 'В архиве не найдены PNG. Нативный набор Dungeondraft не импортируется.');
    res.status(201).json({ assets: await storage.addAssets(prepared), warnings });
  }));
  app.patch('/api/assets/:id', asyncRoute(async (req, res) => {
    res.json(await storage.updateAsset(req.params.id as string, assetChangesSchema.parse(req.body)));
  }));
  app.delete('/api/assets/:id', asyncRoute(async (req, res) => {
    await storage.deleteAsset(req.params.id as string);
    res.status(204).end();
  }));
  app.get('/api/assets/:id/file', asyncRoute(async (req, res) => {
    const image = await storage.assetFile(req.params.id as string);
    res.type('png').send(image);
  }));

  app.get('/api/projects', asyncRoute(async (_req, res) => { res.json(await storage.listProjects()); }));
  app.get('/api/projects/:id', asyncRoute(async (req, res) => { res.json(await storage.getProject(req.params.id as string)); }));
  app.put('/api/projects/:id', asyncRoute(async (req, res) => {
    const document = mapDocumentSchema.parse(req.body);
    if (document.id !== req.params.id) throw new HttpError(400, 'Идентификатор проекта не совпадает с адресом.');
    res.json(await storage.putProject(document));
  }));
  app.delete('/api/projects/:id', asyncRoute(async (req, res) => {
    await storage.deleteProject(req.params.id as string);
    res.status(204).end();
  }));
  app.post('/api/generate', asyncRoute(async (req, res) => {
    const input: GenerationInput = generationInputSchema.parse(req.body);
    const assets: Asset[] = await storage.listAssets();
    const requestedIds = new Set(input.assetIds);
    const availableIds = new Set(assets.map((asset) => asset.id));
    if (input.assetIds.some((id) => !availableIds.has(id))) throw new HttpError(400, 'Один из выбранных ассетов отсутствует.');
    const selectedAssets = assets.filter((asset) => requestedIds.has(asset.id));
    if (input.mode === 'ai' && !aiKey) throw new HttpError(503, 'ИИ не настроен. Добавьте DUNGEON_AI_KEY в окружение сервера или используйте локальную генерацию.');
    if (activeGenerations >= 4) throw new HttpError(429, 'Выполняется слишком много генераций. Повторите позже.');
    activeGenerations++;
    try {
      const generated = input.mode === 'ai'
        ? await generateAIMap(input, selectedAssets, { apiKey: aiKey!, model: aiModel })
        : generateLocalMap(input, selectedAssets);
      res.json(mapDocumentSchema.parse(generated));
    } finally {
      activeGenerations--;
    }
  }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API маршрут не найден.' }); });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof HttpError || error instanceof GenerationError) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: `Некорректные данные: ${error.issues[0]?.message ?? 'проверьте поля'}.` });
    } else if (error instanceof multer.MulterError) {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Превышен лимит загрузки: до 32 файлов, 8 МиБ на файл и 16 МиБ суммарно.' });
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Слишком большой JSON-документ.' });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Некорректный JSON.' });
    } else {
      // Do not return filesystem paths, provider responses, stack traces, or credentials.
      console.error('DungeonAI request failed:', error instanceof Error ? error.name : 'Unknown error');
      res.status(500).json({ error: 'Не удалось выполнить операцию. Проверьте доступность хранилища и повторите.' });
    }
  };
  app.use(handleError);
  return app;
}
