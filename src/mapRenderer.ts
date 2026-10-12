import type { Asset, Floor, MapDocument, MapElement, ObjectElement, RectElement } from '../shared/types';
import { referencedAssetIds } from '../shared/assets';

export const CELL_SIZE = 32;
export interface VisibleLayers { rooms: boolean; walls: boolean; objects: boolean }
export interface RenderOptions {
  grid?: boolean;
  visibleLayers?: VisibleLayers;
  selectedId?: string | null;
  preview?: MapElement | null;
}

const loadedImages = new Map<string, HTMLImageElement>();
const loadingImages = new Map<string, Promise<HTMLImageElement>>();
const textures = new Map<string, HTMLCanvasElement>();
const perimeterCache = new Map<string, Segment[]>();

function seedNumber(value: string): number {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i++) seed = Math.imul(seed ^ value.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function randomSource(seed: number): () => number {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let n = Math.imul(value ^ (value >>> 15), value | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/** Only same-origin asset images are accepted, so PNG exports keep an untainted canvas. */
export function loadAssetImage(asset: Asset): Promise<HTMLImageElement> {
  const cached = loadedImages.get(asset.url);
  if (cached) return Promise.resolve(cached);
  const pending = loadingImages.get(asset.url);
  if (pending) return pending;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const url = new URL(asset.url, window.location.href);
    if (url.origin !== window.location.origin) {
      reject(new Error(`Ассет «${asset.name}» должен загружаться с сервера приложения.`));
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) { reject(new Error(`Повреждён PNG «${asset.name}».`)); return; }
      loadedImages.set(asset.url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Не удалось загрузить PNG «${asset.name}».`));
    img.src = url.href;
  }).finally(() => { loadingImages.delete(asset.url); });
  loadingImages.set(asset.url, promise);
  return promise;
}

export async function preloadMapAssets(document: MapDocument, assets: Asset[]): Promise<void> {
  await Promise.all(referencedAssetIds(document).map(id => {
    const asset = assets.find(item => item.id === id);
    if (!asset) return Promise.reject(new Error(`Ассет ${id} отсутствует в библиотеке. Загрузите исходный PNG перед экспортом.`));
    return loadAssetImage(asset);
  }));
}

/** A tile is one cell wide, while its height follows the source PNG aspect ratio. */
function assetPattern(ctx: CanvasRenderingContext2D, assetId: string | undefined, assets: Asset[]): CanvasPattern | null {
  if (!assetId) return null;
  const asset = assets.find(item => item.id === assetId);
  const image = asset && loadedImages.get(asset.url);
  if (!image) return null;
  const pattern = ctx.createPattern(image, 'repeat');
  pattern?.setTransform(new DOMMatrix().scale(CELL_SIZE / image.naturalWidth));
  return pattern;
}

function makeTexture(floor: Floor, theme: string, seed: string): HTMLCanvasElement {
  const key = `${floor}:${theme}:${seed}`;
  const existing = textures.get(key);
  if (existing) return existing;
  const canvas = window.document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const rand = randomSource(seedNumber(key));
  if (floor === 'wood') {
    ctx.fillStyle = '#6a5039';
    ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 16) {
      ctx.fillStyle = `rgba(${105 + Math.floor(rand() * 25)},${77 + Math.floor(rand() * 15)},43,0.65)`;
      ctx.fillRect(0, y, 128, 15);
      ctx.strokeStyle = '#3c3025';
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(0, y + 15.5); ctx.lineTo(128, y + 15.5); ctx.stroke();
      const joint = (y % 32 === 0 ? 42 : 88);
      ctx.beginPath(); ctx.moveTo(joint, y); ctx.lineTo(joint, y + 16); ctx.stroke();
      for (let grain = 0; grain < 7; grain++) {
        ctx.strokeStyle = rand() > 0.5 ? 'rgba(205,164,102,0.11)' : 'rgba(31,24,19,0.17)';
        const gy = y + 2 + rand() * 11;
        ctx.beginPath(); ctx.moveTo(rand() * 40, gy); ctx.bezierCurveTo(50, gy - 1, 74, gy + 1.8, 128, gy); ctx.stroke();
      }
      ctx.fillStyle = '#30281f';
      ctx.fillRect(joint - 3, y + 3, 1, 1); ctx.fillRect(joint + 3, y + 12, 1, 1);
    }
  } else if (floor === 'earth') {
    ctx.fillStyle = '#625849'; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 700; i++) {
      const x = rand() * 128, y = rand() * 128, size = 0.4 + rand() * 2;
      ctx.fillStyle = rand() > 0.5 ? 'rgba(169,153,115,0.12)' : 'rgba(20,23,18,0.17)';
      ctx.beginPath(); ctx.ellipse(x, y, size, size * 0.6, rand() * 3, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 16; i++) {
      ctx.strokeStyle = 'rgba(34,38,25,0.22)'; ctx.lineWidth = 0.7;
      const x = rand() * 128, y = rand() * 128;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 9, y + 2); ctx.lineTo(x + 16, y - 4); ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#373b35'; ctx.fillRect(0, 0, 128, 128);
    for (let row = 0; row < 4; row++) {
      for (let col = -1; col < 4; col++) {
        const x = col * 40 + (row % 2) * 20, y = row * 32;
        const base = theme === 'cave' ? 83 : 89;
        const tint = Math.floor(rand() * 14);
        ctx.fillStyle = `rgb(${base + tint},${base + tint + 3},${base + tint - 5})`;
        ctx.fillRect(x + 1.4, y + 1.2, 37.5, 29.3);
        ctx.strokeStyle = 'rgba(186,188,158,0.11)'; ctx.lineWidth = 0.7;
        ctx.strokeRect(x + 2, y + 2, 36.1, 27.6);
        if (rand() > 0.46) {
          ctx.strokeStyle = 'rgba(30,35,29,0.25)';
          ctx.beginPath(); ctx.moveTo(x + 10, y + 2); ctx.lineTo(x + 16, y + 11); ctx.lineTo(x + 13, y + 17); ctx.stroke();
        }
      }
    }
    for (let i = 0; i < 450; i++) {
      ctx.fillStyle = rand() > 0.5 ? 'rgba(210,211,181,0.08)' : 'rgba(10,18,13,0.10)';
      ctx.fillRect(rand() * 128, rand() * 128, rand() * 1.5, rand() * 1.5);
    }
  }
  if (textures.size > 24) textures.delete(textures.keys().next().value!);
  textures.set(key, canvas);
  return canvas;
}

interface Segment { x1: number; y1: number; x2: number; y2: number }

/** Find the exact exterior of the room union, including fractional rectangle edges. */
export function perimeterSegments(rooms: RectElement[]): Segment[] {
  const horizontal = new Map<number, [number, number][]>();
  const vertical = new Map<number, [number, number][]>();
  const exposed = (start: number, end: number, blocked: [number, number][]): [number, number][] => {
    const result: [number, number][] = [];
    let cursor = start;
    blocked.sort((a, b) => a[0] - b[0]);
    for (const [left, right] of blocked) {
      if (right <= cursor || left >= end) continue;
      if (left > cursor) result.push([cursor, Math.min(left, end)]);
      cursor = Math.max(cursor, right);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
    return result;
  };
  const add = (lines: Map<number, [number, number][]>, at: number, spans: [number, number][]) => {
    if (!spans.length) return;
    const existing = lines.get(at) ?? [];
    existing.push(...spans); lines.set(at, existing);
  };
  for (const room of rooms) {
    const top: [number, number][] = [], bottom: [number, number][] = [];
    const left: [number, number][] = [], right: [number, number][] = [];
    for (const other of rooms) {
      if (other === room) continue;
      const ox = other.x + other.width, oy = other.y + other.height;
      if (other.y < room.y && oy >= room.y) top.push([other.x, ox]);
      if (other.y <= room.y + room.height && oy > room.y + room.height) bottom.push([other.x, ox]);
      if (other.x < room.x && ox >= room.x) left.push([other.y, oy]);
      if (other.x <= room.x + room.width && ox > room.x + room.width) right.push([other.y, oy]);
    }
    add(horizontal, room.y, exposed(room.x, room.x + room.width, top));
    add(horizontal, room.y + room.height, exposed(room.x, room.x + room.width, bottom));
    add(vertical, room.x, exposed(room.y, room.y + room.height, left));
    add(vertical, room.x + room.width, exposed(room.y, room.y + room.height, right));
  }
  const result: Segment[] = [];
  const mergeLines = (lines: Map<number, [number, number][]>, isHorizontal: boolean) => {
    for (const [at, spans] of lines) {
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      for (const [start, end] of merged) result.push(isHorizontal ? { x1: start, y1: at, x2: end, y2: at } : { x1: at, y1: start, x2: at, y2: end });
    }
  };
  mergeLines(horizontal, true); mergeLines(vertical, false);
  return result;
}

function cachedPerimeter(rooms: RectElement[]): Segment[] {
  const key = rooms.map(room => `${room.x},${room.y},${room.width},${room.height}`).join(';');
  const existing = perimeterCache.get(key);
  if (existing) return existing;
  const segments = perimeterSegments(rooms);
  if (perimeterCache.size >= 12) perimeterCache.delete(perimeterCache.keys().next().value!);
  perimeterCache.set(key, segments);
  return segments;
}

function wall(ctx: CanvasRenderingContext2D, segment: Segment, thickness = 0.22, texture: CanvasPattern | null = null): void {
  const x1 = segment.x1 * CELL_SIZE, y1 = segment.y1 * CELL_SIZE;
  const x2 = segment.x2 * CELL_SIZE, y2 = segment.y2 * CELL_SIZE;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.shadowColor = '#070b09'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 4;
  ctx.strokeStyle = '#202720'; ctx.lineWidth = Math.max(4, thickness * CELL_SIZE + 4); ctx.stroke();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = '#8c8c72'; ctx.lineWidth = Math.max(3, thickness * CELL_SIZE); ctx.stroke();
  if (texture) { ctx.strokeStyle = texture; ctx.stroke(); }
  ctx.strokeStyle = 'rgba(204,202,165,0.38)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(x1, y1 - thickness * CELL_SIZE / 3); ctx.lineTo(x2, y2 - thickness * CELL_SIZE / 3); ctx.stroke();
  const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
  if (length > 0) {
    const nx = -dy / length * thickness * CELL_SIZE / 2, ny = dx / length * thickness * CELL_SIZE / 2;
    ctx.strokeStyle = '#424a3c'; ctx.lineWidth = 1;
    for (let offset = 12; offset < length - 2; offset += 15) {
      const px = x1 + dx * offset / length, py = y1 + dy * offset / length;
      ctx.beginPath(); ctx.moveTo(px - nx, py - ny); ctx.lineTo(px + nx, py + ny); ctx.stroke();
    }
  }
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
}

function builtin(ctx: CanvasRenderingContext2D, element: ObjectElement): void {
  const width = element.width * CELL_SIZE, height = element.height * CELL_SIZE;
  ctx.scale(width / 40, height / 40);
  ctx.lineWidth = 1.7; ctx.strokeStyle = '#221e17'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
  switch (element.kind) {
    case 'chest': {
      ctx.fillStyle = '#8b6035'; roundedRect(ctx, -18, -14, 36, 28, 3); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#a77946'; roundedRect(ctx, -16, -12, 32, 11, 2); ctx.fill();
      ctx.strokeStyle = '#443321'; ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(18, 0); ctx.stroke();
      ctx.fillStyle = '#b7a576'; ctx.fillRect(-12, -14, 4, 28); ctx.fillRect(8, -14, 4, 28);
      ctx.strokeStyle = '#575243'; ctx.strokeRect(-12, -14, 4, 28); ctx.strokeRect(8, -14, 4, 28);
      ctx.fillStyle = '#cdb77d'; ctx.fillRect(-3, -4, 6, 9); ctx.strokeRect(-3, -4, 6, 9);
      ctx.fillStyle = '#302b20'; ctx.beginPath(); ctx.arc(0, -0.4, 1.1, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'table': {
      ctx.fillStyle = '#3d2d20'; roundedRect(ctx, -16, -22, 32, 8, 2); ctx.fill(); roundedRect(ctx, -16, 14, 32, 8, 2); ctx.fill();
      ctx.fillStyle = '#937149'; roundedRect(ctx, -19, -13, 38, 26, 3); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = '#64462d'; ctx.lineWidth = 1;
      for (let y = -6; y <= 6; y += 6) { ctx.beginPath(); ctx.moveTo(-17, y); ctx.lineTo(17, y); ctx.stroke(); }
      ctx.fillStyle = '#d1c39d'; ctx.beginPath(); ctx.arc(9, 3, 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#897b5d'; ctx.stroke(); ctx.fillStyle = '#986745'; ctx.fillRect(-8, -3, 4, 5);
      ctx.fillStyle = '#d3ab52'; ctx.beginPath(); ctx.arc(-6, -3, 1.5, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'barrel': {
      ctx.fillStyle = '#926944'; ctx.beginPath(); ctx.ellipse(0, 0, 15, 18, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = '#543b28'; ctx.lineWidth = 1;
      for (let x = -9; x <= 9; x += 6) { ctx.beginPath(); ctx.moveTo(x, -14); ctx.lineTo(x, 14); ctx.stroke(); }
      ctx.strokeStyle = '#a0a08a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(0, 0, 11.7, 14.7, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#4a3424'; ctx.beginPath(); ctx.arc(5, -4, 2, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'torch': {
      ctx.fillStyle = '#473c2a'; ctx.fillRect(-4, -1, 8, 17); ctx.strokeRect(-4, -1, 8, 17);
      ctx.shadowBlur = 8; ctx.shadowColor = '#ec9a36'; ctx.fillStyle = '#ee983d';
      ctx.beginPath(); ctx.moveTo(0, -19); ctx.bezierCurveTo(15, -3, 9, 7, 0, 7); ctx.bezierCurveTo(-10, 6, -12, -5, 0, -19); ctx.fill();
      ctx.fillStyle = '#ffe2a4'; ctx.beginPath(); ctx.moveTo(0, -10); ctx.quadraticCurveTo(7, 6, 0, 5); ctx.quadraticCurveTo(-6, 3, 0, -10); ctx.fill(); break;
    }
    case 'pillar': {
      ctx.fillStyle = '#878a75'; roundedRect(ctx, -18, -18, 36, 36, 3); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      const stone = ctx.createRadialGradient(-4, -5, 1, 0, 0, 15); stone.addColorStop(0, '#b5b5a0'); stone.addColorStop(1, '#666d5d');
      ctx.fillStyle = stone; ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#9a9e87'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke(); break;
    }
    case 'stairs': {
      ctx.fillStyle = '#383e35'; roundedRect(ctx, -18, -18, 36, 36, 1); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
      for (let i = 0; i < 7; i++) {
        const y = -17 + i * 4.8;
        ctx.fillStyle = `rgb(${80 + i * 9},${84 + i * 9},${72 + i * 8})`; ctx.fillRect(-16, y, 32, 4.5);
        ctx.strokeStyle = '#363d33'; ctx.beginPath(); ctx.moveTo(-16, y + 4.5); ctx.lineTo(16, y + 4.5); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(216,215,175,.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(0, -10); ctx.moveTo(-4, -6); ctx.lineTo(0, -10); ctx.lineTo(4, -6); ctx.stroke(); break;
    }
    case 'bed': {
      ctx.fillStyle = '#67482e'; roundedRect(ctx, -16, -19, 32, 38, 2); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#b7ab85'; roundedRect(ctx, -13, -15, 26, 30, 2); ctx.fill();
      ctx.fillStyle = '#677a73'; roundedRect(ctx, -13, -4, 26, 20, 2); ctx.fill();
      ctx.strokeStyle = '#83948a'; ctx.beginPath(); ctx.moveTo(-10, 1); ctx.lineTo(-10, 14); ctx.moveTo(10, 1); ctx.lineTo(10, 14); ctx.stroke();
      ctx.fillStyle = '#e0d8b7'; roundedRect(ctx, -10, -13, 20, 7, 2); ctx.fill(); break;
    }
    case 'door': {
      ctx.fillStyle = '#272c24'; ctx.fillRect(-24, -21, 48, 42);
      ctx.fillStyle = '#967148'; roundedRect(ctx, -18, -13, 36, 26, 2); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = '#574027'; ctx.lineWidth = 1;
      for (let x = -12; x <= 12; x += 6) { ctx.beginPath(); ctx.moveTo(x, -12); ctx.lineTo(x, 12); ctx.stroke(); }
      ctx.fillStyle = '#4e564b'; ctx.fillRect(-18, -8, 36, 3); ctx.fillRect(-18, 5, 36, 3);
      ctx.fillStyle = '#d2b55f'; ctx.beginPath(); ctx.arc(11, 0, 2.4, 0, Math.PI * 2); ctx.fill(); break;
    }
  }
}

function drawObject(ctx: CanvasRenderingContext2D, element: ObjectElement, assets: Asset[]): void {
  ctx.save();
  ctx.translate((element.x + element.width / 2) * CELL_SIZE, (element.y + element.height / 2) * CELL_SIZE);
  ctx.rotate(element.rotation * Math.PI / 180);
  if (element.assetId) {
    const asset = assets.find(item => item.id === element.assetId);
    const img = asset && loadedImages.get(asset.url);
    if (img) {
      ctx.shadowColor = 'rgba(0,0,0,0.42)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
      ctx.drawImage(img, -element.width * CELL_SIZE / 2, -element.height * CELL_SIZE / 2, element.width * CELL_SIZE, element.height * CELL_SIZE);
    } else {
      const w = element.width * CELL_SIZE, h = element.height * CELL_SIZE;
      ctx.fillStyle = 'rgba(135,53,44,.22)'; ctx.strokeStyle = '#d59c79'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.fillRect(-w / 2, -h / 2, w, h); ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(-w / 3, -h / 3); ctx.lineTo(w / 3, h / 3); ctx.moveTo(w / 3, -h / 3); ctx.lineTo(-w / 3, h / 3); ctx.stroke();
    }
  } else builtin(ctx, element);
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, element: MapElement): void {
  ctx.save(); ctx.strokeStyle = '#53d5cb'; ctx.fillStyle = '#b6eee5'; ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(79,204,193,.25)'; ctx.shadowBlur = 5;
  if (element.type === 'wall') {
    ctx.setLineDash([5, 4]); ctx.lineWidth = element.thickness * CELL_SIZE + 7;
    ctx.beginPath(); ctx.moveTo(element.x * CELL_SIZE, element.y * CELL_SIZE); ctx.lineTo(element.x2 * CELL_SIZE, element.y2 * CELL_SIZE); ctx.stroke(); ctx.setLineDash([]);
    for (const [x, y] of [[element.x, element.y], [element.x2, element.y2]]) { ctx.fillRect(x * CELL_SIZE - 3, y * CELL_SIZE - 3, 6, 6); }
  } else {
    ctx.translate((element.x + element.width / 2) * CELL_SIZE, (element.y + element.height / 2) * CELL_SIZE);
    if (element.type === 'object') ctx.rotate(element.rotation * Math.PI / 180);
    const x = -element.width * CELL_SIZE / 2 - 3, y = -element.height * CELL_SIZE / 2 - 3;
    const w = element.width * CELL_SIZE + 6, h = element.height * CELL_SIZE + 6;
    ctx.setLineDash([5, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
  }
  ctx.restore();
}

export function renderMap(ctx: CanvasRenderingContext2D, document: MapDocument, assets: Asset[], options: RenderOptions = {}): void {
  const width = document.width * CELL_SIZE, height = document.height * CELL_SIZE;
  const layers = options.visibleLayers ?? { rooms: true, walls: true, objects: true };
  ctx.save();
  ctx.fillStyle = document.theme === 'cave' ? '#272c23' : '#272e29'; ctx.fillRect(0, 0, width, height);
  const rand = randomSource(seedNumber(document.seed));
  for (let i = 0; i < Math.min(2500, document.width * document.height * 1.7); i++) {
    const x = rand() * width, y = rand() * height, radius = 0.4 + rand() * 2.5;
    ctx.fillStyle = rand() > 0.65 ? 'rgba(127,131,105,0.07)' : 'rgba(8,16,10,0.11)';
    ctx.beginPath(); ctx.ellipse(x, y, radius, radius * 0.65, rand() * 3, 0, Math.PI * 2); ctx.fill();
  }
  const elements = options.preview ? [...document.elements, options.preview] : document.elements;
  const rooms = elements.filter((element): element is RectElement => element.type === 'room' || element.type === 'corridor');
  if (layers.rooms) {
    for (const room of rooms) {
      ctx.save();
      ctx.shadowColor = '#0b110c'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5;
      ctx.fillStyle = '#4b5144'; ctx.fillRect(room.x * CELL_SIZE, room.y * CELL_SIZE, room.width * CELL_SIZE, room.height * CELL_SIZE);
      ctx.restore();
    }
    for (const room of rooms) {
      ctx.save();
      ctx.fillStyle = ctx.createPattern(makeTexture(room.floor, document.theme, document.seed), 'repeat')!;
      ctx.fillRect(room.x * CELL_SIZE, room.y * CELL_SIZE, room.width * CELL_SIZE, room.height * CELL_SIZE);
      const texture = assetPattern(ctx, room.floorAssetId, assets);
      if (texture) {
        ctx.fillStyle = texture;
        ctx.fillRect(room.x * CELL_SIZE, room.y * CELL_SIZE, room.width * CELL_SIZE, room.height * CELL_SIZE);
      }
      ctx.restore();
    }
  }
  if (layers.walls) {
    const globalWallTexture = assetPattern(ctx, document.wallAssetId, assets);
    for (const segment of cachedPerimeter(rooms)) wall(ctx, segment, 0.22, globalWallTexture);
    for (const element of elements) if (element.type === 'wall') wall(ctx, { x1: element.x, y1: element.y, x2: element.x2, y2: element.y2 }, element.thickness, element.assetId ? assetPattern(ctx, element.assetId, assets) : globalWallTexture);
  }
  if (layers.objects) {
    for (const element of elements) if (element.type === 'object' && element.kind === 'torch' && !element.assetId) {
      const x = (element.x + element.width / 2) * CELL_SIZE, y = (element.y + element.height / 2) * CELL_SIZE;
      const glow = ctx.createRadialGradient(x, y, 2, x, y, CELL_SIZE * 2.6);
      glow.addColorStop(0, 'rgba(243,185,79,.32)'); glow.addColorStop(0.45, 'rgba(224,154,59,.13)'); glow.addColorStop(1, 'rgba(224,154,59,0)');
      ctx.fillStyle = glow; ctx.fillRect(x - CELL_SIZE * 2.6, y - CELL_SIZE * 2.6, CELL_SIZE * 5.2, CELL_SIZE * 5.2);
    }
    for (const element of elements) if (element.type === 'object') drawObject(ctx, element, assets);
  }
  const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.67);
  vignette.addColorStop(0, 'rgba(9,15,10,0)'); vignette.addColorStop(1, 'rgba(9,15,10,.35)');
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
  if (options.grid) {
    ctx.strokeStyle = 'rgba(166,176,150,.14)'; ctx.lineWidth = 0.7; ctx.beginPath();
    for (let x = 0; x <= document.width; x++) { ctx.moveTo(x * CELL_SIZE, 0); ctx.lineTo(x * CELL_SIZE, height); }
    for (let y = 0; y <= document.height; y++) { ctx.moveTo(0, y * CELL_SIZE); ctx.lineTo(width, y * CELL_SIZE); }
    ctx.stroke();
  }
  if (layers.rooms) for (const room of rooms) if (room.type === 'room' && room.label) {
    ctx.save(); ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = room.label.length > 36 ? `${room.label.slice(0, 34)}…` : room.label;
    const maxWidth = Math.max(20, room.width * CELL_SIZE - 12), textWidth = Math.min(ctx.measureText(label).width + 14, maxWidth);
    const x = (room.x + room.width / 2) * CELL_SIZE, y = (room.y + room.height / 2) * CELL_SIZE;
    ctx.fillStyle = 'rgba(29,35,29,.74)'; roundedRect(ctx, x - textWidth / 2, y - 10, textWidth, 20, 4); ctx.fill();
    ctx.fillStyle = '#c4c7af'; ctx.fillText(label, x, y, maxWidth - 8); ctx.restore();
  }
  const selected = document.elements.find(element => element.id === options.selectedId);
  if (selected && (selected.type === 'object' ? layers.objects : selected.type === 'wall' ? layers.walls : layers.rooms)) drawSelection(ctx, selected);
  if (options.preview) drawSelection(ctx, options.preview);
  ctx.restore();
}

export async function exportMapPng(document: MapDocument, assets: Asset[], options: { scale?: number; grid?: boolean; visibleLayers?: VisibleLayers } = {}): Promise<Blob> {
  const scale = Math.max(1, Math.min(3, Number.isFinite(options.scale) ? options.scale! : 1));
  await preloadMapAssets(document, assets);
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.ceil(document.width * CELL_SIZE * scale);
  canvas.height = Math.ceil(document.height * CELL_SIZE * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не смог создать холст для экспорта.');
  ctx.scale(scale, scale);
  renderMap(ctx, document, assets, { grid: options.grid, visibleLayers: options.visibleLayers });
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Браузер не смог сохранить PNG.')), 'image/png'); }
    catch { reject(new Error('PNG не удалось экспортировать: проверьте доступность загруженных изображений.')); }
  });
}
