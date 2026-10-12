import type { MapDocument } from './types';

/** Every image referenced by a map, including textures, must survive save and export. */
export function referencedAssetIds(document: MapDocument): string[] {
  return [...new Set([
    ...(document.wallAssetId ? [document.wallAssetId] : []),
    ...document.elements.flatMap(element => {
      if (element.type === 'room' || element.type === 'corridor') return element.floorAssetId ? [element.floorAssetId] : [];
      if (element.type === 'object' || element.type === 'wall') return element.assetId ? [element.assetId] : [];
      return [];
    }),
  ])];
}
