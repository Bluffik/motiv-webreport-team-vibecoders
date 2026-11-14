// Небольшой набор иконок (inline SVG, без внешних зависимостей).
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconTower(props: { size?: number }) {
  const s = props.size || 22;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 7v14M8 21h8M12 7l-4.5 14M12 7l4.5 14M9.6 14.5h4.8" />
      <path d="M7.5 3.5a6 6 0 0 0 0 7M16.5 3.5a6 6 0 0 1 0 7" opacity="0.7" />
      <circle cx="12" cy="7" r="1.6" fill="#e5383b" stroke="none" />
    </svg>
  );
}
export function IconDownload() {
  return (<svg {...base} aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></svg>);
}
export function IconPrint() {
  return (<svg {...base} aria-hidden="true"><path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z" /></svg>);
}
export function IconPlus() {
  return (<svg {...base} aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>);
}
export function IconCheck() {
  return (<svg {...base} aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>);
}
export function IconCopy() {
  return (<svg {...base} aria-hidden="true"><path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" /></svg>);
}
export function IconTrash() {
  return (<svg {...base} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></svg>);
}
export function IconStop() {
  return (<svg {...base} aria-hidden="true"><path d="M4 4h8v8H4z" /></svg>);
}
export function IconLogout() {
  return (<svg {...base} aria-hidden="true"><path d="M6.5 13.5h-3v-11h3M10 11l3-3-3-3M13 8H6" /></svg>);
}
export function IconKey() {
  return (<svg {...base} aria-hidden="true"><circle cx="5.5" cy="10.5" r="3" /><path d="M7.7 8.3L13.5 2.5M11.5 4.5l1.5 1.5" /></svg>);
}
