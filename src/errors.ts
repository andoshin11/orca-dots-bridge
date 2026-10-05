export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorResult(error: unknown) {
  return {
    code: error instanceof BridgeError ? error.code : "internal_error",
    message:
      error instanceof BridgeError
        ? error.message
        : "Unexpected bridge error; see local diagnostics.",
  };
}
