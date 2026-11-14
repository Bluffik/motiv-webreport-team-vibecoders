import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { api, qs } from '../api';
import { nowWallMinute, useTick, nowWall } from '../clock';
import type { Alarm, Station } from '../types';
import { Counter, DurationInput, Field, Select } from './Field';
import { DateTimeInput } from './DateTimeInput';
import { noteMap } from '../format';
import {
  MAX_BS, POWER_TYPE, SECTOR_LABEL, WHOLE_NETWORK, formatBs, normalizeBs, stationCodeOf,
} from '../../../shared/dict';
import {
  computeCommonSeconds, computeLengthSeconds, estimateProstoySeconds, formatDuration, humanDuration, parseDateTime,
  parseDuration,
} from '../../../shared/time';

/** Состояние формы: все значения — строки, как в полях ввода. */
export interface Draft {
  PW: string;
  NAPR: string;
  TEHC: string;
  KATEG: string;
  NETW_TYPE: string;
  SERV_ELEM: string;
  NUMB_RBS: string;
  EQIP_TYPE: string;
  ALARM_TYPE: string;
  DESCR: string;
  BEGIN_TIME: string;
  END_TIME: string;
  END_OPEN: boolean;
  AKB: string;
  DGU: string;
  PROSTOY: string;
  ALARM_WHO: string;
  DESC_NOTICE: string;
}

export function emptyDraft(): Draft {
  return {
    PW: '', NAPR: '', TEHC: '', KATEG: '', NETW_TYPE: '', SERV_ELEM: '', NUMB_RBS: '', EQIP_TYPE: '',
    ALARM_TYPE: '', DESCR: '', BEGIN_TIME: '', END_TIME: '', END_OPEN: true, AKB: '', DGU: '', PROSTOY: '',
    ALARM_WHO: '', DESC_NOTICE: '',
  };
}

function s(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Черновик из существующей аварии. copy=true — для «Создать копию»: без номера заявки, времени и длительностей. */
export function draftFromAlarm(a: Alarm, copy?: boolean): Draft {
  const d: Draft = {
    PW: s(a.PW), NAPR: s(a.NAPR), TEHC: s(a.TEHC), KATEG: s(a.KATEG), NETW_TYPE: s(a.NETW_TYPE),
    SERV_ELEM: s(a.SERV_ELEM), NUMB_RBS: formatBs(a.NUMB_RBS), EQIP_TYPE: s(a.EQIP_TYPE),
    ALARM_TYPE: s(a.ALARM_TYPE), DESCR: s(a.DESCR), BEGIN_TIME: s(a.BEGIN_TIME), END_TIME: s(a.END_TIME),
    END_OPEN: a.IS_OPEN, AKB: s(a.AKB), DGU: s(a.DGU), PROSTOY: s(a.PROSTOY), ALARM_WHO: s(a.ALARM_WHO),
    DESC_NOTICE: s(a.DESC_NOTICE),
  };
  if (copy) {
    d.PW = '';
    d.BEGIN_TIME = '';
    d.END_TIME = '';
    d.END_OPEN = true;
    d.AKB = '';
    d.DGU = '';
    d.PROSTOY = '';
  }
  return d;
}

export function draftToPayload(d: Draft) {
  return {
    PW: d.PW, NAPR: d.NAPR, TEHC: d.NAPR === WHOLE_NETWORK ? '' : d.TEHC, KATEG: d.KATEG, NETW_TYPE: d.NETW_TYPE,
    SERV_ELEM: d.SERV_ELEM, NUMB_RBS: d.NUMB_RBS, EQIP_TYPE: d.EQIP_TYPE, ALARM_TYPE: d.ALARM_TYPE, DESCR: d.DESCR,
    BEGIN_TIME: d.BEGIN_TIME, END_TIME: d.END_OPEN ? 'НВ' : d.END_TIME, AKB: d.AKB, DGU: d.DGU,
    PROSTOY: d.PROSTOY, ALARM_WHO: d.ALARM_WHO, DESC_NOTICE: d.DESC_NOTICE,
  };
}

/** Допуск на расхождение часов при проверке «не в будущем» — как на сервере. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Проверка на клиенте — те же правила, что на сервере, чтобы ошибки были видны сразу. */
export function validateDraft(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.NAPR) e.NAPR = 'Выберите направление';
  if (!d.TEHC && d.NAPR !== WHOLE_NETWORK) e.TEHC = 'Выберите ТЦ';
  if (!d.KATEG) e.KATEG = 'Выберите категорию';
  if (!d.NETW_TYPE) e.NETW_TYPE = 'Выберите тип сети';
  if (!d.SERV_ELEM.trim()) e.SERV_ELEM = 'Укажите адрес БС или услугу';
  if (!d.NUMB_RBS.trim()) e.NUMB_RBS = 'Укажите количество или «' + SECTOR_LABEL + '»';
  else if (normalizeBs(d.NUMB_RBS) === null) e.NUMB_RBS = 'От 1 до ' + MAX_BS + ' или «' + SECTOR_LABEL + '»';
  if (!d.ALARM_TYPE) e.ALARM_TYPE = 'Выберите тип';
  const latest = (parseDateTime(nowWall()) as number) + FUTURE_TOLERANCE_MS;
  const begin = parseDateTime(d.BEGIN_TIME);
  if (!d.BEGIN_TIME) e.BEGIN_TIME = 'Укажите начало';
  else if (begin !== null && begin > latest) e.BEGIN_TIME = 'Начало не может быть в будущем';
  if (!d.END_OPEN) {
    const end = parseDateTime(d.END_TIME);
    if (!d.END_TIME) e.END_TIME = 'Укажите окончание или отметьте НВ';
    else if (d.BEGIN_TIME && d.END_TIME < d.BEGIN_TIME) e.END_TIME = 'Окончание раньше начала';
    else if (end !== null && end > latest) e.END_TIME = 'Окончание не может быть в будущем — отметьте НВ';
  }
  ['AKB', 'DGU', 'PROSTOY'].forEach(function (k) {
    const v = (d as any)[k] as string;
    if (v && parseDuration(v) === null) e[k] = 'Формат чч:мм:сс';
  });
  return e;
}

/** Подсказки по ранее введённым значениям (datalist). */
function useSuggest(field: string, query: string, enabled: boolean, extra?: { type?: string; tehc?: string }): string[] {
  const [items, setItems] = useState<string[]>([]);
  const type = extra && extra.type ? extra.type : '';
  const tehc = extra && extra.tehc ? extra.tehc : '';
  useEffect(
    function () {
      if (!enabled) return undefined;
      const t = window.setTimeout(function () {
        api
          .get<{ items: string[] }>('/api/alarms/suggest' + qs({ field: field, q: query.slice(0, 60), type: type, tehc: tehc }))
          .then(function (r) {
            setItems(r.items);
          })
          .catch(function () {
            /* подсказки не критичны */
          });
      }, 250);
      return function () {
        window.clearTimeout(t);
      };
    },
    [field, query, enabled, type, tehc],
  );
  return items;
}

/** Станция из инвентаря для введённого сетевого элемента: по паре «код — название» или по единственному коду. */
function useStationByElem(elem: string): Station | null {
  const [st, setSt] = useState<Station | null>(null);
  const code = stationCodeOf(elem);
  useEffect(
    function () {
      if (!code) {
        setSt(null);
        return undefined;
      }
      let alive = true;
      const t = window.setTimeout(function () {
        api
          .get<{ item: Station | null }>('/api/stations/resolve' + qs({ elem: elem.trim() }))
          .then(function (r) {
            if (alive) setSt(r.item);
          })
          .catch(function () {
            if (alive) setSt(null);
          });
      }, 200);
      return function () {
        alive = false;
        window.clearTimeout(t);
      };
    },
    [code, elem],
  );
  return st;
}

function akbText(min: number | null): string {
  if (min === null) return 'нет данных';
  return min % 60 === 0 ? min / 60 + ' ч' : humanDuration(min * 60);
}

/** Поле «Сетевой элемент» с поиском по инвентарю БС и ранее введённым значениям. */
function ServElemInput(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onPick: (st: Station) => void;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [stations, setStations] = useState<Station[]>([]);
  const query = props.value.trim();
  const history = useSuggest('SERV_ELEM', query, open && !props.readOnly && query.length >= 2);

  useEffect(
    function () {
      if (!open || query.length < 2) {
        setStations([]);
        return undefined;
      }
      let alive = true;
      const t = window.setTimeout(function () {
        api
          .get<{ items: Station[] }>('/api/stations/search' + qs({ q: query.slice(0, 60) }))
          .then(function (r) { if (alive) { setStations(r.items); setActive(0); } })
          .catch(function () { /* без подсказок */ });
      }, 200);
      return function () {
        alive = false;
        window.clearTimeout(t);
      };
    },
    [query, open],
  );

  const prev = history.filter(function (h) {
    return h !== props.value && !stations.some(function (st) { return st.serv_elem === h; });
  }).slice(0, 5);
  const total = stations.length + prev.length;
  const show = open && total > 0;

  function choose(i: number) {
    if (i < stations.length) props.onPick(stations[i]);
    else props.onChange(prev[i - stations.length]);
    setOpen(false);
  }

  return (
    <div className="suggest">
      <textarea id={props.id} className="textarea" rows={2} style={{ minHeight: 34 }} value={props.value}
        role="combobox" aria-expanded={show} aria-controls={props.id + '-list'} aria-autocomplete="list"
        onChange={function (e) { props.onChange(e.target.value); setOpen(true); }}
        onFocus={function () { setOpen(true); }}
        onBlur={function () { window.setTimeout(function () { setOpen(false); }, 150); }}
        onKeyDown={function (e) {
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % total); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + total) % total); }
          else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); choose(active); }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        }}
        placeholder="Код или адрес БС: начните вводить — подскажем из инвентаря" />
      {show ? (
        <ul className="suggest-list" id={props.id + '-list'} role="listbox">
          {stations.length ? <li className="suggest-group" role="presentation">Инвентарь БС</li> : null}
          {stations.map(function (st, i) {
            return (
              <li key={st.id} role="option" aria-selected={active === i} className={active === i ? 'on' : ''}
                onMouseDown={function (e) { e.preventDefault(); choose(i); }}
                onMouseEnter={function () { setActive(i); }}>
                <b>{st.code}</b>
                <span className="addr">{st.address}</span>
                <span className="meta">
                  {st.tehc || st.napr}{st.netw_type ? ', ' + st.netw_type : ''}, {st.bs_count} БС, АКБ {akbText(st.akb_minutes)}{st.has_dgu ? ', ДГУ' : ''}
                </span>
              </li>
            );
          })}
          {prev.length ? <li className="suggest-group" role="presentation">Ранее введённые</li> : null}
          {prev.map(function (h, j) {
            const i = stations.length + j;
            return (
              <li key={'h' + j} role="option" aria-selected={active === i} className={active === i ? 'on' : ''}
                onMouseDown={function (e) { e.preventDefault(); choose(i); }}
                onMouseEnter={function () { setActive(i); }}>
                <span className="addr">{h}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function AlarmForm(props: {
  draft: Draft;
  onChange: (d: Draft) => void;
  errors: Record<string, string>;
  readOnly?: boolean;
  idPrefix: string;
}) {
  const app = useApp();
  const meta = app.meta;
  const d = props.draft;
  const err = props.errors;
  const ro = !!props.readOnly;
  const p = props.idPrefix;
  const dict = meta.dict;
  const draftRef = useRef(d);
  draftRef.current = d;

  const live = d.END_OPEN && !!d.BEGIN_TIME;
  useTick(1000, live);

  function set(patch: Partial<Draft>) {
    props.onChange(Object.assign({}, draftRef.current, patch));
  }
  function bind(key: keyof Draft) {
    return function (v: string) {
      const patch: any = {};
      patch[key] = v;
      set(patch);
    };
  }

  const eqSuggest = useSuggest('EQIP_TYPE', d.EQIP_TYPE, !ro);
  const whoSuggest = useSuggest('ALARM_WHO', d.ALARM_WHO, !ro, { tehc: d.TEHC });
  const descrSuggest = useSuggest('DESCR', d.DESCR, !ro, { type: d.ALARM_TYPE });

  /** Быстрые вставки в «Уведомление (кому)» — как пишут в сводке: «20:30 Иванову И.И.», «(при получении сводки)». */
  function addWho(kind: 'time' | 'summary' | 'phone') {
    const v = d.ALARM_WHO.trim();
    const hm = nowWallMinute().slice(11, 16);
    if (kind === 'time') set({ ALARM_WHO: /^\d{1,2}:\d{2}\s/.test(v) ? v.replace(/^\d{1,2}:\d{2}/, hm) : (hm + ' ' + v).trim() });
    if (kind === 'summary' && v.indexOf('(при получении сводки)') < 0) set({ ALARM_WHO: (v + ' (при получении сводки)').trim() });
    if (kind === 'phone') set({ ALARM_WHO: (v + ' (по тел. ' + hm.replace(':', 'ч') + 'м)').trim() });
  }
  const station = useStationByElem(d.SERV_ELEM);

  function pickStation(st: Station) {
    const cur = draftRef.current;
    set({
      SERV_ELEM: st.serv_elem,
      NAPR: st.napr || cur.NAPR,
      TEHC: st.napr === WHOLE_NETWORK ? '' : st.tehc || cur.TEHC,
      NETW_TYPE: st.netw_type || cur.NETW_TYPE,
      EQIP_TYPE: cur.EQIP_TYPE || st.eqip_type || '',
      NUMB_RBS: cur.NUMB_RBS || String(st.bs_count),
    });
  }

  const lengthSec = computeLengthSeconds(d.BEGIN_TIME, d.END_OPEN ? null : d.END_TIME, nowWall());
  const bs = normalizeBs(d.NUMB_RBS);
  const prostoySec = parseDuration(d.PROSTOY);
  const commonSec = computeCommonSeconds(prostoySec, bs);
  const sector = bs === SECTOR_LABEL;
  const whole = d.NAPR === WHOLE_NETWORK;
  const akbSec = parseDuration(d.AKB);
  const dguSec = parseDuration(d.DGU);
  const estimate = (akbSec || dguSec) && lengthSec !== null && lengthSec > 0 ? estimateProstoySeconds(lengthSec, akbSec, dguSec) : null;
  const typeNotes = noteMap(dict.items, 'type');

  return (
    <fieldset className="alarm-form" disabled={ro} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <div className="section">
        <div className="section-title">Объект</div>
        <div className="grid">
          <Field label="Сетевой элемент, услуга" htmlFor={p + 'SERV'} required className="c-6 md-12" error={err.SERV_ELEM}
            aside={<Counter value={d.SERV_ELEM} />}
            help={station ? (
              <span className="from-inv">
                Из инвентаря: {station.tehc || station.napr}, {station.netw_type || 'тип сети не указан'}, {station.bs_count} БС,
                АКБ {akbText(station.akb_minutes)}{station.has_dgu ? ', есть ДГУ' : ', ДГУ нет'}
                {station.note ? '. ' + station.note : ''}
              </span>
            ) : 'Выберите БС из инвентаря — направление, ТЦ, тип сети и оборудование подставятся сами'}>
            <ServElemInput id={p + 'SERV'} value={d.SERV_ELEM} readOnly={ro}
              onChange={function (v) { set({ SERV_ELEM: v }); }} onPick={pickStation} />
          </Field>
          <Field label="Количество БС" htmlFor={p + 'BS'} required className="c-2 md-6" error={err.NUMB_RBS} help={'1–' + MAX_BS + ' или «С» — сектор'}>
            <div className="input-group">
              <input id={p + 'BS'} className="input tnum" value={d.NUMB_RBS} inputMode="numeric" autoComplete="off" maxLength={5}
                onChange={function (e) { set({ NUMB_RBS: e.target.value.replace(/[cсCС]/g, SECTOR_LABEL) }); }} placeholder="1" />
              <button type="button" className={'addon' + (sector ? ' on' : '')} title="Сектор БС" aria-pressed={sector}
                onClick={function () { set({ NUMB_RBS: sector ? '' : SECTOR_LABEL }); }}>
                С
              </button>
            </div>
          </Field>
          <Field label="Тип оборудования" htmlFor={p + 'EQ'} className="c-4 md-6" error={err.EQIP_TYPE} aside={<Counter value={d.EQIP_TYPE} />}>
            <input id={p + 'EQ'} className="input" list={p + 'EQ-list'} value={d.EQIP_TYPE} autoComplete="off"
              onChange={function (e) { set({ EQIP_TYPE: e.target.value }); }} placeholder="Например: Huawei DBS3900" />
            <datalist id={p + 'EQ-list'}>
              {eqSuggest.map(function (x) { return <option key={x} value={x} />; })}
            </datalist>
          </Field>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Классификация</div>
        <div className="grid">
          <Field label="Номер PW/NTT" htmlFor={p + 'PW'} className="c-2 md-6" error={err.PW} aside={<Counter value={d.PW} />}>
            <input id={p + 'PW'} className="input" value={d.PW} onChange={function (e) { set({ PW: e.target.value }); }} placeholder="Номер или ссылка из CRM" autoComplete="off" />
          </Field>
          <Field label="Направление" htmlFor={p + 'NAPR'} required className="c-2 md-6" error={err.NAPR}>
            <Select id={p + 'NAPR'} value={d.NAPR} options={dict.directions} placeholder="—"
              onChange={function (v) { set(v === WHOLE_NETWORK ? { NAPR: v, TEHC: '' } : { NAPR: v }); }} />
          </Field>
          <Field label="ТЦ" htmlFor={p + 'TEHC'} required={!whole} className="c-2 md-4 sm-6" error={err.TEHC}
            help={whole ? 'Для всей сети ТЦ не указывается' : undefined}>
            <Select id={p + 'TEHC'} value={whole ? '' : d.TEHC} options={dict.techCenters} onChange={bind('TEHC')}
              placeholder={whole ? 'не нужен' : '—'} disabled={whole} />
          </Field>
          <Field label="Категория" htmlFor={p + 'KATEG'} required className="c-1 md-4 sm-6" error={err.KATEG}>
            <Select id={p + 'KATEG'} value={d.KATEG} options={dict.categories} onChange={bind('KATEG')} placeholder="—" />
          </Field>
          <Field label="Тип сети" htmlFor={p + 'NETW'} required className="c-2 md-4 sm-6" error={err.NETW_TYPE}>
            <Select id={p + 'NETW'} value={d.NETW_TYPE} options={dict.networkTypes} onChange={bind('NETW_TYPE')} placeholder="—" />
          </Field>
          <Field label="Тип" htmlFor={p + 'TYPE'} required className="c-3 md-6 sm-6" error={err.ALARM_TYPE}>
            <Select id={p + 'TYPE'} value={d.ALARM_TYPE} options={dict.alarmTypes} labels={typeNotes} onChange={bind('ALARM_TYPE')} placeholder="—" />
          </Field>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          Время
          <small>чч:мм:сс</small>
        </div>
        <div className="grid">
          <Field label="Начало" htmlFor={p + 'BEGIN'} required className="c-3 md-6" error={err.BEGIN_TIME}>
            <div className="input-group">
              <DateTimeInput id={p + 'BEGIN'} value={d.BEGIN_TIME} onChange={bind('BEGIN_TIME')} invalid={!!err.BEGIN_TIME} disabled={ro} maxNow />
              <button type="button" className="addon" onClick={function () { set({ BEGIN_TIME: nowWallMinute() }); }}>
                Сейчас
              </button>
            </div>
          </Field>
          <Field label="Окончание" htmlFor={p + 'END'} className="c-3 md-6" error={err.END_TIME}
            help={d.END_OPEN ? 'НВ — авария продолжается' : undefined}>
            <div className="input-group">
              <DateTimeInput id={p + 'END'} value={d.END_OPEN ? '' : d.END_TIME} onChange={function (v) { set({ END_TIME: v, END_OPEN: false }); }}
                disabled={d.END_OPEN || ro} placeholder={d.END_OPEN ? 'НВ' : undefined} invalid={!!err.END_TIME} maxNow />
              <button type="button" className={'addon' + (d.END_OPEN ? ' on' : '')} title="Настоящее время — авария не закрыта" aria-pressed={d.END_OPEN}
                onClick={function () { set(d.END_OPEN ? { END_OPEN: false, END_TIME: nowWallMinute() } : { END_OPEN: true, END_TIME: '' }); }}>
                НВ
              </button>
              <button type="button" className="addon" onClick={function () { set({ END_OPEN: false, END_TIME: nowWallMinute() }); }}>
                Сейчас
              </button>
            </div>
          </Field>
          <Field label="Длительность аварии" className="c-2 md-4 sm-6" help={d.END_OPEN ? 'сейчас − начало' : 'окончание − начало'}>
            <div className={'computed' + (live ? ' live' : '')} aria-live="off">
              {lengthSec === null ? '—' : formatDuration(Math.max(0, lengthSec))}
            </div>
          </Field>
          <Field label="АКБ" htmlFor={p + 'AKB'} className="c-2 md-4 sm-6" error={err.AKB}
            help={station && station.akb_minutes !== null && d.ALARM_TYPE === POWER_TYPE ? 'Автономность по инвентарю: ' + akbText(station.akb_minutes) : 'Работа от батарей'}>
            <DurationInput id={p + 'AKB'} value={d.AKB} onChange={bind('AKB')} />
          </Field>
          <Field label="ГУ" htmlFor={p + 'DGU'} className="c-2 md-4 sm-6" error={err.DGU} help="Работа от генератора">
            <DurationInput id={p + 'DGU'} value={d.DGU} onChange={bind('DGU')} />
          </Field>
          <div className="c-12">
            <div className="formula-row">
              <Field label="Время перерыва связи" htmlFor={p + 'PROSTOY'} className="" error={err.PROSTOY} help="Среднее время простоя 1 БС">
                <div className="input-group">
                  <DurationInput id={p + 'PROSTOY'} value={d.PROSTOY} onChange={bind('PROSTOY')} />
                  {estimate !== null ? (
                    <button type="button" className="addon" title="Простой начинается, когда кончился резерв: длительность − АКБ − ГУ"
                      onClick={function () { set({ PROSTOY: formatDuration(estimate) }); }}>
                      − АКБ − ГУ
                    </button>
                  ) : null}
                  {lengthSec !== null && lengthSec > 0 ? (
                    <button type="button" className="addon" title="Подставить длительность аварии"
                      onClick={function () { set({ PROSTOY: formatDuration(lengthSec) }); }}>
                      = длит.
                    </button>
                  ) : null}
                </div>
              </Field>
              <span className="op" aria-hidden="true">×</span>
              <span className="bs-chip">{bs === null ? '? БС' : sector ? 'сектор (×1)' : bs + ' БС'}</span>
              <span className="op" aria-hidden="true">=</span>
              <Field label="Общее время простоя БС" className="wide" help="перерыв связи × количество БС">
                <div className="computed">{commonSec === null ? '—' : formatDuration(commonSec)}</div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Описание</div>
        <div className="grid">
          <Field label="Описание" htmlFor={p + 'DESCR'} className="c-6 md-12" error={err.DESCR} aside={<Counter value={d.DESCR} />}>
            <input id={p + 'DESCR'} className="input" list={p + 'DESCR-list'} value={d.DESCR} autoComplete="off"
              onChange={function (e) { set({ DESCR: e.target.value }); }}
              placeholder={d.ALARM_TYPE ? 'Кратко; частые описания для типа ' + d.ALARM_TYPE + ' — в подсказке' : 'Кратко: что произошло'} />
            <datalist id={p + 'DESCR-list'}>
              {descrSuggest.map(function (x) { return <option key={x} value={x} />; })}
            </datalist>
          </Field>
          <Field label="Уведомление об аварии (кому)" htmlFor={p + 'WHO'} className="c-6 md-12" error={err.ALARM_WHO} aside={<Counter value={d.ALARM_WHO} />}
            help={ro ? undefined : (
              <span className="quick">
                <button type="button" className="btn-link" onClick={function () { addWho('time'); }}>+ время сейчас</button>
                <button type="button" className="btn-link" onClick={function () { addWho('phone'); }}>+ по телефону</button>
                <button type="button" className="btn-link" onClick={function () { addWho('summary'); }}>+ при получении сводки</button>
                <span>Автоуведомления по правилам уходят сами</span>
              </span>
            )}>
            <input id={p + 'WHO'} className="input" list={p + 'WHO-list'} value={d.ALARM_WHO} autoComplete="off"
              onChange={function (e) { set({ ALARM_WHO: e.target.value }); }} placeholder="Кого и как уведомили" />
            <datalist id={p + 'WHO-list'}>
              {whoSuggest.map(function (x) { return <option key={x} value={x} />; })}
            </datalist>
          </Field>
          <Field label="Подробное описание" htmlFor={p + 'NOTICE'} className="c-12" error={err.DESC_NOTICE} aside={<Counter value={d.DESC_NOTICE} />}>
            <textarea id={p + 'NOTICE'} className="textarea" rows={3} value={d.DESC_NOTICE}
              onChange={function (e) { set({ DESC_NOTICE: e.target.value }); }} placeholder="Причина, ход работ, результат" />
          </Field>
        </div>
      </div>
    </fieldset>
  );
}
