import { WalletNotFoundError } from "../errors.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { toWalletView, type WalletView } from "../views.ts";

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((scope) => scope.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}
