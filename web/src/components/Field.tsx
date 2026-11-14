import { type ReactNode } from 'react';
import { normalizeDuration, parseDuration } from '../../../shared/time';
import { TEXT_MAX } from '../../../shared/dict';

export function Field(props: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  help?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={'field ' + (props.className || '') + (props.error ? ' invalid' : '')}>
      <label className="field-label" htmlFor={props.htmlFor}>
        <span>
          {props.label}
          {props.required ? <span className="req" aria-hidden="true">*</span> : null}
        </span>
        {props.aside ? <span className="aside">{props.aside}</span> : null}
      </label>
      {props.children}
      {props.error ? (
        <div className="field-error" role="alert">{props.error}</div>
      ) : props.help ? (
        <div className="field-help">{props.help}</div>
      ) : null}
    </div>
  );
}

export function Select(props: {
  id?: string;
  value: string;
  options: Array<string | number>;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  /** Подписи к значениям: «ЭЛ» → «ЭЛ — Электропитание». */
  labels?: Record<string, string>;
}) {
  // Значение, скрытое администратором из справочника, остаётся видимым в старой записи.
  const options = props.options.slice();
  if (props.value && !options.some(function (o) { return String(o) === props.value; })) options.push(props.value);
  return (
    <select
      id={props.id}
      className="select"
      value={props.value}
      disabled={props.disabled}
      onChange={function (e) {
        props.onChange(e.target.value);
      }}
    >
      <option value="" disabled={!props.allowEmpty}>
        {props.placeholder || '— выберите —'}
      </option>
      {options.map(function (o) {
        const note = props.labels ? props.labels[String(o)] : '';
        return (
          <option key={String(o)} value={String(o)}>
            {note ? String(o) + ' — ' + note : String(o)}
          </option>
        );
      })}
    </select>
  );
}

/** Счётчик символов для полей VARCHAR(450): появляется ближе к пределу. */
export function Counter(props: { value: string; max?: number }) {
  const max = props.max || TEXT_MAX;
  const len = (props.value || '').length;
  if (len < max * 0.7) return null;
  return (
    <span className={'counter' + (len > max ? ' over' : '')}>
      {len}/{max}
    </span>
  );
}

/** Поле длительности «чч:мм:сс»: принимает и «чч.мм.сс», «1:30», «0130»; нормализует при уходе с поля. */
export function DurationInput(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const bad = !!props.value && parseDuration(props.value) === null;
  return (
    <input
      id={props.id}
      className={'input tnum' + (bad ? ' invalid' : '')}
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder || 'чч:мм:сс'}
      inputMode="numeric"
      autoComplete="off"
      maxLength={12}
      onChange={function (e) {
        props.onChange(e.target.value);
      }}
      onBlur={function () {
        if (props.value) props.onChange(normalizeDuration(props.value));
      }}
    />
  );
}
