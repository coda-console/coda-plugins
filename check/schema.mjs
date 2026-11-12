// ACP's own parsers, from the SDK version Coda pins (package.json). They are its generated zod schemas, which the SDK does
// not export by name: read from the stable v1 file relative to its entry point.
const sdk = import.meta.resolve('@agentclientprotocol/sdk');
export const schemas = await import(new URL('../schema/zod.gen.js', sdk));

// One line on why a value does not parse. A union (a session update is one of many kinds) names the branch it meant: the
// one whose `sessionUpdate` matched.
export function explain(error, value) {
  let issue = error.issues[0], path = [];
  while (issue?.code === 'invalid_union' && issue.errors?.length) {
    path = [...path, ...issue.path];
    const matched = issue.errors.filter(branch => !branch.some(i => i.path.at(-1) === 'sessionUpdate'));
    if (!matched.length && path.at(-1) === 'update') return `update.sessionUpdate 不是 ACP 认识的类型：${JSON.stringify(value?.update?.sessionUpdate)}`;
    const best = (matched.length ? matched : issue.errors).reduce((a, b) => b.length < a.length ? b : a);
    issue = best[0];
  }
  return `${[...path, ...(issue?.path ?? [])].join('.') || '（整体）'}：${issue?.message ?? '不合 schema'}`;
}
