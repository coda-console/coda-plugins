// What Git and the repository sources take of plugins (components/plugins/contribution-points.mjs): the commands that answer
// Git for an address (docs/plugins.md「Git 凭据」, adapters/git-credential.mjs) and the one that lists repositories to choose
// from (「仓库来源」, repositories.mjs), defined as this module loads.
// Descriptions only: nothing here imports a component, for the plugins read with them are read before any is made.
import { defineContributionPoint } from './contribution-points.mjs';
import { SCHEMAS } from '@coda-console/protocol/validate';

// Git's credentials for an address are one plugin's: the address as Git matches it, a port's leading zeros and https's default
// port dropped (the schema takes `https://` and a host in lower case alone), so that `https://host:443` is `https://host`'s
// and `https://host:08443` is `https://host:8443`'s. Installing one confirms
// each address it answers Git for, with the command; clients do not list them yet.
defineContributionPoint({ key: 'gitCredentials', schema: SCHEMAS['git-credentials.json'], read: (raw = []) => ({ gitCredentials: raw.map(c => ({ url: c.url, command: c.command })) }),
  claim: plugin => (plugin.gitCredentials ?? []).map(c => `${c.url.replace(/:0*(\d+)$/, ':$1').replace(/:443$/, '')} 的 Git 凭据`),
  confirm: plugin => plugin.gitCredentials?.length
    ? { gitCredentials: plugin.gitCredentials.map(c => ({ label: `Git 凭据：为 ${c.url} 回答 Git（Git 要凭据时运行）`, command: c.command })) } : {} });
// Nor the command that lists repositories to choose from. Each plugin's list is read on its own and put with the others
// (repositories.mjs), so no plugin claims it.
defineContributionPoint({ key: 'repositories', schema: SCHEMAS['repositories.json'], read: raw => raw ? { repositories: { command: raw.command } } : {},
  confirm: plugin => plugin.repositories ? { repositories: { label: '仓库来源（挑仓库时运行）', command: plugin.repositories.command } } : {} });
