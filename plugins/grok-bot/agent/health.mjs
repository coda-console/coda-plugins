// A connection frame alone is not recovery: require useful data, a heartbeat,
// or a clean stream end. This also counts repeated post-connect failures.
export const authenticationError = error => error.status === 401 || error.status === 403 || /unauthenticated/.test(error.message);
export class ConnectionHealth {
  constructor({ log, error, recovered }) {
    Object.assign(this, { log, error, recovered });
    this.failures = 0;
    this.reported = false;
  }
  failure(error) {
    this.log(error.message);
    this.failures++;
    if (!this.reported && (authenticationError(error) || this.failures >= 3)) {
      this.reported = true;
      this.error(error);
    }
  }
  success() {
    this.failures = 0;
    if (this.reported) { this.reported = false; this.recovered(); }
  }
  get delay() { return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, this.failures - 1), 5)); }
}
