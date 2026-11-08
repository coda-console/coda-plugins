// What Git and the repository sources take of plugins (components/plugins/contribution-points.mjs): the commands that answer
// Git for an address (docs/plugins.md「Git 凭据」, adapters/git-credential.mjs) and the one that lists repositories to choose
// from (「仓库来源」, repositories.mjs), defined as this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from './contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';

// Git's credentials for an address are one plugin's. Clients do not list them in the confirmation yet: only one Coda ships
// may bring them.
defineContributionPoint({ key: 'gitCredentials', schema: SCHEMAS['git-credentials.json'], read: (raw = []) => ({ gitCredentials: raw.map(c => ({ url: c.url, command: c.command })) }),
  claim: plugin => (plugin.gitCredentials ?? []).map(c => `${c.url} 的 Git 凭据`),
  builtinOnly: plugin => plugin.gitCredentials?.length ? '只有 Coda 自带的插件能提供 Git 凭据' : null });
// Nor the command that lists repositories to choose from.
defineContributionPoint({ key: 'repositories', schema: SCHEMAS['repositories.json'], read: raw => raw ? { repositories: { command: raw.command } } : {},
  builtinOnly: plugin => plugin.repositories ? '只有 Coda 自带的插件能提供仓库列表' : null });
