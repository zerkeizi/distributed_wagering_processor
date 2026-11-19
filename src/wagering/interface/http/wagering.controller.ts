import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../../../shared/auth/auth.guard.ts";
import {
  PROVIDER_IDENTITY,
  type ProviderIdentityPort,
} from "../../../shared/auth/provider-identity.port.ts";
import { currentLogContext, enrichLogContext } from "../../../shared/observability/log-context.ts";
import {
  GetWagerTransaction,
  type WagerTransactionView,
} from "../../application/use-cases/get-wager-transaction.ts";
import {
  type SubmissionResult,
  SubmitWagerTransaction,
} from "../../application/use-cases/submit-wager-transaction.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction-kind.ts";
import {
  idempotencyKeySchema,
  identifier,
  uuidSchema,
  wagerTransactionFields,
} from "../contracts.ts";
import { parseInput } from "./validation.ts";

const submitBody = wagerTransactionFields;

export type SubmissionResponse = Omit<SubmissionResult, "outcome">;

/**
 * Status por resultado (ADR 0010): 201 aplicada agora · 200 replay · 202 aguardando reference ·
 * 422 rejeitada por regra de negócio (corpo completo, é um resultado registrado) · 500 FAILED.
 */
export function httpStatusFor(result: SubmissionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.outcome === "replayed" ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(GetWagerTransaction) private readonly query: GetWagerTransaction,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post("wagering/transactions")
  async create(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmissionResponse> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey, "Idempotency-Key");
    const input = parseInput(submitBody, body, "body");
    enrichLogContext({ providerId: input.providerId, walletId: input.walletId });
    this.assertCallerIs(input.providerId);

    const result = await this.submit.execute({
      ...input,
      idempotencyKey: key,
      correlationId: currentLogContext()?.correlationId ?? Bun.randomUUIDv7(),
      channel: "http",
    });
    enrichLogContext({ transactionId: result.transactionId });
    res.status(httpStatusFor(result));
    const { outcome: _outcome, ...response } = result;
    return response;
  }

  @Get("wagering/transactions/:transactionId")
  byId(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    return this.query.byId(parseInput(uuidSchema, transactionId, "transactionId"));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    this.assertCallerIs(providerId);
    return this.query.byExternalId(
      parseInput(identifier, providerId, "providerId"),
      parseInput(identifier, externalTransactionId, "externalTransactionId"),
    );
  }

  /** Com IdP, o provider autenticado só age em nome de si mesmo (ADR 0005). Hoje: sem identidade. */
  private assertCallerIs(providerId: string): void {
    const caller = this.identity.current();
    if (caller && caller.providerId !== providerId) {
      throw new ForbiddenException("authenticated provider does not match providerId");
    }
  }
}
