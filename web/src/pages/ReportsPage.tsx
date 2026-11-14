import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import { syncServerTime } from '../clock';
import type { Alarm, Totals } from '../types';
import { AlarmEditor } from '../components/AlarmEditor';
import type { Draft } from '../components/AlarmForm';
import { Field, Select } from '../components/Field';
import { PeriodFilter, defaultPeriod, type Period } from '../components/PeriodFilter';
import { IconDownload, IconPrint } from '../components/Icons';
import { SummaryImportDialog } from '../components/SummaryImport';
import { allValues, hours, noteMap, num, plural } from '../format';
import { crmLink, formatBs } from '../../../shared/dict';
import { formatDuration, humanDate, humanDateTime } from '../../../shared/time';

export interface Filters extends Period {
  napr: string;
  tehc: string;
  kateg: string;
  netw: string;
  type: string;
  status: string;
  q: string;
}

const FILTER_KEY = 'webreport.reportFilters';
const JUMP_KEY = 'webreport.reportJump';

/** Переход из «Статистики»: открыть отчёт сразу с нужным периодом и отбором. */
export function openReportWith(patch: Partial<Filters>) {
  try {
    window.sessionStorage.setItem(JUMP_KEY, JSON.stringify(patch));
  } catch (e) {
    /* без перехода с отбором */
  }
  window.location.hash = '#/reports';
}

function initialFilters(): Filters {
  const base: Filters = Object.assign(defaultPeriod(7), { napr: '', tehc: '', kateg: '', netw: '', type: '', status: '', q: '' });
  try {
    const jump = window.sessionStorage.getItem(JUMP_KEY);
    if (jump) {
      window.sessionStorage.removeItem(JUMP_KEY);
      return Object.assign(base, JSON.parse(jump));
    }
  } catch (e) {
    /* обычный порядок */
  }
  try {
    const raw = window.localStorage.getItem(FILTER_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Период каждый раз начинается с последних 7 дней; фильтры по полям запоминаются.
      ['napr', 'tehc', 'kateg', 'netw', 'type', 'status', 'mode'].forEach(function (k) {
        if (typeof saved[k] === 'string') (base as any)[k] = saved[k];
      });
    }
  } catch (e) {
    /* без сохранённых фильтров */
  }
  return base;
}

interface ListResponse {
  items: Alarm[];
  total: number;
  page: number;
  pageSize: number;
  totals: Totals;
  serverNow: string;
}

const COLUMNS: Array<{ key: string; label: string; sort?: string; cls?: string }> = [
  { key: 'ID', label: '№', sort: 'id', cls: 'num' },
  { key: 'PW', label: 'PW/NTT', sort: 'pw' },
  { key: 'NAPR', label: 'Направление', sort: 'napr' },
  { key: 'TEHC', label: 'ТЦ', sort: 'tehc' },
  { key: 'KATEG', label: 'Кат.', sort: 'kateg' },
  { key: 'NETW_TYPE', label: 'Тип сети', sort: 'netw' },
  { key: 'SERV_ELEM', label: 'Сетевой элемент, услуга' },
  { key: 'NUMB_RBS', label: 'Кол-во БС', sort: 'bs', cls: 'num' },
  { key: 'EQIP_TYPE', label: 'Тип оборудования' },
  { key: 'ALARM_TYPE', label: 'Тип', sort: 'type' },
  { key: 'DESCR', label: 'Описание' },
  { key: 'BEGIN_TIME', label: 'Начало', sort: 'begin' },
  { key: 'END_TIME', label: 'Окончание', sort: 'end' },
  { key: 'AKB', label: 'АКБ' },
  { key: 'DGU', label: 'ГУ' },
  { key: 'LENGHT', label: 'Длительность', sort: 'length' },
  { key: 'PROSTOY', label: 'Перерыв связи' },
  { key: 'COMMON_PROSTOY', label: 'Общий простой БС', sort: 'common' },
  { key: 'ALARM_WHO', label: 'Уведомление (кому)' },
  { key: 'DESC_NOTICE', label: 'Подробное описание' },
];

export function ReportsPage(props: { onCopy: (d: Draft) => void }) {
  const app = useApp();
  const dict = app.meta.dict;
  const [f, setF] = useState<Filters>(initialFilters);
  const [q, setQ] = useState(f.q);
  const [sort, setSort] = useState({ key: 'begin', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [sep, setSep] = useState('semicolon');
  const [importing, setImporting] = useState(false);

  function update(patch: Partial<Filters>) {
    const next = Object.assign({}, f, patch);
    setF(next);
    setPage(1);
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    } catch (e) {
      /* не критично */
    }
  }

  // Поиск — с задержкой, чтобы не дёргать сервер на каждую букву.
  useEffect(
    function () {
      const t = window.setTimeout(function () {
        if (q !== f.q) update({ q: q });
      }, 350);
      return function () {
        window.clearTimeout(t);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [q],
  );

  const filterQuery = {
    from: f.from, to: f.to, mode: f.mode, napr: f.napr, tehc: f.tehc, kateg: f.kateg,
    netw: f.netw, type: f.type, status: f.status, q: f.q,
  };

  useEffect(
    function () {
      let alive = true;
      setLoading(true);
      api
        .get<ListResponse>('/api/alarms' + qs(Object.assign({}, filterQuery, { sort: sort.key, dir: sort.dir, page: page, pageSize: pageSize })))
        .then(function (r) {
          if (!alive) return;
          syncServerTime(r.serverNow);
          setData(r);
          setError('');
        })
        .catch(function (e: ApiError) {
          if (alive) setError(e.message);
        })
        .then(function () {
          if (alive) setLoading(false);
        });
      return function () {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [JSON.stringify(filterQuery), sort.key, sort.dir, page, pageSize, app.version],
  );

  function sortBy(key: string) {
    setSort(function (s) {
      return { key: key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' };
    });
    setPage(1);
  }

  const csvHref = '/api/alarms/export.csv' + qs(Object.assign({}, filterQuery, { sep: sep }));
  const xlsxHref = '/api/summary/export.xlsx' + qs(filterQuery);
  const totals = data ? data.totals : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeFilters = ['napr', 'tehc', 'kateg', 'netw', 'type', 'status', 'q'].filter(function (k) {
    return !!(f as any)[k];
  }).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Отчётность</h1>
          <p>Аварии за выбранный период{app.canEdit ? ': нажмите на строку, чтобы изменить запись' : ''}</p>
        </div>
        <div className="hstack no-print">
          <label className="visually-hidden" htmlFor="csv-sep">Разделитель CSV</label>
          <select id="csv-sep" className="select" style={{ width: 170, height: 34 }} value={sep}
            onChange={function (e) { setSep(e.target.value); }}>
            <option value="semicolon">Разделитель «;»</option>
            <option value="comma">Разделитель «,»</option>
            <option value="tab">Табуляция</option>
            <option value="pipe">Разделитель «|»</option>
          </select>
          <a className={'btn btn-primary' + (data && data.total ? '' : ' disabled')} href={csvHref} download>
            <IconDownload />
            Выгрузить CSV
          </a>
          <a className={'btn' + (data && data.total ? '' : ' disabled')} href={xlsxHref} download
            title="Excel в формате сводки ЦОУ: лист «Аварии на сети СС», те же столбцы и шапка">
            <IconDownload />
            Excel как сводка
          </a>
          {app.isAdmin ? (
            <button type="button" className="btn" onClick={function () { setImporting(true); }}
              title="Перенести аварии из файла сводки ЦОУ (.xlsx)">
              Загрузить сводку
            </button>
          ) : null}
          <button type="button" className="btn" onClick={function () {
            if (data && data.total > data.items.length) app.toast('Печатается текущая страница. Для полного отчёта увеличьте число строк на странице.');
            window.print();
          }}>
            <IconPrint />
            Печать
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="filters">
          <div className="grid">
            <PeriodFilter value={f} onChange={function (p) { update(p); }} idPrefix="rep-" />
            <Field label="Поиск" htmlFor="rep-q" className="c-5 md-12">
              <input id="rep-q" className="input" type="search" value={q} placeholder="PW/NTT, адрес БС, оборудование, описание"
                onChange={function (e) { setQ(e.target.value); }} />
            </Field>
            <Field label="Направление" htmlFor="rep-napr" className="c-2 md-4 sm-6">
              <Select id="rep-napr" value={f.napr} options={allValues(dict.items, 'napr')} onChange={function (v) { update({ napr: v }); }} placeholder="Все" allowEmpty />
            </Field>
            <Field label="ТЦ" htmlFor="rep-tehc" className="c-2 md-4 sm-6">
              <Select id="rep-tehc" value={f.tehc} options={allValues(dict.items, 'tehc')} onChange={function (v) { update({ tehc: v }); }} placeholder="Все" allowEmpty />
            </Field>
            <Field label="Категория" htmlFor="rep-kateg" className="c-1 md-4 sm-6">
              <Select id="rep-kateg" value={f.kateg} options={dict.categories} onChange={function (v) { update({ kateg: v }); }} placeholder="Все" allowEmpty />
            </Field>
            <Field label="Тип сети" htmlFor="rep-netw" className="c-2 md-4 sm-6">
              <Select id="rep-netw" value={f.netw} options={allValues(dict.items, 'netw')} onChange={function (v) { update({ netw: v }); }} placeholder="Все" allowEmpty />
            </Field>
            <Field label="Тип" htmlFor="rep-type" className="c-2 md-4 sm-6">
              <Select id="rep-type" value={f.type} options={allValues(dict.items, 'type')} labels={noteMap(dict.items, 'type')} onChange={function (v) { update({ type: v }); }} placeholder="Все" allowEmpty />
            </Field>
            <Field label="Состояние" htmlFor="rep-status" className="c-2 md-4 sm-6">
              <select id="rep-status" className="select" value={f.status} onChange={function (e) { update({ status: e.target.value }); }}>
                <option value="">Все</option>
                <option value="open">Открытые (НВ)</option>
                <option value="closed">Закрытые</option>
              </select>
            </Field>
            <div className="c-1 md-4" style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" disabled={!activeFilters}
                onClick={function () {
                  setQ('');
                  update({ napr: '', tehc: '', kateg: '', netw: '', type: '', status: '', q: '' });
                }}>
                Сбросить
              </button>
            </div>
          </div>
        </div>

        {totals ? (
          <div className="summary" aria-live="polite">
            <div className="s">
              <b>
                {num(totals.count)}
                {totals.open ? <span className="of">{totals.open} НВ</span> : null}
              </b>
              <span>{plural(totals.count, ['авария', 'аварии', 'аварий'])} в выборке</span>
            </div>
            <div className="s"><b>{formatDuration(totals.lengthSec)}</b><span>суммарная длительность</span></div>
            <div className="s"><b>{formatDuration(totals.commonSec)}</b><span>общий простой БС ({hours(totals.commonSec)})</span></div>
            <div className="s"><b>{num(totals.bs)}{totals.sectors ? <span className="of" style={{ color: 'var(--muted)' }}>+{totals.sectors} С</span> : null}</b><span>затронуто БС</span></div>
            <div className="s"><b>{formatDuration(totals.akbSec)}</b><span>работа от АКБ</span></div>
            <div className="s"><b>{formatDuration(totals.dguSec)}</b><span>работа от ГУ</span></div>
          </div>
        ) : null}

        <h2 className="print-title">
          Отчёт об авариях за {humanDate(f.from)} — {humanDate(f.to)}
        </h2>

        {error ? <div className="panel-body"><div className="alert alert-err">{error}</div></div> : null}

        {data && !data.items.length ? (
          <div className="empty">
            <b>За выбранный период аварий нет</b>
            Измените период или сбросьте фильтры.
          </div>
        ) : null}

        {data && data.items.length ? (
          <div className="table-wrap" aria-busy={loading}>
            <table className="data">
              <thead>
                <tr>
                  {COLUMNS.map(function (c) {
                    const on = c.sort && sort.key === c.sort;
                    return (
                      <th key={c.key} className={(c.cls || '') + (c.sort ? ' sortable' : '')}
                        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        onClick={c.sort ? function () { sortBy(c.sort!); } : undefined}>
                        {c.label}
                        {on ? <span className="arrow">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.items.map(function (a) {
                  const link = crmLink(a.PW, app.meta.crmUrlTemplate);
                  return (
                    <tr key={a.ID} className={'clickable' + (a.IS_OPEN ? ' open' : '')} tabIndex={0}
                      onClick={function () { setEditId(a.ID); }}
                      onKeyDown={function (e) { if (e.key === 'Enter') setEditId(a.ID); }}>
                      <td className="num">{a.ID}</td>
                      <td className="nowrap">
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" onClick={function (e) { e.stopPropagation(); }}>{a.PW}</a>
                        ) : a.PW}
                      </td>
                      <td className="nowrap">{a.NAPR}</td>
                      <td>{a.TEHC}</td>
                      <td><span className={'tag tag-k' + a.KATEG}>{a.KATEG}</span></td>
                      <td className="nowrap">{a.NETW_TYPE}</td>
                      <td className="clip-l" title={a.SERV_ELEM || ''}>{a.SERV_ELEM}</td>
                      <td className="num">{formatBs(a.NUMB_RBS)}</td>
                      <td className="clip" title={a.EQIP_TYPE || ''}>{a.EQIP_TYPE}</td>
                      <td title={app.note('type', a.ALARM_TYPE)}>{a.ALARM_TYPE}</td>
                      <td className="clip" title={a.DESCR || ''}>{a.DESCR}</td>
                      <td className="t">{humanDateTime(a.BEGIN_TIME)}</td>
                      <td className="t">{a.IS_OPEN ? <span className="tag tag-open">НВ</span> : humanDateTime(a.END_TIME)}</td>
                      <td className="t">{a.AKB}</td>
                      <td className="t">{a.DGU}</td>
                      <td className={'t' + (a.IS_OPEN ? ' live' : '')}>{a.LENGHT}</td>
                      <td className="t">{a.PROSTOY}</td>
                      <td className="t">{a.COMMON_PROSTOY}</td>
                      <td className="clip" title={a.ALARM_WHO || ''}>{a.ALARM_WHO}</td>
                      <td className="clip-l" title={a.DESC_NOTICE || ''}>{a.DESC_NOTICE}</td>
                    </tr>
                  );
                })}
              </tbody>
              {totals ? (
                <tfoot>
                  <tr>
                    <td colSpan={7}>Итого по выборке: {num(totals.count)} {plural(totals.count, ['авария', 'аварии', 'аварий'])}</td>
                    <td className="num">{num(totals.bs)}</td>
                    <td colSpan={5} />
                    <td className="t">{formatDuration(totals.akbSec)}</td>
                    <td className="t">{formatDuration(totals.dguSec)}</td>
                    <td className="t">{formatDuration(totals.lengthSec)}</td>
                    <td />
                    <td className="t">{formatDuration(totals.commonSec)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}

        {data && data.total > 0 ? (
          <div className="pager">
            <span className="muted">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.total, data.page * data.pageSize)} из {num(data.total)}
            </span>
            <span className="spacer" />
            <label className="muted" htmlFor="rep-ps">Строк на странице</label>
            <select id="rep-ps" className="select" style={{ width: 80, height: 28 }} value={pageSize}
              onChange={function (e) { setPageSize(+e.target.value); setPage(1); }}>
              {[25, 50, 100, 200, 500].map(function (n) { return <option key={n} value={n}>{n}</option>; })}
            </select>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={function () { setPage(page - 1); }}>Назад</button>
            <span className="tnum">{page} / {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={function () { setPage(page + 1); }}>Вперёд</button>
          </div>
        ) : null}
      </section>

      {editId !== null ? (
        <AlarmEditor
          alarmId={editId}
          onClose={function () { setEditId(null); }}
          onCopy={function (d) {
            setEditId(null);
            props.onCopy(d);
          }}
        />
      ) : null}
      {importing ? (
        <SummaryImportDialog onClose={function () { setImporting(false); }} onDone={function () { setImporting(false); }} />
      ) : null}
    </div>
  );
}
