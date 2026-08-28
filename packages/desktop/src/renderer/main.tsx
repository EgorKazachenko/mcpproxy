import { createRoot } from 'react-dom/client';
import '@mcpproxy/design/css';
import './app.css';
import { App } from './App.js';
import { applyTheme, currentTheme } from './theme.js';

const root = document.getElementById('root');
if (root === null) throw new Error('точка монтирования #root отсутствует в index.html');

applyTheme(currentTheme());
createRoot(root).render(<App />);
