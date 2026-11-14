import type { DictItem, Role } from '../../shared/dict';

export interface User {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

export interface Meta {
  appName: string;
  serverNow: string;
  timeZone: string;
  demo: boolean;
  crmUrlTemplate: string;
  dict: {
    directions: string[];
    techCenters: string[];
    categories: number[];
    networkTypes: string[];
    alarmTypes: string[];
    items: DictItem[];
    wholeNetwork: string;
    roles: Record<Role, string>;
    roleHints: Record<Role, string>;
  };
}

export interface StationRef {
  id: number;
  code: string;
  akb_minutes: number | null;
  has_dgu: boolean;
}

export interface Alarm {
  ID: number;
  PW: string | null;
  NAPR: string | null;
  TEHC: string | null;
  KATEG: number | null;
  NETW_TYPE: string | null;
  SERV_ELEM: string | null;
  /** Число БС или «С» (сектор). */
  NUMB_RBS: string | null;
  EQIP_TYPE: string | null;
  ALARM_TYPE: string | null;
  DESCR: string | null;
  BEGIN_TIME: string | null;
  END_TIME: string | null;
  IS_OPEN: boolean;
  AKB: string | null;
  DGU: string | null;
  LENGHT: string | null;
  LENGTH_SEC: number | null;
  PROSTOY: string | null;
  COMMON_PROSTOY: string | null;
  COMMON_SEC: number | null;
  ALARM_WHO: string | null;
  DESC_NOTICE: string | null;
  /** Только в списке открытых аварий: данные станции из инвентаря. */
  STATION?: StationRef | null;
}

export interface Totals {
  count: number;
  open: number;
  lengthSec: number;
  commonSec: number;
  bs: number;
  sectors: number;
  akbSec: number;
  dguSec: number;
}

export interface AuditEntry {
  id: number;
  ts: string;
  user_id: number | null;
  user_login: string | null;
  user_name: string | null;
  action: string;
  alarm_id: number | null;
  details: any;
}

export interface UserRow extends User {
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface Station {
  id: number;
  code: string;
  address: string;
  napr: string | null;
  tehc: string | null;
  netw_type: string | null;
  eqip_type: string | null;
  bs_count: number;
  akb_minutes: number | null;
  has_dgu: boolean;
  note: string | null;
  is_active: boolean;
  updated_at: string;
  serv_elem: string;
  alarms90?: number;
  open_now?: number;
  last_alarm?: string | null;
}

export type Channel = 'email';

export interface NotifyRule {
  id: number;
  name: string;
  channel: Channel;
  target: string;
  kateg: string[];
  napr: string[];
  tehc: string[];
  alarm_types: string[];
  on_create: boolean;
  on_close: boolean;
  long_hours: number | null;
  daily_at: string | null;
  is_active: boolean;
  created_at: string;
  total?: number;
  sent?: number;
  last?: string | null;
}

export type SettingSource = 'ui' | 'env' | 'none';

export interface NotifyStatus {
  email: { configured: boolean; server: string; security: string; user: string; from: string; source: SettingSource; secretBroken: boolean };
  appUrl: { value: string; source: SettingSource };
}

export type SmtpSecurity = 'auto' | 'starttls' | 'ssl' | 'none';

export interface SettingsView {
  mail: {
    host: string;
    port: number;
    security: SmtpSecurity;
    user: string;
    hasPassword: boolean;
    fromName: string;
    fromAddress: string;
    tlsVerify: boolean;
    allowedDomains: string;
    effectiveDomains: string[];
    ready: boolean;
    source: SettingSource;
    updatedAt: string | null;
    updatedBy: string | null;
    secretBroken: boolean;
  };
  appUrl: { value: string; source: SettingSource };
}

export interface CheckResult {
  ok: boolean;
  steps: Array<{ ok: boolean; text: string }>;
}

export interface NotifyLogEntry {
  id: number;
  ts: string;
  rule_id: number | null;
  rule_name: string | null;
  alarm_id: number | null;
  event: 'create' | 'close' | 'long' | 'test' | 'daily';
  channel: Channel;
  target: string;
  subject?: string;
  body?: string;
  status: 'sent' | 'failed' | 'skipped' | 'pending';
  error: string | null;
  sent_at: string | null;
}

export type Tab = 'alarms' | 'reports' | 'stats' | 'stations' | 'admin';
export type AdminTab = 'users' | 'dicts' | 'notify' | 'trash' | 'api' | 'audit';
