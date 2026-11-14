import { Router } from 'express';
import { exec, select } from './db.js';
import { requireAdmin, requireAuth } from './auth.js';
import { logAction } from './auditlog.js';
import { HttpError, intParam, str } from './http.js';
import { DICTS, WHOLE_NETWORK, defaultNote, type DictItem, type DictKey } from '../../shared/dict.js';

// Справочники выпадающих списков живут в БД и кешируются в памяти:
// проверка аварии синхронная и не ходит в БД за каждым значением.

let cache: DictItem[] = [];

function mapItem(r: any): DictItem {
  return {
    id: r.id,
    dict: r.dict,
    value: r.value,
    note: r.note || '',
    sort: Number(r.sort) || 0,
    is_active: !!r.is_active,
    is_system: !!r.is_system,
  };
}

export async function reloadDicts(): Promise<void> {
  const rows = await select('SELECT * FROM dict_items ORDER BY dict, sort, id');
  cache = rows.map(mapItem);
}

/** Первичное наполнение по ТЗ — только для справочников, в которых ещё нет ни одного значения. */
export async function ensureDicts(): Promise<void> {
  for (const d of DICTS) {
    const [{ c }] = await select<{ c: number }>('SELECT COUNT(*) AS c FROM dict_items WHERE dict = ?', [d.key]);
    if (Number(c) > 0) continue;
    const rows = d.defaults.map((v, i) => [
      d.key, v, defaultNote(d.key, v), (i + 1) * 10, 1,
      d.key === 'napr' && v === WHOLE_NETWORK ? 1 : 0,
    ]);
    await exec('INSERT INTO dict_items (dict, value, note, sort, is_active, is_system) VALUES ?', [rows]);
    console.log(`[seed] справочник «${d.plural}» — значений: ${rows.length}`);
  }
  // Пустые расшифровки известных значений заполняем (полные названия ТЦ и направлений из сводки).
  const empty = await select<{ id: number; dict: string; value: string }>("SELECT id, dict, value FROM dict_items WHERE note = ''");
  for (const it of empty) {
    const note = defaultNote(it.dict, it.value);
    if (note) await exec("UPDATE dict_items SET note = ? WHERE id = ? AND note = ''", [note, it.id]);
  }
  await reloadDicts();
}

export function dictItems(key?: DictKey): DictItem[] {
  return key ? cache.filter((i) => i.dict === key) : cache.slice();
}

/** Значения справочника. activeOnly=false — включая скрытые (для проверки старых записей и фильтров). */
export function dictValues(key: DictKey, activeOnly = false): string[] {
  return cache.filter((i) => i.dict === key && (!activeOnly || i.is_active)).map((i) => i.value);
}

function dictMeta(key: string) {
  const d = DICTS.find((x) => x.key === key);
  if (!d) throw new HttpError(400, 'Неизвестный справочник');
  return d;
}

async function usageCount(field: string, value: string): Promise<number> {
  const [{ c }] = await select<{ c: number }>(`SELECT COUNT(*) AS c FROM alarms WHERE ${field} = ?`, [value]);
  return Number(c);
}

const STATION_COLUMN: Record<string, string> = { napr: 'napr', tehc: 'tehc', netw: 'netw_type' };

function readBody(body: any) {
  const value = str(body?.value);
  const note = str(body?.note);
  const errors: Record<string, string> = {};
  if (!value) errors.value = 'Укажите значение';
  else if (value.length > 64) errors.value = 'Не длиннее 64 символов';
  else if (/[,;]/.test(value)) errors.value = 'Без запятых и точек с запятой';
  if (note.length > 190) errors.note = 'Не длиннее 190 символов';
  return { value, note, errors };
}

export const dictsRouter = Router();

/** Все значения всех справочников (со скрытыми) и сколько аварий их используют. */
dictsRouter.get('/', requireAuth, async (_req, res) => {
  const usage: Record<string, Record<string, number>> = {};
  for (const d of DICTS) {
    const rows = await select(`SELECT ${d.field} AS v, COUNT(*) AS c FROM alarms GROUP BY ${d.field}`);
    usage[d.key] = {};
    for (const r of rows) if (r.v !== null) usage[d.key][r.v] = Number(r.c);
  }
  res.json({
    dicts: DICTS.map((d) => ({ key: d.key, field: d.field, label: d.label, plural: d.plural })),
    items: dictItems().map((i) => Object.assign({}, i, { used: (usage[i.dict] || {})[i.value] || 0 })),
  });
});

dictsRouter.post('/', requireAdmin, async (req, res) => {
  const d = dictMeta(str(req.body?.dict));
  const { value, note, errors } = readBody(req.body);
  if (!errors.value && dictValues(d.key).indexOf(value) >= 0) errors.value = 'Такое значение уже есть';
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  const [{ m }] = await select<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM dict_items WHERE dict = ?', [d.key]);
  const r = await exec('INSERT INTO dict_items (dict, value, note, sort, is_active, is_system) VALUES (?, ?, ?, ?, 1, 0)', [
    d.key, value, note, Number(m) + 10,
  ]);
  await reloadDicts();
  await logAction(req.user!, 'dict_create', null, { dict: d.plural, value, note });
  res.status(201).json({ item: cache.find((i) => i.id === r.insertId) });
});

/** Изменение значения. Переименование каскадно обновляет аварии и инвентарь — отчёты не «рвутся». */
dictsRouter.put('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const item = cache.find((i) => i.id === id);
  if (!item) throw new HttpError(404, 'Значение не найдено');
  const d = dictMeta(item.dict);
  const { value, note, errors } = readBody(req.body);
  const is_active = req.body?.is_active === false ? 0 : 1;
  if (!errors.value && value !== item.value && dictValues(d.key).indexOf(value) >= 0) errors.value = 'Такое значение уже есть';
  if (item.is_system && value !== item.value) errors.value = 'Системное значение переименовать нельзя';
  if (item.is_system && !is_active) errors.value = 'Системное значение скрыть нельзя';
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);

  let renamed = 0;
  if (value !== item.value) {
    const r = await exec(`UPDATE alarms SET ${d.field} = ? WHERE ${d.field} = ?`, [value, item.value]);
    renamed = r.affectedRows;
    const col = STATION_COLUMN[d.key];
    if (col) await exec(`UPDATE stations SET ${col} = ? WHERE ${col} = ?`, [value, item.value]);
  }
  await exec('UPDATE dict_items SET value = ?, note = ?, is_active = ? WHERE id = ?', [value, note, is_active, id]);
  await reloadDicts();
  const changes: Record<string, unknown> = { dict: d.plural, value: item.value };
  if (value !== item.value) changes.renamed = [item.value, value];
  if (note !== item.note) changes.note = [item.note, note];
  if (!!is_active !== item.is_active) changes.is_active = [item.is_active, !!is_active];
  if (renamed) changes.alarms_updated = renamed;
  await logAction(req.user!, 'dict_update', null, changes);
  res.json({ item: cache.find((i) => i.id === id), renamed });
});

/** Порядок значений в выпадающем списке: массив id в нужном порядке. */
dictsRouter.post('/order', requireAdmin, async (req, res) => {
  const d = dictMeta(str(req.body?.dict));
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids)) throw new HttpError(400, 'Ожидается список id');
  let sort = 10;
  for (const raw of ids) {
    const id = Number(raw);
    if (!cache.some((i) => i.id === id && i.dict === d.key)) continue;
    await exec('UPDATE dict_items SET sort = ? WHERE id = ?', [sort, id]);
    sort += 10;
  }
  await reloadDicts();
  res.json({ ok: true });
});

/** Удалить можно только неиспользуемое значение; используемое — скрыть. */
dictsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const item = cache.find((i) => i.id === id);
  if (!item) throw new HttpError(404, 'Значение не найдено');
  if (item.is_system) throw new HttpError(409, 'Системное значение удалить нельзя');
  const d = dictMeta(item.dict);
  const used = await usageCount(d.field, item.value);
  if (used > 0) {
    throw new HttpError(409, `«${item.value}» указано в ${used} авариях. Скройте значение — оно пропадёт из списков, а старые записи сохранятся.`);
  }
  await exec('DELETE FROM dict_items WHERE id = ?', [id]);
  await reloadDicts();
  await logAction(req.user!, 'dict_delete', null, { dict: d.plural, value: item.value });
  res.json({ ok: true });
});
