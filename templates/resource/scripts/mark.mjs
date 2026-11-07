// 「记下此刻」按钮的动作：Coda 在点按钮（并确认）后运行它，退出码 0 就算成功，随后重读这个类型。
// 按钮带的 args 在 CODA_PANEL_ARGS 里（JSON），这个按钮没带。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

writeFileSync(join(process.env.CODA_PLUGIN_STATE, 'mark.json'), JSON.stringify({ at: new Date().toISOString() }));
