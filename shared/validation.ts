import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const coordinate = z.number().finite().min(0).max(80);
const floorSchema = z.enum(['stone', 'wood', 'earth']);
const themeSchema = z.enum(['crypt', 'tavern', 'cave']);
export const builtinKindSchema = z.enum(['chest', 'table', 'barrel', 'torch', 'pillar', 'stairs', 'bed', 'door']);

const rectSchema = z.object({
  id: identifierSchema,
  type: z.enum(['room', 'corridor']),
  x: coordinate,
  y: coordinate,
  width: z.number().finite().min(0.25).max(80),
  height: z.number().finite().min(0.25).max(80),
  floor: floorSchema,
  floorAssetId: identifierSchema.optional(),
  label: z.string().max(120).optional(),
}).strict();

const wallSchema = z.object({
  id: identifierSchema,
  type: z.literal('wall'),
  x: coordinate,
  y: coordinate,
  x2: coordinate,
  y2: coordinate,
  thickness: z.number().finite().min(0.01).max(4),
  assetId: identifierSchema.optional(),
}).strict();

const objectSchema = z.object({
  id: identifierSchema,
  type: z.literal('object'),
  x: coordinate,
  y: coordinate,
  // Thin PNGs retain their original aspect ratio.
  width: z.number().finite().positive().max(80),
  height: z.number().finite().positive().max(80),
  rotation: z.number().finite().min(-360).max(360),
  kind: builtinKindSchema,
  assetId: identifierSchema.optional(),
}).strict();

export const mapDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifierSchema,
  name: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  width: z.number().int().min(12).max(80),
  height: z.number().int().min(12).max(80),
  gridSize: z.literal(32),
  theme: themeSchema,
  seed: z.string().max(128),
  prompt: z.string().max(2000),
  generationMode: z.enum(['local', 'ai', 'manual']),
  wallAssetId: identifierSchema.optional(),
  elements: z.array(z.union([rectSchema, wallSchema, objectSchema])).max(2000),
}).strict().superRefine((map, context) => {
  const identifiers = new Set<string>();
  map.elements.forEach((element, index) => {
    if (identifiers.has(element.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['elements', index, 'id'], message: 'Element IDs must be unique' });
    }
    identifiers.add(element.id);
    const outside = element.type === 'wall'
      ? element.x > map.width || element.x2 > map.width || element.y > map.height || element.y2 > map.height
      : element.x + element.width > map.width + 1e-8 || element.y + element.height > map.height + 1e-8;
    if (outside) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['elements', index], message: 'Element must fit within the map' });
    }
    if (element.type === 'wall' && element.x === element.x2 && element.y === element.y2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['elements', index], message: 'Wall must have a nonzero length' });
    }
  });
});

export const generationInputSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  width: z.number().int().min(12).max(80),
  height: z.number().int().min(12).max(80),
  theme: themeSchema,
  seed: z.string().trim().min(1).max(128),
  mode: z.enum(['local', 'ai']),
  assetIds: z.array(identifierSchema).max(200).default([]),
}).strict().superRefine((input, context) => {
  if (new Set(input.assetIds).size !== input.assetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['assetIds'], message: 'Asset IDs must be unique' });
  }
});
