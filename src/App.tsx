import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, BedDouble, Box, Check, ChevronDown, CircleHelp,
  Columns3, DoorOpen, Download, Eraser, Expand, FolderOpen, Grid2X2, Hand, Layers,
  LoaderCircle, Maximize2, Minus, MousePointer2, MoveRight, Package, Plus, Redo2,
  RotateCw, Save, Search, Settings2, Shuffle, Sparkles, Square, Table2, Trash2,
  Undo2, Upload, WandSparkles, X, Flame, LockKeyhole, Copy, Pencil,
} from 'lucide-react';
import type { Asset, AssetCategory, BuiltinKind, Capabilities, MapDocument, MapElement, ProjectSummary, Theme } from '../shared/types';
import { mapDocumentSchema } from '../shared/validation';
import { referencedAssetIds } from '../shared/assets';
import { IMPORT_LIMITS, IMPORT_LIMIT_TEXT } from '../shared/importLimits';
import { selectLibraryAssets } from '../shared/localGenerator';
import { MapCanvas, type Tool } from './MapCanvas';
import { api, ApiError, download, jsonRequest, STORAGE_MODE } from './api';

const BROWSER_STORAGE = STORAGE_MODE === 'browser';
const DRAFT_KEY = BROWSER_STORAGE ? 'dungeonai-studio:browser-draft:v1' : 'dungeonai-studio:draft:v1';
const ASSETS_PER_PAGE = 96;
const START_PROMPT = 'Древний склеп: 5 комнат, соединённых узкими коридорами. Центральный зал с колоннами, сокровищница и вход с факелами.';
const THEMES: { id: Theme; label: string; description: string }[] = [
  { id: 'crypt', label: 'Склеп', description: 'Камень и тайны' },
  { id: 'tavern', label: 'Таверна', description: 'Дерево и уют' },
  { id: 'cave', label: 'Пещера', description: 'Земля и глубины' },
];
const BUILTINS: { id: BuiltinKind; label: string; icon: typeof Box }[] = [
  { id: 'chest', label: 'Сундук', icon: LockKeyhole }, { id: 'table', label: 'Стол', icon: Table2 },
  { id: 'barrel', label: 'Бочка', icon: Box }, { id: 'torch', label: 'Факел', icon: Flame },
  { id: 'pillar', label: 'Колонна', icon: Columns3 }, { id: 'stairs', label: 'Лестница', icon: Layers },
  { id: 'bed', label: 'Кровать', icon: BedDouble }, { id: 'door', label: 'Дверь', icon: DoorOpen },
];
const TOOLS: { id: Tool; label: string; icon: typeof Box; shortcut: string }[] = [
  { id: 'select', label: 'Выделение', icon: MousePointer2, shortcut: 'V' },
  { id: 'pan', label: 'Перемещение', icon: Hand, shortcut: 'H' },
  { id: 'room', label: 'Помещение', icon: Square, shortcut: 'R' },
  { id: 'corridor', label: 'Коридор', icon: MoveRight, shortcut: 'C' },
  { id: 'wall', label: 'Стена', icon: Columns3, shortcut: 'W' },
  { id: 'object', label: 'Объект', icon: Package, shortcut: 'O' },
  { id: 'erase', label: 'Удаление', icon: Eraser, shortcut: 'E' },
];
const ELEMENT_LABELS = { room: 'Помещение', corridor: 'Коридор', wall: 'Стена', object: 'Объект' };
const CATEGORY_LABELS: Record<AssetCategory, string> = { objects: 'Объекты', floors: 'Полы', walls: 'Стены' };

function blankDocument(): MapDocument {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: crypto.randomUUID(), name: 'Новая карта', createdAt: now, updatedAt: now,
    width: 40, height: 28, gridSize: 32, theme: 'crypt', seed: 'adventure-01', prompt: '', generationMode: 'manual', elements: [] };
}
function validDraft(value: unknown): value is MapDocument {
  return mapDocumentSchema.safeParse(value).success;
}
function missingAssets(doc: MapDocument, library: Asset[]) {
  const available = new Set(library.map(a => a.id));
  return referencedAssetIds(doc).filter(id => !available.has(id));
}
function bounded(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function safeFilename(name: string) { return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'map'; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Не удалось выполнить операцию.'; }
function Modal({ title, children, onClose, wide = false, error = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; error?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={19}/></button></div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {children}
    </div>
  </div>;
}

function AssetSelect({ id, label, library, value, category, fallback, disabled, onChange }: {
  id: string; label: string; library: Asset[]; value?: string; category: AssetCategory;
  fallback: string; disabled?: boolean; onChange: (id: string | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const search = query.trim().toLowerCase();
    return library.filter(asset => asset.category === category
      && `${asset.name} ${asset.tags.join(' ')}`.toLowerCase().includes(search));
  }, [library, category, query]);
  const options = matches.slice(0, ASSETS_PER_PAGE);
  const current = value ? library.find(asset => asset.id === value) : undefined;
  return <div className="asset-picker">
    <label className="field-label" htmlFor={id}>{label.toUpperCase()}</label>
    <div className="asset-picker-search"><Search size={12}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Имя или тег PNG" aria-label={`Поиск: ${label}`} disabled={disabled}/></div>
    <select className="full-input" id={id} value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value || undefined)}>
      <option value="">{fallback}</option>
      {value && !current && <option value={value}>Ассет отсутствует — замените его</option>}
      {current && !options.some(asset => asset.id === current.id) && <option value={current.id}>{current.name} (текущий)</option>}
      {options.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
    </select>
    <p>Введите имя или тег, чтобы найти PNG. Показаны первые 96 совпадений{matches.length > ASSETS_PER_PAGE ? ` из ${matches.length.toLocaleString('ru-RU')}` : ''}.</p>
  </div>;
}

export default function App() {
  const [document, setDocument] = useState<MapDocument | null>(null);
  const [projectName, setProjectName] = useState('');
  const [past, setPast] = useState<MapDocument[]>([]);
  const [future, setFuture] = useState<MapDocument[]>([]);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [builtinKind, setBuiltinKind] = useState<BuiltinKind>('chest');
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(window.innerWidth < 1300 ? .6 : .72);
  const [visibleLayers, setVisibleLayers] = useState({ rooms: true, walls: true, objects: true });
  const [rightTab, setRightTab] = useState<'generate' | 'inspect'>('generate');
  const [libraryTab, setLibraryTab] = useState<'builtin' | 'uploaded'>('builtin');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | AssetCategory>('all');
  const [assetPage, setAssetPage] = useState(0);
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number; phase: 'validate' | 'commit' } | null>(null);
  const [prompt, setPrompt] = useState(START_PROMPT);
  const [theme, setTheme] = useState<Theme>('crypt');
  const [width, setWidth] = useState(40);
  const [height, setHeight] = useState(28);
  const [seed, setSeed] = useState('adventure-01');
  const [mode, setMode] = useState<'local' | 'ai'>('local');
  const [useLibrary, setUseLibrary] = useState(true);
  const [busy, setBusy] = useState<'startup' | 'generate' | 'save' | 'upload' | 'export' | 'open' | null>('startup');
  const [status, setStatus] = useState('Подготавливаем мастерскую…');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [modal, setModal] = useState<'projects' | 'export' | 'help' | 'asset' | null>(null);
  const [exportScale, setExportScale] = useState(2);
  const [exportGrid, setExportGrid] = useState(false);
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [assetName, setAssetName] = useState('');
  const [assetTags, setAssetTags] = useState('');
  const [assetCategory, setAssetCategory] = useState<AssetCategory>('objects');
  const [draggingFiles, setDraggingFiles] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const exporterRef = useRef<((scale: number, grid: boolean) => Promise<Blob>) | null>(null);
  const initialized = useRef(false);
  const dirty = !!document && JSON.stringify(document) !== savedFingerprint;
  const selected = document?.elements.find(e => e.id === selectedId);
  const activeAsset = assets.find(a => a.id === selectedAssetId);
  const filteredAssets = useMemo(() => {
    const query = search.toLowerCase();
    return assets.filter(a => (category === 'all' || a.category === category)
      && `${a.name} ${a.tags.join(' ')} ${a.pack || ''}`.toLowerCase().includes(query));
  }, [assets, category, search]);
  const assetPages = Math.ceil(filteredAssets.length / ASSETS_PER_PAGE);
  const currentAssetPage = Math.min(assetPage, Math.max(0, assetPages - 1));
  const pageAssets = filteredAssets.slice(currentAssetPage * ASSETS_PER_PAGE, (currentAssetPage + 1) * ASSETS_PER_PAGE);
  const closeModal = useCallback(() => setModal(null), []);
  const receiveExporter = useCallback((exporter: (scale: number, grid: boolean) => Promise<Blob>) => { exporterRef.current = exporter; }, []);

  useEffect(() => { setAssetPage(0); }, [search, category]);
  useEffect(() => { setProjectName(document?.name || ''); }, [document?.id, document?.name]);
  useEffect(() => {
    let lastUpdate = 0;
    let lastPhase = '';
    function progress(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (!detail || !Number.isFinite(detail.processed) || !Number.isFinite(detail.total) || !['validate', 'commit'].includes(detail.phase)) return;
      const now = performance.now();
      if (detail.processed !== 0 && detail.processed !== detail.total && detail.phase === lastPhase && now - lastUpdate < 100) return;
      lastUpdate = now; lastPhase = detail.phase;
      setImportProgress({ processed: Math.max(0, detail.processed), total: Math.max(0, detail.total), phase: detail.phase });
      setStatus(`${detail.phase === 'commit' ? 'Сохраняем' : 'Проверяем'} ассеты: ${detail.processed.toLocaleString('ru-RU')} / ${detail.total.toLocaleString('ru-RU')}`);
    }
    window.addEventListener('dungeonai-import-progress', progress);
    return () => window.removeEventListener('dungeonai-import-progress', progress);
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    async function initialize() {
      try {
        const results = await Promise.allSettled([api<Capabilities>('/capabilities'), api<Asset[]>('/assets'), api<ProjectSummary[]>('/projects')]);
        if (results[0].status === 'fulfilled') setCapabilities(results[0].value);
        if (results[1].status === 'fulfilled') setAssets(results[1].value);
        if (results[2].status === 'fulfilled') setProjects(results[2].value);
        for (const result of results) if (result.status === 'rejected') setError(errorMessage(result.reason));
        let draft: unknown;
        try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* No usable draft. */ }
        if (validDraft(draft)) {
          // Restore browser work without overwriting the saved server version.
          setDocument(draft);
          try { setSavedFingerprint(JSON.stringify(await api<MapDocument>(`/projects/${draft.id}`))); }
          catch (err) { if (!(err instanceof ApiError && err.status === 404)) setError(errorMessage(err)); }
          setPrompt(draft.prompt || START_PROMPT); setTheme(draft.theme); setWidth(draft.width); setHeight(draft.height); setSeed(draft.seed);
          setStatus('Черновик восстановлен');
          const library = results[1].status === 'fulfilled' ? results[1].value : [];
          if (missingAssets(draft, library).length) setWarnings(['Некоторые PNG ассеты черновика отсутствуют в библиотеке. Назначьте новые изображения в свойствах перед экспортом.']);
        } else {
          const generated = await api<MapDocument>('/generate', jsonRequest('POST', { prompt: START_PROMPT, width: 40, height: 28, theme: 'crypt', seed: 'adventure-01', mode: 'local', assetIds: [] }));
          setDocument(generated); setStatus('Стартовая карта готова. Добавьте свою историю.');
        }
      } catch (err) {
        setError(errorMessage(err)); setDocument(blankDocument()); setStatus(BROWSER_STORAGE ? 'Открыт пустой проект. Не удалось прочитать хранилище браузера.' : 'Открыт пустой проект. Проверьте подключение к серверу.');
      } finally { setBusy(null); }
    }
    void initialize();
  }, []);

  useEffect(() => {
    if (!document) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(document)); } catch { setStatus(BROWSER_STORAGE ? 'Черновик не поместился в памяти браузера. Сохраните проект или скачайте JSON.' : 'Черновик не поместился в браузере. Сохраните проект на сервере.'); }
  }, [document]);

  useEffect(() => {
    if (!document) return;
    const frame = requestAnimationFrame(fitMap);
    return () => cancelAnimationFrame(frame);
  }, [document?.id]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function changeDocument(next: MapDocument) {
    if (!document || busy) return;
    const result = mapDocumentSchema.safeParse(next);
    if (!result.success) {
      setError(next.elements.length > 2000 ? 'Карта может содержать до 2 000 элементов. Удалите ненужные объекты перед добавлением новых.' : 'Изменение не применено: параметры элемента выходят за допустимые пределы карты.');
      return;
    }
    setPast(previous => [...previous.slice(-59), document]); setFuture([]);
    setDocument({ ...next, updatedAt: new Date().toISOString() });
  }
  function undo() {
    if (!document || !past.length || busy) return;
    setFuture(previous => [document, ...previous]); setDocument(past[past.length - 1]); setPast(previous => previous.slice(0, -1)); setSelectedId(null);
  }
  function redo() {
    if (!document || !future.length || busy) return;
    setPast(previous => [...previous, document]); setDocument(future[0]); setFuture(previous => previous.slice(1)); setSelectedId(null);
  }
  function select(id: string | null) { setSelectedId(id); if (id) setRightTab('inspect'); }
  function updateSelected(update: Partial<MapElement>) {
    if (!document || !selected || busy) return;
    if (Object.values(update).some(value => typeof value === 'number' && !Number.isFinite(value))) return;
    const next = { ...selected, ...update } as MapElement;
    if (next.type === 'wall') {
      next.x = bounded(next.x, 0, document.width); next.x2 = bounded(next.x2, 0, document.width);
      next.y = bounded(next.y, 0, document.height); next.y2 = bounded(next.y2, 0, document.height);
      next.thickness = bounded(next.thickness, .01, 4);
      if (next.x === next.x2 && next.y === next.y2) return;
    } else {
      const minimumWidth = next.type === 'object' ? Math.min(selected.type !== 'wall' ? selected.width : .01, .25) : .25;
      const minimumHeight = next.type === 'object' ? Math.min(selected.type !== 'wall' ? selected.height : .01, .25) : .25;
      if ('width' in update) next.width = bounded(next.width, minimumWidth, document.width - next.x);
      if ('height' in update) next.height = bounded(next.height, minimumHeight, document.height - next.y);
      next.x = bounded(next.x, 0, document.width - next.width); next.y = bounded(next.y, 0, document.height - next.height);
      if (next.type === 'object') next.rotation = ((next.rotation % 360) + 360) % 360;
    }
    if (!mapDocumentSchema.safeParse({ ...document, elements: document.elements.map(e => e.id === selected.id ? next : e) }).success) return;
    changeDocument({ ...document, elements: document.elements.map(e => e.id === selected.id ? next : e) });
  }
  function deleteSelected() {
    if (!document || !selected) return;
    changeDocument({ ...document, elements: document.elements.filter(e => e.id !== selected.id) }); setSelectedId(null); setStatus('Объект удалён. Отмените действие с помощью Ctrl+Z.');
  }
  function duplicateSelected() {
    if (!document || !selected || busy) return;
    const clone = { ...selected, id: crypto.randomUUID() };
    if (clone.type === 'wall') {
      const dx = Math.min(1, document.width - Math.max(clone.x, clone.x2));
      const dy = Math.min(1, document.height - Math.max(clone.y, clone.y2));
      clone.x += dx; clone.x2 += dx; clone.y += dy; clone.y2 += dy;
    } else { clone.x = Math.min(clone.x + 1, document.width - clone.width); clone.y = Math.min(clone.y + 1, document.height - clone.height); }
    changeDocument({ ...document, elements: [...document.elements, clone] }); setSelectedId(clone.id);
  }
  async function saveProject() {
    if (!document || busy) return;
    if (!projectName.trim()) setProjectName(document.name);
    setBusy('save'); setError('');
    try {
      const saved = await api<MapDocument>(`/projects/${document.id}`, jsonRequest('PUT', document));
      setDocument(saved); setSavedFingerprint(JSON.stringify(saved)); setStatus(BROWSER_STORAGE ? 'Проект сохранён на этом устройстве' : 'Проект сохранён на сервере');
      setProjects(await api<ProjectSummary[]>('/projects'));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  }
  function canReplace() { return !dirty || window.confirm('В проекте есть несохранённые изменения. Заменить текущую карту? Сначала нажмите «Отмена», чтобы сохранить её.'); }
  async function generate() {
    if (busy || !canReplace()) return;
    setBusy('generate'); setError(''); setWarnings([]); setStatus(mode === 'ai' ? 'ИИ создаёт план карты…' : 'Строим помещения, соединяем коридоры…');
    try {
      const input = { prompt, width, height, theme, seed, mode, assetIds: [] as string[] };
      input.assetIds = useLibrary ? selectLibraryAssets(input, assets).map(asset => asset.id) : [];
      const next = await api<MapDocument>('/generate', jsonRequest('POST', input));
      setDocument(next); setPast([]); setFuture([]); setSavedFingerprint(''); setSelectedId(null);
      setStatus(next.generationMode === 'ai' ? 'Карта создана с помощью ИИ' : 'Карта создана локальным процедурным генератором');
    } catch (err) { setError(errorMessage(err)); setStatus('Генерация не завершена. Текущая карта сохранена в редакторе.'); } finally { setBusy(null); }
  }
  async function openProject(id: string) {
    if (busy || !canReplace()) return;
    setBusy('open'); setError('');
    try {
      const next = await api<MapDocument>(`/projects/${id}`);
      setDocument(next); setSavedFingerprint(JSON.stringify(next)); setPast([]); setFuture([]); setSelectedId(null); setModal(null);
      setPrompt(next.prompt || START_PROMPT); setWidth(next.width); setHeight(next.height); setTheme(next.theme); setSeed(next.seed); setStatus('Проект открыт');
      const missing = missingAssets(next, assets);
      if (missing.length) setWarnings([`В библиотеке отсутствуют PNG ассеты (${missing.length}). Назначьте новые изображения в свойствах перед экспортом.`]);
      else setWarnings([]);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  }
  async function showProjects() {
    setModal('projects');
    try { setProjects(await api<ProjectSummary[]>('/projects')); } catch (err) { setError(errorMessage(err)); }
  }
  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busy || !canReplace()) return;
    setBusy('open'); setError('');
    try {
      if (file.size > 5_000_000) throw new Error('Файл проекта слишком большой (максимум 5 МБ).');
      const value = JSON.parse(await file.text());
      if (!validDraft(value)) throw new Error('Это не проект DungeonAI Studio версии 1. Формат Dungeondraft пока не поддерживается.');
      // Import as a new project to protect existing projects with the same ID.
      const copy = { ...value, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const missing = missingAssets(copy, assets);
      // Missing images can be reassigned in the editor before a validated server save.
      const next = missing.length ? copy : await api<MapDocument>(`/projects/${copy.id}`, jsonRequest('PUT', copy));
      setDocument(next); setSavedFingerprint(missing.length ? '' : JSON.stringify(next)); setPast([]); setFuture([]); setSelectedId(null); setModal(null);
      setPrompt(next.prompt || START_PROMPT); setWidth(next.width); setHeight(next.height); setTheme(next.theme); setSeed(next.seed);
      setProjects(await api<ProjectSummary[]>('/projects')); setStatus(missing.length ? 'Проект импортирован в черновик. Назначьте PNG и сохраните.' : 'Проект импортирован и сохранён');
      setWarnings(missing.length ? [`В проекте отсутствуют PNG ассеты (${missing.length}). JSON содержит ссылки на библиотеку, а не файлы. Назначьте новые изображения в свойствах.`] : []);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  }
  async function deleteProject(project: ProjectSummary) {
    if (!window.confirm(`Удалить сохранённый проект «${project.name}»? Это действие нельзя отменить.`)) return;
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' }); setProjects(previous => previous.filter(p => p.id !== project.id));
      if (document?.id === project.id) setSavedFingerprint(''); setStatus('Сохранённый проект удалён');
    } catch (err) { setError(errorMessage(err)); }
  }
  async function uploadFiles(files: FileList | File[]) {
    if (!files.length || busy) return;
    setBusy('upload'); setError(''); setWarnings([]); setImportProgress(null); setStatus('Импортируем ассеты…');
    try {
      const selectedFiles = Array.from(files);
      if (selectedFiles.length > IMPORT_LIMITS.files) throw new Error(IMPORT_LIMIT_TEXT.files);
      if (selectedFiles.reduce((bytes, file) => bytes + file.size, 0) > IMPORT_LIMITS.uploadBytes) throw new Error(IMPORT_LIMIT_TEXT.upload);
      if (selectedFiles.some(file => /\.png$/i.test(file.name) && file.size > IMPORT_LIMITS.pngBytes)) throw new Error(IMPORT_LIMIT_TEXT.png);
      if (selectedFiles.some(file => /\.zip$/i.test(file.name) && file.size > IMPORT_LIMITS.archiveBytes)) throw new Error(IMPORT_LIMIT_TEXT.archive);
      if (selectedFiles.some(file => /\.dungeondraft_pack$/i.test(file.name))) throw new Error('Нативные .dungeondraft_pack пока не поддерживаются. Извлеките PNG разрешённым инструментом и загрузите изображения или ZIP с PNG.');
      const data = new FormData(); selectedFiles.forEach(file => data.append('files', file));
      const result = await api<{ assets: Asset[]; warnings: string[] }>('/assets', { method: 'POST', body: data });
      const loaded = await api<Asset[]>('/assets'); setAssets(loaded); setWarnings(result.warnings || []); setLibraryTab('uploaded'); setAssetPage(0);
      setStatus(`Добавлено ассетов: ${result.assets.length}`);
    } catch (err) { setError(errorMessage(err)); setStatus('Импорт не завершён. Проверьте сообщение об ошибке.'); } finally { setBusy(null); setImportProgress(null); }
  }
  function editAsset(asset: Asset) {
    setEditingAsset(asset); setAssetName(asset.name); setAssetTags(asset.tags.join(', ')); setAssetCategory(asset.category); setModal('asset');
  }
  function useAsset(asset: Asset) {
    if (!document || busy) return;
    if (asset.category === 'floors') {
      if (selected?.type === 'room' || selected?.type === 'corridor') updateSelected({ floorAssetId: asset.id });
      else if (document.elements.some(e => e.type === 'room' || e.type === 'corridor')) changeDocument({ ...document, elements: document.elements.map(e => e.type === 'room' || e.type === 'corridor' ? { ...e, floorAssetId: asset.id } : e) });
      else { setStatus('Сначала нарисуйте помещение, чтобы применить текстуру пола'); return; }
      setStatus(`Текстура пола применена: ${asset.name}`);
    } else if (asset.category === 'walls') {
      if (selected?.type === 'wall') updateSelected({ assetId: asset.id });
      else changeDocument({ ...document, wallAssetId: asset.id });
      setStatus(`Текстура стен применена: ${asset.name}`);
    } else { setSelectedAssetId(asset.id); setTool('object'); }
  }
  async function saveAsset() {
    if (!editingAsset) return;
    try {
      const next = await api<Asset>(`/assets/${editingAsset.id}`, jsonRequest('PATCH', { name: assetName, category: assetCategory, tags: assetTags.split(',').map(s => s.trim()).filter(Boolean) }));
      setAssets(previous => previous.map(a => a.id === next.id ? next : a)); setModal(null); setStatus('Ассет обновлён');
    } catch (err) { setError(errorMessage(err)); }
  }
  async function deleteAsset() {
    if (!editingAsset || !window.confirm('Удалить ассет из библиотеки? Карты, использующие его, будут показывать встроенный значок.')) return;
    try {
      await api(`/assets/${editingAsset.id}`, { method: 'DELETE' }); setAssets(previous => previous.filter(a => a.id !== editingAsset.id));
      if (selectedAssetId === editingAsset.id) setSelectedAssetId(null); setModal(null); setStatus('Ассет удалён');
    } catch (err) { setError(errorMessage(err)); }
  }
  async function exportPng() {
    if (!document || !exporterRef.current || busy) return;
    setBusy('export'); setError('');
    try { download(await exporterRef.current(exportScale, exportGrid), `${safeFilename(document.name)}.png`); setStatus('PNG экспортирован'); setModal(null); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  }
  function exportProject() {
    if (!document) return;
    download(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }), `${safeFilename(document.name)}.dungeonai.json`);
    setStatus('Файл проекта загружен. PNG ассеты хранятся отдельно в библиотеке.');
  }
  function fitMap() {
    if (!document) return;
    const viewport = window.document.querySelector('.map-canvas-viewport');
    if (viewport) setZoom(Math.max(.2, Math.min(2, Math.min((viewport.clientWidth - 72) / (document.width * 32), (viewport.clientHeight - 112) / (document.height * 32)))));
  }

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const input = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); if (!modal) void saveProject(); return; }
      if (input || modal) return;
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!busy) deleteSelected(); }
      else if (!modifier) { const found = TOOLS.find(t => t.shortcut.toLowerCase() === event.key.toLowerCase()); if (found) setTool(found.id); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  const elementCounts = document ? {
    rooms: document.elements.filter(e => e.type === 'room').length,
    corridors: document.elements.filter(e => e.type === 'corridor').length,
    objects: document.elements.filter(e => e.type === 'object').length,
  } : { rooms: 0, corridors: 0, objects: 0 };

  return <div className="studio-app">
    <header className="app-header">
      <a className="brand" href="#" onClick={e => e.preventDefault()} aria-label="DungeonAI Studio">
        <span className="brand-mark"><Layers size={23} strokeWidth={1.6}/></span>
        <span className="brand-name">Dungeon<span>AI</span><small>STUDIO</small></span>
      </a>
      <div className="header-divider"/>
      <span className="workspace-label">Мастерская карт <ChevronDown size={13}/></span>
      <div className="header-actions">
        <span className="local-badge"><span/> {BROWSER_STORAGE ? 'На этом устройстве' : 'Локальное хранилище'}</span>
        <button className="button button-quiet" onClick={() => void showProjects()} disabled={!!busy}><FolderOpen size={16}/><span>Проекты</span></button>
        <button className="button button-quiet" onClick={() => void saveProject()} disabled={!!busy || !document} aria-label="Сохранить">
          {busy === 'save' ? <LoaderCircle size={16} className="spin"/> : <Save size={16}/>}<span>Сохранить</span>{dirty && <span className="unsaved-dot" title="Есть несохранённые изменения"/>}
        </button>
        <button className="button button-gold" onClick={() => setModal('export')} disabled={!!busy || !document}><Download size={16}/><span>Экспорт</span></button>
        <button className="icon-button help-button" onClick={() => setModal('help')} aria-label="Поддерживаемые форматы и справка"><CircleHelp size={19}/></button>
      </div>
    </header>

    <div className="studio-body">
      <aside className="asset-sidebar">
        <div className="panel-heading"><div><span className="eyebrow">ВАШ НАБОР ИНСТРУМЕНТОВ</span><h2>Библиотека ассетов</h2></div><Package size={19}/></div>
        <div className="segmented-control library-tabs">
          <button className={libraryTab === 'builtin' ? 'active' : ''} onClick={() => setLibraryTab('builtin')}>Встроенные <span>8</span></button>
          <button className={libraryTab === 'uploaded' ? 'active' : ''} onClick={() => setLibraryTab('uploaded')}>Мои ассеты <span>{assets.length}</span></button>
        </div>
        <div className="asset-scroll">
          {libraryTab === 'builtin' ? <>
            <div className="section-label"><span>ОБЪЕКТЫ</span><span>Нажмите и разместите</span></div>
            <div className="builtin-grid">{BUILTINS.map(({ id, label, icon: Icon }) => <button key={id}
              className={`builtin-card ${tool === 'object' && !selectedAssetId && builtinKind === id ? 'selected' : ''}`}
              onClick={() => { setBuiltinKind(id); setSelectedAssetId(null); setTool('object'); }} aria-label={`Разместить: ${label}`}>
              <span className={`builtin-preview preview-${id}`}><Icon size={32} strokeWidth={1.2}/></span><span>{label}</span>
              {tool === 'object' && !selectedAssetId && builtinKind === id && <Check size={12} className="card-check"/>}
            </button>)}</div>
            <div className="palette-note"><MousePointer2 size={15}/><p>Выберите объект, затем нажмите на карту. Размер и поворот доступны в свойствах.</p></div>
            <div className="floor-swatches"><div className="section-label"><span>МАТЕРИАЛЫ ПОМЕЩЕНИЙ</span></div><div className="swatches-row">
              <span><i className="swatch swatch-stone"/>Камень</span><span><i className="swatch swatch-wood"/>Дерево</span><span><i className="swatch swatch-earth"/>Земля</span>
            </div><p>Меняйте материал в свойствах помещения.</p></div>
          </> : <>
            <div className="search-field"><Search size={15}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по имени или тегу" aria-label="Поиск ассетов"/></div>
            <div className="asset-filters">{(['all', 'objects', 'floors', 'walls'] as const).map(c => <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c === 'all' ? 'Все' : CATEGORY_LABELS[c]}</button>)}</div>
            {filteredAssets.length ? <><div className="uploaded-grid">{pageAssets.map(asset => <div className={`uploaded-card ${selectedAssetId === asset.id ? 'selected' : ''}`} key={asset.id}>
              <button className="asset-place" onClick={() => useAsset(asset)} aria-label={`Разместить ассет ${asset.name}`} title={asset.category === 'floors' ? 'Применить к выбранному помещению или ко всем помещениям' : asset.category === 'walls' ? 'Применить к выбранной стене или к стенам карты' : 'Разместить на карте'}><span className="asset-thumbnail">{asset.width * asset.height > 16 * 1024 * 1024 ? <span className="big-asset-preview"><Package size={22}/><span>Большой PNG</span></span> : <img src={asset.url} alt="" loading="lazy"/>}</span><span className="asset-title" title={asset.name}>{asset.name}</span><span className="asset-size">{CATEGORY_LABELS[asset.category]} · {asset.width} × {asset.height}</span></button>
              <button className="asset-edit" onClick={() => editAsset(asset)} aria-label={`Свойства ассета ${asset.name}`}><Pencil size={12}/></button>
            </div>)}</div><div className="asset-pagination"><span>{(currentAssetPage * ASSETS_PER_PAGE + 1).toLocaleString('ru-RU')}–{Math.min((currentAssetPage + 1) * ASSETS_PER_PAGE, filteredAssets.length).toLocaleString('ru-RU')} из {filteredAssets.length.toLocaleString('ru-RU')}</span>{assetPages > 1 && <div><button onClick={() => setAssetPage(currentAssetPage - 1)} disabled={currentAssetPage === 0} aria-label="Предыдущая страница ассетов"><ArrowLeft size={14}/></button><span>{currentAssetPage + 1}/{assetPages}</span><button onClick={() => { setAssetPage(currentAssetPage + 1); window.document.querySelector('.asset-scroll')?.scrollTo({ top: 0 }); }} disabled={currentAssetPage >= assetPages - 1} aria-label="Следующая страница ассетов"><ArrowRight size={14}/></button></div>}</div></> : <div className="library-empty"><Package size={34} strokeWidth={1}/><h3>{search ? 'Ассеты не найдены' : 'Своя коллекция — свой мир'}</h3><p>{search ? 'Попробуйте другой запрос или категорию.' : 'Загрузите PNG или ZIP с PNG, чтобы добавить их на карту.'}</p></div>}
          </>}
          <div className={`upload-zone ${draggingFiles ? 'drag-over' : ''}`} onDragOver={e => { e.preventDefault(); setDraggingFiles(true); }} onDragLeave={() => setDraggingFiles(false)} onDrop={e => { e.preventDefault(); setDraggingFiles(false); void uploadFiles(e.dataTransfer.files); }}>
            <button onClick={() => uploadRef.current?.click()} disabled={!!busy}><span className="upload-symbol">{busy === 'upload' ? <LoaderCircle size={21} className="spin"/> : <Upload size={21}/>}</span><strong>{busy === 'upload' ? importProgress?.phase === 'commit' ? 'Сохраняем ассеты…' : 'Проверяем и загружаем…' : 'Добавить свои ассеты'}</strong><span>{busy === 'upload' && importProgress ? `${importProgress.processed.toLocaleString('ru-RU')} / ${importProgress.total.toLocaleString('ru-RU')} файлов` : 'Перетащите файлы или выберите'}</span><small>PNG до 64 МиБ · ZIP до 1 ГиБ</small></button>
            {busy === 'upload' && importProgress && importProgress.total > 0 && <div className="import-progress" role="progressbar" aria-label={importProgress.phase === 'commit' ? 'Сохранение ассетов' : 'Проверка ассетов'} aria-valuemin={0} aria-valuemax={importProgress.total} aria-valuenow={Math.min(importProgress.processed, importProgress.total)}><span style={{ width: `${Math.min(100, 100 * importProgress.processed / importProgress.total)}%` }}/></div>}
          </div>
          <div className="upload-limits">До 2 ГиБ за загрузку · до 65 534 PNG</div>
          <div className="format-note"><CircleHelp size={12}/><span>Наборы .dungeondraft_pack пока не читаются.</span></div>
        </div>
        <div className="layers-panel"><div className="section-label"><span><Layers size={14}/> СЛОИ КАРТЫ</span></div>
          {(['rooms', 'walls', 'objects'] as const).map(layer => <label className="layer-row" key={layer}><input type="checkbox" checked={visibleLayers[layer]} onChange={e => setVisibleLayers(previous => ({ ...previous, [layer]: e.target.checked }))}/><span>{layer === 'rooms' ? 'Помещения и коридоры' : layer === 'walls' ? 'Стены' : 'Объекты'}</span><span>{document?.elements.filter(e => layer === 'rooms' ? e.type === 'room' || e.type === 'corridor' : layer === 'walls' ? e.type === 'wall' : e.type === 'object').length || 0}</span></label>)}
          <p>Видимость слоёв относится к редактору.</p>
        </div>
      </aside>

      <main className="editor-main">
        <div className="document-bar"><div className="document-title"><span className="document-icon"><Square size={16}/></span><input aria-label="Название проекта" value={document ? projectName : 'Подготовка карты…'} maxLength={120} disabled={!document || !!busy} onChange={e => { setProjectName(e.target.value); if (document && e.target.value.trim()) changeDocument({ ...document, name: e.target.value }); }} onBlur={() => { if (!projectName.trim() && document) setProjectName(document.name); }}/>{dirty && <span className="document-dirty" title="Не сохранено"/>}</div>
          <div className="document-meta"><span>{document?.width || width} × {document?.height || height}</span><span className="meta-separator"/><span>{THEMES.find(t => t.id === document?.theme)?.label || 'Склеп'}</span></div>
          <div className="history-buttons"><button className="icon-button" onClick={undo} disabled={!past.length || !!busy} title="Отменить (Ctrl+Z)" aria-label="Отменить"><Undo2 size={17}/></button><button className="icon-button" onClick={redo} disabled={!future.length || !!busy} title="Повторить (Ctrl+Y)" aria-label="Повторить"><Redo2 size={17}/></button></div>
        </div>
        <div className={`map-wrap ${busy ? 'is-busy' : ''}`} aria-busy={!!busy}>
          <div className="map-top-label"><span className="canvas-dot"/> РЕДАКТОР КАРТЫ <span className="canvas-mode">{document?.generationMode === 'ai' ? 'Создана ИИ' : document?.generationMode === 'manual' ? 'Ручная карта' : 'Процедурная карта'}</span></div>
          {document ? <MapCanvas document={document} onChange={changeDocument} assets={assets} tool={tool} selectedId={selectedId} onSelect={select} selectedAssetId={selectedAssetId} builtinKind={builtinKind} showGrid={showGrid} snap={snap} zoom={zoom} onZoomChange={setZoom} visibleLayers={visibleLayers} onExportReady={receiveExporter}/> : <div className="startup-empty"><LoaderCircle size={32} className="spin"/><p>Раскладываем карту приключения…</p></div>}
          {(busy === 'startup' || busy === 'generate') && <div className="generation-overlay"><span className="generation-orb"><Sparkles size={28}/></span><h3>{busy === 'startup' ? 'Добро пожаловать в мастерскую' : mode === 'ai' ? 'ИИ создаёт ваше приключение' : 'Ваш мир обретает форму'}</h3><p>{busy === 'startup' ? 'Подготавливаем первую карту' : 'Размещаем комнаты, коридоры и объекты…'}</p><div className="progress-track"><span/></div></div>}
          <div className="canvas-tools" role="toolbar" aria-label="Инструменты редактирования">{TOOLS.map(({ id, label, icon: Icon, shortcut }) => <button key={id} className={tool === id ? 'active' : ''} onClick={() => setTool(id)} title={`${label} (${shortcut})`} aria-label={label} aria-pressed={tool === id} disabled={!!busy}><Icon size={18}/></button>)}<span className="toolbar-divider"/><button className={showGrid ? 'active subtle' : ''} onClick={() => setShowGrid(!showGrid)} title="Показать сетку" aria-label="Показать сетку" aria-pressed={showGrid}><Grid2X2 size={17}/></button><button className={snap ? 'active subtle' : ''} onClick={() => setSnap(!snap)} title="Привязка к сетке" aria-label="Привязка к сетке" aria-pressed={snap}><Expand size={17}/></button></div>
          <div className="zoom-tools"><button onClick={() => setZoom(Math.max(.2, +(zoom - .1).toFixed(2)))} aria-label="Уменьшить масштаб"><Minus size={15}/></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(2.5, +(zoom + .1).toFixed(2)))} aria-label="Увеличить масштаб"><Plus size={15}/></button><span className="zoom-divider"/><button onClick={fitMap} aria-label="Вместить карту" title="Вместить карту"><Maximize2 size={15}/></button></div>
        </div>
        <div className="canvas-footer"><span><span className="live-dot"/>{tool === 'select' ? 'Выберите объект · перетащите, чтобы переместить' : tool === 'pan' ? 'Перетащите карту для навигации' : tool === 'room' || tool === 'corridor' || tool === 'wall' ? 'Нажмите и потяните, чтобы нарисовать' : tool === 'erase' ? 'Нажмите на объект, чтобы удалить' : `Нажмите на карту: ${activeAsset?.name || BUILTINS.find(b => b.id === builtinKind)?.label}`}</span><span>{elementCounts.rooms} комнат · {elementCounts.corridors} коридоров · {elementCounts.objects} объектов</span></div>
      </main>

      <aside className="generator-sidebar">
        <div className="right-tabs"><button className={rightTab === 'generate' ? 'active' : ''} onClick={() => setRightTab('generate')}><Sparkles size={15}/> Создать карту</button><button className={rightTab === 'inspect' ? 'active' : ''} onClick={() => setRightTab('inspect')}><Settings2 size={15}/> Свойства</button></div>
        <div className="generator-scroll">
          {rightTab === 'generate' ? <>
            <div className="generator-intro"><span className="intro-icon"><WandSparkles size={22}/></span><span className="eyebrow">НАЧНИТЕ С ИДЕИ</span><h2>Из замысла<br/>в приключение.</h2><p>Опишите место. Создайте основу.<br/>Добавьте детали вручную.</p></div>
            <div className="mode-selector"><button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>Процедурная</button><button className={mode === 'ai' ? 'active' : ''} disabled={!capabilities?.ai.configured} onClick={() => setMode('ai')} title={capabilities?.ai.configured ? `Модель: ${capabilities.ai.model}` : BROWSER_STORAGE ? 'ИИ доступен в серверной версии' : 'Для ИИ нужен DUNGEON_AI_KEY на сервере'}><Sparkles size={12}/> С помощью ИИ {!capabilities?.ai.configured && <LockKeyhole size={11}/>}</button></div>
            <label className="field-label" htmlFor="map-prompt">ВАША ИСТОРИЯ <span>{prompt.length}/2000</span></label>
            <div className="prompt-field"><textarea id="map-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={2000} placeholder="Заброшенный храм, 6 комнат, тайный проход и зал с колоннами…"/><span><Pencil size={12}/> Чем подробнее, тем интереснее</span></div>
            <div className="prompt-chips"><button onClick={() => { setPrompt('Средневековая таверна: 6 комнат, большой общий зал со столами, спальни с кроватями и склад с бочками.'); setTheme('tavern'); }}>Таверна у дороги</button><button onClick={() => { setPrompt('Система пещер: 7 каменных залов, узкие коридоры, сокровищница с сундуками и факелы у входа.'); setTheme('cave'); }}>Логово в пещере</button></div>
            <label className="field-label">АТМОСФЕРА</label><div className="theme-options">{THEMES.map(item => <button key={item.id} className={theme === item.id ? 'active' : ''} onClick={() => setTheme(item.id)}><span className={`theme-glyph theme-${item.id}`}>{item.id === 'crypt' ? <Columns3 size={21}/> : item.id === 'tavern' ? <Flame size={21}/> : <Square size={21}/>}</span><span>{item.label}</span>{theme === item.id && <Check size={10}/>}</button>)}</div>
            <label className="field-label">РАЗМЕР КАРТЫ <span>в клетках</span></label><div className="dimension-fields"><label><span>Ширина</span><input aria-label="Ширина карты в клетках" type="number" min={12} max={80} value={width} onChange={e => setWidth(Number(e.target.value))}/></label><X size={12}/><label><span>Высота</span><input aria-label="Высота карты в клетках" type="number" min={12} max={80} value={height} onChange={e => setHeight(Number(e.target.value))}/></label></div>
            <label className="field-label" htmlFor="map-seed">ЗЕРНО ГЕНЕРАЦИИ <span>Повторяемая карта</span></label><div className="seed-field"><input id="map-seed" value={seed} maxLength={100} onChange={e => setSeed(e.target.value)} placeholder="Например, adventure-01"/><button onClick={() => setSeed(crypto.randomUUID().slice(0, 8))} aria-label="Случайное зерно" title="Случайное зерно"><Shuffle size={15}/></button></div>
            {assets.length > 0 && <><label className="generation-assets"><input type="checkbox" checked={useLibrary} onChange={e => setUseLibrary(e.target.checked)}/><span>Использовать мою библиотеку ({assets.length.toLocaleString('ru-RU')} ассетов)</span></label><p className="generation-disclaimer">Генератор выберет подходящие PNG для помещений, стен и объектов.</p></>}
            <button className="generate-button" onClick={() => void generate()} disabled={!!busy || !prompt.trim() || !seed.trim() || width < 12 || width > 80 || height < 12 || height > 80 || !Number.isInteger(width) || !Number.isInteger(height)}>{busy === 'generate' ? <LoaderCircle className="spin" size={18}/> : <Sparkles size={18}/>}<span>{busy === 'generate' ? 'Создаём карту…' : 'Создать карту'}</span><ArrowRight size={17}/></button>
            <p className="generation-disclaimer">{mode === 'ai' ? `План создаёт OpenAI · ${capabilities?.ai.model}. Ваш текст отправляется провайдеру.` : BROWSER_STORAGE ? 'Генератор работает в браузере: учитывает тему, число комнат и ключевые слова. Аккаунт и ключ ИИ не нужны.' : 'Локальный генератор учитывает тему, число комнат и ключевые слова. Интернет и ключ ИИ не нужны.'}</p>
            {!capabilities?.ai.configured && <div className="ai-note"><Sparkles size={15}/><p><strong>{BROWSER_STORAGE ? 'ИИ доступен в серверной версии' : 'Хотите подключить ИИ?'}</strong><br/>{BROWSER_STORAGE ? 'Эта версия создаёт карты процедурно на вашем устройстве. ИИ требует отдельного сервера.' : 'Настройте DUNGEON_AI_KEY в среде сервера. Справка — в README проекта.'}</p></div>}
          </> : selected ? <>
            <div className="inspector-title"><span className="intro-icon"><Settings2 size={20}/></span><span className="eyebrow">ВЫБРАННЫЙ ЭЛЕМЕНТ</span><h2>{ELEMENT_LABELS[selected.type]}</h2><p>Координаты и размеры — в клетках.</p></div>
            {selected.type === 'room' || selected.type === 'corridor' ? <><label className="field-label" htmlFor="element-name">ПОДПИСЬ</label><input className="full-input" id="element-name" value={selected.label || ''} maxLength={80} placeholder="Название помещения" onChange={e => updateSelected({ label: e.target.value })}/></> : null}
            <label className="field-label">ПОЛОЖЕНИЕ</label><div className="property-grid">{(['x', 'y'] as const).map(key => <label key={key}><span>{key.toUpperCase()}</span><input aria-label={`Координата ${key}`} type="number" min={0} max={key === 'x' ? (document?.width || 40) : (document?.height || 28)} step={snap ? 1 : .25} value={+selected[key].toFixed(2)} onChange={e => updateSelected({ [key]: Number(e.target.value) })}/></label>)}</div>
            {selected.type === 'wall' ? <><label className="field-label">КОНЕЦ СТЕНЫ</label><div className="property-grid">{(['x2', 'y2'] as const).map(key => <label key={key}><span>{key.toUpperCase()}</span><input aria-label={`Координата конца ${key}`} type="number" min={0} max={key === 'x2' ? document?.width : document?.height} step={.25} value={+selected[key].toFixed(2)} onChange={e => updateSelected({ [key]: Number(e.target.value) })}/></label>)}</div><label className="field-label" htmlFor="wall-thickness">ТОЛЩИНА</label><input className="full-input" id="wall-thickness" type="number" min={.01} max={4} step={.1} value={selected.thickness} onChange={e => updateSelected({ thickness: Number(e.target.value) })}/></> : <><label className="field-label">РАЗМЕР</label><div className="property-grid"><label><span>Ширина</span><input aria-label="Ширина элемента" type="number" min={.25} max={document?.width} step={.25} value={+selected.width.toFixed(2)} onChange={e => updateSelected({ width: Math.max(.25, Number(e.target.value)) })}/></label><label><span>Высота</span><input aria-label="Высота элемента" type="number" min={.25} max={document?.height} step={.25} value={+selected.height.toFixed(2)} onChange={e => updateSelected({ height: Math.max(.25, Number(e.target.value)) })}/></label></div></>}
            {(selected.type === 'room' || selected.type === 'corridor') && <><label className="field-label" htmlFor="floor-material">МАТЕРИАЛ ПОЛА</label><select className="full-input" id="floor-material" value={selected.floor} onChange={e => updateSelected({ floor: e.target.value as 'stone' | 'wood' | 'earth' })}><option value="stone">Камень</option><option value="wood">Дерево</option><option value="earth">Земля</option></select><AssetSelect id="floor-asset" label="PNG текстура пола" library={assets} value={selected.floorAssetId} category="floors" fallback="Встроенный материал" disabled={!!busy} onChange={id => updateSelected({ floorAssetId: id })}/></>}
            {selected.type === 'wall' && <><AssetSelect id="wall-asset" label="PNG текстура стены" library={assets} value={selected.assetId} category="walls" fallback="Как у стен карты" disabled={!!busy} onChange={id => updateSelected({ assetId: id })}/></>}
            {selected.type === 'object' && <><label className="field-label" htmlFor="object-rotation">ПОВОРОТ</label><div className="seed-field"><input id="object-rotation" type="number" step={15} value={selected.rotation} onChange={e => updateSelected({ rotation: Number(e.target.value) })}/><button title="Повернуть на 90°" aria-label="Повернуть на 90 градусов" onClick={() => updateSelected({ rotation: (selected.rotation + 90) % 360 })}><RotateCw size={16}/></button></div><label className="field-label" htmlFor="object-kind">ВСТРОЕННЫЙ ОБЪЕКТ</label><select className="full-input" id="object-kind" value={selected.kind} onChange={e => updateSelected({ kind: e.target.value as BuiltinKind, assetId: undefined })}>{BUILTINS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select>{selected.assetId && <p className="inspector-asset">PNG: {assets.find(a => a.id === selected.assetId)?.name || 'ассет отсутствует'}</p>}</>}
            {selected.type === 'object' && <><AssetSelect id="object-asset" label="PNG объекта" library={assets} value={selected.assetId} category="objects" fallback="Встроенный объект" disabled={!!busy} onChange={id => updateSelected({ assetId: id })}/></>}
            <div className="inspector-actions"><button className="button button-outline" onClick={duplicateSelected} disabled={!!busy}><Copy size={15}/> Дублировать</button><button className="button button-danger" onClick={deleteSelected} disabled={!!busy}><Trash2 size={15}/> Удалить</button></div>
            <p className="generation-disclaimer">Изменения сохраняются в черновике. Ctrl+Z отменяет последнее действие.</p>
          </> : <div className="inspector-empty"><MousePointer2 size={36} strokeWidth={1}/><h2>Всё в ваших руках</h2><p>Выберите помещение, стену или объект на карте, чтобы изменить его свойства.</p><button className="button button-outline" onClick={() => setTool('select')}><MousePointer2 size={15}/> Инструмент выделения</button></div>}
          {rightTab === 'inspect' && document && <div className="map-properties"><AssetSelect id="map-wall-asset" label="PNG стен всей карты" library={assets} value={document.wallAssetId} category="walls" fallback="Встроенный камень" disabled={!!busy} onChange={id => changeDocument({ ...document, wallAssetId: id })}/><p className="generation-disclaimer">Текстура контуров помещений и стен без собственной PNG текстуры.</p></div>}
        </div>
        <div className="sidebar-bottom"><span className="compass-symbol">✧</span><span>Каждая карта — начало истории.</span></div>
      </aside>
    </div>

    <footer className="app-status"><span className="status-message" role="status"><span className={`status-dot ${busy ? 'working' : ''}`}/>{status}</span><span className="status-shortcuts">V выделение <span>·</span> R комната <span>·</span> Ctrl+Z отменить</span><span className="version-tag">DUNGEONAI STUDIO <span>v1.0</span></span></footer>
    {!modal && (error || warnings.length > 0) && <div className={`notice-toast ${error ? 'error' : 'warning'}`} role={error ? 'alert' : 'status'}><CircleHelp size={18}/><div>{error || warnings.join(' ')}</div><button onClick={() => { setError(''); setWarnings([]); }} aria-label="Закрыть уведомление"><X size={17}/></button></div>}
    <input ref={uploadRef} type="file" hidden multiple accept=".png,.zip,image/png,application/zip" onChange={e => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ''; }}/>
    <input ref={importRef} type="file" hidden accept=".json,application/json" onChange={e => void importProject(e)}/>

    {modal === 'projects' && <Modal title="Ваши проекты" onClose={closeModal} error={error} wide><p className="modal-subtitle">{BROWSER_STORAGE ? "Карты хранятся в этом браузере на этом устройстве. Скачайте JSON для резервной копии; PNG переносите отдельно." : "Карты хранятся на сервере этой среды. Скачайте JSON для резервной копии."}</p><div className="project-dialog-tools"><button className="button button-outline" onClick={() => importRef.current?.click()} disabled={!!busy}><Upload size={16}/> Импорт JSON</button><button className="button button-outline" onClick={() => { if (canReplace()) { setDocument(blankDocument()); setSavedFingerprint(''); setPast([]); setFuture([]); setSelectedId(null); setModal(null); setStatus('Создан пустой проект'); } }} disabled={!!busy}><Plus size={16}/> Пустая карта</button></div>
      <div className="project-list">{projects.length ? projects.map(project => <div className="project-row" key={project.id}><span className="project-thumbnail"><Layers size={25}/></span><button className="project-open" onClick={() => void openProject(project.id)} disabled={!!busy}><strong>{project.name}</strong><span>{project.width} × {project.height} · {project.elementCount} элементов · {new Date(project.updatedAt).toLocaleDateString('ru-RU')}</span></button><button className="icon-button" onClick={() => void deleteProject(project)} disabled={!!busy} aria-label={`Удалить проект ${project.name}`}><Trash2 size={16}/></button><button className="icon-button" onClick={() => void openProject(project.id)} disabled={!!busy} aria-label={`Открыть проект ${project.name}`}><ArrowRight size={18}/></button></div>) : <div className="projects-empty"><FolderOpen size={36} strokeWidth={1}/><h3>Пока здесь пусто</h3><p>Нажмите «Сохранить», чтобы первый проект появился здесь.</p></div>}</div><p className="dialog-footnote">JSON DungeonAI хранит геометрию и ссылки на ассеты. Изображения переносите отдельно. Файлы Dungeondraft не импортируются.</p></Modal>}
    {modal === 'export' && document && <Modal title="Заберите свою карту" onClose={closeModal} error={error}><p className="modal-subtitle">Для виртуального стола, печати или следующего приключения.</p><div className="export-card"><span className="export-icon"><Grid2X2 size={23}/></span><div><strong>Карта в PNG</strong><p>Готовое изображение с вашими ассетами</p></div><span className="format-pill">PNG</span></div><label className="field-label" htmlFor="export-scale">РАЗРЕШЕНИЕ</label><select id="export-scale" className="full-input" value={exportScale} onChange={e => setExportScale(Number(e.target.value))}>{[1, 2, 3].map(scale => <option key={scale} value={scale}>{scale}× · {document.width * 32 * scale} × {document.height * 32 * scale} px</option>)}</select><label className="export-grid-toggle"><input type="checkbox" checked={exportGrid} onChange={e => setExportGrid(e.target.checked)}/>Включить клетчатую сетку</label><p className="dialog-footnote">PNG включает все слои карты. Скрытые в редакторе слои тоже экспортируются.</p><button className="button button-gold export-primary" onClick={() => void exportPng()} disabled={!!busy}>{busy === 'export' ? <LoaderCircle size={17} className="spin"/> : <Download size={17}/>} Скачать PNG</button><div className="export-json"><div><strong>Редактируемый проект</strong><p>.dungeonai.json · ассеты отдельно</p></div><button className="button button-outline" onClick={exportProject}><ArrowDownToLine size={15}/> JSON</button></div><div className="planned-export"><LockKeyhole size={15}/><span>Экспорт .dungeondraft_map</span><small>В планах</small></div></Modal>}
    {modal === 'help' && <Modal title="Мастерская без загадок" onClose={closeModal} error={error}><p className="modal-subtitle">DungeonAI Studio создаёт карты для настольных приключений. Совместимость с Dungeondraft развивается отдельно.</p><div className="format-table"><div><Check size={16}/><strong>PNG ассеты</strong><span>Загрузка и размещение</span></div><div><Check size={16}/><strong>ZIP с PNG</strong><span>Распаковка изображений</span></div><div><Check size={16}/><strong>PNG карты</strong><span>Экспорт 1×, 2× и 3×</span></div><div><Check size={16}/><strong>.dungeonai.json</strong><span>Редактируемый проект Studio</span></div><div className="unsupported"><LockKeyhole size={15}/><strong>.dungeondraft_pack</strong><span>Не поддерживается</span></div><div className="unsupported"><LockKeyhole size={15}/><strong>.dungeondraft_map</strong><span>Импорт и экспорт в планах</span></div></div><p className="dialog-footnote">Для наборов Dungeondraft загрузите PNG, предварительно извлечённые с разрешения автора. ZIP — контейнер для PNG, а не нативный набор Dungeondraft.</p><div className="upload-help"><h3>Для больших наборов</h3><p>PNG до 64 МиБ · ZIP до 1 ГиБ · загрузка до 2 ГиБ. До 65 534 файлов и до 8 ГиБ после распаковки.</p><p>Изображение: до 16 384 px по стороне и до 64 мегапикселей. Ассеты доступны страницами по 96; поиск работает по всей коллекции.</p>{BROWSER_STORAGE && <p>Объём коллекции зависит от доступного места в хранилище этого браузера. Проверенные изображения сохраняются по одному, затем набор публикуется целиком.</p>}</div><div className="legacy-help"><a href={`${import.meta.env.BASE_URL}legacy/index.html`} target="_blank" rel="noopener noreferrer">Открыть исходную версию (v0.1) <ArrowRight size={12}/></a><p>Для проектов старого формата и прежних инструментов. Эта версия открывается отдельно.</p></div><div className="keyboard-help"><h3>Быстрые действия</h3><p><kbd>Ctrl</kbd> + <kbd>S</kbd> сохранить <span>·</span> <kbd>Ctrl</kbd> + <kbd>Z</kbd> отменить</p><p><kbd>V</kbd> выделение <span>·</span> <kbd>R</kbd> комната <span>·</span> <kbd>Delete</kbd> удалить</p></div></Modal>}
    {modal === 'asset' && editingAsset && <Modal title="Свойства ассета" onClose={closeModal} error={error}><div className="asset-modal-preview"><img src={editingAsset.url} alt={editingAsset.name}/><span>{editingAsset.width} × {editingAsset.height} px</span></div><label className="field-label" htmlFor="asset-name">НАЗВАНИЕ</label><input className="full-input" id="asset-name" value={assetName} maxLength={120} onChange={e => setAssetName(e.target.value)}/><label className="field-label" htmlFor="asset-category">КАТЕГОРИЯ БИБЛИОТЕКИ</label><select className="full-input" id="asset-category" value={assetCategory} onChange={e => setAssetCategory(e.target.value as AssetCategory)}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p className="dialog-footnote">Объекты размещаются на карте; PNG полов и стен применяются как повторяющиеся текстуры. Генератор выбирает первый ассет каждой категории.</p><label className="field-label" htmlFor="asset-tags">ТЕГИ <span>через запятую</span></label><input className="full-input" id="asset-tags" value={assetTags} maxLength={300} onChange={e => setAssetTags(e.target.value)}/><div className="asset-modal-actions"><button className="button button-danger" onClick={() => void deleteAsset()}><Trash2 size={15}/> Удалить</button><button className="button button-gold" onClick={() => void saveAsset()} disabled={!assetName.trim()}><Check size={15}/> Сохранить</button></div></Modal>}
  </div>;
}
