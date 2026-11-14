import { todayWall } from '../clock';
import { DateTimeInput } from './DateTimeInput';
import { Field } from './Field';
import { addDays } from '../../../shared/time';

export interface Period {
  from: string;
  to: string;
  mode: 'begin' | 'active';
}

function monthStart(date: string): string {
  return date.slice(0, 8) + '01';
}

export function presets(): Array<{ key: string; label: string; from: string; to: string }> {
  const today = todayWall();
  const thisMonth = monthStart(today);
  const prevMonthEnd = addDays(thisMonth, -1);
  return [
    { key: 'today', label: 'Сегодня', from: today, to: today },
    { key: 'yesterday', label: 'Вчера', from: addDays(today, -1), to: addDays(today, -1) },
    { key: 'week', label: '7 дней', from: addDays(today, -6), to: today },
    { key: 'month30', label: '30 дней', from: addDays(today, -29), to: today },
    { key: 'thisMonth', label: 'Этот месяц', from: thisMonth, to: today },
    { key: 'prevMonth', label: 'Прошлый месяц', from: monthStart(prevMonthEnd), to: prevMonthEnd },
  ];
}

export function defaultPeriod(days: number): Period {
  const today = todayWall();
  return { from: addDays(today, -(days - 1)), to: today, mode: 'begin' };
}

/** Период отчёта: даты из календаря, быстрые кнопки и режим учёта аварий. */
export function PeriodFilter(props: { value: Period; onChange: (p: Period) => void; idPrefix: string; hideMode?: boolean }) {
  const v = props.value;
  const list = presets();
  return (
    <>
      <div className="presets c-12" role="group" aria-label="Быстрый выбор периода">
        {list.map(function (p) {
          const on = p.from === v.from && p.to === v.to;
          return (
            <button key={p.key} type="button" className={'chip' + (on ? ' on' : '')} aria-pressed={on}
              onClick={function () { props.onChange({ from: p.from, to: p.to, mode: v.mode }); }}>
              {p.label}
            </button>
          );
        })}
      </div>
      <Field label="С даты" htmlFor={props.idPrefix + 'from'} className="c-2 md-4 sm-6">
        <DateTimeInput id={props.idPrefix + 'from'} dateOnly value={v.from}
          onChange={function (d) { props.onChange({ from: d, to: v.to, mode: v.mode }); }} />
      </Field>
      <Field label="По дату" htmlFor={props.idPrefix + 'to'} className="c-2 md-4 sm-6">
        <DateTimeInput id={props.idPrefix + 'to'} dateOnly value={v.to}
          onChange={function (d) { props.onChange({ from: v.from, to: d, mode: v.mode }); }} />
      </Field>
      {props.hideMode ? null : <Field label="Какие аварии учитывать" htmlFor={props.idPrefix + 'mode'} className="c-3 md-4">
        <select id={props.idPrefix + 'mode'} className="select" value={v.mode}
          onChange={function (e) { props.onChange({ from: v.from, to: v.to, mode: e.target.value === 'active' ? 'active' : 'begin' }); }}>
          <option value="begin">Начавшиеся в периоде</option>
          <option value="active">Действовавшие в периоде</option>
        </select>
      </Field>}
    </>
  );
}
