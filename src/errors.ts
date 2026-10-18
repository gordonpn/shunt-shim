/**
 * Standardized API error payload shape.
 */
export interface ApiError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

/**
 * Creates a standardized API error response object.
 *
 * @param message - Human-readable description of the error.
 * @param type - High-level error classification string.
 * @param code - Specific machine-readable error code.
 * @param param - Parameter name associated with the error, or null.
 * @returns Standardized API error object.
 */
export function createErrorResponse(
  message: string,
  type: string,
  code: string,
  param?: string | null,
): ApiError {
  const errorParam = param ?? null;
  return {
    error: {
      message,
      type,
      param: errorParam,
      code,
    },
  };
}
