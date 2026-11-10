import { requestBinding } from '../lib/binding.mjs';
try {
  const { record } = JSON.parse(process.env.CODA_PANEL_ARGS);
  console.log(JSON.stringify(await requestBinding(process.env.CODA_PLUGIN_STATE, record)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
