import assert from 'node:assert/strict';
import test from 'node:test';
import { perimeterSegments, preloadMapAssets } from '../src/mapRenderer.js';
import { hitTestElement } from '../src/MapCanvas.js';
import type { MapDocument, ObjectElement, RectElement, WallElement } from '../shared/types.js';

const room = (x: number, y: number, width: number, height: number, type: 'room' | 'corridor' = 'room'): RectElement => ({ id: `r-${x}-${y}`, type, x, y, width, height, floor: 'stone' });
const perimeter = (rooms: RectElement[]) => perimeterSegments(rooms).reduce((total, segment) => total + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1), 0);
const allLayers = { rooms: true, walls: true, objects: true };

test('room and corridor share an open passage instead of an internal perimeter wall', () => {
  const rooms = [room(1, 1, 4, 4), room(5, 2, 3, 1, 'corridor')];
  assert.equal(perimeter(rooms), 22);
  assert.equal(perimeterSegments(rooms).some(segment => segment.x1 === 5 && segment.x2 === 5 && segment.y1 < 3 && segment.y2 > 2), false);
});

test('fractional room boundaries stay exact and overlapping floors form one perimeter', () => {
  assert.equal(perimeter([room(0.5, 0.25, 3.5, 3), room(4, 1, 1.75, 0.5, 'corridor')]), 16.5);
  assert.equal(perimeter([room(1, 1, 4, 4), room(3, 1, 4, 4)]), 20);
  assert.equal(perimeter([room(1, 1, 4, 4), room(1, 1, 4, 4)]), 16);
  assert.equal(perimeter([room(1, 1, 4, 4), room(2, 2, 1, 1)]), 16);
});

test('touching corners do not erase boundaries and an inner courtyard retains its walls', () => {
  assert.equal(perimeter([room(0, 0, 4, 4), room(4, 4, 4, 4)]), 32);
  const courtyard = [room(0, 0, 6, 1), room(0, 5, 6, 1), room(0, 1, 1, 4), room(5, 1, 1, 4)];
  assert.equal(perimeter(courtyard), 40);
  assert.equal(perimeter([]), 0);
});

test('general overlapping room unions match independently counted exposed grid edges', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const rooms = Array.from({ length: 25 }, (_, index) => room((index * 7 + seed) % 12, (index * 11 + seed * 3) % 12, (index + seed) % 4 + 1, (index * 3 + seed) % 4 + 1));
    const cells = new Set<string>();
    for (const rect of rooms) for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) cells.add(`${x},${y}`);
    let exposedEdges = 0;
    for (const cell of cells) {
      const [x, y] = cell.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!cells.has(`${x + dx},${y + dy}`)) exposedEdges++;
    }
    assert.equal(perimeter(rooms), exposedEdges);
  }
});

test('selection follows rotated object bounds and the visible rendering order', () => {
  const object: ObjectElement = { id: 'object', type: 'object', x: 2, y: 2, width: 2, height: 1, rotation: 90, kind: 'chest' };
  const floor = room(1, 1, 6, 6);
  const wall: WallElement = { id: 'wall', type: 'wall', x: 1, y: 2.5, x2: 6, y2: 2.5, thickness: 0.22 };
  const elements = [object, wall, floor];
  assert.equal(hitTestElement({ x: 3, y: 1.7 }, elements, allLayers)?.id, object.id);
  assert.equal(hitTestElement({ x: 2.2, y: 2.5 }, [object], allLayers), undefined);
  assert.equal(hitTestElement({ x: 3, y: 2.5 }, elements, allLayers)?.id, object.id);
  assert.equal(hitTestElement({ x: 3, y: 2.5 }, elements, { ...allLayers, objects: false })?.id, wall.id);
  assert.equal(hitTestElement({ x: 3, y: 2.5 }, elements, { ...allLayers, objects: false, walls: false })?.id, floor.id);
  assert.equal(hitTestElement({ x: 3, y: 2.5 }, elements, { rooms: false, objects: false, walls: false }), undefined);
});

test('export preparation requires floor, explicit wall and global perimeter PNG assets', async () => {
  const document: MapDocument = { schemaVersion: 1, id: 'map', name: 'Map', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', width: 20, height: 20, gridSize: 32, theme: 'crypt', seed: 'test', prompt: '', generationMode: 'manual', elements: [] };
  await preloadMapAssets(document, []);
  await assert.rejects(preloadMapAssets({ ...document, elements: [{ ...room(1, 1, 4, 4), floorAssetId: 'missing-floor' }] }, []), /missing-floor/);
  await assert.rejects(preloadMapAssets({ ...document, wallAssetId: 'missing-perimeter' }, []), /missing-perimeter/);
  await assert.rejects(preloadMapAssets({ ...document, elements: [{ id: 'wall', type: 'wall', x: 1, y: 1, x2: 4, y2: 1, thickness: 0.22, assetId: 'missing-wall' }] }, []), /missing-wall/);
});
