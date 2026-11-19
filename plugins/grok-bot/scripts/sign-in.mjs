#!/usr/bin/env node
// The「Grok Bot」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): the plugin's own PKCE login, no CLI. It reports
// the official link (`coda progress`) before it polls for the page to be confirmed or keeps anything: a report that fails fails the
// login with the credentials as they were. The credentials are the plugin's, in its state directory.
import { execFile } from 'node:child_process';
import { NativeAuth } from '../lib/auth.mjs';

// Coda's own command: what it prints, or why it failed (its last line).
const coda = (...args) => new Promise((done, fail) => execFile('coda', args, (error, stdout, stderr) =>
  error ? fail(new Error(stderr.trim().split('\n').at(-1) || error.message)) : done(stdout)));

let auth;
try {
  auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE });
  await auth.login(url => coda('progress', JSON.stringify({ url }))).promise;
  console.log('{}');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { auth?.close(); }
