import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import { num, plural } from '../format';
import type { DictItem, DictKey } from '../../../shared/dict';

interface Item extends DictItem {
  used: number;
}

interface Resp {
  dicts: Array<{ key: DictKey; field: string; label: string; plural: string }>;
  items: Item[];
}

const HINTS: Record<DictKey, string> = {
  napr: '«Вся сеть» — системное значение: при нём ТЦ не указывается',
  tehc: 'Новый ТЦ сразу появится в форме аварии, фильтрах и инвентаре',
  netw: 'Например, при запуске 5G добавьте «NR»',
  type: 'Расшифровка видна в форме, отчёте, статистике и уведомлениях',
};

export function DictsPage() {
  const app = useApp();
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(
    function () {
      api.get<Resp>('/api/dicts')
        .then(function (r) { setData(r); setError(''); })
        .catch(function (e: ApiError) { setError(e.message); });
    },
    [reload],
  );

  function changed() {
    setReload(reload + 1);
    app.reloadMeta();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Справочники</h1>
          <p>Значения выпадающих списков. Скрытое значение пропадает из формы, но остаётся в старых авариях, отчётах и фильтрах</p>
        </div>
      </div>
      {error ? <div className="alert alert-err">{error}</div> : null}
      {data ? (
        <div className="dicts">
          {data.dicts.map(function (d) {
            return (
              <DictPanel key={d.key} dict={d.key} title={d.plural} hint={HINTS[d.key]}
                items={data.items.filter(function (i) { return i.dict === d.key; })} onChanged={changed} />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DictPanel(props: { dict: DictKey; title: string; hint: string; items: Item[]; onChanged: () => void }) {
  const app = useApp();
  const [editId, setEditId] = useState<number | null>(null);
  const [ev, setEv] = useState({ value: '', note: '' });
  const [nv, setNv] = useState({ value: '', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const items = props.items;

  function fail(e: ApiError) {
    setErrors(e.fields);
    app.toast(e.message, 'err');
    setBusy(false);
  }

  function add() {
    setBusy(true);
    api.post('/api/dicts', { dict: props.dict, value: nv.value, note: nv.note })
      .then(function () {
        app.toast('«' + nv.value.trim() + '» добавлено в справочник «' + props.title + '»');
        setNv({ value: '', note: '' });
        setErrors({});
        setBusy(false);
        props.onChanged();
      })
      .catch(fail);
  }

  function save(it: Item, patch: { value?: string; note?: string; is_active?: boolean }) {
    const body = { value: it.value, note: it.note, is_active: it.is_active };
    Object.assign(body, patch);
    if (body.value.trim() !== it.value && it.used > 0) {
      const ok = window.confirm('Переименовать «' + it.value + '» в «' + body.value.trim() + '»? Значение обновится в ' + it.used + ' ' +
        plural(it.used, ['аварии', 'авариях', 'авариях']) + ' и в инвентаре БС.');
      if (!ok) return;
    }
    setBusy(true);
    api.put<{ renamed: number }>('/api/dicts/' + it.id, body)
      .then(function (r) {
        app.toast(r.renamed ? 'Переименовано, обновлено аварий: ' + r.renamed : 'Сохранено');
        setEditId(null);
        setErrors({});
        setBusy(false);
        props.onChanged();
      })
      .catch(fail);
  }

  function remove(it: Item) {
    if (!window.confirm('Удалить «' + it.value + '» из справочника?')) return;
    setBusy(true);
    api.del('/api/dicts/' + it.id)
      .then(function () { app.toast('«' + it.value + '» удалено'); setBusy(false); props.onChanged(); })
      .catch(fail);
  }

  function move(i: number, dir: number) {
    const ids = items.map(function (x) { return x.id; });
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const t = ids[i];
    ids[i] = ids[j];
    ids[j] = t;
    setBusy(true);
    api.post('/api/dicts/order', { dict: props.dict, ids: ids })
      .then(function () { setBusy(false); props.onChanged(); })
      .catch(fail);
  }

  return (
    <section className="panel dict-panel">
      <div className="panel-head">
        <h2>{props.title}</h2>
        <span className="hint">{items.length} {plural(items.length, ['значение', 'значения', 'значений'])}</span>
      </div>
      <p className="dict-hint">{props.hint}</p>
      <ul className="dict-list">
        {items.map(function (it, i) {
          const editing = editId === it.id;
          return (
            <li key={it.id} className={it.is_active ? '' : 'off'}>
              <span className="order">
                <button type="button" className="btn-icon" aria-label={'Выше: ' + it.value} disabled={busy || i === 0}
                  onClick={function () { move(i, -1); }}>↑</button>
                <button type="button" className="btn-icon" aria-label={'Ниже: ' + it.value} disabled={busy || i === items.length - 1}
                  onClick={function () { move(i, 1); }}>↓</button>
              </span>
              {editing ? (
                <span className="dict-edit">
                  <input className={'input' + (errors.value ? ' invalid' : '')} value={ev.value} aria-label="Значение" disabled={it.is_system}
                    onChange={function (e) { setEv({ value: e.target.value, note: ev.note }); }} />
                  <input className="input" value={ev.note} aria-label="Расшифровка" placeholder="Расшифровка"
                    onChange={function (e) { setEv({ value: ev.value, note: e.target.value }); }}
                    onKeyDown={function (e) { if (e.key === 'Enter') save(it, ev); }} />
                  {errors.value ? <span className="field-error">{errors.value}</span> : null}
                </span>
              ) : (
                <span className="dict-val">
                  <b>{it.value}</b>
                  {it.note ? <span className="muted"> — {it.note}</span> : null}
                  {it.is_system ? <span className="tag">системное</span> : null}
                  {it.is_active ? null : <span className="tag tag-off">скрыто</span>}
                </span>
              )}
              <span className="used">{it.used ? 'в ' + num(it.used) + ' ' + plural(it.used, ['аварии', 'авариях', 'авариях']) : 'не используется'}</span>
              <span className="acts">
                {editing ? (
                  <>
                    <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={function () { save(it, ev); }}>Сохранить</button>
                    <button type="button" className="btn btn-xs" onClick={function () { setEditId(null); setErrors({}); }}>Отмена</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-xs" onClick={function () { setEditId(it.id); setEv({ value: it.value, note: it.note }); setErrors({}); }}>Изменить</button>
                    {!it.is_system ? (
                      <button type="button" className="btn btn-xs" disabled={busy} onClick={function () { save(it, { is_active: !it.is_active }); }}>
                        {it.is_active ? 'Скрыть' : 'Вернуть'}
                      </button>
                    ) : null}
                    {!it.is_system && !it.used ? (
                      <button type="button" className="btn btn-xs btn-danger" disabled={busy} onClick={function () { remove(it); }}>Удалить</button>
                    ) : null}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="dict-add">
        <input className={'input' + (errors.value && editId === null ? ' invalid' : '')} value={nv.value} placeholder="Новое значение" aria-label="Новое значение"
          maxLength={64} onChange={function (e) { setNv({ value: e.target.value, note: nv.note }); }} />
        <input className="input" value={nv.note} placeholder="Расшифровка (необязательно)" aria-label="Расшифровка"
          onChange={function (e) { setNv({ value: nv.value, note: e.target.value }); }}
          onKeyDown={function (e) { if (e.key === 'Enter' && nv.value.trim()) add(); }} />
        <button type="button" className="btn btn-sm" disabled={busy || !nv.value.trim()} onClick={add}>Добавить</button>
        {errors.value && editId === null ? <div className="field-error">{errors.value}</div> : null}
      </div>
    </section>
  );
}
