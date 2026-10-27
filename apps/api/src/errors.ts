export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = '请先登录'): AppError {
  return new AppError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message = '当前角色无权执行该操作'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(code: string, message: string): AppError {
  return new AppError(404, code, message);
}

export function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(409, code, message, details);
}

export function unprocessable(code: string, message: string, details?: unknown): AppError {
  return new AppError(422, code, message, details);
}

export function badGateway(code: string, message: string): AppError {
  return new AppError(502, code, message);
}
