import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { zipSync } from 'fflate';
import { createApp } from '../server/app.js';
import type { Asset, Capabilities, MapDocument } from '../shared/types.js';

function pngFixture(): Buffer {
  const png = new PNG({ width: 3, height: 2 });
  png.data.set([
    255, 0, 0, 255, 0, 255, 0, 180, 0, 0, 255, 0,
    0, 0, 0, 255, 255, 255, 255, 255, 100, 100, 100, 80,
  ]);
  return PNG.sync.write(png);
}

async function listen(dataDir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp({ dataDir });
  const server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withServer(action: (base: string, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dungeon-backend-'));
  const server = await listen(dataDir);
  try { await action(server.base, dataDir); }
  finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function multipart(files: { name: string; data: Uint8Array }[]): FormData {
  const data = new FormData();
  for (const file of files) {
    data.append('files', new Blob([new Uint8Array(file.data)], { type: file.name.endsWith('.png') ? 'image/png' : 'application/octet-stream' }), file.name);
  }
  return data;
}

function jsonBody(value: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

test('PNG import decodes pixels, persists across server restart, and supports metadata edits', async () => {
  await withServer(async (base, dataDir) => {
    const png = pngFixture();
    const uploaded = await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'сундук.png', data: png }]) });
    assert.equal(uploaded.status, 201);
    const result = await uploaded.json() as { assets: Asset[]; warnings: string[] };
    assert.equal(result.assets.length, 1);
    const asset = result.assets[0]!;
    assert.equal(asset.width, 3);
    assert.equal(asset.height, 2);
    assert.equal(asset.name, 'сундук');
    assert.equal(asset.filename, 'сундук.png');
    const image = await fetch(`${base}${asset.url}`);
    assert.match(image.headers.get('content-type') ?? '', /^image\/png/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const edited = await fetch(`${base}/api/assets/${asset.id}`, {
      method: 'PATCH', ...jsonBody({ name: 'Сундук', category: 'objects', tags: ['loot', 'wood'] }),
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json() as Asset).name, 'Сундук');
    const restarted = await listen(dataDir);
    try {
      const persisted = await fetch(`${restarted.base}/api/assets`);
      assert.equal((await persisted.json() as Asset[])[0]!.name, 'Сундук');
    } finally { await restarted.close(); }
    const boundary = 'dungeon-legacy-filename';
    const legacyBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="café.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const legacy = await fetch(`${base}/api/assets`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: legacyBody,
    });
    assert.equal(legacy.status, 201);
    const legacyAsset = (await legacy.json() as { assets: Asset[] }).assets[0]!;
    assert.equal(legacyAsset.name, 'café');
    assert.equal(legacyAsset.filename, 'café.png');
  });
});

test('ZIP PNG import verifies checksums and reports skipped files; unsupported native formats stay false', async () => {
  await withServer(async (base) => {
    const archive = zipSync({ 'pack/objects/сундук.png': pngFixture(), 'README.txt': new TextEncoder().encode('pack description') });
    const response = await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'коллекция.zip', data: archive }]) });
    assert.equal(response.status, 201);
    const result = await response.json() as { assets: Asset[]; warnings: string[] };
    assert.equal(result.assets[0]!.pack, 'коллекция');
    assert.equal(result.assets[0]!.filename, 'сундук.png');
    assert.equal(result.assets[0]!.name, 'сундук');
    assert.equal(result.warnings.length, 1);
    const capabilities = await (await fetch(`${base}/api/capabilities`)).json() as Capabilities;
    assert.deepEqual(capabilities.formats, { png: true, pngZip: true, dungeondraftPack: false, dungeondraftExport: false });
    assert.equal(capabilities.ai.configured, false);
    const native = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart([{ name: 'collection.dungeondraft_pack', data: new Uint8Array([1, 2, 3]) }]),
    });
    assert.equal(native.status, 415);

    const corrupt = Buffer.from(zipSync({ 'otherwise-valid.png': pngFixture() }, { level: 0 }));
    const centralDirectory = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(centralDirectory >= 0);
    corrupt.writeUInt32LE(0, centralDirectory + 16);
    const badZip = await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'bad-checksum.zip', data: corrupt }]) });
    assert.equal(badZip.status, 400);
    assert.equal((await (await fetch(`${base}/api/assets`)).json() as Asset[]).length, 1);
  });
});

test('invalid PNGs, traversal archives, excessive entries, and invalid batches do not change storage', async () => {
  await withServer(async (base) => {
    const corruptPng = Buffer.from(pngFixture());
    corruptPng[29] = corruptPng[29]! ^ 255;
    const badBatch = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart([{ name: 'good.png', data: pngFixture() }, { name: 'bad.png', data: corruptPng }]),
    });
    assert.equal(badBatch.status, 400);
    const fake = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart([{ name: 'fake.png', data: new TextEncoder().encode('PNG is only a filename') }]),
    });
    assert.equal(fake.status, 400);
    const traversal = zipSync({ '../escape.png': pngFixture() });
    assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'traversal.zip', data: traversal }]) })).status, 400);
    const crowded = zipSync(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.txt`, new Uint8Array()])));
    assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'crowded.zip', data: crowded }]) })).status, 413);
    assert.deepEqual(await (await fetch(`${base}/api/assets`)).json(), []);
  });
});

test('multipart byte budgets and ZIP expansion budgets reject oversized requests before import', async () => {
  await withServer(async (base) => {
    const tooLargeFile = new Uint8Array(8 * 1024 * 1024 + 1);
    const perFile = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart([{ name: 'huge.png', data: tooLargeFile }]),
    });
    assert.equal(perFile.status, 413);
    const medium = new Uint8Array(6 * 1024 * 1024);
    const total = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart(['one.png', 'two.png', 'three.png'].map((name) => ({ name, data: medium }))),
    });
    assert.equal(total.status, 413);
    const expansion = Buffer.from(zipSync({ 'bomb.png': pngFixture() }));
    const centralDirectory = expansion.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(centralDirectory >= 0);
    expansion.writeUInt32LE(65 * 1024 * 1024, centralDirectory + 24);
    const archive = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart([{ name: 'bomb.zip', data: expansion }]),
    });
    assert.equal(archive.status, 413);
    assert.deepEqual(await (await fetch(`${base}/api/assets`)).json(), []);
  });
});

test('local generation, project round trip and reference-safe asset deletion work through HTTP', async () => {
  await withServer(async (base, dataDir) => {
    const assetResponse = await fetch(`${base}/api/assets`, { method: 'POST', body: multipart([{ name: 'table.png', data: pngFixture() }]) });
    const asset = ((await assetResponse.json()) as { assets: Asset[] }).assets[0]!;
    const generated = await fetch(`${base}/api/generate`, {
      method: 'POST', ...jsonBody({ prompt: 'Таверна с двумя комнатами и сундуком', width: 24, height: 20, theme: 'tavern', seed: 'backend-test', mode: 'local', assetIds: [asset.id] }),
    });
    assert.equal(generated.status, 200);
    const document = await generated.json() as MapDocument;
    assert.equal(document.generationMode, 'local');
    assert.ok(document.elements.some((element) => element.type === 'room'));
    document.elements.push({ id: 'uploaded-object', type: 'object', x: 2, y: 2, width: 1.5, height: 1, rotation: 0, kind: 'table', assetId: asset.id });
    const save = await fetch(`${base}/api/projects/${document.id}`, { method: 'PUT', ...jsonBody(document) });
    assert.equal(save.status, 200);
    const saved = await save.json() as MapDocument;
    assert.equal(saved.elements.length, document.elements.length);
    assert.deepEqual((await (await fetch(`${base}/api/projects/${document.id}`)).json()), saved);
    const blockedDelete = await fetch(`${base}/api/assets/${asset.id}`, { method: 'DELETE' });
    assert.equal(blockedDelete.status, 409);
    const restarted = await listen(dataDir);
    try {
      assert.deepEqual(await (await fetch(`${restarted.base}/api/projects/${document.id}`)).json(), saved);
      assert.equal((await (await fetch(`${restarted.base}/api/projects`)).json()).length, 1);
    } finally { await restarted.close(); }
    assert.equal((await fetch(`${base}/api/projects/${document.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/assets/${asset.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}${asset.url}`)).status, 404);
  });
});

test('classified PNG floors, walls, and objects survive generation and persistence with protected references', async () => {
  await withServer(async (base, dataDir) => {
    const uploaded = await fetch(`${base}/api/assets`, {
      method: 'POST', body: multipart(['floor.png', 'wall.png', 'table.png'].map((name) => ({ name, data: pngFixture() }))),
    });
    assert.equal(uploaded.status, 201);
    const assets = (await uploaded.json() as { assets: Asset[] }).assets;
    const floor = assets.find((asset) => asset.name === 'floor')!;
    const wall = assets.find((asset) => asset.name === 'wall')!;
    const object = assets.find((asset) => asset.name === 'table')!;
    for (const [id, category] of [[floor.id, 'floors'], [wall.id, 'walls'], [object.id, 'objects']]) {
      assert.equal((await fetch(`${base}/api/assets/${id}`, { method: 'PATCH', ...jsonBody({ category }) })).status, 200);
    }
    const generated = await fetch(`${base}/api/generate`, {
      method: 'POST', ...jsonBody({ prompt: 'Таверна с двумя комнатами и столом', width: 24, height: 20, theme: 'tavern', seed: 'texture-test', mode: 'local', assetIds: assets.map((asset) => asset.id) }),
    });
    assert.equal(generated.status, 200);
    const document = await generated.json() as MapDocument;
    assert.equal(document.wallAssetId, wall.id);
    assert.ok(document.elements.some((element) => (element.type === 'room' || element.type === 'corridor') && element.floorAssetId === floor.id));
    assert.ok(document.elements.some((element) => element.type === 'object' && element.assetId === object.id));
    document.elements.push({ id: 'textured-wall', type: 'wall', x: 1, y: 1, x2: 3, y2: 1, thickness: 0.2, assetId: wall.id });
    const save = await fetch(`${base}/api/projects/${document.id}`, { method: 'PUT', ...jsonBody(document) });
    assert.equal(save.status, 200);
    const saved = await save.json() as MapDocument;
    const restarted = await listen(dataDir);
    try {
      assert.deepEqual(await (await fetch(`${restarted.base}/api/projects/${document.id}`)).json(), saved);
      for (const asset of assets) {
        assert.equal((await fetch(`${restarted.base}/api/assets/${asset.id}`, { method: 'DELETE' })).status, 409);
      }
    } finally { await restarted.close(); }

    // An explicit wall remains a protected reference even without the perimeter texture.
    const explicitWallOnly = { ...saved, wallAssetId: undefined, elements: saved.elements.filter((element) => element.type === 'wall') };
    assert.equal((await fetch(`${base}/api/projects/${document.id}`, { method: 'PUT', ...jsonBody(explicitWallOnly) })).status, 200);
    assert.equal((await fetch(`${base}/api/assets/${wall.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await fetch(`${base}/api/projects/${document.id}`, { method: 'DELETE' })).status, 204);
    for (const asset of assets) {
      assert.equal((await fetch(`${base}/api/assets/${asset.id}`, { method: 'DELETE' })).status, 204);
    }
  });
});

test('project and generation validation reject dangerous IDs, missing assets, invalid geometry and unknown AI credentials', async () => {
  await withServer(async (base) => {
    const input = { prompt: 'Крипта и коридор', width: 24, height: 20, theme: 'crypt', seed: 'validation', mode: 'local', assetIds: [] };
    const doc = await (await fetch(`${base}/api/generate`, { method: 'POST', ...jsonBody(input) })).json() as MapDocument;
    const badGeometry = { ...doc, elements: [{ id: 'bad-room', type: 'room', x: 23, y: 1, width: 3, height: 3, floor: 'stone' }] };
    assert.equal((await fetch(`${base}/api/projects/${doc.id}`, { method: 'PUT', ...jsonBody(badGeometry) })).status, 400);
    const missing = { ...doc, elements: [{ id: 'bad-object', type: 'object', x: 2, y: 2, width: 1, height: 1, rotation: 0, kind: 'chest', assetId: 'missing-asset' }] };
    assert.equal((await fetch(`${base}/api/projects/${doc.id}`, { method: 'PUT', ...jsonBody(missing) })).status, 400);
    const missingFloor = { ...doc, elements: [{ id: 'bad-floor', type: 'room', x: 2, y: 2, width: 3, height: 3, floor: 'stone', floorAssetId: 'missing-asset' }] };
    assert.equal((await fetch(`${base}/api/projects/${doc.id}`, { method: 'PUT', ...jsonBody(missingFloor) })).status, 400);
    const missingWall = { ...doc, wallAssetId: 'missing-asset' };
    assert.equal((await fetch(`${base}/api/projects/${doc.id}`, { method: 'PUT', ...jsonBody(missingWall) })).status, 400);
    const missingExplicitWall = { ...doc, elements: [{ id: 'bad-wall', type: 'wall', x: 1, y: 1, x2: 3, y2: 1, thickness: 0.2, assetId: 'missing-asset' }] };
    assert.equal((await fetch(`${base}/api/projects/${doc.id}`, { method: 'PUT', ...jsonBody(missingExplicitWall) })).status, 400);
    assert.equal((await fetch(`${base}/api/projects/mismatched`, { method: 'PUT', ...jsonBody(doc) })).status, 400);
    assert.equal((await fetch(`${base}/api/projects/%2e%2e%2f`)).status, 400);
    const unknownAsset = await fetch(`${base}/api/generate`, { method: 'POST', ...jsonBody({ ...input, assetIds: ['missing-asset'] }) });
    assert.equal(unknownAsset.status, 400);
    const ai = await fetch(`${base}/api/generate`, { method: 'POST', ...jsonBody({ ...input, mode: 'ai' }) });
    assert.equal(ai.status, 503);
    assert.equal((await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
    assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), []);
  });
});
