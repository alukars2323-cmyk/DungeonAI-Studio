import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import yauzl from 'yauzl';
import { PNG } from 'pngjs';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import type { Asset, Capabilities, GenerationInput } from '../shared/types.js';
import { generationInputSchema, mapDocumentSchema } from '../shared/validation.js';
import { generateAIMap, generateLocalMap, GenerationError } from './generator.js';
import { HttpError, Storage, type PreparedAsset } from './storage.js';
import { IMPORT_LIMITS, IMPORT_LIMIT_TEXT } from '../shared/importLimits.js';

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

function imageAsset(data: Buffer, filename: string, sourcePath: string, pack?: string): PreparedAsset {
  if (data.length > IMPORT_LIMITS.pngBytes) throw new HttpError(413, IMPORT_LIMIT_TEXT.png);
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature) || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw new HttpError(400, `«${filename}» не является PNG.`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!width || !height || width > IMPORT_LIMITS.pngSide || height > IMPORT_LIMITS.pngSide || width * height > IMPORT_LIMITS.pngPixels) {
    throw new HttpError(400, IMPORT_LIMIT_TEXT.pixels);
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
    filename: basename.slice(0, 240), width, height, sourcePath,
    ...(pack ? { pack: pack.slice(0, 120) } : {}),
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function updateCrc(crc: number, data: Buffer): number {
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return crc;
}

async function unzipAssets(sourcePath: string, filename: string, stagingDir: string, expansionBudget: number): Promise<{ assets: PreparedAsset[]; warnings: string[]; bytes: number }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error || !archive) reject(new HttpError(400, `ZIP «${filename}» повреждён.`));
      else resolve(archive);
    });
  });
  if (zip.entryCount > IMPORT_LIMITS.archiveEntries) {
    zip.close();
    throw new HttpError(413, IMPORT_LIMIT_TEXT.entries);
  }
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
      const outOfSpace = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOSPC';
      reject(outOfSpace
        ? new HttpError(507, 'Недостаточно места в хранилище для распаковки ZIP. Освободите место и повторите импорт.')
        : error instanceof HttpError ? error : new HttpError(400, `ZIP «${filename}» повреждён.`));
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
      if (entries > IMPORT_LIMITS.archiveEntries) return fail(new HttpError(413, IMPORT_LIMIT_TEXT.entries));
      const entryName = entry.fileName;
      if (entryName.startsWith('/') || entryName.includes('\\') || entryName.split('/').includes('..') || /^[A-Za-z]:/.test(entryName)) {
        return fail(new HttpError(400, 'ZIP содержит небезопасный путь.'));
      }
      if (entry.generalPurposeBitFlag & 1) return fail(new HttpError(400, 'Зашифрованные ZIP не поддерживаются.'));
      // Inspect every declared entry, including files that will be skipped.
      bytes += entry.uncompressedSize;
      if (bytes > expansionBudget) return fail(new HttpError(413, IMPORT_LIMIT_TEXT.expanded));
      if (entryName.endsWith('/')) return zip.readEntry();
      if (!/\.png$/i.test(entryName)) {
        warnings.push(`Пропущен «${entryName.slice(0, 200)}»: импортируются только PNG.`);
        return zip.readEntry();
      }
      const unixMode = entry.externalFileAttributes >>> 16;
      if ((unixMode & 0xf000) === 0xa000) return fail(new HttpError(400, 'Символические ссылки в ZIP не поддерживаются.'));
      if (entry.uncompressedSize > IMPORT_LIMITS.pngBytes) return fail(new HttpError(413, IMPORT_LIMIT_TEXT.png));
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail(error ?? new Error('Missing ZIP entry stream'));
        let size = 0;
        let crc = 0xffffffff;
        const outputPath = path.join(stagingDir, `${randomUUID()}.png`);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > IMPORT_LIMITS.pngBytes || size > entry.uncompressedSize) {
              callback(new HttpError(413, IMPORT_LIMIT_TEXT.png));
            } else {
              crc = updateCrc(crc, chunk);
              callback(null, chunk);
            }
          },
        });
        void pipeline(stream, meter, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })).then(async () => {
          if (!finished) {
            if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('ZIP checksum mismatch');
            assets.push(imageAsset(await readFile(outputPath), entryName, outputPath, filename.replace(/\.zip$/i, '')));
            zip.readEntry();
          }
        }).catch(fail);
      });
    });
    zip.readEntry();
  });
}

interface UploadSession { directory: string; bytes: number }

// Uploads and expanded PNGs stay on disk. Only one validated PNG is decoded at a time.
function uploadMiddleware(sessions: WeakMap<Request, UploadSession>) {
  let writers = 0;
  const waiting: (() => void)[] = [];
  const acquireWriter = async () => {
    if (writers >= 8) await new Promise<void>((resolve) => waiting.push(resolve));
    else writers++;
  };
  const releaseWriter = () => {
    const next = waiting.shift();
    if (next) next();
    else writers--;
  };
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      const session = sessions.get(req)!;
      const filename = multipartFilename(file.originalname);
      const zip = /\.zip$/i.test(filename);
      const limit = zip ? IMPORT_LIMITS.archiveBytes : IMPORT_LIMITS.pngBytes;
      file.path = path.join(session.directory, `${randomUUID()}.upload`);
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          session.bytes += chunk.length;
          if (size > limit) done(new HttpError(413, zip ? IMPORT_LIMIT_TEXT.archive : IMPORT_LIMIT_TEXT.png));
          else if (session.bytes > IMPORT_LIMITS.uploadBytes) done(new HttpError(413, IMPORT_LIMIT_TEXT.upload));
          else done(null, chunk);
        },
      });
      void acquireWriter().then(async () => {
        try {
          await pipeline(file.stream, meter, createWriteStream(file.path, { flags: 'wx', mode: 0o600 }));
          callback(null, { path: file.path, size });
        } catch (error) {
          callback(error instanceof Error ? error : new Error('Upload failed'));
        } finally { releaseWriter(); }
      });
    },
    _removeFile(_req, file, callback) {
      void unlink(file.path).then(() => callback(null), (error: NodeJS.ErrnoException) => {
        callback(error.code === 'ENOENT' ? null : error);
      });
    },
  };
  const options: multer.Options & { fileHwm: number } = {
    storage,
    // A low file-stream watermark keeps multipart backpressure while waiting for a disk writer.
    fileHwm: 1,
    limits: { fileSize: IMPORT_LIMITS.archiveBytes, files: IMPORT_LIMITS.files, fields: 0, parts: IMPORT_LIMITS.files },
    fileFilter(_req, file, callback) {
      const name = multipartFilename(file.originalname);
      if (/\.dungeondraft_pack$/i.test(name)) {
        callback(new HttpError(415, 'Нативный .dungeondraft_pack пока не поддерживается. Экспортируйте PNG и загрузите их напрямую или в ZIP.'));
      } else if (!/\.(png|zip)$/i.test(name)) {
        callback(new HttpError(415, 'Поддерживаются PNG и ZIP с PNG.'));
      } else callback(null, true);
    },
  };
  return multer(options).array('files', IMPORT_LIMITS.files);
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
  let activeImports = 0;
  const uploadSessions = new WeakMap<Request, UploadSession>();
  const parseUpload = uploadMiddleware(uploadSessions);
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
  app.post('/api/assets', asyncRoute(async (req, res) => {
    if (activeImports) throw new HttpError(429, 'Другой импорт уже выполняется. Дождитесь его завершения.');
    const declaredBytes = Number(req.headers['content-length'] ?? 0);
    if (declaredBytes > IMPORT_LIMITS.uploadBytes) throw new HttpError(413, IMPORT_LIMIT_TEXT.upload);
    activeImports++;
    let stagingDir: string | undefined;
    let result: { assets: Asset[]; warnings: string[] } | undefined;
    try {
      await mkdir(options.dataDir, { recursive: true });
      stagingDir = await mkdtemp(path.join(path.resolve(options.dataDir), '.import-'));
      uploadSessions.set(req, { directory: stagingDir, bytes: 0 });
      if (req.aborted) throw new Error('Request aborted');
      await new Promise<void>((resolve, reject) => parseUpload(req, res, (error?: unknown) => error ? reject(error) : resolve()));
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) throw new HttpError(400, 'Добавьте PNG или ZIP с PNG в поле files.');
      const prepared: PreparedAsset[] = [];
      const warnings: string[] = [];
      let expandedBytes = 0;
      for (const file of files) {
        const filename = multipartFilename(file.originalname);
        if (/\.png$/i.test(filename)) {
          prepared.push(imageAsset(await readFile(file.path), filename, file.path));
          expandedBytes += file.size;
        } else {
          const archive = await unzipAssets(file.path, filename, stagingDir, IMPORT_LIMITS.expandedBytes - expandedBytes);
          prepared.push(...archive.assets);
          warnings.push(...archive.warnings);
          expandedBytes += archive.bytes;
        }
        if (expandedBytes > IMPORT_LIMITS.expandedBytes || prepared.length > IMPORT_LIMITS.files) {
          throw new HttpError(413, IMPORT_LIMIT_TEXT.batch);
        }
      }
      if (!prepared.length) throw new HttpError(400, 'В архиве не найдены PNG. Нативный набор Dungeondraft не импортируется.');
      result = { assets: await storage.addAssets(prepared), warnings };
    } finally {
      uploadSessions.delete(req);
      try {
        if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
      } finally { activeImports--; }
    }
    res.status(201).json(result);
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
    if (res.destroyed) return;
    if (error instanceof HttpError || error instanceof GenerationError) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: `Некорректные данные: ${error.issues[0]?.message ?? 'проверьте поля'}.` });
    } else if (error instanceof multer.MulterError) {
      const limitError = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT'].includes(error.code);
      const message = error.code === 'LIMIT_FILE_SIZE' ? IMPORT_LIMIT_TEXT.archive : IMPORT_LIMIT_TEXT.files;
      res.status(limitError ? 413 : 400).json({ error: message });
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Слишком большой JSON-документ.' });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Некорректный JSON.' });
    } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOSPC') {
      res.status(507).json({ error: 'Недостаточно места в хранилище для этой загрузки. Освободите место и повторите импорт.' });
    } else {
      // Do not return filesystem paths, provider responses, stack traces, or credentials.
      console.error('DungeonAI request failed:', error instanceof Error ? error.name : 'Unknown error');
      res.status(500).json({ error: 'Не удалось выполнить операцию. Проверьте доступность хранилища и повторите.' });
    }
  };
  app.use(handleError);
  return app;
}
