import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import type { Alarm } from '../types';
import { AlarmEditor } from '../components/AlarmEditor';
import type { Draft } from '../components/AlarmForm';
import { PeriodFilter, defaultPeriod, type Period } from '../components/PeriodFilter';
import { hours, noteMap, num, plural } from '../format';
import { openReportWith, type Filters } from './ReportsPage';
import { formatBs } from '../../../shared/dict';
import { formatDuration, humanDate, humanDateTime, humanDuration } from '../../../shared/time';

interface Bucket {
  key: string;
  count: number;
  open: number;
  lengthSec: number;
  commonSec: number;
  bs: number;
  avgSec: number;
}

interface TotalsT {
  count: number;
  open: number;
  closed: number;
  lengthSec: number;
  commonSec: number;
  bs: number;
  sectors: number;
  akbSec: number;
  dguSec: number;
  avgClosedSec: number;
  maxLengthSec: number;
  cat1: number;
}

interface RepeatRow {
  key: string;
  code: string | null;
  servElem: string;
  count: number;
  lengthSec: number;
  commonSec: number;
  last: string;
  types: Record<string, number>;
}

interface StatsResponse {
  totals: TotalsT;
  prev: (TotalsT & { from: string; to: string }) | null;
  byNapr: Bucket[];
  byTehc: Bucket[];
  byType: Bucket[];
  byKateg: Bucket[];
  byNetw: Bucket[];
  byDay: Array<{ date: string; count: number; commonSec: number; lengthSec: number }>;
  matrix: { rows: string[]; cols: string[]; cells: Array<Array<{ count: number; commonSec: number }>> };
  repeat: RepeatRow[];
  top: Alarm[];
}

type Metric = 'count' | 'commonSec' | 'lengthSec' | 'avgSec';

const METRICS: Array<{ key: Metric; label: string }> = [
  { key: 'count', label: 'Количество' },
  { key: 'commonSec', label: 'Простой БС' },
  { key: 'lengthSec', label: 'Длительность' },
  { key: 'avgSec', label: 'Средняя длительность' },
];

function metricText(m: Metric, v: number): string {
  if (m === 'count') return num(v);
  if (m === 'avgSec') return humanDuration(v);
  return hours(v);
}

/** Изменение к предыдущему периоду такой же длины. Цветом не оцениваем — только направление и величина. */
function Delta(props: { cur: number; prev: number | undefined }) {
  if (props.prev === undefined) return null;
  const p = props.prev;
  if (p === 0 && props.cur === 0) return <em className="delta">как в прошлом периоде</em>;
  if (p === 0) return <em className="delta">в прошлом периоде — 0</em>;
  const pct = Math.round(((props.cur - p) / p) * 100);
  if (pct === 0) return <em className="delta">как в прошлом периоде</em>;
  return (
    <em className="delta">
      {pct > 0 ? '▲ +' : '▼ '}{pct}% к прошлому периоду
    </em>
  );
}

export function StatsPage(props: { onCopy: (d: Draft) => void }) {
  const app = useApp();
  const [period, setPeriod] = useState<Period>(defaultPeriod(30));
  const [metric, setMetric] = useState<Metric>('count');
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<number | null>(null);

  useEffect(
    function () {
      let alive = true;
      api
        .get<StatsResponse>('/api/stats' + qs({ from: period.from, to: period.to, mode: period.mode }))
        .then(function (r) {
          if (alive) {
            setData(r);
            setError('');
          }
        })
        .catch(function (e: ApiError) {
          if (alive) setError(e.message);
        });
      return function () {
        alive = false;
      };
    },
    [period.from, period.to, period.mode, app.version],
  );

  const t = data ? data.totals : null;
  const pv = data && data.prev ? data.prev : null;
  const typeNotes = noteMap(app.meta.dict.items, 'type');

  function drill(patch: Partial<Filters>) {
    openReportWith(Object.assign({ from: period.from, to: period.to, mode: period.mode }, patch));
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Статистика</h1>
          <p>
            Работа сети за период: {humanDate(period.from)} — {humanDate(period.to)}
            {pv ? <span className="muted">. Сравнение с {humanDate(pv.from)} — {humanDate(pv.to)}</span> : null}
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="filters">
          <div className="grid">
            <PeriodFilter value={period} onChange={setPeriod} idPrefix="st-" />
          </div>
        </div>
        {t ? (
          <div className="stat-strip" style={{ borderTop: '1px solid var(--rule-soft)' }}>
            <div className="s">
              <b>{num(t.count)}</b>
              <span>{plural(t.count, ['авария', 'аварии', 'аварий'])}, из них открыто: {t.open}</span>
              <Delta cur={t.count} prev={pv ? pv.count : undefined} />
            </div>
            <div className="s">
              <b>{num(t.cat1)}</b>
              <span>категории 1</span>
              <Delta cur={t.cat1} prev={pv ? pv.cat1 : undefined} />
            </div>
            <div className="s">
              <b>{hours(t.commonSec)}</b>
              <span>общий простой БС ({formatDuration(t.commonSec)})</span>
              <Delta cur={t.commonSec} prev={pv ? pv.commonSec : undefined} />
            </div>
            <div className="s">
              <b>{humanDuration(t.avgClosedSec)}</b>
              <span>средняя длительность закрытой аварии</span>
              <Delta cur={t.avgClosedSec} prev={pv ? pv.avgClosedSec : undefined} />
            </div>
            <div className="s">
              <b>{humanDuration(t.maxLengthSec)}</b>
              <span>самая долгая авария</span>
            </div>
            <div className="s">
              <b>{num(t.bs)}</b>
              <span>затронуто БС{t.sectors ? ', плюс секторов: ' + t.sectors : ''}</span>
            </div>
            <div className="s">
              <b>{hours(t.akbSec + t.dguSec)}</b>
              <span>на резервном питании: АКБ {hours(t.akbSec)}, ГУ {hours(t.dguSec)}</span>
            </div>
          </div>
        ) : null}
      </section>

      {error ? <div className="alert alert-err" style={{ marginTop: 18 }}>{error}</div> : null}

      {data && t && t.count === 0 ? (
        <section className="panel">
          <div className="empty">
            <b>За период аварий нет</b>
            Выберите другой период.
          </div>
        </section>
      ) : null}

      {data && t && t.count > 0 ? (
        <>
          <div className="charts">
            <section className="panel chart-wide">
              <div className="panel-head">
                <h2>Аварии по дням начала</h2>
                <span className="hint">Наведите на столбец, чтобы увидеть число аварий и простой за день</span>
              </div>
              <DayChart days={data.byDay} />
            </section>

            <div className="chart-wide hstack" style={{ justifyContent: 'flex-end' }}>
              <span className="muted small">Показатель для разбивок:</span>
              <div className="metric-switch" role="group" aria-label="Показатель">
                {METRICS.map(function (m) {
                  return (
                    <button key={m.key} type="button" className={metric === m.key ? 'on' : ''} aria-pressed={metric === m.key}
                      onClick={function () { setMetric(m.key); }}>
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <BarPanel title="По типам аварий" buckets={data.byType} metric={metric} sorted notes={typeNotes}
              onPick={function (k) { drill({ type: k }); }} />
            <div>
              <BarPanel title="По направлениям" buckets={data.byNapr} metric={metric} onPick={function (k) { drill({ napr: k }); }} />
              <div style={{ height: 18 }} />
              <BarPanel title="По категориям" buckets={data.byKateg} metric={metric} labelPrefix="Кат. " onPick={function (k) { drill({ kateg: k }); }} />
            </div>
            <BarPanel title="По техническим центрам" buckets={data.byTehc} metric={metric} sorted
              onPick={function (k) { if (k !== 'Без ТЦ') drill({ tehc: k }); }} />
            <BarPanel title="По типу сети" buckets={data.byNetw} metric={metric} onPick={function (k) { drill({ netw: k }); }} />

            <section className="panel chart-wide">
              <div className="panel-head">
                <h2>Технические центры и типы аварий</h2>
                <span className="hint">Число аварий; чем темнее ячейка, тем их больше. Нажмите на ячейку — откроется отчёт</span>
              </div>
              <Heatmap matrix={data.matrix} notes={typeNotes} onPick={function (tehc, type) {
                drill({ tehc: tehc === 'Без ТЦ' ? '' : tehc, type: type });
              }} />
            </section>
          </div>

          {data.repeat.length ? (
            <section className="panel" style={{ marginTop: 18 }}>
              <div className="panel-head">
                <h2>Повторяющиеся аварии на одной БС</h2>
                <span className="hint">Кандидаты на профилактику. Нажмите на строку — все аварии этой БС за период</span>
              </div>
              <div className="table-wrap free">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Сетевой элемент</th>
                      <th className="num">Аварий</th>
                      <th>Типы</th>
                      <th>Суммарная длительность</th>
                      <th>Простой БС</th>
                      <th>Последняя</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repeat.map(function (r) {
                      const q = r.code || r.servElem;
                      return (
                        <tr key={r.key} className="clickable" tabIndex={0}
                          onClick={function () { drill({ q: q }); }}
                          onKeyDown={function (e) { if (e.key === 'Enter') drill({ q: q }); }}>
                          <td className="clip-l" title={r.servElem}>{r.servElem}</td>
                          <td className="num"><b>{r.count}</b></td>
                          <td>
                            {Object.keys(r.types).sort(function (a, b) { return r.types[b] - r.types[a]; }).map(function (k) {
                              return <span key={k} className="tag" title={typeNotes[k] || ''}>{k} × {r.types[k]}</span>;
                            })}
                          </td>
                          <td className="t">{formatDuration(r.lengthSec)}</td>
                          <td className="t">{formatDuration(r.commonSec)}</td>
                          <td className="t">{humanDateTime(r.last)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>Десять аварий с наибольшим простоем БС</h2>
              <span className="hint">Нажмите на строку, чтобы открыть запись</span>
            </div>
            <div className="table-wrap free">
              <table className="data">
                <thead>
                  <tr>
                    <th className="num">№</th>
                    <th>Начало</th>
                    <th>ТЦ</th>
                    <th>Тип</th>
                    <th>Сетевой элемент</th>
                    <th className="num">БС</th>
                    <th>Длительность</th>
                    <th>Простой БС</th>
                    <th>Описание</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top.map(function (a) {
                    return (
                      <tr key={a.ID} className={'clickable' + (a.IS_OPEN ? ' open' : '')} tabIndex={0}
                        onClick={function () { setEditId(a.ID); }}
                        onKeyDown={function (e) { if (e.key === 'Enter') setEditId(a.ID); }}>
                        <td className="num">{a.ID}</td>
                        <td className="t">{humanDateTime(a.BEGIN_TIME)}</td>
                        <td>{a.TEHC || a.NAPR}</td>
                        <td title={typeNotes[a.ALARM_TYPE || ''] || ''}>{a.ALARM_TYPE}</td>
                        <td className="clip-l" title={a.SERV_ELEM || ''}>{a.SERV_ELEM}</td>
                        <td className="num">{formatBs(a.NUMB_RBS)}</td>
                        <td className={'t' + (a.IS_OPEN ? ' live' : '')}>{a.LENGHT}</td>
                        <td className="t"><b>{a.COMMON_PROSTOY}</b></td>
                        <td className="clip" title={a.DESCR || ''}>{a.DESCR}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {editId !== null ? (
        <AlarmEditor alarmId={editId} onClose={function () { setEditId(null); }}
          onCopy={function (d) { setEditId(null); props.onCopy(d); }} />
      ) : null}
    </div>
  );
}

/** Горизонтальные столбцы: одна серия, значения подписаны текстом. Строка — переход в отчёт. */
function BarPanel(props: {
  title: string;
  buckets: Bucket[];
  metric: Metric;
  sorted?: boolean;
  labelPrefix?: string;
  notes?: Record<string, string>;
  onPick?: (key: string) => void;
}) {
  const m = props.metric;
  const list = props.buckets.slice();
  if (props.sorted) list.sort(function (a, b) { return (b as any)[m] - (a as any)[m]; });
  const max = list.reduce(function (acc, b) { return Math.max(acc, (b as any)[m]); }, 0);
  const notes = props.notes;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{props.title}</h2>
      </div>
      <div className={'bars' + (notes ? ' with-notes' : '')} role="table" aria-label={props.title}>
        {list.map(function (b) {
          const v = (b as any)[m] as number;
          const pct = max > 0 ? (v / max) * 100 : 0;
          const note = notes ? notes[b.key] : '';
          const tip =
            (props.labelPrefix || '') + b.key + (note ? ' (' + note + ')' : '') + ': ' + num(b.count) + ' ' +
            plural(b.count, ['авария', 'аварии', 'аварий']) + ', простой БС ' + formatDuration(b.commonSec) +
            ', средняя длительность ' + humanDuration(b.avgSec) + (b.open ? ', открыто ' + b.open : '');
          return (
            <div className={'bar-row' + (props.onPick && b.count ? ' pick' : '')} key={b.key} role="row" title={tip}
              tabIndex={props.onPick && b.count ? 0 : undefined}
              onClick={function () { if (props.onPick && b.count) props.onPick(b.key); }}
              onKeyDown={function (e) { if (e.key === 'Enter' && props.onPick && b.count) props.onPick(b.key); }}>
              <span className="k" role="cell">
                {(props.labelPrefix || '') + b.key}
                {note ? <small>{note}</small> : null}
              </span>
              <span className="track" role="cell" aria-hidden="true">
                <span className={'fill' + (v === 0 ? ' zero' : '')} style={{ width: pct + '%' }} />
              </span>
              <span className="v" role="cell">{metricText(m, v)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Последовательная шкала одного тона (фирменный оранжевый): светлее — меньше, темнее — больше.
const HEAT = ['#eef2f6', '#d3dde7', '#a8bacb', '#7891aa', '#4a6680'];

function heatIndex(v: number, max: number): number {
  if (v <= 0 || max <= 0) return -1;
  return Math.min(HEAT.length - 1, Math.floor((v / max) * HEAT.length - 1e-9));
}

/** Матрица «ТЦ × тип аварии»: число аварий в ячейке, итоги по строкам и столбцам. */
function Heatmap(props: {
  matrix: StatsResponse['matrix'];
  notes: Record<string, string>;
  onPick: (tehc: string, type: string) => void;
}) {
  const mx = props.matrix;
  let max = 0;
  const colTotals = mx.cols.map(function () { return 0; });
  mx.cells.forEach(function (row) {
    row.forEach(function (c, j) {
      if (c.count > max) max = c.count;
      colTotals[j] += c.count;
    });
  });
  return (
    <div className="table-wrap free">
      <table className="data heat">
        <thead>
          <tr>
            <th>ТЦ</th>
            {mx.cols.map(function (c) {
              return <th key={c} className="num" title={props.notes[c] || ''}>{c}</th>;
            })}
            <th className="num">Всего</th>
          </tr>
        </thead>
        <tbody>
          {mx.rows.map(function (r, i) {
            const total = mx.cells[i].reduce(function (s, c) { return s + c.count; }, 0);
            return (
              <tr key={r}>
                <th scope="row">{r}</th>
                {mx.cells[i].map(function (c, j) {
                  const k = heatIndex(c.count, max);
                  const label = r + ', ' + mx.cols[j] + (props.notes[mx.cols[j]] ? ' (' + props.notes[mx.cols[j]] + ')' : '') +
                    ': ' + c.count + ' ' + plural(c.count, ['авария', 'аварии', 'аварий']) + ', простой БС ' + formatDuration(c.commonSec);
                  return (
                    <td key={j} className={'num cell' + (k >= 3 ? ' dark' : '') + (c.count ? ' pick' : '')}
                      style={k >= 0 ? { background: HEAT[k] } : undefined} title={label}
                      tabIndex={c.count ? 0 : undefined}
                      onClick={function () { if (c.count) props.onPick(r, mx.cols[j]); }}
                      onKeyDown={function (e) { if (e.key === 'Enter' && c.count) props.onPick(r, mx.cols[j]); }}>
                      {c.count || <span className="faint">—</span>}
                    </td>
                  );
                })}
                <td className="num"><b>{total}</b></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th>Всего</th>
            {colTotals.map(function (v, j) { return <td key={j} className="num"><b>{v}</b></td>; })}
            <td className="num"><b>{colTotals.reduce(function (a, b) { return a + b; }, 0)}</b></td>
          </tr>
        </tfoot>
      </table>
      <div className="heat-legend" aria-hidden="true">
        <span>меньше</span>
        {HEAT.map(function (c) { return <i key={c} style={{ background: c }} />; })}
        <span>больше (до {max} в ячейке)</span>
      </div>
    </div>
  );
}

/** Столбцы по дням: количество аварий; подсказка — число аварий и простой за день. */
function DayChart(props: { days: Array<{ date: string; count: number; commonSec: number; lengthSec: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [W, setW] = useState(900);
  const box = useRef<HTMLDivElement>(null);
  useEffect(function () {
    const el = box.current;
    if (!el) return undefined;
    const measure = function () { setW(Math.max(280, el.clientWidth - 32)); };
    measure();
    const RO = (window as any).ResizeObserver;
    if (RO) {
      const ro = new RO(measure);
      ro.observe(el);
      return function () { ro.disconnect(); };
    }
    window.addEventListener('resize', measure);
    return function () { window.removeEventListener('resize', measure); };
  }, []);
  const days = props.days;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const padT = 8;
  const innerW = W - padL;
  const innerH = H - padB - padT;
  const max = Math.max(1, days.reduce(function (a, d) { return Math.max(a, d.count); }, 0));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const slot = innerW / days.length;
  const gap = Math.min(2, slot * 0.2);
  const bw = Math.max(1, slot - gap);
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(4, Math.floor(innerW / 56))));
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  const hd = hover !== null ? days[hover] : null;
  return (
    <div className="daychart" ref={box}>
      <svg viewBox={'0 0 ' + W + ' ' + H} width={W} height={H} role="img"
        aria-label={'Аварии по дням: максимум ' + max + ' в день'} onMouseLeave={function () { setHover(null); }}>
        {ticks.map(function (v) {
          const y = padT + innerH - (v / top) * innerH;
          return (
            <g key={v}>
              <line x1={padL} x2={W} y1={y} y2={y} stroke={v === 0 ? '#c4c6c9' : '#ebeced'} strokeWidth="1" />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="11" fill="#707478">{v}</text>
            </g>
          );
        })}
        {days.map(function (d, i) {
          const h = (d.count / top) * innerH;
          const x = padL + i * slot + gap / 2;
          const y = padT + innerH - h;
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.date} onMouseEnter={function () { setHover(i); }}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" />
              {h > 0 ? (
                <path d={roundedTop(x, y, bw, h, r)} fill={hover === i ? '#3f5266' : '#5f7389'} />
              ) : null}
              {i % labelEvery === 0 ? (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#707478">{d.date.slice(8, 10) + '.' + d.date.slice(5, 7)}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hd && hover !== null ? (
        <div className="tip" style={{ left: 16 + padL + hover * slot + slot / 2, top: 8 + padT + innerH - (hd.count / top) * innerH }}>
          <b>{humanDate(hd.date)}</b>: {hd.count} {plural(hd.count, ['авария', 'аварии', 'аварий'])}
          <br />
          простой БС {formatDuration(hd.commonSec)}
        </div>
      ) : null}
    </div>
  );
}

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, nice * pow);
}

/** Столбец со скруглёнными верхними углами (4px), основание — прямое, на нуле. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return (
    'M' + x + ',' + (y + h) + ' V' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
    ' H' + (x + w - r) + ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + ' V' + (y + h) + ' Z'
  );
}
