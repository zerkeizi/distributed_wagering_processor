import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { PinoLogger } from "nestjs-pino";
import { DomainError } from "../../../shared/domain/domain-error.ts";
import { currentLogContext } from "../../../shared/observability/log-context.ts";
import { InvalidRequestError } from "../../application/errors.ts";
import {
  LockTimeoutError,
  PersistenceUnavailableError,
} from "../../application/ports/persistence-errors.ts";
import { ErrorCode } from "../../domain/error-code.ts";

/**
 * Mapeamento único de erro → status HTTP (ADR 0010), igual para todos os endpoints. O provider
 * decide pelo status e pelo `error.code`, nunca pela mensagem.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  [ErrorCode.InvalidPayload]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UnsupportedKind]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ReferenceRequired]: HttpStatus.BAD_REQUEST,
  [ErrorCode.WalletNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.TransactionNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.CurrencyMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WalletPlayerMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.WalletAlreadyExists]: HttpStatus.CONFLICT,
  [ErrorCode.IdempotencyKeyConflict]: HttpStatus.CONFLICT,
  [ErrorCode.ExternalIdConflict]: HttpStatus.CONFLICT,
};

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { readonly path: string; readonly message: string }[];
    readonly correlationId?: string;
  };
}

interface Mapped {
  readonly status: number;
  readonly body: ErrorBody["error"];
  readonly retryAfterSeconds?: number;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext("ApiExceptionFilter");
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = this.map(exception);
    const correlationId = currentLogContext()?.correlationId;
    if (mapped.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    }
    const body: ErrorBody = {
      error: { ...mapped.body, ...(correlationId ? { correlationId } : {}) },
    };
    res.status(mapped.status).json(body);
  }

  private map(exception: unknown): Mapped {
    if (exception instanceof InvalidRequestError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.details.length ? { details: exception.details } : {}),
        },
      };
    }
    if (exception instanceof DomainError) {
      return {
        status: STATUS_BY_CODE[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY,
        body: { code: exception.code, message: exception.message },
      };
    }
    if (exception instanceof LockTimeoutError) {
      this.logger.warn({ err: exception }, "wallet lock timeout");
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { code: ErrorCode.LockTimeout, message: "wallet is busy, retry the same request" },
        retryAfterSeconds: 1,
      };
    }
    if (exception instanceof PersistenceUnavailableError) {
      this.logger.error({ err: exception }, "database unavailable");
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: {
          code: ErrorCode.TemporarilyUnavailable,
          message: "temporarily unavailable, retry the same request",
        },
        retryAfterSeconds: 2,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, body: { code: codeForHttpStatus(status), message: exception.message } };
    }
    // Bug ou falha inesperada: detalhes só no log, nunca na resposta.
    this.logger.error({ err: exception }, "unhandled error");
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.InternalError, message: "internal error" },
    };
  }
}

function codeForHttpStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.InvalidPayload;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.Forbidden;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.RouteNotFound;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ErrorCode.PayloadTooLarge;
    default:
      return `HTTP_${status}`;
  }
}
