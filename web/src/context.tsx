import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Meta, User } from './types';
import { canEdit, isAdmin, type DictKey } from '../../shared/dict';

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

interface AppCtx {
  meta: Meta;
  user: User;
  canEdit: boolean;
  isAdmin: boolean;
  toast: (text: string, kind?: 'ok' | 'err') => void;
  /** Счётчик изменений данных: страницы перечитывают данные, когда он растёт. */
  version: number;
  bump: () => void;
  /** Перечитать справочники после правки администратором. */
  reloadMeta: () => void;
  /** Расшифровка значения справочника, например тип «ЭЛ» → «Электропитание». */
  note: (dict: DictKey, value: string | null | undefined) => string;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppContext не инициализирован');
  return c;
}

export function AppProvider(props: { meta: Meta; user: User; reloadMeta: () => void; children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const toast = useCallback(function (text: string, kind?: 'ok' | 'err') {
    const id = ++seq.current;
    setToasts(function (t) {
      return t.concat([{ id: id, text: text, kind: kind || 'ok' }]).slice(-4);
    });
    window.setTimeout(function () {
      setToasts(function (t) {
        return t.filter(function (x) {
          return x.id !== id;
        });
      });
    }, kind === 'err' ? 7000 : 3500);
  }, []);
  const bump = useCallback(function () {
    setVersion(function (v) {
      return v + 1;
    });
  }, []);
  const value: AppCtx = {
    meta: props.meta,
    user: props.user,
    canEdit: canEdit(props.user.role),
    isAdmin: isAdmin(props.user.role),
    toast: toast,
    version: version,
    bump: bump,
    reloadMeta: props.reloadMeta,
    note: function (dict: DictKey, value: string | null | undefined) {
      if (!value) return '';
      const items = props.meta.dict.items || [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].dict === dict && items[i].value === value) return items[i].note || '';
      }
      return '';
    },
  };
  return (
    <Ctx.Provider value={value}>
      {props.children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(function (t) {
          return (
            <div key={t.id} className={'toast' + (t.kind === 'err' ? ' err' : '')}>
              {t.text}
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
