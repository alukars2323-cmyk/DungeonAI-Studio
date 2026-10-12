import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { PNG } from 'pngjs';
import type { MapDocument } from '../../shared/types';
import { IMPORT_LIMITS, GiB } from '../../shared/importLimits';
import { largePngFixture } from '../uploadFixtures';

const DRAFT_KEY = 'dungeonai-studio:browser-draft:v1';
const DB_NAME = 'dungeonai-studio:browser:v1';

function markerPng(color: [number, number, number] = [254, 17, 235]) {
  const image = new PNG({ width: 16, height: 8 });
  for (let index = 0; index < image.data.length; index += 4) image.data.set([...color, 255], index);
  return PNG.sync.write(image);
}

async function draft(page: Page): Promise<MapDocument> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), DRAFT_KEY);
}

async function storedProjects(page: Page): Promise<MapDocument[]> {
  return page.evaluate(name => new Promise<MapDocument[]>((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('projects').objectStore('projects').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), DB_NAME);
}

async function storedAssets(page: Page) {
  return page.evaluate(name => new Promise<{ id: string; name: string; blobSize: number; hasUrl: boolean; tags: string[]; pack?: string }[]>((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('assets').objectStore('assets').getAll();
      read.onsuccess = () => {
        db.close();
        resolve(read.result.map(asset => ({ id: asset.id, name: asset.name, blobSize: asset.blob.size, hasUrl: 'url' in asset, tags: asset.tags, pack: asset.pack })));
      };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), DB_NAME);
}

async function stagedCount(page: Page): Promise<number> {
  return page.evaluate(name => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('importStaging').objectStore('importStaging').count();
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), DB_NAME);
}

function declareZipSizes(zip: Buffer, bytes: number) {
  let cursor = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cursor >= 0 && zip.readUInt32LE(cursor) === 0x02014b50) {
    const localOffset = zip.readUInt32LE(cursor + 42);
    zip.writeUInt32LE(bytes, cursor + 24);
    zip.writeUInt32LE(bytes, localOffset + 22);
    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return zip;
}

async function start(page: Page) {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('./');
  await expect(page.locator('.app-header').getByRole('button', { name: /^Сохранить/ })).toBeEnabled();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
}

async function categorize(page: Page, name: string, category: string) {
  await page.getByRole('button', { name: `Свойства ассета ${name}`, exact: true }).click();
  await page.locator('#asset-category').selectOption(category);
  await page.locator('#asset-tags').fill('проверка, текстура');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('static Pages app imports a UTF-8 ZIP, generates, persists and exports real PNG textures without an API', async ({ page }) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const archive = zipSync({
    'textures/пол.png': markerPng([25, 190, 230]),
    'textures/стена.png': markerPng([220, 35, 15]),
    'objects/сундук.png': markerPng(),
    'README.txt': new TextEncoder().encode('PNG texture pack'),
  });
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Набор.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  await expect(page.getByText('Добавлено ассетов: 3', { exact: true })).toBeVisible();
  await expect(page.getByText('Пропущен «README.txt»: импортируются только PNG.', { exact: true })).toBeVisible();
  await categorize(page, 'пол', 'floors');
  await categorize(page, 'стена', 'walls');
  const records = await storedAssets(page);
  expect(records).toHaveLength(3);
  expect(records.every(asset => asset.blobSize > 0 && !asset.hasUrl && asset.pack === 'Набор')).toBeTruthy();
  expect(records.find(asset => asset.name === 'пол')?.tags).toEqual(['проверка', 'текстура']);
  expect(await page.locator('.asset-thumbnail img').first().getAttribute('src')).toMatch(/^blob:/);

  await page.getByRole('button', { name: 'Создать карту', exact: true }).first().click();
  await page.locator('#map-prompt').fill('Каменный храм с 3 комнатами и факелами');
  await page.getByRole('spinbutton', { name: 'Ширина карты в клетках', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: 'Высота карты в клетках', exact: true }).fill('20');
  await page.locator('.generate-button').click();
  await expect(page.getByText('Карта создана локальным процедурным генератором', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /С помощью ИИ/ })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Название проекта', exact: true }).fill('Карта GitHub Pages');
  const map = await draft(page);
  expect(map.generationMode).toBe('local');
  expect(map.wallAssetId).toBe(records.find(asset => asset.name === 'стена')?.id);
  expect(map.elements.some(element => element.type === 'object' && element.assetId)).toBeTruthy();
  expect(map.elements.filter(element => element.type === 'room' || element.type === 'corridor').every(element => 'floorAssetId' in element && !!element.floorAssetId)).toBeTruthy();
  await page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.getByText('Проект сохранён на этом устройстве', { exact: true })).toBeVisible();
  expect((await storedProjects(page))[0].elements).toEqual(map.elements);

  // Clear the draft to prove reload opens the saved IndexedDB document, then export recreated Blob URLs.
  await page.evaluate(key => localStorage.removeItem(key), DRAFT_KEY);
  await page.reload();
  await expect(page.locator('.app-header').getByRole('button', { name: /^Сохранить/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть проект Карта GitHub Pages', exact: true }).click();
  await expect.poll(async () => (await draft(page)).id).toBe(map.id);
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await page.locator('#export-scale').selectOption('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click();
  const image = PNG.sync.read(await readFile((await (await download).path())!));
  expect([image.width, image.height]).toEqual([24 * 32, 20 * 32]);
  let floorPixels = 0, wallPixels = 0, objectPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const [r, g, b] = image.data.subarray(index, index + 3);
    if (r < 60 && g > 110 && b > 145) floorPixels++;
    if (r > 130 && g < 65 && b < 60) wallPixels++;
    if (r > 210 && g < 50 && b > 195) objectPixels++;
  }
  expect(floorPixels).toBeGreaterThan(1000);
  expect(wallPixels).toBeGreaterThan(500);
  expect(objectPixels).toBeGreaterThan(100);
  const localValues = await page.evaluate(() => Object.values(localStorage));
  expect(localValues.every(value => !value.includes('data:image') && !value.includes('blob:'))).toBeTruthy();
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('browser PNG and ZIP validation rejects corruption, unsafe archives and oversized streams atomically', async ({ page }) => {
  await start(page);
  const good = markerPng();
  const badCrc = Buffer.from(good);
  badCrc[29] ^= 1;
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'atomic-valid.png', mimeType: 'image/png', buffer: good },
    { name: 'bad-crc.png', mimeType: 'image/png', buffer: badCrc },
  ]);
  await expect(page.getByRole('alert')).toContainText('повреждён');
  expect(await storedAssets(page)).toHaveLength(0);
  expect(await stagedCount(page)).toBe(0);

  const zip = Buffer.from(zipSync({ 'image.png': good }));
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE((zip.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  zip.writeUInt32LE((zip.readUInt32LE(14) ^ 1) >>> 0, 14);
  const encrypted = Buffer.from(zipSync({ 'image.png': good }));
  const encryptedCentral = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 1, encryptedCentral + 8);
  const bomb = Buffer.from(zipSync({ 'bomb.png': new Uint8Array(9 * 1024 * 1024) }));
  const bombCentral = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(100, 22);
  bomb.writeUInt32LE(100, bombCentral + 24);
  const zip64 = Buffer.from(zipSync({ 'image.png': good }));
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 8);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  const expanded = declareZipSizes(Buffer.from(zipSync({ 'a.txt': new Uint8Array(0), 'b.txt': new Uint8Array(0), 'c.txt': new Uint8Array(0) })), 3 * GiB);
  const largeHeader = declareZipSizes(Buffer.from(zipSync({ 'large.png': good })), IMPORT_LIMITS.pngBytes + 1);
  const normal = Buffer.from(zipSync({ 'tail.png': good }));
  const normalCentral = normal.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const junkBytes = 1024 * 1024;
  const trailingJunk = Buffer.concat([normal.subarray(0, normalCentral), Buffer.alloc(junkBytes), normal.subarray(normalCentral)]);
  const junkCentral = normalCentral + junkBytes;
  trailingJunk.writeUInt32LE(trailingJunk.readUInt32LE(18) + junkBytes, 18);
  trailingJunk.writeUInt32LE(trailingJunk.readUInt32LE(junkCentral + 20) + junkBytes, junkCentral + 20);
  trailingJunk.writeUInt32LE(junkCentral, trailingJunk.length - 22 + 16);
  const cases = [
    { name: 'checksum.zip', buffer: zip, error: 'Контрольная сумма' },
    { name: 'path.zip', buffer: Buffer.from(zipSync({ '../escape.png': good })), error: 'небезопасный путь' },
    { name: 'encrypted.zip', buffer: encrypted, error: 'Зашифрованные' },
    { name: 'bomb.zip', buffer: bomb, error: 'слишком большой' },
    { name: 'zip64.zip', buffer: zip64, error: 'ZIP64' },
    { name: 'expanded.zip', buffer: expanded, error: '8 ГиБ' },
    { name: 'large-header.zip', buffer: largeHeader, error: '64 МиБ' },
    { name: 'trailing-junk.zip', buffer: trailingJunk, error: 'Сжатый файл ZIP повреждён' },
  ];
  for (const file of cases) {
    await page.locator('input[type=file]').first().setInputFiles({ name: file.name, mimeType: 'application/zip', buffer: file.buffer });
    await expect(page.getByRole('alert')).toContainText(file.error);
    expect(await storedAssets(page)).toHaveLength(0);
    expect(await stagedCount(page)).toBe(0);
  }
  await page.locator('input[type=file]').first().setInputFiles({ name: 'recovered.png', mimeType: 'image/png', buffer: good });
  await expect(page.getByRole('button', { name: 'Разместить ассет recovered', exact: true })).toBeVisible();
  expect(await storedAssets(page)).toHaveLength(1);
});

test('saved floor and wall references prevent deletion; projects and assets can be deleted afterwards', async ({ page }) => {
  await start(page);
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'floor-ref.png', mimeType: 'image/png', buffer: markerPng() },
    { name: 'wall-ref.png', mimeType: 'image/png', buffer: markerPng() },
  ]);
  await expect(page.getByRole('button', { name: 'Разместить ассет floor-ref', exact: true })).toBeVisible();
  await categorize(page, 'floor-ref', 'floors');
  await categorize(page, 'wall-ref', 'walls');
  await page.getByRole('button', { name: 'Разместить ассет floor-ref', exact: true }).click();
  await page.getByRole('button', { name: 'Разместить ассет wall-ref', exact: true }).click();
  await page.getByRole('textbox', { name: 'Название проекта', exact: true }).fill('Защита текстур');
  await page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.getByText('Проект сохранён на этом устройстве', { exact: true })).toBeVisible();
  for (const name of ['floor-ref', 'wall-ref']) {
    await page.getByRole('button', { name: `Свойства ассета ${name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('используется в сохранённом проекте «Защита текстур»');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
  expect(await storedAssets(page)).toHaveLength(2);
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить проект Защита текстур', exact: true }).click();
  await expect(page.getByText('Пока здесь пусто', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  expect(await storedProjects(page)).toHaveLength(0);
  for (const name of ['floor-ref', 'wall-ref']) {
    await page.getByRole('button', { name: `Свойства ассета ${name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  expect(await storedAssets(page)).toHaveLength(0);
  // A stale draft still cannot create a project referencing deleted images.
  await page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.getByRole('alert')).toContainText('отсутствующий ассет');
  expect(await storedProjects(page)).toHaveLength(0);
});

test('concurrent save and image deletion in different tabs cannot create a broken saved project', async ({ page, context }) => {
  await start(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'shared-floor.png', mimeType: 'image/png', buffer: markerPng() });
  await expect(page.getByRole('button', { name: 'Разместить ассет shared-floor', exact: true })).toBeVisible();
  await categorize(page, 'shared-floor', 'floors');
  await page.getByRole('button', { name: 'Разместить ассет shared-floor', exact: true }).click();
  const second = await context.newPage();
  await start(second);
  await second.getByRole('button', { name: /^Мои ассеты/ }).click();
  await second.getByRole('button', { name: 'Свойства ассета shared-floor', exact: true }).click();
  await Promise.all([
    page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click(),
    second.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click(),
  ]);
  // The winner may vary; both outcomes must preserve the reference invariant.
  await expect.poll(async () => {
    const assetCount = (await storedAssets(page)).length;
    const projectCount = (await storedProjects(page)).length;
    return (assetCount === 1 && projectCount === 1) || (assetCount === 0 && projectCount === 0);
  }).toBeTruthy();
  const available = new Set((await storedAssets(page)).map(asset => asset.id));
  for (const project of await storedProjects(page)) {
    expect(project.elements.filter(element => element.type === 'room' || element.type === 'corridor')
      .every(element => 'floorAssetId' in element && available.has(element.floorAssetId!))).toBeTruthy();
  }
});

test('large PNGs and asset batches above the former limits publish fully and report progress', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const events: { processed: number; total: number; phase: string }[] = [];
    (window as typeof window & { importEvents: typeof events }).importEvents = events;
    window.addEventListener('dungeonai-import-progress', event => events.push((event as CustomEvent).detail));
  });
  const large = largePngFixture();
  expect(large.length).toBeGreaterThan(8 * 1024 * 1024);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'large-real.png', mimeType: 'image/png', buffer: large });
  await expect(page.getByText('Добавлено ассетов: 1', { exact: true })).toBeVisible();
  expect((await storedAssets(page))[0].blobSize).toBe(large.length);
  expect(await stagedCount(page)).toBe(0);
  const archive = zipSync(Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`bulk/bulk-${String(index).padStart(3, '0')}.png`, markerPng()])));
  await page.locator('input[type=file]').first().setInputFiles({ name: 'large-library.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  await expect(page.getByText('Добавлено ассетов: 205', { exact: true })).toBeVisible();
  expect(await storedAssets(page)).toHaveLength(206);
  expect(await stagedCount(page)).toBe(0);
  await expect(page.locator('.uploaded-card')).toHaveCount(96);
  await page.getByRole('button', { name: 'Следующая страница ассетов', exact: true }).click();
  await expect(page.locator('.asset-pagination')).toContainText('97–192 из 206');
  await page.getByRole('textbox', { name: 'Поиск ассетов', exact: true }).fill('bulk-204');
  await expect(page.getByRole('button', { name: 'Разместить ассет bulk-204', exact: true })).toBeVisible();
  await expect(page.locator('.uploaded-card')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Поиск ассетов', exact: true }).fill('');
  await page.locator('input[type=file]').first().setInputFiles(Array.from({ length: 35 }, (_, index) => ({
    name: `loose-${index}.png`, mimeType: 'image/png', buffer: markerPng(),
  })));
  await expect(page.getByText('Добавлено ассетов: 35', { exact: true })).toBeVisible();
  expect(await storedAssets(page)).toHaveLength(241);
  expect(await stagedCount(page)).toBe(0);
  const events = await page.evaluate(() => (window as typeof window & { importEvents: { processed: number; total: number; phase: string }[] }).importEvents);
  expect(events.some(event => event.phase === 'validate' && event.processed === 205 && event.total === 205)).toBeTruthy();
  expect(events.some(event => event.phase === 'commit' && event.processed === 205 && event.total === 205)).toBeTruthy();
  expect(events.every(event => event.processed >= 0 && event.processed <= event.total)).toBeTruthy();
  await page.getByRole('button', { name: 'Создать карту', exact: true }).first().click();
  await page.locator('#map-prompt').fill('Таверна с 3 комнатами');
  await page.getByRole('spinbutton', { name: 'Ширина карты в клетках', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: 'Высота карты в клетках', exact: true }).fill('20');
  await page.locator('.generate-button').click();
  await expect(page.getByText('Карта создана локальным процедурным генератором', { exact: true })).toBeVisible();
  const map = await draft(page);
  expect(map.elements.some(element => element.type === 'object' && element.assetId)).toBeTruthy();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('version 1 projects and PNGs survive IndexedDB migration and only abandoned old staging is removed', async ({ page }) => {
  // An empty same-origin page lets us seed an actual old database before the app opens it.
  await page.route('**/migration-seed.html', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>Migration fixture</body></html>' }));
  await page.goto('./migration-seed.html');
  const now = new Date().toISOString();
  const document: MapDocument = {
    schemaVersion: 1, id: 'migration-project', name: 'Сохранено до обновления', createdAt: now, updatedAt: now,
    width: 12, height: 12, gridSize: 32, theme: 'crypt', seed: 'migration', prompt: '', generationMode: 'manual',
    elements: [{ id: 'migration-object', type: 'object', x: 3, y: 3, width: 2, height: 1, rotation: 0, kind: 'chest', assetId: 'migration-image' }],
  };
  await page.evaluate(({ name, bytes, document }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('assets', { keyPath: 'id' });
      open.result.createObjectStore('projects', { keyPath: 'id' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['assets', 'projects'], 'readwrite');
      tx.objectStore('assets').add({ id: 'migration-image', name: 'старый PNG', filename: 'старый PNG.png', width: 16, height: 8,
        category: 'objects', tags: [], createdAt: document.createdAt, blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }) });
      tx.objectStore('projects').add(document);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { name: DB_NAME, bytes: [...markerPng()], document });
  await start(page);
  expect((await storedProjects(page))[0]).toEqual(document);
  expect(await storedAssets(page)).toHaveLength(1);
  expect(await stagedCount(page)).toBe(0);
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть проект Сохранено до обновления', exact: true }).click();
  await expect.poll(async () => (await draft(page)).id).toBe(document.id);
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await page.locator('#export-scale').selectOption('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click();
  const image = PNG.sync.read(await readFile((await (await download).path())!));
  let markerPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] > 210 && image.data[index + 1] < 50 && image.data[index + 2] > 195) markerPixels++;
  }
  expect(markerPixels).toBeGreaterThan(500);
  await page.evaluate(name => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('importStaging', 'readwrite');
      tx.objectStore('importStaging').add({ id: 'old-staging', batchId: 'abandoned', stagedAt: Date.now() - 25 * 60 * 60 * 1000 });
      tx.objectStore('importStaging').add({ id: 'other-tab-staging', batchId: 'active', stagedAt: Date.now() });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), DB_NAME);
  await page.reload();
  await expect(page.locator('.app-header').getByRole('button', { name: /^Сохранить/ })).toBeEnabled();
  expect(await stagedCount(page)).toBe(1);
  expect((await storedProjects(page))[0]).toEqual(document);
  expect(await storedAssets(page)).toHaveLength(1);
});
