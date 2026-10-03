/** An error with an HTTP status the API error handler passes through to the client. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
