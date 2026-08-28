import { createRoot } from 'react-dom/client';
import '@mcpproxy/design/css';

const root = document.getElementById('root');
if (root === null) throw new Error('точка монтирования #root отсутствует в index.html');

createRoot(root).render(<main className="surface">mcpproxy</main>);
