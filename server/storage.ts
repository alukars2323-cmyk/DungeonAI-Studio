import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Asset, MapDocument, ProjectSummary } from '../shared/types.js';
import { referencedAssetIds } from '../shared/assets.js';
import { mapDocumentSchema } from '../shared/validation.js';
import { IMPORT_LIMITS } from '../shared/importLimits.js';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const safeId = /^[A-Za-z0-9_-]{1,80}$/;
const assetSchema = z.object({
  id: z.string().regex(safeId),
  name: z.string().min(1).max(120),
  filename: z.string().min(1).max(240),
  width: z.number().int().positive().max(IMPORT_LIMITS.pngSide),
  height: z.number().int().positive().max(IMPORT_LIMITS.pngSide),
  category: z.enum(['objects', 'floors', 'walls']),
  tags: z.array(z.string().min(1).max(40)).max(12),
  url: z.string(),
  createdAt: z.string().datetime(),
  pack: z.string().max(120).optional(),
});

export interface PreparedAsset {
  name: string;
  filename: string;
  width: number;
  height: number;
  /** Validated image staged on disk; batches do not retain decoded PNG buffers. */
  sourcePath: string;
  pack?: string;
}

function assertId(id: string): void {
  if (!safeId.test(id)) throw new HttpError(400, 'Некорректный идентификатор.');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function atomicWrite(filename: string, data: string | Buffer): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function atomicCopy(source: string, filename: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** All writes share one queue, including reference checks before deleting assets. */
export class Storage {
  private readonly assetsDir: string;
  private readonly projectsDir: string;
  private readonly commitsDir: string;
  private readonly committedBatches = new Set<string>();
  private readonly ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.assetsDir = path.join(path.resolve(dataDir), 'assets');
    this.projectsDir = path.join(path.resolve(dataDir), 'projects');
    this.commitsDir = path.join(this.assetsDir, '.commits');
    this.ready = Promise.all([
      mkdir(this.assetsDir, { recursive: true }),
      mkdir(this.projectsDir, { recursive: true }),
      mkdir(this.commitsDir, { recursive: true }),
    ]).then(() => undefined);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => {
      await this.ready;
      return operation();
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async readAsset(id: string, visibleBatches?: ReadonlySet<string>): Promise<Asset> {
    assertId(id);
    try {
      const metadata = JSON.parse(await readFile(path.join(this.assetsDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
      const asset = assetSchema.parse(metadata);
      if (asset.id !== id) throw new Error('Asset identifier mismatch');
      if (metadata.batchId !== undefined) {
        if (typeof metadata.batchId !== 'string' || !safeId.test(metadata.batchId)) throw new Error('Invalid asset batch');
        if (visibleBatches && !visibleBatches.has(metadata.batchId)) throw new HttpError(404, 'Ассет не найден.');
        if (!this.committedBatches.has(metadata.batchId)) {
          await stat(path.join(this.commitsDir, `${metadata.batchId}.json`));
          this.committedBatches.add(metadata.batchId);
        }
      }
      await stat(path.join(this.assetsDir, `${id}.png`));
      return { ...asset, url: `/api/assets/${id}/file` };
    } catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'Ассет не найден.');
      throw error;
    }
  }

  async listAssets(): Promise<Asset[]> {
    await this.ready;
    // Capture committed batches before filenames, so a batch cannot become partially visible mid-read.
    const visibleBatches = new Set((await readdir(this.commitsDir)).filter((name) => /^[A-Za-z0-9_-]{1,80}\.json$/.test(name)).map((name) => name.slice(0, -5)));
    const names = (await readdir(this.assetsDir)).filter((name) => /^[A-Za-z0-9_-]{1,80}\.json$/.test(name));
    const visible: Asset[] = [];
    for (let index = 0; index < names.length; index += 64) {
      const batch = await Promise.all(names.slice(index, index + 64).map(async (name) => {
        try { return await this.readAsset(name.slice(0, -5), visibleBatches); }
        catch (error) {
          if (error instanceof HttpError && error.status === 404) return undefined;
          throw error;
        }
      }));
      visible.push(...batch.filter((asset): asset is Asset => Boolean(asset)));
    }
    return visible
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async assetFile(id: string): Promise<Buffer> {
    await this.ready;
    await this.readAsset(id);
    return readFile(path.join(this.assetsDir, `${id}.png`));
  }

  async addAssets(prepared: PreparedAsset[]): Promise<Asset[]> {
    return this.exclusive(async () => {
      const saved: Asset[] = [];
      const files: string[] = [];
      const batchId = randomUUID();
      try {
        for (const item of prepared) {
          const id = randomUUID();
          const asset: Asset = {
            id, name: item.name, filename: item.filename,
            width: item.width, height: item.height, category: 'objects', tags: [],
            url: `/api/assets/${id}/file`, createdAt: new Date().toISOString(),
            ...(item.pack ? { pack: item.pack } : {}),
          };
          assetSchema.parse(asset);
          const imageFilename = path.join(this.assetsDir, `${id}.png`);
          await atomicCopy(item.sourcePath, imageFilename);
          files.push(imageFilename);
          saved.push(asset);
        }
        // All PNGs have been validated and copied before publishing catalogue entries.
        for (const asset of saved) {
          const metadataFilename = path.join(this.assetsDir, `${asset.id}.json`);
          await atomicWrite(metadataFilename, JSON.stringify({ ...asset, batchId }));
          files.push(metadataFilename);
        }
        // A single atomic marker makes the entire batch visible, including to concurrent readers.
        const commitFilename = path.join(this.commitsDir, `${batchId}.json`);
        await atomicWrite(commitFilename, JSON.stringify({ committedAt: new Date().toISOString() }));
        files.push(commitFilename);
        this.committedBatches.add(batchId);
        return saved;
      } catch (error) {
        await Promise.all(files.map((filename) => unlink(filename).catch(() => undefined)));
        throw error;
      }
    });
  }

  async updateAsset(id: string, changes: Pick<Partial<Asset>, 'name' | 'category' | 'tags'>): Promise<Asset> {
    return this.exclusive(async () => {
      const asset = assetSchema.parse({ ...await this.readAsset(id), ...changes });
      await atomicWrite(path.join(this.assetsDir, `${id}.json`), JSON.stringify(asset));
      return asset;
    });
  }

  async deleteAsset(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.readAsset(id);
      for (const project of await this.readProjects()) {
        if (referencedAssetIds(project).includes(id)) {
          throw new HttpError(409, `Ассет используется в сохранённом проекте «${project.name}».`);
        }
      }
      // Hide the catalogue entry first, so a failed image removal cannot expose a broken asset.
      await unlink(path.join(this.assetsDir, `${id}.json`));
      await unlink(path.join(this.assetsDir, `${id}.png`));
    });
  }

  async getProject(id: string): Promise<MapDocument> {
    assertId(id);
    await this.ready;
    try {
      const project = mapDocumentSchema.parse(JSON.parse(await readFile(path.join(this.projectsDir, `${id}.json`), 'utf8')));
      if (project.id !== id) throw new Error('Project identifier mismatch');
      return project;
    } catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'Проект не найден.');
      throw error;
    }
  }

  private async readProjects(): Promise<MapDocument[]> {
    await this.ready;
    const names = (await readdir(this.projectsDir)).filter((name) => /^[A-Za-z0-9_-]{1,80}\.json$/.test(name));
    return Promise.all(names.map((name) => this.getProject(name.slice(0, -5))));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.readProjects()).map((project) => ({
      id: project.id, name: project.name, updatedAt: project.updatedAt,
      width: project.width, height: project.height, elementCount: project.elements.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async putProject(document: MapDocument): Promise<MapDocument> {
    return this.exclusive(async () => {
      const assetIds = new Set(referencedAssetIds(document));
      for (const id of assetIds) {
        try { await this.readAsset(id); }
        catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            throw new HttpError(400, 'Проект ссылается на отсутствующий ассет. Импортируйте его перед сохранением.');
          }
          throw error;
        }
      }
      let previous: MapDocument | undefined;
      try { previous = await this.getProject(document.id); }
      catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
      const now = new Date().toISOString();
      const saved = mapDocumentSchema.parse({ ...document, createdAt: previous?.createdAt ?? now, updatedAt: now });
      await atomicWrite(path.join(this.projectsDir, `${saved.id}.json`), JSON.stringify(saved));
      return saved;
    });
  }

  async deleteProject(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.getProject(id);
      await unlink(path.join(this.projectsDir, `${id}.json`));
    });
  }
}
