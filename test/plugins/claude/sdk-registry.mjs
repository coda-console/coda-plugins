// The upgrade check of the Claude entry's registry (plugins/claude/agent/registry.mjs): every message type and subtype the
// locked Claude Agent SDK declares (its SDKMessage union), and every content block type of an assistant's and a user's
// message (the elements of their `message.content`), is registered. npm test runs it (sdk-registry.test.mjs); on its own it
// lists what is missing:
//
//   node test/plugins/claude/sdk-registry.mjs
//
// The declarations are read by TypeScript's own checker: aliases, intersections, re-exports and generics resolve as they do
// for the SDK's users. A `type` or `subtype` that is not string literals fails the check, naming its member, rather than
// passing unseen.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ASSISTANT_BLOCKS, MESSAGES, USER_BLOCKS } from '../../../plugins/claude/agent/registry.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const OPTIONS = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ESNext,
  noEmit: true, skipLibCheck: true, types: [] };

// What the SDK whose declarations are `file` declares: its messages' names (type, and type/subtype where it has subtypes), and
// the content block types of its assistant's and user's messages.
export function declared(file) {
  const program = ts.createProgram([file], OPTIONS), checker = program.getTypeChecker();
  const parts = type => type.isUnion() ? type.types : [type];
  const property = (type, name, what) => {
    const symbol = checker.getPropertyOfType(type, name);
    if (!symbol) throw new Error(`${what} 没有 ${name}`);
    return checker.getTypeOfSymbol(symbol);
  };
  const literals = (type, name, what) => parts(property(type, name, what)).map(part => {
    if (!part.isStringLiteral()) throw new Error(`${what} 的 ${name} 不全是字符串字面量：${checker.typeToString(part)}`);
    return part.value;
  });
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file))).find(symbol => symbol.name === 'SDKMessage');
  if (!exported) throw new Error(`${file} 没有导出 SDKMessage`);
  const messages = parts(checker.getDeclaredTypeOfSymbol(exported)).map(type => ({ type, what: checker.typeToString(type) }));
  const names = messages.flatMap(({ type, what }) => {
    const subtypes = checker.getPropertyOfType(type, 'subtype') ? literals(type, 'subtype', what) : [null];
    return literals(type, 'type', what).flatMap(name => subtypes.map(subtype => subtype === null ? name : `${name}/${subtype}`));
  });
  // The elements of the arrays a role's messages' `message.content` can be.
  const blocks = role => messages.filter(({ type, what }) => literals(type, 'type', what).includes(role)).flatMap(({ type, what }) => {
    const arrays = parts(property(property(type, 'message', what), 'content', `${what}.message`)).filter(part => checker.isArrayType(part));
    if (!arrays.length) throw new Error(`${what}.message.content 不是内容块的数组`);
    return arrays.flatMap(array => parts(checker.getTypeArguments(array)[0]))
      .flatMap(block => literals(block, 'type', `${what} 的内容块 ${checker.typeToString(block)}`));
  });
  const sorted = list => [...new Set(list)].sort();
  return { messages: sorted(names), assistant: sorted(blocks('assistant')), user: sorted(blocks('user')) };
}
// The declarations of the SDK plugins/claude installs, as the entry's code resolves it.
export function sdkDeclarations() {
  resolveFrom('claude', '@anthropic-ai/claude-agent-sdk');
  return ts.resolveModuleName('@anthropic-ai/claude-agent-sdk', join(pluginDir('claude'), 'agent', 'session.mjs'), OPTIONS, ts.sys).resolvedModule.resolvedFileName;
}

// What the SDK declares that `registry` does not have, by the registry's table.
export function unregistered(registry = { MESSAGES, ASSISTANT_BLOCKS, USER_BLOCKS }, file = sdkDeclarations()) {
  const { messages, assistant, user } = declared(file);
  return [...messages.filter(name => !Object.hasOwn(registry.MESSAGES, name)).map(name => `MESSAGES：${name}`),
    ...assistant.filter(type => !Object.hasOwn(registry.ASSISTANT_BLOCKS, type)).map(type => `ASSISTANT_BLOCKS：${type}`),
    ...user.filter(type => !Object.hasOwn(registry.USER_BLOCKS, type)).map(type => `USER_BLOCKS：${type}`)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = unregistered();
  if (missing.length) {
    console.error(`锁定的 Claude Agent SDK 有这些没登记（plugins/claude/agent/registry.mjs）：\n${missing.map(m => `  ${m}`).join('\n')}`);
    process.exit(1);
  }
  console.log('锁定的 Claude Agent SDK 的消息与内容块类型都登记了');
}
