export type Theme = 'crypt' | 'tavern' | 'cave';
export type Floor = 'stone' | 'wood' | 'earth';
export type BuiltinKind = 'chest' | 'table' | 'barrel' | 'torch' | 'pillar' | 'stairs' | 'bed' | 'door';
export type AssetCategory = 'objects' | 'floors' | 'walls';
export interface Asset {
  id: string;
  name: string;
  filename: string;
  width: number;
  height: number;
  category: AssetCategory;
  tags: string[];
  url: string;
  createdAt: string;
  pack?: string;
}
export interface RectElement {
  id: string;
  type: 'room' | 'corridor';
  x: number;
  y: number;
  width: number;
  height: number;
  floor: Floor;
  floorAssetId?: string;
  label?: string;
}
export interface WallElement {
  id: string;
  type: 'wall';
  x: number;
  y: number;
  x2: number;
  y2: number;
  thickness: number;
  assetId?: string;
}
export interface ObjectElement {
  id: string;
  type: 'object';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  kind: BuiltinKind;
  assetId?: string;
}
export type MapElement = RectElement | WallElement | ObjectElement;
/** Coordinates and sizes are measured in grid cells, not screen pixels. */
export interface MapDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
  gridSize: number;
  theme: Theme;
  seed: string;
  prompt: string;
  generationMode: 'local' | 'ai' | 'manual';
  wallAssetId?: string;
  elements: MapElement[];
}
export interface GenerationInput {
  prompt: string;
  width: number;
  height: number;
  theme: Theme;
  seed: string;
  mode: 'local' | 'ai';
  assetIds: string[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  width: number;
  height: number;
  elementCount: number;
}
export interface Capabilities {
  ai: { configured: boolean; model: string; provider: 'OpenAI' };
  formats: { png: boolean; pngZip: boolean; dungeondraftPack: boolean; dungeondraftExport: boolean };
  storage: 'local' | 'browser';
}
