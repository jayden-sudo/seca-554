/** An error the HTTP server reports to the caller with this status (400 bad input, 404 unknown, 409 conflict...). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
