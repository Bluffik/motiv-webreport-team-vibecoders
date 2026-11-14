import { useEffect, useRef, type ReactNode } from 'react';

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'mid' | 'wide';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(function () {
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea, .modal-foot .btn-primary',
      );
      if (first) first.focus();
      else node.focus(); // содержимое ещё грузится — фокус на само окно, чтобы работали Esc и Tab
    }
    function isTopmost() {
      const backs = document.querySelectorAll('.modal-back');
      return !!node && backs[backs.length - 1] === node.parentElement;
    }
    function onKey(e: KeyboardEvent) {
      // Esc закрывает только верхнее окно и только если не открыт календарь.
      if (e.key === 'Escape' && isTopmost() && !document.querySelector('.flatpickr-calendar.open')) onCloseRef.current();
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return function () {
      document.removeEventListener('keydown', onKey);
      if (document.querySelectorAll('.modal-back').length <= 1) document.body.style.overflow = '';
      if (prev && prev.focus) prev.focus();
    };
  }, []);

  return (
    <div
      className="modal-back"
      onMouseDown={function (e) {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className={'modal ' + (props.size || '')} role="dialog" aria-modal="true" ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="x" aria-label="Закрыть" onClick={props.onClose}>
            ×
          </button>
        </div>
        {props.children}
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}
