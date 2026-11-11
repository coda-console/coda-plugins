// Once the device is held, connect to the resolved Android endpoint on the calling machine. The custodian handles
// lending and returning; an iPhone or iPad needs no connection step here.
import { connect } from './android.mjs';
if (process.env.PLATFORM === 'android') connect(process.env.ADB);
