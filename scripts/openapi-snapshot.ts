import { writeFileSync } from 'node:fs';
import { buildSpecApp, openApiInfo } from '../apps/server/src/openapi/app.ts';

/** 重新生成开放 API 规范快照（契约测试拿它比对）。 */
const doc = buildSpecApp().getOpenAPI31Document(openApiInfo);
writeFileSync(new URL('../docs/openapi/v1.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`docs/openapi/v1.json：${Object.keys(doc.paths ?? {}).length} 个路径`);
