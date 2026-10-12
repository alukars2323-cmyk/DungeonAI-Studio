import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Asset, BuiltinKind, MapDocument, MapElement, ObjectElement, RectElement } from '../shared/types';
import { CELL_SIZE, exportMapPng, preloadMapAssets, renderMap, retainMapAssetImages } from './mapRenderer';
import type { VisibleLayers } from './mapRenderer';

export type Tool = 'select' | 'room' | 'corridor' | 'wall' | 'object' | 'erase' | 'pan';
export interface MapCanvasProps {
  document: MapDocument;
  onChange: (document: MapDocument) => void;
  assets: Asset[];
  tool: Tool;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selectedAssetId: string | null;
  builtinKind: BuiltinKind;
  showGrid: boolean;
  snap: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  visibleLayers: VisibleLayers;
  onExportReady?: (exporter: (scale: number, grid: boolean) => Promise<Blob>) => void;
}

interface Point { x: number; y: number }
type Interaction =
  | { mode: 'draw'; origin: Point; current: Point; element: MapElement }
  | { mode: 'move'; origin: Point; original: MapElement; current: MapElement }
  | { mode: 'pan'; origin: Point; scroll: Point };

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function quantize(value: number, snap: boolean): number { return snap ? Math.round(value) : Math.round(value * 100) / 100; }
function freshId(): string { return crypto.randomUUID(); }

export function hitTestElement(point: Point, elements: MapElement[], layers: VisibleLayers): MapElement | undefined {
  const ordered = [
    ...elements.filter(element => element.type === 'object' && layers.objects).reverse(),
    ...elements.filter(element => element.type === 'wall' && layers.walls).reverse(),
    ...elements.filter(element => (element.type === 'room' || element.type === 'corridor') && layers.rooms).reverse(),
  ];
  return ordered.find(element => {
    if (element.type === 'wall') {
      const dx = element.x2 - element.x, dy = element.y2 - element.y;
      const ratio = clamp(((point.x - element.x) * dx + (point.y - element.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      return Math.hypot(point.x - element.x - ratio * dx, point.y - element.y - ratio * dy) <= Math.max(0.24, element.thickness / 2);
    }
    if (element.type === 'object') {
      const cx = element.x + element.width / 2, cy = element.y + element.height / 2;
      const angle = -element.rotation * Math.PI / 180;
      const px = (point.x - cx) * Math.cos(angle) - (point.y - cy) * Math.sin(angle);
      const py = (point.x - cx) * Math.sin(angle) + (point.y - cy) * Math.cos(angle);
      return Math.abs(px) <= element.width / 2 && Math.abs(py) <= element.height / 2;
    }
    return point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height;
  });
}

function movedElement(element: MapElement, dx: number, dy: number, document: MapDocument, snap: boolean): MapElement {
  if (element.type === 'wall') {
    const actualDx = clamp(quantize(dx, snap), -Math.min(element.x, element.x2), document.width - Math.max(element.x, element.x2));
    const actualDy = clamp(quantize(dy, snap), -Math.min(element.y, element.y2), document.height - Math.max(element.y, element.y2));
    return { ...element, x: element.x + actualDx, y: element.y + actualDy, x2: element.x2 + actualDx, y2: element.y2 + actualDy };
  }
  return { ...element, x: clamp(quantize(element.x + dx, snap), 0, document.width - element.width), y: clamp(quantize(element.y + dy, snap), 0, document.height - element.height) };
}

function drawnElement(element: MapElement, start: Point, current: Point, document: MapDocument, snap: boolean): MapElement {
  const x = clamp(quantize(current.x, snap), 0, document.width);
  const y = clamp(quantize(current.y, snap), 0, document.height);
  if (element.type === 'wall') return { ...element, x: start.x, y: start.y, x2: x, y2: y };
  if (element.type === 'object') return element;
  const minimum = snap ? 1 : 0.25;
  const left = clamp(Math.min(start.x, x), 0, document.width - minimum);
  const top = clamp(Math.min(start.y, y), 0, document.height - minimum);
  return { ...element, x: left, y: top, width: Math.min(document.width - left, Math.max(minimum, Math.abs(x - start.x))), height: Math.min(document.height - top, Math.max(minimum, Math.abs(y - start.y))) };
}

const objectSizes: Record<BuiltinKind, [number, number]> = {
  chest: [1.2, 0.9], table: [2, 1.3], barrel: [0.9, 0.9], torch: [0.65, 0.65],
  pillar: [1, 1], stairs: [2, 2], bed: [1.2, 2], door: [1.5, 0.5],
};

export function MapCanvas(props: MapCanvasProps) {
  const { document, onChange, assets, tool, selectedId, onSelect, selectedAssetId, builtinKind, showGrid, snap, zoom, onZoomChange, visibleLayers, onExportReady } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [interaction, setInteractionState] = useState<Interaction | null>(null);
  const [imageRevision, setImageRevision] = useState(0);
  const [assetError, setAssetError] = useState('');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const displayZoom = clamp(zoom, 0.2, 2.5);

  const setInteraction = useCallback((next: Interaction | null) => { interactionRef.current = next; setInteractionState(next); }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const release = retainMapAssetImages(document, assets);
    preloadMapAssets(document, assets, { signal: controller.signal }).then(() => { if (active) { setAssetError(''); setImageRevision(value => value + 1); } }).catch(error => { if (active) setAssetError(error instanceof Error ? error.message : 'Не удалось загрузить PNG.'); });
    return () => { active = false; controller.abort(); release(); };
  }, [document, assets]);

  useEffect(() => {
    if (onExportReady) onExportReady((scale, grid) => exportMapPng(document, assets, { scale, grid }));
  }, [document, assets, onExportReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpi = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(document.width * CELL_SIZE * displayZoom * dpi);
    canvas.height = Math.round(document.height * CELL_SIZE * displayZoom * dpi);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(displayZoom * dpi, 0, 0, displayZoom * dpi, 0, 0);
    let renderedDocument = document;
    if (interaction?.mode === 'move') renderedDocument = { ...document, elements: document.elements.map(element => element.id === interaction.current.id ? interaction.current : element) };
    renderMap(ctx, renderedDocument, assets, { grid: showGrid, visibleLayers, selectedId, preview: interaction?.mode === 'draw' ? interaction.element : null });
  }, [document, assets, showGrid, visibleLayers, selectedId, interaction, displayZoom, imageRevision]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button, a') || target?.closest('[role="dialog"]') || target?.isContentEditable) return;
      if (event.code === 'Space') { event.preventDefault(); setSpaceHeld(true); }
      if (event.key === 'Escape') setInteraction(null);
    };
    const keyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const blur = () => { setSpaceHeld(false); setInteraction(null); };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); };
  }, [setInteraction]);

  const getPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width * document.width, 0, document.width), y: clamp((event.clientY - rect.top) / rect.height * document.height, 0, document.height) };
  };

  const commit = (elements: MapElement[]) => onChange({ ...document, generationMode: 'manual', updatedAt: new Date().toISOString(), elements });

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'pan' || spaceHeld || event.button === 1) {
      const viewport = viewportRef.current;
      if (viewport) setInteraction({ mode: 'pan', origin: { x: event.clientX, y: event.clientY }, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } });
      return;
    }
    const point = getPoint(event);
    if (tool === 'select' || tool === 'erase') {
      const hit = hitTestElement(point, document.elements, visibleLayers);
      if (tool === 'erase') {
        if (hit) { commit(document.elements.filter(element => element.id !== hit.id)); if (hit.id === selectedId) onSelect(null); }
      } else {
        onSelect(hit?.id ?? null);
        if (hit) setInteraction({ mode: 'move', origin: point, original: hit, current: hit });
      }
      return;
    }
    if (tool === 'object') {
      const asset = assets.find(item => item.id === selectedAssetId);
      if (selectedAssetId && !asset) { setAssetError('Выбранный ассет отсутствует в библиотеке. Выберите другой PNG.'); return; }
      if (asset && asset.category !== 'objects') { setAssetError('Для размещения объекта выберите PNG категории «Объекты». Текстуры назначаются помещениям и стенам.'); return; }
      setAssetError('');
      let [width, height] = objectSizes[builtinKind];
      if (asset) {
        const ratio = asset.width / asset.height;
        width = ratio >= 1 ? 2 : 2 * ratio;
        height = ratio >= 1 ? 2 / ratio : 2;
      }
      width = Math.min(width, document.width); height = Math.min(height, document.height);
      const element: ObjectElement = { id: freshId(), type: 'object', x: clamp(quantize(point.x - width / 2, snap), 0, document.width - width), y: clamp(quantize(point.y - height / 2, snap), 0, document.height - height), width, height, rotation: 0, kind: builtinKind, ...(asset ? { assetId: asset.id } : {}) };
      commit([...document.elements, element]); onSelect(element.id); return;
    }
    const origin = { x: clamp(quantize(point.x, snap), 0, document.width), y: clamp(quantize(point.y, snap), 0, document.height) };
    let element: MapElement;
    if (tool === 'wall') element = { id: freshId(), type: 'wall', x: origin.x, y: origin.y, x2: origin.x, y2: origin.y, thickness: 0.22 };
    else {
      const floorAssetId = document.elements.find((item): item is RectElement => (item.type === 'room' || item.type === 'corridor') && Boolean(item.floorAssetId))?.floorAssetId;
      element = { id: freshId(), type: tool === 'corridor' ? 'corridor' : 'room', x: origin.x, y: origin.y, width: 1, height: 1, floor: document.theme === 'tavern' ? 'wood' : document.theme === 'cave' ? 'earth' : 'stone', ...(floorAssetId ? { floorAssetId } : {}) } as RectElement;
    }
    element = drawnElement(element, origin, origin, document, snap);
    setInteraction({ mode: 'draw', origin, current: point, element });
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = interactionRef.current;
    if (!current) return;
    if (current.mode === 'pan') {
      const viewport = viewportRef.current;
      if (viewport) { viewport.scrollLeft = current.scroll.x - (event.clientX - current.origin.x); viewport.scrollTop = current.scroll.y - (event.clientY - current.origin.y); }
      return;
    }
    const point = getPoint(event);
    if (current.mode === 'move') {
      const distance = Math.hypot(point.x - current.origin.x, point.y - current.origin.y) * CELL_SIZE * displayZoom;
      setInteraction({ ...current, current: distance < 3 ? current.original : movedElement(current.original, point.x - current.origin.x, point.y - current.origin.y, document, snap) });
    }
    else setInteraction({ ...current, current: point, element: drawnElement(current.element, current.origin, point, document, snap) });
  };

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = interactionRef.current;
    if (current?.mode === 'move') {
      const point = getPoint(event);
      const element = movedElement(current.original, point.x - current.origin.x, point.y - current.origin.y, document, snap);
      const distance = Math.hypot(point.x - current.origin.x, point.y - current.origin.y) * CELL_SIZE * displayZoom;
      if (distance >= 3 && JSON.stringify(current.original) !== JSON.stringify(element)) commit(document.elements.map(item => item.id === element.id ? element : item));
    }
    if (current?.mode === 'draw') {
      const element = drawnElement(current.element, current.origin, getPoint(event), document, snap);
      if (element.type !== 'wall' || Math.hypot(element.x2 - element.x, element.y2 - element.y) >= 0.2) { commit([...document.elements, element]); onSelect(element.id); }
    }
    setInteraction(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cursor = interaction?.mode === 'pan' ? 'grabbing' : tool === 'pan' || spaceHeld ? 'grab' : tool === 'select' ? (interaction?.mode === 'move' ? 'grabbing' : 'default') : tool === 'erase' ? 'not-allowed' : 'crosshair';
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); onZoomChange(clamp(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), 0.2, 2.5)); }
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [zoom, onZoomChange]);
  return <div ref={viewportRef} className="map-canvas-viewport">
    <div className="map-canvas-stage" style={{ width: document.width * CELL_SIZE * displayZoom, height: document.height * CELL_SIZE * displayZoom, flexShrink: 0, position: 'relative' }}>
      <canvas ref={canvasRef} className="map-canvas" data-testid="map-canvas" aria-label="Холст карты: выберите инструмент и рисуйте мышью" tabIndex={0}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => setInteraction(null)} onContextMenu={event => event.preventDefault()} />
      {document.elements.length === 0 && !interaction && <div className="map-canvas-empty-hint" style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', pointerEvents: 'none', color: '#a0aaa0', gap: 8 }}><strong>Здесь начинается ваше приключение</strong><span>Создайте карту по описанию или нарисуйте первое помещение.</span></div>}
      {assetError && <div className="map-canvas-asset-error" role="status" style={{ position: 'absolute', left: 12, bottom: 12, right: 12, padding: '8px 12px', color: '#efc5aa', background: 'rgba(69,38,29,.94)', borderRadius: 6, fontSize: 12 }}>{assetError}</div>}
    </div>
  </div>;
}
