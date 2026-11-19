/**
 * Quem está chamando, segundo a autenticação (ADR 0005). Com o guard no-op, não há identidade
 * autenticada e o `providerId` do payload é aceito como veio — mas continua passando pelas mesmas
 * validações de domínio (CHALLENGE §2).
 */
export interface ProviderIdentity {
  readonly providerId: string;
}

export interface ProviderIdentityPort {
  /** `undefined` = sem identidade autenticada (modo atual, sem IdP). */
  current(): ProviderIdentity | undefined;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export class UnauthenticatedProviderIdentity implements ProviderIdentityPort {
  current(): ProviderIdentity | undefined {
    return undefined;
  }
}
