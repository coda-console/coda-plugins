import { NativeAuth } from '../lib/auth.mjs';
const auth = new NativeAuth({ root: process.env.CODA_PLUGIN_STATE });
try {
  const login = auth.login();
  console.log(login.url);
  await login.promise;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { auth.close(); }
