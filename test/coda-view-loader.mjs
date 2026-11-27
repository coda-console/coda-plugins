// 测试里的 WebView 标准库映射：Coda 客户端在页面里提供同源的 coda-view://lib/v1/accord.js，Node 解不了这种地址，
// 这里把它指到协议包的同一份实现（@coda-console/protocol/accord）。用法：node --import ./test/coda-view-loader.mjs --test …
import { registerHooks } from 'node:module';

const LIBRARIES = new Map([['coda-view://lib/v1/accord.js', import.meta.resolve('@coda-console/protocol/accord')]]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = LIBRARIES.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
