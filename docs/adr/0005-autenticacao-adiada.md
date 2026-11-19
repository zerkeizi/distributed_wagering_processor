# Autenticação não implementada, com ponto de extensão explícito

> Referência no CHALLENGE: §2 Autenticação — a cargo do candidato; §9 Health checks; §14 Avaliação (autenticação não pontua).

Não integramos um IdP. O ponto de extensão fica explícito no código, em `src/shared/auth/`:

- **`AuthGuard`** (no-op, `return true`) já está aplicado com `@UseGuards` nos controllers de wallet e de wagering. Com um IdP, ele validaria o bearer token (assinatura via JWKS, `iss`, `aud`, `exp`) e recusaria com `401`.
- **`ProviderIdentityPort`** responde quem está chamando. Hoje devolve `undefined` (ninguém autenticado). Com um IdP, devolveria o `providerId` contido no token.
- **`assertCallerIs`**, no `WageringController`, já compara a identidade da porta com o `providerId` do corpo (ou da rota) e responde `403 FORBIDDEN` se forem diferentes. A checagem fica no controller, e não no guard, porque o guard roda antes de o corpo ser validado. Hoje ela não tem efeito, porque não há identidade.

O desenho-alvo é client-credentials OIDC (Keycloak), com um client por provider e o `providerId` como claim do token. Ativar a autenticação significa trocar o conteúdo dessas duas peças; controllers e use cases não mudam.

Os endpoints de health e `/metrics` não passam pelo guard. Mensagens SQS são tratadas como canal interno confiável (não passam por HTTP), mas o `providerId` delas passa pelas mesmas validações de domínio.
