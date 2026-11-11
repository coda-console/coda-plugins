import { connect } from './android.mjs';
if (process.env.PLATFORM === 'android') connect(process.env.ADB);
