export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isRetriable(): boolean {
    return this.status >= 500;
  }
}
