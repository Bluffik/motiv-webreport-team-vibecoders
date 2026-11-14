import { useState } from 'react';
import { useApp } from '../context';
import { nowWall, useTick } from '../clock';
import type { Alarm } from '../types';
import { plural } from '../format';
import { POWER_TYPE, formatBs, isSector } from '../../../shared/dict';
import { computeLengthSeconds, formatDateTime, formatDuration, humanDateTime, humanDuration, parseDateTime } from '../../../shared/time';

/**
 * Прогноз по АКБ для аварии по электропитанию (ответ куратора, вопрос 6):
 * БС работает от батарей, пока не кончится автономность из инвентаря, потом начинается простой.
 */
function AkbForecast(props: { a: Alarm; lengthSec: number | null }) {
  const a = props.a;
  if (a.ALARM_TYPE !== POWER_TYPE || props.lengthSec === null) return null;
  const st = a.STATION;
  if (!st) return <span className="akb muted">Нет БС в инвентаре — прогноз по АКБ недоступен</span>;
  if (st.akb_minutes === null) return <span className="akb muted">Автономность АКБ не указана в инвентаре</span>;
  const left = st.akb_minutes * 60 - props.lengthSec;
  const dgu = st.has_dgu ? ', на объекте есть ДГУ' : '';
  if (left > 0) {
    const until = formatDateTime((parseDateTime(a.BEGIN_TIME) as number) + st.akb_minutes * 60000).slice(11, 16);
    return (
      <span className={'akb' + (left < 30 * 60 ? ' soon' : '')}>
        АКБ по паспорту: осталось ≈ {humanDuration(left)}, до {until}{dgu}
      </span>
    );
  }
  return (
    <span className="akb dead">
      АКБ по паспорту разряжена {humanDuration(-left)} назад — проверьте, работает ли БС{dgu}
    </span>
  );
}

const LONG_SEC = 86400;

/**
 * Табло открытых аварий (окончание = НВ): длительность идёт в реальном времени.
 * Свежие аварии (меньше суток) — сверху, новые первыми. Длительные (больше суток) —
 * как переходящие позиции сводки: свёрнуты одной строкой, раскрываются по кнопке.
 */
export function OpenBoard(props: {
  items: Alarm[] | null;
  onOpen: (id: number) => void;
  onCloseAlarm: (a: Alarm) => void;
}) {
  const app = useApp();
  const items = props.items;
  const [tc, setTc] = useState('');
  const [showLong, setShowLong] = useState(false);
  useTick(1000, !!items && items.length > 0);

  if (items === null) {
    return (
      <section className="board calm" aria-busy="true">
        <div className="board-calm muted">Загрузка открытых аварий…</div>
      </section>
    );
  }
  if (!items.length) {
    return (
      <section className="board calm">
        <div className="board-calm">
          <span className="lamp" aria-hidden="true" />
          Открытых аварий нет — все внесённые аварии закрыты.
        </div>
      </section>
    );
  }

  const now = nowWall();
  const where = function (a: Alarm) { return a.TEHC || a.NAPR || '—'; };
  const places = Array.from(new Set(items.map(where))).sort();
  const shown = tc ? items.filter(function (a) { return where(a) === tc; }) : items;
  const withSec = shown.map(function (a) { return { a: a, sec: computeLengthSeconds(a.BEGIN_TIME, null, now) }; });
  // Новые — первыми; при равном времени начала выше категория 1.
  withSec.sort(function (x, y) {
    if (x.a.BEGIN_TIME !== y.a.BEGIN_TIME) return String(y.a.BEGIN_TIME) < String(x.a.BEGIN_TIME) ? -1 : 1;
    return (x.a.KATEG || 3) - (y.a.KATEG || 3);
  });
  const fresh = withSec.filter(function (x) { return x.sec === null || x.sec < LONG_SEC; });
  const long = withSec.filter(function (x) { return x.sec !== null && x.sec >= LONG_SEC; });
  const cat1 = shown.filter(function (a) { return a.KATEG === 1; }).length;

  function row(x: { a: Alarm; sec: number | null }) {
    const a = x.a;
    const sec = x.sec;
    return (
          <div className="board-row" key={a.ID}>
            <span className="lamp" aria-hidden="true" />
            <div className="board-timer" title="Длительность аварии">
              {sec === null ? '—' : formatDuration(Math.max(0, sec))}
              <small>с {humanDateTime(a.BEGIN_TIME)}</small>
            </div>
            <div className="board-where">
              <b>{a.TEHC || a.NAPR}</b>
              <span>
                {a.TEHC ? a.NAPR + ', ' : ''}
                <span className={'tag tag-k' + a.KATEG}>кат. {a.KATEG}</span>{' '}
                <span className="tag">{a.ALARM_TYPE}</span>{' '}
                {a.NETW_TYPE ? <span className="tag">{a.NETW_TYPE}</span> : null}
              </span>
            </div>
            <div className="board-what">
              <span className="elem" title={a.SERV_ELEM || ''}>{a.SERV_ELEM}</span>
              <span className="descr" title={a.DESCR || ''}>
                {a.DESCR || 'Без описания'}
              </span>
              <AkbForecast a={a} lengthSec={sec} />
            </div>
            <div className="board-bs">
              <b>{formatBs(a.NUMB_RBS)}</b> {isSector(a.NUMB_RBS) ? 'сектор' : 'БС'}
              {a.PW ? <div className="small">{a.PW}</div> : null}
            </div>
            <div className="board-actions">
              <button type="button" className="btn btn-sm" onClick={function () { props.onOpen(a.ID); }}>
                {app.canEdit ? 'Изменить' : 'Открыть'}
              </button>
              {app.canEdit ? (
                <button type="button" className="btn btn-sm btn-alarm" onClick={function () { props.onCloseAlarm(a); }}>
                  Закрыть
                </button>
              ) : null}
            </div>
          </div>
        );
  }

  return (
    <section className="board" aria-label="Открытые аварии">
      <div className="board-head">
        <h2>Открытые аварии</h2>
        <span className="total">{shown.length}</span>
        <span className="sub">
          {fresh.length} {plural(fresh.length, ['началась', 'начались', 'начались'])} за сутки, {long.length} {plural(long.length, ['длится', 'длятся', 'длятся'])} дольше
          {cat1 ? ', категория 1: ' + cat1 : ''}
        </span>
        {places.length > 1 ? (
          <select className="select select-sm board-filter" value={tc} aria-label="ТЦ"
            onChange={function (e) { setTc(e.target.value); }}>
            <option value="">Все ТЦ и направления</option>
            {places.map(function (p) {
              const n = items.filter(function (a) { return where(a) === p; }).length;
              return <option key={p} value={p}>{p} — {n}</option>;
            })}
          </select>
        ) : null}
      </div>
      {fresh.length ? fresh.map(row) : (
        <div className="board-note">За последние сутки новых открытых аварий нет{tc ? ' в ' + tc : ''}.</div>
      )}
      {long.length ? (
        <>
          <button type="button" className="board-more" aria-expanded={showLong} onClick={function () { setShowLong(!showLong); }}>
            <span className="caret" aria-hidden="true">{showLong ? '▾' : '▸'}</span>
            Длятся больше суток: <b>{long.length}</b>
            <span className="muted"> — переходящие аварии (ждут запчастей, выезда, сетевой компании)</span>
            <span className="board-more-act">{showLong ? 'Свернуть' : 'Показать'}</span>
          </button>
          {showLong ? long.map(row) : null}
        </>
      ) : null}
    </section>
  );
}
