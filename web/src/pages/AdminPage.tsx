import type { AdminTab } from '../types';
import { UsersPage } from './UsersPage';
import { DictsPage } from './DictsPage';
import { NotifyPage } from './NotifyPage';
import { AuditPage } from './AuditPage';
import { ApiPage } from './ApiPage';
import { TrashPage } from './TrashPage';

const ITEMS: Array<{ key: AdminTab; label: string }> = [
  { key: 'users', label: 'Пользователи' },
  { key: 'dicts', label: 'Справочники' },
  { key: 'notify', label: 'Уведомления' },
  { key: 'trash', label: 'Корзина' },
  { key: 'api', label: 'API' },
  { key: 'audit', label: 'Журнал действий' },
];

/** Раздел администратора: подменю под шапкой и выбранная страница. */
export function AdminPage(props: { tab: AdminTab }) {
  return (
    <>
      <nav className="subnav" aria-label="Администрирование">
        <div className="subnav-inner">
          {ITEMS.map(function (it) {
            const on = props.tab === it.key;
            return (
              <a key={it.key} href={'#/admin/' + it.key} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
                {it.label}
              </a>
            );
          })}
        </div>
      </nav>
      {props.tab === 'users' ? <UsersPage /> : null}
      {props.tab === 'dicts' ? <DictsPage /> : null}
      {props.tab === 'notify' ? <NotifyPage /> : null}
      {props.tab === 'trash' ? <TrashPage /> : null}
      {props.tab === 'api' ? <ApiPage /> : null}
      {props.tab === 'audit' ? <AuditPage /> : null}
    </>
  );
}
