import { useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import { Field } from './Field';
import { Modal } from './Modal';
import { plural } from '../format';
import { humanDateTime } from '../../../shared/time';

interface ImportResult {
  sheet: string;
  rows: number;
  valid: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
  errorCount: number;
  newDict: Record<string, string[]>;
  newStations: number;
  stationsCreated: number;
  period: { from: string; to: string } | null;
  open: number;
}

const DICT_LABEL: Record<string, string> = { napr: 'направления', tehc: 'ТЦ', netw: 'типы сети', type: 'типы аварий' };

/**
 * Загрузка сводки ЦОУ (.xlsx, лист «Аварии на сети СС»). Сначала — проверка без записи:
 * сколько новых, сколько обновится, какие строки с ошибками. Повторная загрузка
 * обновлённой сводки не создаёт дублей.
 */
export function SummaryImportDialog(props: { onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [addStations, setAddStations] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function readFile(f: File) {
    setCheck(null);
    setError('');
    if (f.size > 25 * 1024 * 1024) {
      setError('Файл больше 25 МБ — сохраните в Excel только нужные листы');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const url = String(reader.result || '');
      const data = url.slice(url.indexOf(',') + 1);
      setFile({ name: f.name, data: data });
      run({ name: f.name, data: data }, true);
    };
    reader.readAsDataURL(f);
  }

  function run(fl: { name: string; data: string }, dryRun: boolean) {
    setBusy(true);
    setError('');
    api.post<ImportResult>('/api/summary/import', { file: fl.data, name: fl.name, dryRun: dryRun, addStations: addStations })
      .then(function (r) {
        if (dryRun) {
          setCheck(r);
          setBusy(false);
        } else {
          app.toast('Сводка загружена: новых аварий ' + r.created + ', обновлено ' + r.updated +
            (r.stationsCreated ? ', объектов в инвентарь ' + r.stationsCreated : ''));
          app.bump();
          props.onDone();
        }
      })
      .catch(function (e: ApiError) { setError(e.message); setBusy(false); });
  }

  const dictParts = check
    ? Object.keys(check.newDict).map(function (k) { return DICT_LABEL[k] + ': ' + check.newDict[k].join(', '); })
    : [];
  const total = check ? check.toCreate + check.toUpdate : 0;

  return (
    <Modal title="Загрузка сводки из Excel" onClose={props.onClose} size="mid"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" disabled={busy || !file || !check || !total}
            onClick={function () { if (file) run(file, false); }}>
            {check && total ? 'Загрузить ' + total + ' ' + plural(total, ['аварию', 'аварии', 'аварий']) : 'Загрузить'}
          </button>
        </>
      }>
      <div className="modal-body">
        <p className="lead-note">
          Файл сводки ЦОУ в формате .xlsx: лист «Аварии на сети СС» — 19 столбцов, как в ТЗ, ниже строки с номерами 1…19.
          Повторная загрузка обновлённой сводки не создаёт дублей: авария узнаётся по сетевому элементу и времени начала,
          изменённые поля (например, окончание вместо «НВ») обновятся.
        </p>
        <Field label="Файл сводки (.xlsx)" htmlFor="sum-file">
          <input id="sum-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={function (e) { if (e.target.files && e.target.files[0]) readFile(e.target.files[0]); }} />
        </Field>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={addStations} onChange={function (e) { setAddStations(e.target.checked); }} />
          Добавить в инвентарь объекты, которых там нет
        </label>
        {busy && !check ? <div className="check-steps busy" role="status">Читаю {file ? file.name : 'файл'}…</div> : null}
        {error ? <div className="alert alert-err" style={{ marginTop: 12 }}>{error}</div> : null}
        {check ? (
          <div className="import-summary">
            <dl className="ch-props">
              <dt>Лист</dt>
              <dd>«{check.sheet}», строк с авариями: {check.rows}</dd>
              {check.period ? (
                <>
                  <dt>Период</dt>
                  <dd>начало с {humanDateTime(check.period.from)} по {humanDateTime(check.period.to)}, открытых (НВ): {check.open}</dd>
                </>
              ) : null}
              <dt>Новых аварий</dt>
              <dd><b>{check.toCreate}</b></dd>
              <dt>Обновится</dt>
              <dd>{check.toUpdate}{check.unchanged ? ', без изменений: ' + check.unchanged : ''}</dd>
              <dt>В инвентарь</dt>
              <dd>{check.newStations ? (addStations ? 'добавится объектов: ' + check.newStations : 'новых объектов: ' + check.newStations + ' (не добавлять)') : 'все объекты уже есть'}</dd>
              {dictParts.length ? (
                <>
                  <dt>В справочники</dt>
                  <dd>добавятся {dictParts.join('; ')}</dd>
                </>
              ) : null}
            </dl>
            {check.errorCount ? (
              <div className="alert alert-warn" style={{ marginTop: 12 }}>
                Строк с ошибками: {check.errorCount} — они будут пропущены.
                <ul className="import-errors">
                  {check.errors.slice(0, 8).map(function (e) {
                    return <li key={e.line}>Строка {e.line}: {e.message}</li>;
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
