import { useEffect, useRef } from 'react';
import flatpickr from 'flatpickr';
import type { Instance } from 'flatpickr/dist/types/instance';
import { Russian } from 'flatpickr/dist/l10n/ru.js';
import 'flatpickr/dist/flatpickr.min.css';
import { parseDateTime } from '../../../shared/time';
import { nowWall } from '../clock';

type FP = Instance;

function pad(n: number) {
  return n < 10 ? '0' + n : String(n);
}

// flatpickr работает с локальными Date браузера, а наши значения — «настенное» время центра
// без часового пояса. Поэтому переводим через компоненты даты, без смещений.
function toLocalDate(value: string): Date | null {
  const ms = parseDateTime(value);
  if (ms === null) return null;
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0);
}

function fromLocalDate(d: Date): string {
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00'
  );
}

/** Дата + время из выпадающего календаря (ТЗ, п. 11–12). Можно ввести и вручную: ДД.ММ.ГГГГ ЧЧ:ММ. */
export function DateTimeInput(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  dateOnly?: boolean;
  /** Не дать выбрать дату позже текущего времени центра (аварии уже произошли). */
  maxNow?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const fp = useRef<FP | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const dateOnly = !!props.dateOnly;
  const maxNowRef = useRef(!!props.maxNow);
  maxNowRef.current = !!props.maxNow;

  useEffect(function () {
    const inst = flatpickr(ref.current as HTMLInputElement, {
      locale: Russian,
      enableTime: !dateOnly,
      time_24hr: true,
      allowInput: true,
      altInput: true,
      altInputClass: 'input tnum',
      altFormat: dateOnly ? 'd.m.Y' : 'd.m.Y H:i',
      dateFormat: dateOnly ? 'Y-m-d' : 'Y-m-d H:i:S',
      minuteIncrement: 1,
      disableMobile: true,
      onOpen: function (_dates: Date[], _str: string, self: FP) {
        // Граница обновляется при каждом открытии: форма может быть открыта долго.
        if (maxNowRef.current) self.set('maxDate', toLocalDate(nowWall().slice(0, 16) + ':59'));
      },
      onChange: function (dates: Date[]) {
        if (!dates.length) onChangeRef.current('');
        else {
          const v = fromLocalDate(dates[0]);
          onChangeRef.current(dateOnly ? v.slice(0, 10) : v);
        }
      },
    }) as FP;
    fp.current = inst;
    if (inst.altInput) {
      inst.altInput.placeholder = props.placeholder || (dateOnly ? 'дд.мм.гггг' : 'дд.мм.гггг чч:мм');
      if (props.id) {
        if (ref.current) ref.current.removeAttribute('id');
        inst.altInput.id = props.id;
      }
    }
    return function () {
      inst.destroy();
      fp.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    function () {
      const inst = fp.current;
      if (!inst) return;
      const want = props.value ? toLocalDate(dateOnly ? props.value + ' 00:00:00' : props.value) : null;
      const cur = inst.selectedDates[0];
      if (!want) {
        if (cur) inst.clear(false);
      } else if (!cur || cur.getTime() !== want.getTime()) {
        inst.setDate(want, false);
      }
    },
    [props.value, dateOnly],
  );

  useEffect(
    function () {
      const inst = fp.current;
      if (inst && inst.altInput) {
        inst.altInput.disabled = !!props.disabled;
        if (props.invalid) inst.altInput.classList.add('invalid');
        else inst.altInput.classList.remove('invalid');
      }
    },
    [props.disabled, props.invalid],
  );

  return (
    <span className="fp-wrap">
      <input ref={ref} id={props.id} className="input tnum" defaultValue="" />
    </span>
  );
}
