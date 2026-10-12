import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationError, generateAIMap, generateLocalMap, parseRoomCount } from '../server/generator.js';
import type { Asset, GenerationInput, MapDocument, RectElement } from '../shared/types.js';
import { generationInputSchema, mapDocumentSchema } from '../shared/validation.js';

const input: GenerationInput = { prompt: 'Склеп: 6 комнат, сундуки и факелы', width: 32, height: 24, theme: 'crypt', seed: 'test-seed', mode: 'local', assetIds: [] };
const asset: Asset = { id: 'asset-table', name: 'Большой стол', filename: 'table.png', width: 200, height: 100, category: 'objects', tags: ['table', 'стол'], url: '/api/assets/asset-table/file', createdAt: '2026-01-01T00:00:00.000Z' };

function assertConnected(map: MapDocument) {
  const floors = map.elements.filter((element): element is RectElement => element.type === 'room' || element.type === 'corridor');
  const cells = new Set<string>();
  for (const floor of floors) {
    for (let y = floor.y; y < floor.y + floor.height; y++) {
      for (let x = floor.x; x < floor.x + floor.width; x++) cells.add(`${x},${y}`);
    }
  }
  assert.ok(cells.size > 0);
  const visited = new Set<string>();
  const queue = [cells.values().next().value!];
  visited.add(queue[0]);
  for (let index = 0; index < queue.length; index++) {
    const [x, y] = queue[index].split(',').map(Number);
    for (const next of [`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`]) {
      if (cells.has(next) && !visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  assert.equal(visited.size, cells.size, 'Every floor cell must connect to the entrance');
  for (const object of map.elements) {
    if (object.type !== 'object') continue;
    assert.ok(floors.some(room => room.type === 'room' && object.x >= room.x && object.y >= room.y && object.x + object.width <= room.x + room.width && object.y + object.height <= room.y + room.height), 'Generated objects must fit inside rooms');
  }
}

test('local seed reproduces layout and a different seed changes it', () => {
  const first = generateLocalMap(input, []);
  const again = generateLocalMap(input, []);
  assert.deepEqual(first.elements, again.elements);
  assert.notDeepEqual(first.elements, generateLocalMap({ ...input, seed: 'different-seed' }, []).elements);
  assert.equal(first.generationMode, 'local');
  assert.equal(first.gridSize, 32);
  assert.equal(first.elements.filter(element => element.type === 'room').length, 6);
  assert.equal(first.elements.some(element => element.type === 'wall'), false, 'Perimeter is derived from floor union instead of sealing each room');
});

test('room counts understand RU/EN room descriptions without counting corridor numbers', () => {
  assert.equal(parseRoomCount('четыре большие комнаты и 2 коридора'), 4);
  assert.equal(parseRoomCount('Three rooms with 9 chests'), 3);
  assert.equal(parseRoomCount('2 комнаты и 3 больших зала'), 5);
  assert.equal(parseRoomCount('Rooms: 8, water and stone'), 8);
  assert.equal(parseRoomCount('Ancient crypt with corridors'), undefined);
});

test('varied dimensions, seeds, and requested counts always produce bounded connected floors', () => {
  for (const width of [12, 13, 24, 32, 80]) {
    for (const height of [12, 17, 24, 80]) {
      for (const count of [1, 2, 6, 24, 99]) {
        const map = generateLocalMap({ ...input, width, height, prompt: `${count} rooms and corridors`, seed: `${width}-${height}-${count}` }, []);
        const expected = Math.max(1, Math.min(count, 24, Math.floor((width - 2) / 5) * Math.floor((height - 2) / 5)));
        assert.equal(map.elements.filter(element => element.type === 'room').length, expected);
        assert.ok(mapDocumentSchema.safeParse(map).success);
        assertConnected(map);
      }
    }
  }
});

test('selected PNG assets are used inside rooms with their aspect ratio and builtins remain', () => {
  const thinAsset = { ...asset, id: 'asset-thin', width: 1000, height: 1 };
  const map = generateLocalMap({ ...input, assetIds: [asset.id, thinAsset.id] }, [asset, thinAsset]);
  const objects = map.elements.filter(element => element.type === 'object');
  for (const available of [asset, thinAsset]) {
    const object = objects.find(element => element.assetId === available.id)!;
    assert.ok(object, `Selected ${available.id} must appear`);
    assert.ok(Math.abs(object.width / object.height - available.width / available.height) < 1e-9);
  }
  assert.ok(objects.some(object => !object.assetId));
  assertConnected(map);
  assert.equal(generateLocalMap(input, [asset]).elements.some(element => element.type === 'object' && element.assetId), false, 'No asset is selected implicitly');
});

test('absent or excessive selected object assets give explicit errors', () => {
  assert.throws(() => generateLocalMap({ ...input, assetIds: ['missing'] }, []), /больше не доступен/);
  const tooMany = Array.from({ length: 100 }, (_, index) => ({ ...asset, id: `asset-${index}` }));
  assert.throws(() => generateLocalMap({ ...input, width: 12, height: 12, assetIds: tooMany.map(item => item.id) }, tooMany), /недостаточно места/);
});

test('document schemas reject unsafe IDs, duplicate elements and invalid coordinates', () => {
  const map = generateLocalMap(input, []);
  assert.equal(mapDocumentSchema.safeParse({ ...map, id: '../project' }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, elements: [map.elements[0], map.elements[0]] }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, elements: [{ ...map.elements[0], x: map.width }] }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, elements: [{ ...map.elements[0], x: NaN }] }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, elements: [{ id: 'wall', type: 'wall', x: 1, y: 1, x2: 1, y2: 1, thickness: 0.1 }] }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, wallAssetId: '../texture' }).success, false);
  assert.equal(mapDocumentSchema.safeParse({ ...map, elements: [{ ...map.elements[0], floorAssetId: '../texture' }] }).success, false);
  assert.equal(generationInputSchema.safeParse({ ...input, assetIds: ['a', 'a'] }).success, false);
  assert.equal(generationInputSchema.safeParse({ ...input, width: 81 }).success, false);
});

test('local floor and wall PNG references persist without creating object images', () => {
  const floorAsset: Asset = { ...asset, id: 'floor-stone', category: 'floors' };
  const wallAsset: Asset = { ...asset, id: 'wall-brick', category: 'walls' };
  const otherFloor: Asset = { ...floorAsset, id: 'floor-secondary' };
  const map = generateLocalMap({ ...input, assetIds: [floorAsset.id, wallAsset.id, otherFloor.id, asset.id] }, [floorAsset, wallAsset, otherFloor, asset]);
  assert.equal(map.wallAssetId, wallAsset.id);
  for (const element of map.elements) {
    if (element.type === 'room' || element.type === 'corridor') assert.equal(element.floorAssetId, floorAsset.id);
    if (element.type === 'object') assert.ok(!element.assetId || element.assetId === asset.id);
  }
  assert.deepEqual(mapDocumentSchema.parse(JSON.parse(JSON.stringify(map))), map);
  assertConnected(map);
});

const validPlan = {
  name: 'Две комнаты',
  rooms: [{ x: 2, y: 2, width: 5, height: 5, label: 'Вход' }, { x: 12, y: 2, width: 5, height: 5, label: 'Зал' }],
  corridors: [{ x: 5, y: 4, width: 10, height: 2 }],
  objects: [{ x: 3, y: 3, width: 1, height: 1, rotation: 0, kind: 'chest', assetId: null }],
};
const provider = (plan: unknown): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('AI submits an authenticated structured request and accepts a validated connected plan', async () => {
  let requested = false;
  const mockFetch: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer secret-for-test');
    const body = JSON.parse(options?.body as string);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(JSON.parse(body.messages[1].content).description, input.prompt);
    requested = true;
    return provider(validPlan)(url, options);
  };
  const map = await generateAIMap({ ...input, mode: 'ai' }, [], { apiKey: 'secret-for-test', fetch: mockFetch });
  assert.ok(requested);
  assert.equal(map.generationMode, 'ai');
  assert.equal(map.name, validPlan.name);
  assertConnected(map);
});

test('AI receives only object assets and applies floor and wall textures after validated planning', async () => {
  const floorAsset: Asset = { ...asset, id: 'floor-stone', category: 'floors' };
  const wallAsset: Asset = { ...asset, id: 'wall-brick', category: 'walls' };
  const plan = { ...validPlan, objects: [{ ...validPlan.objects[0], width: 1, height: 0.5, assetId: asset.id }] };
  const mockFetch: typeof fetch = async (url, options) => {
    const request = JSON.parse(options?.body as string);
    assert.deepEqual(JSON.parse(request.messages[1].content).assets.map((item: { id: string }) => item.id), [asset.id]);
    return provider(plan)(url, options);
  };
  const map = await generateAIMap({ ...input, mode: 'ai', assetIds: [floorAsset.id, wallAsset.id, asset.id] }, [floorAsset, wallAsset, asset], { apiKey: 'test-key', fetch: mockFetch });
  assert.equal(map.wallAssetId, wallAsset.id);
  for (const element of map.elements) if (element.type === 'room' || element.type === 'corridor') assert.equal(element.floorAssetId, floorAsset.id);
  assert.equal(map.elements.some(element => element.type === 'object' && element.assetId === floorAsset.id), false);
  assertConnected(map);
});

test('AI refuses disconnected, out-of-bounds, unknown asset, rotated-outside and non-JSON plans', async () => {
  const invalidPlans: unknown[] = [
    { ...validPlan, corridors: [] },
    { ...validPlan, rooms: [{ ...validPlan.rooms[0], x: 31 }] },
    { ...validPlan, objects: [{ ...validPlan.objects[0], assetId: 'unknown' }] },
    { ...validPlan, objects: [{ ...validPlan.objects[0], x: 2, y: 2, width: 4, height: 4, rotation: 45 }] },
    { ...validPlan, unexpected: true },
    'bad content',
  ];
  for (const plan of invalidPlans) {
    await assert.rejects(generateAIMap({ ...input, mode: 'ai' }, [], { apiKey: 'test-key', fetch: provider(plan) }), (error: unknown) => error instanceof GenerationError && error.status === 502 && /некорректную/.test(error.message));
  }
  await assert.rejects(generateAIMap({ ...input, mode: 'ai', assetIds: [asset.id] }, [asset], { apiKey: 'test-key', fetch: provider(validPlan) }), /некорректную/);
});

test('AI never silently falls back or exposes provider bodies and has a timeout', async () => {
  await assert.rejects(generateAIMap({ ...input, mode: 'ai' }, [], {}), (error: unknown) => error instanceof GenerationError && error.status === 503);
  const privateBody: typeof fetch = async () => new Response('sensitive-provider-secret', { status: 401 });
  await assert.rejects(generateAIMap({ ...input, mode: 'ai' }, [], { apiKey: 'secret', fetch: privateBody }), (error: unknown) => error instanceof GenerationError && error.status === 502 && !error.message.includes('sensitive-provider-secret'));
  const stalled: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(generateAIMap({ ...input, mode: 'ai' }, [], { apiKey: 'test-key', timeoutMs: 5, fetch: stalled }), (error: unknown) => error instanceof GenerationError && error.status === 504);
});
