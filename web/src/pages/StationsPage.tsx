import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import type { Station } from '../types';
import { Field, Select } from '../components/Field';
import { Modal } from '../components/Modal';
import { AlarmEditor } from '../components/AlarmEditor';
import { emptyDraft, type Draft } from '../components/AlarmForm';
import { IconDownload, IconPlus } from '../components/Icons';
import { allValues, num, plural } from '../format';
import { WHOLE_NETWORK } from '../../../shared/dict';
import { humanDate, humanDateTime, humanDuration } from '../../../shared/time';

interface ListResp {
  items: Station[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number; active: number; noAkb: number; dgu: number };
}

interface Filters {
  q: string;
  tehc: string;
  napr: string;
  netw: string;
  active: string;
  akb: string;
}

export function akbText(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  return min % 60 === 0 ? min / 60 + ' ч' : humanDuration(min * 60);
}

/** Черновик новой аварии по станции из инвентаря. */
export function draftForStation(st: Station): Draft {
  return Object.assign(emptyDraft(), {
    SERV_ELEM: st.serv_elem,
    NAPR: st.napr || '',
    TEHC: st.napr === WHOLE_NETWORK ? '' : st.tehc || '',
    NETW_TYPE: st.netw_type || '',
    EQIP_TYPE: st.eqip_type || '',
    NUMB_RBS: String(st.bs_count || 1),
  });
}

const SORTS: Array<{ key: string; label: string }> = [
  { key: 'code', label: 'По коду' },
  { key: 'alarms', label: 'Больше аварий за 90 дней' },
  { key: 'last', label: 'Недавние аварии' },
  { key: 'akb', label: 'Меньше автономность АКБ' },
];

export function StationsPage(props: { onCopy: (d: Draft) => void }) {
  const app = useApp();
  const dict = app.meta.dict;
  const [f, setF] = useState<Filters>({ q: '', tehc: '', napr: '', netw: '', active: '1', akb: '' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('code');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Station | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);

  function update(patch: Partial<Filters>) {
    setF(Object.assign({}, f, patch));
    setPage(1);
  }

  useEffect(
    function () {
      const t = window.setTimeout(function () {
        if (q !== f.q) update({ q: q });
      }, 300);
      return function () { window.clearTimeout(t); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [q],
  );

  useEffect(
    function () {
      let alive = true;
      api
        .get<ListResp>('/api/stations' + qs({ q: f.q, tehc: f.tehc, napr: f.napr, netw: f.netw, active: f.active, akb: f.akb, sort: sort, page: page, pageSize: 50 }))
        .then(function (r) { if (alive) { setData(r); setError(''); } })
        .catch(function (e: ApiError) { if (alive) setError(e.message); });
      return function () { alive = false; };
    },
    [f.q, f.tehc, f.napr, f.netw, f.active, f.akb, sort, page, reload, app.version],
  );

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const s = data ? data.summary : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Инвентарь БС</h1>
          <p>Справочник базовых станций. Из него форма аварии подставляет адрес, ТЦ, направление, тип сети и оборудование</p>
        </div>
        <div className="hstack">
          <a className="btn" href="/api/stations/export.csv" download>
            <IconDownload />
            Выгрузить CSV
          </a>
          {app.isAdmin ? (
            <button type="button" className="btn" onClick={function () { setImporting(true); }}>Загрузить из CSV</button>
          ) : null}
          {app.isAdmin ? (
            <button type="button" className="btn btn-primary" onClick={function () { setOpen('new'); }}>
              <IconPlus />
              Добавить БС
            </button>
          ) : null}
        </div>
      </div>

      <section className="panel">
        <div className="filters">
          <div className="grid">
            <Field label="Поиск" htmlFor="inv-q" className="c-3 md-6">
              <input id="inv-q" className="input" value={q} placeholder="Код, адрес или оборудование" autoComplete="off"
                onChange={function (e) { setQ(e.target.value); }} />
            </Field>
            <Field label="Направление" htmlFor="inv-napr" className="c-2 md-6 sm-6">
              <Select id="inv-napr" value={f.napr} options={allValues(dict.items, 'napr')} placeholder="Все" allowEmpty
                onChange={function (v) { update({ napr: v }); }} />
            </Field>
            <Field label="ТЦ" htmlFor="inv-tehc" className="c-2 md-4 sm-6">
              <Select id="inv-tehc" value={f.tehc} options={allValues(dict.items, 'tehc')} placeholder="Все" allowEmpty
                onChange={function (v) { update({ tehc: v }); }} />
            </Field>
            <Field label="Тип сети" htmlFor="inv-netw" className="c-1 md-4 sm-6">
              <Select id="inv-netw" value={f.netw} options={allValues(dict.items, 'netw')} placeholder="Все" allowEmpty
                onChange={function (v) { update({ netw: v }); }} />
            </Field>
            <Field label="Состояние" htmlFor="inv-active" className="c-2 md-4 sm-6">
              <select id="inv-active" className="select" value={f.active} onChange={function (e) { update({ active: e.target.value }); }}>
                <option value="1">Действующие</option>
                <option value="0">Выведенные</option>
                <option value="">Все</option>
              </select>
            </Field>
            <Field label="Сортировка" htmlFor="inv-sort" className="c-2 md-6 sm-6">
              <select id="inv-sort" className="select" value={sort} onChange={function (e) { setSort(e.target.value); setPage(1); }}>
                {SORTS.map(function (o) { return <option key={o.key} value={o.key}>{o.label}</option>; })}
              </select>
            </Field>
          </div>
        </div>
        {s ? (
          <div className="summary">
            <div className="s"><b>{num(s.total)}</b><span>станций в инвентаре</span></div>
            <div className="s"><b>{num(s.active)}</b><span>действующих</span></div>
            <div className="s"><b>{num(s.dgu)}</b><span>со стационарной ДГУ</span></div>
            <div className="s">
              <b>{num(s.noAkb)}</b>
              <span>
                без данных об АКБ{' '}
                {s.noAkb ? (
                  <button type="button" className="btn-link" onClick={function () { update({ akb: f.akb ? '' : 'none' }); }}>
                    {f.akb ? 'показать все' : 'показать'}
                  </button>
                ) : null}
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        {error ? <div className="panel-body"><div className="alert alert-err">{error}</div></div> : null}
        {data && !data.items.length ? (
          <div className="empty">
            <b>Станций не найдено</b>
            Измените условия поиска{app.isAdmin ? ' или добавьте БС' : ''}.
          </div>
        ) : null}
        {data && data.items.length ? (
          <div className="table-wrap free">
            <table className="data">
              <thead>
                <tr>
                  <th>Код</th>
                  <th>Адрес</th>
                  <th>ТЦ</th>
                  <th>Напр.</th>
                  <th>Сеть</th>
                  <th>Оборудование</th>
                  <th className="num">БС</th>
                  <th className="num">АКБ</th>
                  <th>ДГУ</th>
                  <th className="num">Аварий за 90 дн.</th>
                  <th>Последняя авария</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(function (st) {
                  return (
                    <tr key={st.id} className={'clickable' + (st.is_active ? '' : ' dim')} tabIndex={0}
                      onClick={function () { setOpen(st); }}
                      onKeyDown={function (e) { if (e.key === 'Enter') setOpen(st); }}>
                      <td className="nowrap"><b>{st.code}</b>{st.is_active ? null : <span className="tag tag-off">выведена</span>}</td>
                      <td className="clip-l" title={st.address}>{st.address}</td>
                      <td>{st.tehc}</td>
                      <td>{st.napr}</td>
                      <td className="nowrap">{st.netw_type}</td>
                      <td className="clip" title={st.eqip_type || ''}>{st.eqip_type}</td>
                      <td className="num">{st.bs_count}</td>
                      <td className="num">{st.akb_minutes === null ? <span className="faint">нет данных</span> : akbText(st.akb_minutes)}</td>
                      <td>{st.has_dgu ? 'есть' : <span className="faint">нет</span>}</td>
                      <td className="num">
                        {st.alarms90 ? <b>{st.alarms90}</b> : <span className="faint">0</span>}
                        {st.open_now ? <span className="tag tag-open" style={{ marginLeft: 6 }}>НВ</span> : null}
                      </td>
                      <td className="t">{st.last_alarm ? humanDate(st.last_alarm) : <span className="faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.total > data.pageSize ? (
          <div className="pager">
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={function () { setPage(page - 1); }}>Назад</button>
            <span>Страница {page} из {pages}, всего {num(data.total)}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={function () { setPage(page + 1); }}>Вперёд</button>
          </div>
        ) : null}
      </section>

      {open ? (
        <StationDialog station={open === 'new' ? null : open}
          onClose={function () { setOpen(null); }}
          onSaved={function () { setOpen(null); setReload(reload + 1); }}
          onNewAlarm={function (st) { setOpen(null); props.onCopy(draftForStation(st)); }} />
      ) : null}
      {importing ? (
        <ImportDialog onClose={function () { setImporting(false); }} onDone={function () { setImporting(false); setReload(reload + 1); }} />
      ) : null}
    </div>
  );
}

interface StationForm {
  code: string;
  address: string;
  napr: string;
  tehc: string;
  netw_type: string;
  eqip_type: string;
  bs_count: string;
  akb_minutes: string;
  has_dgu: boolean;
  note: string;
  is_active: boolean;
}

interface StationAlarm {
  ID: number;
  BEGIN_TIME: string;
  END_TIME: string;
  ALARM_TYPE: string;
  KATEG: number;
  DESCR: string | null;
  LENGHT: string | null;
  IS_OPEN: boolean;
}

function StationDialog(props: {
  station: Station | null;
  onClose: () => void;
  onSaved: () => void;
  onNewAlarm: (st: Station) => void;
}) {
  const app = useApp();
  const dict = app.meta.dict;
  const st = props.station;
  const ro = !app.isAdmin;
  const [f, setF] = useState<StationForm>({
    code: st ? st.code : '',
    address: st ? st.address : '',
    napr: st ? st.napr || '' : '',
    tehc: st ? st.tehc || '' : '',
    netw_type: st ? st.netw_type || '' : '',
    eqip_type: st ? st.eqip_type || '' : '',
    bs_count: st ? String(st.bs_count) : '1',
    akb_minutes: st && st.akb_minutes !== null ? String(st.akb_minutes) : '',
    has_dgu: st ? st.has_dgu : false,
    note: st ? st.note || '' : '',
    is_active: st ? st.is_active : true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [alarms, setAlarms] = useState<StationAlarm[] | null>(null);
  const [alarmId, setAlarmId] = useState<number | null>(null);

  useEffect(
    function () {
      if (!st) return;
      api
        .get<{ item: Station; alarms: StationAlarm[] }>('/api/stations/' + st.id)
        .then(function (r) { setAlarms(r.alarms); })
        .catch(function () { setAlarms([]); });
    },
    [st],
  );

  function set(patch: Partial<StationForm>) {
    setF(Object.assign({}, f, patch));
  }

  function save() {
    setBusy(true);
    const req = st ? api.put('/api/stations/' + st.id, f) : api.post('/api/stations', f);
    req
      .then(function () {
        app.toast(st ? 'БС ' + f.code + ' сохранена' : 'БС ' + f.code.toUpperCase() + ' добавлена в инвентарь');
        props.onSaved();
      })
      .catch(function (e: ApiError) {
        setErrors(e.fields);
        app.toast(e.message, 'err');
        setBusy(false);
      });
  }

  function remove() {
    if (!st || !window.confirm('Удалить ' + st.code + ' из инвентаря? Внесённые аварии не изменятся. Если станцию просто демонтировали — лучше снять отметку «Действующая».')) return;
    setBusy(true);
    api.del('/api/stations/' + st.id)
      .then(function () { app.toast('БС ' + st.code + ' удалена из инвентаря'); props.onSaved(); })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); setBusy(false); });
  }

  const whole = f.napr === WHOLE_NETWORK;
  const akbMin = /^\d+$/.test(f.akb_minutes) ? +f.akb_minutes : null;

  return (
    <Modal
      title={st ? 'БС ' + st.code : 'Новая БС'}
      onClose={props.onClose}
      size="mid"
      footer={
        <>
          {st && app.isAdmin ? <button type="button" className="btn btn-danger left" onClick={remove} disabled={busy}>Удалить</button> : null}
          {st && app.canEdit && st.is_active ? (
            <button type="button" className="btn" onClick={function () { props.onNewAlarm(st); }}>
              <IconPlus />
              Внести аварию по этой БС
            </button>
          ) : null}
          <button type="button" className="btn" onClick={props.onClose}>{ro ? 'Закрыть' : 'Отмена'}</button>
          {!ro ? <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{st ? 'Сохранить' : 'Добавить БС'}</button> : null}
        </>
      }
    >
      <div className="modal-body">
        <fieldset disabled={ro} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <div className="grid">
            <Field label="Код БС" htmlFor="st-code" required className="c-3 md-6" error={errors.code} help="Например, ЕКБ-0412">
              <input id="st-code" className="input" value={f.code} autoComplete="off" onChange={function (e) { set({ code: e.target.value }); }} />
            </Field>
            <Field label="Адрес" htmlFor="st-addr" required className="c-9 md-12" error={errors.address}>
              <input id="st-addr" className="input" value={f.address} autoComplete="off" onChange={function (e) { set({ address: e.target.value }); }}
                placeholder="ул. Ленина, 12, крыша" />
            </Field>
            <Field label="Направление" htmlFor="st-napr" required className="c-3 md-6" error={errors.napr}>
              <Select id="st-napr" value={f.napr} options={dict.directions} placeholder="—"
                onChange={function (v) { set(v === WHOLE_NETWORK ? { napr: v, tehc: '' } : { napr: v }); }} />
            </Field>
            <Field label="ТЦ" htmlFor="st-tehc" required={!whole} className="c-3 md-6" error={errors.tehc}>
              <Select id="st-tehc" value={f.tehc} options={dict.techCenters} placeholder={whole ? 'не нужен' : '—'} disabled={whole}
                onChange={function (v) { set({ tehc: v }); }} />
            </Field>
            <Field label="Тип сети" htmlFor="st-netw" className="c-3 md-6" error={errors.netw_type}>
              <Select id="st-netw" value={f.netw_type} options={dict.networkTypes} placeholder="—" allowEmpty
                onChange={function (v) { set({ netw_type: v }); }} />
            </Field>
            <Field label="Количество БС" htmlFor="st-bs" className="c-3 md-6" error={errors.bs_count} help="На площадке">
              <input id="st-bs" className="input tnum" value={f.bs_count} inputMode="numeric" onChange={function (e) { set({ bs_count: e.target.value }); }} />
            </Field>
            <Field label="Тип оборудования" htmlFor="st-eq" className="c-6 md-12" error={errors.eqip_type}>
              <input id="st-eq" className="input" value={f.eqip_type} autoComplete="off" onChange={function (e) { set({ eqip_type: e.target.value }); }}
                placeholder="Huawei DBS3900" />
            </Field>
            <Field label="АКБ, минут" htmlFor="st-akb" className="c-3 md-6" error={errors.akb_minutes}
              help={akbMin !== null ? '≈ ' + akbText(akbMin) + ' работы от батарей' : 'Для прогноза разряда'}>
              <input id="st-akb" className="input tnum" value={f.akb_minutes} inputMode="numeric" placeholder="240"
                onChange={function (e) { set({ akb_minutes: e.target.value.replace(/\D/g, '') }); }} />
            </Field>
            <div className="c-3 md-6 checks">
              <label className="check">
                <input type="checkbox" checked={f.has_dgu} onChange={function (e) { set({ has_dgu: e.target.checked }); }} />
                Стационарная ДГУ
              </label>
              <label className="check">
                <input type="checkbox" checked={f.is_active} onChange={function (e) { set({ is_active: e.target.checked }); }} />
                Действующая
              </label>
            </div>
            <Field label="Примечание" htmlFor="st-note" className="c-12" error={errors.note}>
              <input id="st-note" className="input" value={f.note} autoComplete="off" onChange={function (e) { set({ note: e.target.value }); }}
                placeholder="Доступ, ключи, особенности площадки" />
            </Field>
          </div>
        </fieldset>
      </div>
      {st ? (
        <div className="history" style={{ paddingBottom: 6 }}>
          <div className="sub-head">
            Аварии на этой БС{alarms ? ': ' + alarms.length + (alarms.length === 30 ? ' последних' : '') : ''}
          </div>
          {alarms === null ? <p className="muted pad">Загрузка…</p> : null}
          {alarms && !alarms.length ? <p className="muted pad">Аварий по этой БС не вносили.</p> : null}
          {alarms && alarms.length ? (
            <div className="table-wrap free">
              <table className="data compact">
                <tbody>
                  {alarms.map(function (a) {
                    return (
                      <tr key={a.ID} className={'clickable' + (a.IS_OPEN ? ' open' : '')} tabIndex={0}
                        onClick={function () { setAlarmId(a.ID); }}
                        onKeyDown={function (e) { if (e.key === 'Enter') setAlarmId(a.ID); }}>
                        <td className="num">№{a.ID}</td>
                        <td className="t">{humanDateTime(a.BEGIN_TIME)}</td>
                        <td><span className={'tag tag-k' + a.KATEG}>кат. {a.KATEG}</span> <span title={app.note('type', a.ALARM_TYPE)}>{a.ALARM_TYPE}</span></td>
                        <td className="t">{a.IS_OPEN ? <span className="tag tag-open">НВ</span> : a.LENGHT}</td>
                        <td className="clip" title={a.DESCR || ''}>{a.DESCR}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      {alarmId !== null ? <AlarmEditor alarmId={alarmId} onClose={function () { setAlarmId(null); }} /> : null}
    </Modal>
  );
}

const TEMPLATE = 'Код БС;Адрес;Направление;ТЦ;Тип сети;Тип оборудования;Количество БС;Автономность АКБ, мин;ДГУ;Примечание;Активна\r\n' +
  'ЕКБ-0412;ул. Ленина, 12, крыша;ЮЗН;ЕКБ;LTE/GSM;Huawei DBS3900;2;240;нет;;да\r\n';

/** Загрузка инвентаря из CSV: сначала проверка без записи, потом загрузка. */
function ImportDialog(props: { onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<{ rows: number; valid: number; errors: Array<{ line: number; message: string }> } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function readFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = function () {
      const buf = reader.result as ArrayBuffer;
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        // Excel в русской Windows сохраняет CSV в кодировке Windows-1251.
        decoded = new TextDecoder('windows-1251').decode(buf);
      }
      setText(decoded);
      runCheck(decoded);
    };
    reader.readAsArrayBuffer(file);
  }

  function runCheck(csv: string) {
    setBusy(true);
    setError('');
    api.post<{ rows: number; valid: number; errors: Array<{ line: number; message: string }> }>('/api/stations/import', { csv: csv, dryRun: true })
      .then(function (r) { setCheck(r); })
      .catch(function (e: ApiError) { setCheck(null); setError(e.message); })
      .then(function () { setBusy(false); });
  }

  function load() {
    setBusy(true);
    api.post<{ created: number; updated: number; errors: unknown[] }>('/api/stations/import', { csv: text })
      .then(function (r) {
        app.toast('Инвентарь загружен: добавлено ' + r.created + ', обновлено ' + r.updated + (r.errors.length ? ', пропущено строк с ошибками: ' + r.errors.length : ''));
        props.onDone();
      })
      .catch(function (e: ApiError) { setError(e.message); setBusy(false); });
  }

  function template() {
    const blob = new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'шаблон_инвентаря_БС.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <Modal title="Загрузка инвентаря из CSV" onClose={props.onClose} size="mid"
      footer={
        <>
          <button type="button" className="btn btn-ghost left" onClick={template}>
            <IconDownload />
            Шаблон CSV
          </button>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" disabled={busy || !check || !check.valid} onClick={load}>
            {check && check.valid ? 'Загрузить ' + check.valid + ' ' + plural(check.valid, ['станцию', 'станции', 'станций']) : 'Загрузить'}
          </button>
        </>
      }>
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          Подойдёт выгрузка из Site Info или таблица Excel, сохранённая как CSV. Нужны столбцы «Код БС» и «Адрес»; остальные — по шаблону.
          Станции с уже известным кодом обновятся, новые — добавятся.
        </p>
        <Field label="Файл CSV" htmlFor="imp-file">
          <input id="imp-file" type="file" accept=".csv,text/csv,text/plain"
            onChange={function (e) { if (e.target.files && e.target.files[0]) readFile(e.target.files[0]); }} />
        </Field>
        {fileName && busy && !check ? <p className="muted">Проверяем {fileName}…</p> : null}
        {error ? <div className="alert alert-err" style={{ marginTop: 12 }}>{error}</div> : null}
        {check ? (
          <div className={'alert ' + (check.errors.length ? 'alert-warn' : 'alert-info')} style={{ marginTop: 12 }}>
            Строк в файле: {check.rows}. Готовы к загрузке: <b>{check.valid}</b>.
            {check.errors.length ? ' С ошибками: ' + check.errors.length + ' — они будут пропущены.' : ' Ошибок нет.'}
            {check.errors.length ? (
              <ul className="import-errors">
                {check.errors.slice(0, 8).map(function (e) {
                  return <li key={e.line}>Строка {e.line}: {e.message}</li>;
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
