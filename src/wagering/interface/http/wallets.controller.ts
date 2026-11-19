import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AuthGuard } from "../../../shared/auth/auth.guard.ts";
import { currentLogContext, enrichLogContext } from "../../../shared/observability/log-context.ts";
import { CreateWallet } from "../../application/use-cases/create-wallet.ts";
import { GetWallet } from "../../application/use-cases/get-wallet.ts";
import { type LedgerPageView, ListLedger } from "../../application/use-cases/list-ledger.ts";
import {
  ReconcileWallet,
  type ReconciliationReport,
} from "../../application/use-cases/reconcile-wallet.ts";
import type { WalletView } from "../../application/views.ts";
import { moneySchema, parseInput, uuidSchema } from "./validation.ts";

const createWalletBody = z.object({
  playerId: uuidSchema,
  initialBalance: moneySchema,
});

const ledgerQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/, "limit must be a positive integer")
    .transform(Number)
    .optional(),
});

/** O controller só traduz HTTP ↔ use case; regras e erros ficam nas camadas de baixo. */
@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletView> {
    const input = parseInput(createWalletBody, body, "body");
    const wallet = await this.createWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId: correlationId(),
    });
    enrichLogContext({ walletId: wallet.id });
    return wallet;
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletParam(walletId));
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<LedgerPageView> {
    const q = parseInput(ledgerQuery, query, "query");
    return this.listLedger.execute({ walletId: walletParam(walletId), ...q });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcile(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletParam(walletId));
  }
}

function walletParam(walletId: string): string {
  const id = parseInput(uuidSchema, walletId, "walletId");
  enrichLogContext({ walletId: id });
  return id;
}

function correlationId(): string {
  return currentLogContext()?.correlationId ?? Bun.randomUUIDv7();
}
