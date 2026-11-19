import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * Ponto de extensão da autenticação (ADR 0005, CHALLENGE §2). Hoje permite tudo.
 *
 * Desenho-alvo: client-credentials OIDC (Keycloak), um client por provider. Este guard validaria o
 * bearer token (assinatura via JWKS, `iss`, `aud`, `exp`) e anexaria a identidade à requisição;
 * a `ProviderIdentityPort` então resolveria o `providerId` do token e o use case exigiria que fosse
 * igual ao `providerId` do corpo. Health checks e a fila SQS ficam fora deste guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
