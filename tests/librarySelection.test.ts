import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset, GenerationInput } from '../shared/types';
import { generateLocalMap, selectLibraryAssets } from '../shared/localGenerator';

const input: GenerationInput = { prompt: 'Склеп с 5 комнатами и сундуками', width: 40, height: 28,
  theme: 'crypt', seed: 'large-library', mode: 'local', assetIds: [] };
const library: Asset[] = Array.from({ length: 500 }, (_, index) => ({ id: `asset-${index}`, name: `Декор ${index}`,
  filename: `${index}.png`, width: 32, height: 32, category: 'objects', tags: [], url: `/api/assets/asset-${index}/file`,
  createdAt: '2026-10-12T00:00:00.000Z' }));
library.push({ ...library[0], id: 'matching-chest', name: 'сундуками', tags: ['сундук'] },
  { ...library[0], id: 'last-floor', category: 'floors' }, { ...library[0], id: 'last-wall', category: 'walls' });

test('large libraries generate fitting maps and include textures beyond the first 200 uploads', () => {
  for (const size of [[40, 28], [12, 12], [12, 80], [80, 12]]) {
    const request = { ...input, width: size[0], height: size[1] };
    const selected = selectLibraryAssets(request, library);
    assert.ok(selected.length <= 200);
    assert.ok(selected.some(asset => asset.id === 'matching-chest'));
    const map = generateLocalMap({ ...request, assetIds: selected.map(asset => asset.id) }, library);
    assert.equal(map.wallAssetId, 'last-wall');
    assert.ok(map.elements.some(element => (element.type === 'room' || element.type === 'corridor') && element.floorAssetId === 'last-floor'));
    for (const asset of selected.filter(asset => asset.category === 'objects')) {
      assert.ok(map.elements.some(element => element.type === 'object' && element.assetId === asset.id));
    }
  }
});

test('library selection is reproducible and automatic use of huge PNGs has a decoded-pixel budget', () => {
  assert.deepEqual(selectLibraryAssets(input, library), selectLibraryAssets(input, library));
  assert.notDeepEqual(selectLibraryAssets(input, library).map(asset => asset.id),
    selectLibraryAssets({ ...input, seed: 'another-seed' }, library).map(asset => asset.id));
  const huge = library.slice(0, 30).map(asset => ({ ...asset, width: 8192, height: 8192 }));
  const selected = selectLibraryAssets(input, huge);
  assert.equal(selected.length, 2);
  assert.ok(generateLocalMap({ ...input, assetIds: selected.map(asset => asset.id) }, huge).elements.length > 0);
});
