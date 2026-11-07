// The「Claude」resources, printed once as `{ resources }`, from what the sessions wrote into this plugin's state.
import { join } from 'node:path';
import { ClaudeSessionLimits } from '../agent/limits.mjs';
import { resources } from './quota.mjs';

console.log(JSON.stringify(resources(new ClaudeSessionLimits({ path: process.env.CODA_PLUGIN_STATE ? join(process.env.CODA_PLUGIN_STATE, 'limits.json') : null }))));
