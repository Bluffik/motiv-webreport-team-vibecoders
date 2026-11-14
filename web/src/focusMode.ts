// Рамка фокуса — только при работе с клавиатуры.
// В Chrome 75 нет :focus-visible, поэтому режим определяем сами: Tab и стрелки
// включают класс `kbd` на <html>, нажатие мышью или касание выключает. Без этого
// после щелчка по строке таблицы, кнопке или флажку оставалась тёмная рамка.

const NAV_KEYS = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

export function trackInputMode(): void {
  const root = document.documentElement;
  document.addEventListener(
    'keydown',
    function (e) {
      if (NAV_KEYS.indexOf(e.key) >= 0 && !e.altKey && !e.ctrlKey && !e.metaKey) root.classList.add('kbd');
    },
    true,
  );
  function pointer() {
    root.classList.remove('kbd');
  }
  document.addEventListener('mousedown', pointer, true);
  document.addEventListener('touchstart', pointer, true);
}
