export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/** Large-library limits, shared by the server and the browser edition. */
export const IMPORT_LIMITS = {
  pngBytes: 64 * MiB,
  archiveBytes: GiB,
  uploadBytes: 2 * GiB,
  files: 65_534,
  archiveEntries: 65_534,
  expandedBytes: 8 * GiB,
  pngSide: 16_384,
  pngPixels: 64 * 1024 * 1024,
} as const;

export const IMPORT_LIMIT_TEXT = {
  png: 'PNG превышает лимит 64 МиБ.',
  archive: 'ZIP превышает лимит 1 ГиБ.',
  upload: 'Загрузка превышает общий лимит 2 ГиБ.',
  files: 'За одну загрузку допускается до 65 534 файлов.',
  entries: 'В ZIP допускается не больше 65 534 записей.',
  expanded: 'Распакованная загрузка превышает 8 ГиБ.',
  pixels: 'PNG должен быть не больше 16 384 пикселей по стороне и 64 мегапикселей.',
  batch: 'Одна загрузка допускает до 65 534 PNG и до 8 ГиБ после распаковки.',
} as const;
