import type { Asset, BuiltinKind, Floor, GenerationInput, MapDocument, MapElement, ObjectElement, RectElement } from './types.js';
import { generationInputSchema, mapDocumentSchema } from './validation.js';
import { GenerationError } from './generationError.js';

export const floors: Record<GenerationInput['theme'], Floor> = { crypt: 'stone', tavern: 'wood', cave: 'earth' };
const themeObjects: Record<GenerationInput['theme'], BuiltinKind[]> = {
  crypt: ['chest', 'torch', 'pillar', 'stairs'],
  tavern: ['table', 'barrel', 'bed', 'torch'],
  cave: ['chest', 'pillar', 'torch', 'stairs'],
};

function seededRandom(seed: string) {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return () => {
    hash += 0x6d2b79f5;
    let value = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/** Counts only room nouns, so “4 rooms, 2 corridors” creates four rooms. */
export function parseRoomCount(prompt: string): number | undefined {
  const text = prompt.toLowerCase();
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  };
  const number = `(?:\\d{1,3}|${Object.keys(words).join('|')})`;
  const noun = '(?:rooms?|chambers?|комнат[а-я]*|помещени[а-я]*|зал[а-я]*)';
  const matches = [...text.matchAll(new RegExp(`(?:^|[\\s,;])(${number})\\s+(?:[a-zа-яё-]+\\s+){0,2}${noun}(?=$|[\\s,.;:!?])`, 'g'))];
  if (matches.length) return matches.reduce((total, match) => total + (words[match[1]] ?? Number(match[1])), 0);
  const reverse = text.match(/(?:rooms|chambers|комнаты|помещения|залы)\s*[:=]\s*(\d{1,3})/);
  return reverse ? Number(reverse[1]) : undefined;
}

export function requestedAssets(input: GenerationInput, assets: Asset[]): Asset[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return input.assetIds.map(id => {
    const asset = byId.get(id);
    if (!asset) throw new GenerationError('Выбранный ассет больше не доступен. Обновите библиотеку.', 400);
    return asset;
  });
}

/** Choose a fitting subset for the UI's automatic-library option. */
export function selectLibraryAssets(rawInput: GenerationInput, library: Asset[]): Asset[] {
  const input = generationInputSchema.parse({ ...rawInput, assetIds: [] });
  const rooms = roomLayout(input, seededRandom(input.seed));
  const slots = rooms.reduce((total, room) => total
    + Math.max(1, Math.floor((room.width - 0.6) / 1.6)) * Math.max(1, Math.floor((room.height - 0.6) / 1.6)), 0);
  const prompt = `${input.prompt} ${input.theme}`.toLowerCase();
  const ranked = library.map((asset, index) => ({
    asset,
    index,
    score: [...asset.tags, ...asset.name.split(/[\s_.-]+/)].reduce((score, tag) =>
      score + (tag.length >= 3 && prompt.includes(tag.toLowerCase()) ? 1 : 0), 0),
    tie: seededRandom(`${input.seed}:${asset.id}`)(),
  }));
  const textures = (['floors', 'walls'] as const).flatMap(category => {
    const chosen = ranked.filter(item => item.asset.category === category)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    return chosen ? [chosen.asset] : [];
  });
  // Originals stay intact; automatic maps avoid decoding hundreds of huge PNGs.
  let remainingPixels = Math.max(0, 128 * 1024 * 1024
    - textures.reduce((total, asset) => total + asset.width * asset.height, 0));
  const objects: Asset[] = [];
  const capacity = Math.min(slots, 200 - textures.length);
  for (const item of ranked.filter(item => item.asset.category === 'objects')
    .sort((a, b) => b.score - a.score || a.tie - b.tie || a.index - b.index)) {
    if (objects.length >= capacity) break;
    const pixels = item.asset.width * item.asset.height;
    if (pixels > remainingPixels) continue;
    objects.push(item.asset);
    remainingPixels -= pixels;
  }
  return [...textures, ...objects];
}

export function baseDocument(input: GenerationInput, elements: MapElement[], mode: 'local' | 'ai', name?: string, assets: Asset[] = []): MapDocument {
  const timestamp = new Date().toISOString();
  const floorAsset = assets.find(asset => asset.category === 'floors');
  const wallAsset = assets.find(asset => asset.category === 'walls');
  return mapDocumentSchema.parse({
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    name: name?.trim().slice(0, 120) || input.prompt.slice(0, 80),
    createdAt: timestamp,
    updatedAt: timestamp,
    width: input.width,
    height: input.height,
    gridSize: 32,
    theme: input.theme,
    seed: input.seed,
    prompt: input.prompt,
    generationMode: mode,
    ...(wallAsset ? { wallAssetId: wallAsset.id } : {}),
    elements: floorAsset ? elements.map(element => element.type === 'room' || element.type === 'corridor' ? { ...element, floorAssetId: floorAsset.id } : element) : elements,
  });
}

function roomLayout(input: GenerationInput, random: () => number): RectElement[] {
  const maximumColumns = Math.floor((input.width - 2) / 5);
  const maximumRows = Math.floor((input.height - 2) / 5);
  const count = Math.max(1, Math.min(parseRoomCount(input.prompt) ?? 6, maximumColumns * maximumRows, 24));
  let columns = 1;
  let rows = 1;
  let bestScore = Infinity;
  for (let x = 1; x <= maximumColumns; x++) {
    for (let y = 1; y <= maximumRows; y++) {
      if (x * y < count) continue;
      const score = Math.abs(Math.log((input.width / x) / (input.height / y))) + (x * y - count) * 0.2;
      if (score < bestScore) { columns = x; rows = y; bestScore = score; }
    }
  }
  const slots = shuffled(Array.from({ length: columns * rows }, (_, index) => index), random).slice(0, count);
  return slots.map((slot, index) => {
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x0 = 1 + Math.floor(column * (input.width - 2) / columns);
    const y0 = 1 + Math.floor(row * (input.height - 2) / rows);
    const x1 = 1 + Math.floor((column + 1) * (input.width - 2) / columns);
    const y1 = 1 + Math.floor((row + 1) * (input.height - 2) / rows);
    const width = Math.max(3, Math.min(x1 - x0 - 2, Math.floor((x1 - x0) * (0.57 + random() * 0.23))));
    const height = Math.max(3, Math.min(y1 - y0 - 2, Math.floor((y1 - y0) * (0.57 + random() * 0.23))));
    const x = x0 + 1 + Math.floor(random() * Math.max(1, x1 - x0 - width - 1));
    const y = y0 + 1 + Math.floor(random() * Math.max(1, y1 - y0 - height - 1));
    return { id: `room-${index + 1}`, type: 'room', x, y, width, height, floor: floors[input.theme], label: index === 0 ? 'Вход' : `Зал ${index + 1}` };
  });
}

function connectRooms(rooms: RectElement[], floor: Floor, random: () => number): RectElement[] {
  const corridors: RectElement[] = [];
  const connected = new Set([0]);
  const center = (room: RectElement) => ({ x: room.x + Math.floor(room.width / 2), y: room.y + Math.floor(room.height / 2) });
  const add = (x: number, y: number, width: number, height: number) => {
    corridors.push({ id: `corridor-${corridors.length + 1}`, type: 'corridor', x, y, width, height, floor });
  };
  // Prim's minimum spanning tree guarantees every room has a passage.
  while (connected.size < rooms.length) {
    let best: { a: number; b: number; distance: number } | undefined;
    for (const a of connected) {
      for (let b = 0; b < rooms.length; b++) {
        if (connected.has(b)) continue;
        const start = center(rooms[a]);
        const end = center(rooms[b]);
        const distance = Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
        if (!best || distance < best.distance) best = { a, b, distance };
      }
    }
    const start = center(rooms[best!.a]);
    const end = center(rooms[best!.b]);
    if (random() < 0.5) {
      add(Math.min(start.x, end.x), start.y, Math.abs(start.x - end.x) + 1, 2);
      add(end.x, Math.min(start.y, end.y), 2, Math.abs(start.y - end.y) + 1);
    } else {
      add(start.x, Math.min(start.y, end.y), 2, Math.abs(start.y - end.y) + 1);
      add(Math.min(start.x, end.x), end.y, Math.abs(start.x - end.x) + 1, 2);
    }
    connected.add(best!.b);
  }
  return corridors;
}

function placeObjects(input: GenerationInput, rooms: RectElement[], assets: Asset[], random: () => number): ObjectElement[] {
  const keywords = input.prompt.toLowerCase();
  const kinds = [...themeObjects[input.theme]];
  const mentioned: [RegExp, BuiltinKind][] = [
    [/сундук|сокровищ|chest|treasure/, 'chest'], [/стол|table/, 'table'], [/бочк|barrel/, 'barrel'],
    [/кроват|bed/, 'bed'], [/колонн|pillar/, 'pillar'], [/лестниц|stairs/, 'stairs'], [/факел|torch/, 'torch'],
  ];
  for (const [pattern, kind] of mentioned) if (pattern.test(keywords)) kinds.unshift(kind);
  const priority = (asset: Asset) => [...asset.tags, asset.name].reduce((score, tag) => score + (keywords.includes(tag.toLowerCase()) ? 1 : 0), 0);
  const selected = [...assets].sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
  const roomSlots = rooms.map(room => {
    const columns = Math.max(1, Math.floor((room.width - 0.6) / 1.6));
    const rows = Math.max(1, Math.floor((room.height - 0.6) / 1.6));
    return shuffled(Array.from({ length: columns * rows }, (_, index) => ({
      x: room.x + (index % columns + 0.5) * room.width / columns,
      y: room.y + (Math.floor(index / columns) + 0.5) * room.height / rows,
    })), random);
  });
  const slots: { x: number; y: number }[] = [];
  while (roomSlots.some(room => room.length)) for (const room of roomSlots) { const slot = room.shift(); if (slot) slots.push(slot); }
  if (selected.length > slots.length) throw new GenerationError('Для всех выбранных ассетов недостаточно места. Увеличьте карту или выберите меньше ассетов.', 400);
  const count = Math.min(slots.length, Math.max(selected.length, rooms.length * 3), 200);
  return slots.slice(0, count).map((slot, index) => {
    const asset = selected[index];
    const kind = kinds[index % kinds.length];
    let width = kind === 'torch' || kind === 'pillar' ? 0.65 : 1.2;
    let height = kind === 'table' || kind === 'bed' || kind === 'stairs' ? 0.8 : width;
    if (asset) {
      const scale = 1.2 / Math.max(asset.width, asset.height);
      width = asset.width * scale;
      height = asset.height * scale;
    }
    return { id: `object-${index + 1}`, type: 'object', x: slot.x - width / 2, y: slot.y - height / 2, width, height, rotation: 0, kind, ...(asset ? { assetId: asset.id } : {}) };
  });
}

export function generateLocalMap(rawInput: GenerationInput, availableAssets: Asset[]): MapDocument {
  const input = generationInputSchema.parse(rawInput);
  const assets = requestedAssets(input, availableAssets);
  const random = seededRandom(input.seed);
  const rooms = roomLayout(input, random);
  const corridors = connectRooms(rooms, floors[input.theme], random);
  const objects = placeObjects(input, rooms, assets.filter(asset => asset.category === 'objects'), random);
  // The renderer computes perimeter walls from the floor union: room exits stay open.
  return baseDocument(input, [...rooms, ...corridors, ...objects], 'local', undefined, assets);
}

