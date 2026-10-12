import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { PNG } from 'pngjs';
import type { MapDocument } from '../../shared/types';

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
  const cases = [
    { name: 'checksum.zip', buffer: zip, error: 'Контрольная сумма' },
    { name: 'path.zip', buffer: Buffer.from(zipSync({ '../escape.png': good })), error: 'небезопасный путь' },
    { name: 'encrypted.zip', buffer: encrypted, error: 'Зашифрованные' },
    { name: 'bomb.zip', buffer: bomb, error: 'слишком большой' },
    { name: 'count.zip', buffer: Buffer.from(zipSync(Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`${index}.txt`, new Uint8Array(0)])))), error: '200 записей' },
  ];
  for (const file of cases) {
    await page.locator('input[type=file]').first().setInputFiles({ name: file.name, mimeType: 'application/zip', buffer: file.buffer });
    await expect(page.getByRole('alert')).toContainText(file.error);
    expect(await storedAssets(page)).toHaveLength(0);
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
