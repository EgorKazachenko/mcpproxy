import { writeFileSync } from 'node:fs';
import { API_SURFACE_SNAPSHOT, currentApiSurface } from '../dist/api-surface.js';

// Единственный способ обновить снапшот поверхности. Живёт отдельно от теста намеренно:
// гейт, умеющий одобрить сам себя из переменной окружения, гейтом не является — в E0 такой
// уже стоял за `if (process.env.UPDATE_API_SURFACE === '1')` и переписывал снапшот под то,
// чем поверхность стала. Запускается руками, вместе с явным решением владельца.
writeFileSync(API_SURFACE_SNAPSHOT, currentApiSurface());
console.log(`снапшот обновлён: ${API_SURFACE_SNAPSHOT}`);
