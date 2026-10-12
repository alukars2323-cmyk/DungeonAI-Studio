import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import type { MapDocument, ProjectSummary } from '../../shared/types';

const DRAFT_KEY = 'dungeonai-studio:draft:v1';

function markerPng(color: [number, number, number] = [254, 17, 235]) {
  const image = new PNG({ width: 16, height: 8 });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data.set([...color, 255], index);
  }
  return PNG.sync.write(image);
}

async function draft(page: Page): Promise<MapDocument> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), DRAFT_KEY);
}

async function start(page: Page) {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-header').getByRole('button', { name: /^Сохранить/ })).toBeEnabled();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Вместить карту', exact: true }).click();
}

async function point(page: Page, x: number, y: number) {
  const map = await draft(page);
  const bounds = await page.getByTestId('map-canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no bounds');
  return { x: bounds.x + x / map.width * bounds.width, y: bounds.y + y / map.height * bounds.height };
}

async function draw(page: Page, x1: number, y1: number, x2: number, y2: number) {
  const from = await point(page, x1, y1);
  const to = await point(page, x2, y2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('PNG upload, manual editing, undo, server save, reopen and exported pixels work together', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'e2e-marker.png', mimeType: 'image/png', buffer: markerPng() });
  await expect(page.getByRole('button', { name: 'Разместить ассет e2e-marker', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Разместить ассет e2e-marker', exact: true }).click();
  const target = await point(page, 20, 14);
  await page.mouse.click(target.x, target.y);
  await expect(page.getByText('PNG: e2e-marker', { exact: true })).toBeVisible();
  const placed = await draft(page);
  const object = placed.elements.at(-1)!;
  expect(object.type).toBe('object');
  if (object.type !== 'object') throw new Error('PNG was not placed');
  expect(object.width / object.height).toBe(2);
  await page.getByRole('button', { name: 'Повернуть на 90 градусов', exact: true }).click();
  expect((await draft(page)).elements.at(-1)).toMatchObject({ rotation: 90 });
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  expect((await draft(page)).elements.at(-1)).toMatchObject({ rotation: 0 });
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  expect((await draft(page)).elements.at(-1)).toMatchObject({ rotation: 90 });
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();

  await page.getByRole('textbox', { name: 'Название проекта', exact: true }).fill('Проверка PNG и сохранения');
  await page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.getByText('Проект сохранён на сервере', { exact: true })).toBeVisible();
  const summaries = await (await request.get('/api/projects')).json() as ProjectSummary[];
  const savedId = summaries.find(project => project.name === 'Проверка PNG и сохранения')!.id;
  const saved = await (await request.get(`/api/projects/${savedId}`)).json() as MapDocument;
  expect(saved.elements.find(element => element.id === object.id)).toMatchObject({ assetId: object.assetId, width: 2, height: 1 });

  // Editor visibility does not remove PNG objects from exported maps.
  await page.getByRole('checkbox', { name: /^Объекты/ }).uncheck();
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await page.locator('#export-scale').selectOption('1');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  const image = PNG.sync.read(await readFile((await file.path())!));
  expect([image.width, image.height]).toEqual([saved.width * 32, saved.height * 32]);
  let markerPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] > 210 && image.data[index + 1] < 50 && image.data[index + 2] > 195) markerPixels++;
  }
  expect(markerPixels).toBeGreaterThan(500);
  expect(image.data[3]).toBe(255);

  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть проект Проверка PNG и сохранения', exact: true }).click();
  expect((await draft(page)).id).toBe(savedId);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Название проекта', exact: true })).toHaveValue('Проверка PNG и сохранения');
  expect((await draft(page)).elements.find(element => element.id === object.id)).toMatchObject({ assetId: object.assetId });
  expect(errors).toEqual([]);
});

test('drawn rooms and walls stay editable and undo correctly; description uses uploaded library', async ({ page }) => {
  await start(page);
  const initial = await draft(page);
  await page.getByRole('button', { name: 'Помещение', exact: true }).click();
  await draw(page, 1, 1, 6, 5);
  await expect(page.locator('#element-name')).toBeVisible();
  await page.locator('#element-name').fill('Ручной зал');
  const afterRoom = await draft(page);
  expect(afterRoom.elements.at(-1)).toMatchObject({ type: 'room', x: 1, y: 1, width: 5, height: 4, label: 'Ручной зал' });
  await page.getByRole('spinbutton', { name: 'Ширина элемента', exact: true }).fill('80');
  const bounded = (await draft(page)).elements.at(-1)!;
  if (bounded.type === 'wall') throw new Error('Expected room');
  expect(bounded.x + bounded.width).toBeLessThanOrEqual(initial.width);
  await page.getByRole('button', { name: 'Стена', exact: true }).click();
  await draw(page, 3, 8, 7, 8);
  expect((await draft(page)).elements.at(-1)).toMatchObject({ type: 'wall', x: 3, y: 8, x2: 7, y2: 8 });
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  expect((await draft(page)).elements.at(-1)?.type).toBe('room');

  await page.locator('input[type=file]').first().setInputFiles({ name: 'second-test-marker.png', mimeType: 'image/png', buffer: markerPng() });
  await expect(page.getByRole('button', { name: 'Разместить ассет second-test-marker', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Создать карту', exact: true }).first().click();
  await page.locator('#map-prompt').fill('Таверна с 3 комнатами, столами и бочками');
  await page.getByRole('spinbutton', { name: 'Ширина карты в клетках', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: 'Высота карты в клетках', exact: true }).fill('20');
  await page.getByRole('button', { name: 'Таверна', exact: true }).click();
  await page.locator('.generate-button').click();
  await expect(page.getByText('Карта создана локальным процедурным генератором', { exact: true })).toBeVisible();
  const generated = await draft(page);
  expect(generated.elements.filter(element => element.type === 'room')).toHaveLength(3);
  expect(generated.theme).toBe('tavern');
  expect([generated.width, generated.height]).toEqual([24, 20]);
  expect(generated.elements.some(element => element.type === 'object' && element.assetId)).toBeTruthy();
  await expect(page.getByRole('button', { name: /С помощью ИИ/ })).toBeDisabled();
});

test('invalid uploads are reported and unsupported native formats are described honestly', async ({ page }) => {
  await start(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
  await expect(page.getByRole('alert')).toContainText('не является PNG');
  await page.getByRole('button', { name: 'Поддерживаемые форматы и справка', exact: true }).click();
  const help = page.getByRole('dialog');
  await expect(help).toContainText('.dungeondraft_pack');
  await expect(help).toContainText('Не поддерживается');
  await expect(help).toContainText('.dungeondraft_map');
  await expect(help).toContainText('в планах');
});

test('categorized floor and wall PNGs survive generation, saving and raster export', async ({ page, request }) => {
  await start(page);
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'texture-floor.png', mimeType: 'image/png', buffer: markerPng([25, 190, 230]) },
    { name: 'texture-wall.png', mimeType: 'image/png', buffer: markerPng([220, 35, 15]) },
  ]);
  await expect(page.getByRole('button', { name: 'Разместить ассет texture-floor', exact: true })).toBeVisible();
  for (const [name, category] of [['texture-floor', 'floors'], ['texture-wall', 'walls']]) {
    await page.getByRole('button', { name: `Свойства ассета ${name}`, exact: true }).click();
    await page.locator('#asset-category').selectOption(category);
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await page.getByRole('button', { name: 'Создать карту', exact: true }).first().click();
  await page.locator('#map-prompt').fill('Каменный храм с 3 комнатами и факелами');
  await page.getByRole('spinbutton', { name: 'Ширина карты в клетках', exact: true }).fill('24');
  await page.getByRole('spinbutton', { name: 'Высота карты в клетках', exact: true }).fill('20');
  await page.locator('.generate-button').click();
  await expect(page.getByText('Карта создана локальным процедурным генератором', { exact: true })).toBeVisible();
  const map = await draft(page);
  expect(map.wallAssetId).toBeTruthy();
  expect(map.elements.filter(element => element.type === 'room' || element.type === 'corridor').every(element => 'floorAssetId' in element && element.floorAssetId)).toBeTruthy();
  await page.locator('.app-header').getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.getByText('Проект сохранён на сервере', { exact: true })).toBeVisible();
  const stored = await (await request.get(`/api/projects/${map.id}`)).json() as MapDocument;
  expect(stored.wallAssetId).toBe(map.wallAssetId);
  expect(stored.elements).toEqual(map.elements);

  await page.getByRole('checkbox', { name: /^Стены/ }).uncheck();
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await page.locator('#export-scale').selectOption('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click();
  const image = PNG.sync.read(await readFile((await (await download).path())!));
  let floorPixels = 0, wallPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const [r, g, b] = image.data.subarray(index, index + 3);
    if (r < 60 && g > 110 && b > 145) floorPixels++;
    if (r > 130 && g < 65 && b < 60) wallPixels++;
  }
  expect(floorPixels).toBeGreaterThan(1000);
  expect(wallPixels).toBeGreaterThan(500);
});
