// 好友插件的模块（Coda 的 docs/plugins.md「插件宿主」）。Accord 的读写全在页面里发起（页面用自己的 coda.query / coda.call /
// coda.watch）；模块只管好友的本地备注：存在插件自己的持久目录 notes.json 里，不外发，页面通过视图消息读写，
// 也能用 `coda self notes.list|notes.set|notes.delete` 读写。activate 里不碰 Accord。
import { deleteNote, readNotes, setNote } from './lib/notes.mjs';

let dir = null;
const handles = [];

export function activate(coda) {
  dir = coda.plugin.state;
  const actions = {
    'notes.list': () => readNotes(dir),
    'notes.set': ({ node, note } = {}) => setNote(dir, node, note),
    'notes.delete': ({ node } = {}) => deleteNote(dir, node),
  };
  const run = (name, input) => {
    if (!dir) throw new Error('这台机器没有插件状态目录，备注存不下');
    return actions[name](input);
  };
  for (const name of Object.keys(actions)) handles.push(coda.self.handle(name, input => run(name, input ?? {})));
  coda.views.register('friends', {
    open(view) {
      view.onMessage(async message => {
        const name = message?.type;
        if (!Object.hasOwn(actions, name) || typeof message.rid !== 'string') return;
        try { view.postMessage({ type: 'reply', rid: message.rid, ok: true, value: await run(name, message) }); }
        catch (e) { view.postMessage({ type: 'reply', rid: message.rid, ok: false, error: String(e?.message ?? e) }); }
      });
    },
  });
}

export function deactivate() {
  for (const handle of handles.splice(0)) handle?.dispose?.();
  dir = null;
}
