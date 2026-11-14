import { createRoot } from 'react-dom/client';
// Фирменные шрифты «Мотив» (Ubuntu — текст, Montserrat — заголовки), встроены в сборку: работает без интернета.
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/500.css';
import '@fontsource/ubuntu/700.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import './styles.css';
import { App } from './App';
import { trackInputMode } from './focusMode';

trackInputMode();
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
