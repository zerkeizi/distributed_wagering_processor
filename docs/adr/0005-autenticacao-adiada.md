# Autenticação não implementada, com ponto de extensão explícito

> Referência no README: §2 Autenticação — a cargo do candidato; §9 Health checks; §14 Avaliação (autenticação não pontua).

Não integramos um IdP. Fica no código um `ProviderAuthGuard` no-op e uma `ProviderIdentityPort`. O desenho-alvo é client-credentials OIDC (Keycloak) com um client por provider: a porta extrai o `providerId` do token e o guard exige que ele seja igual ao `providerId` do corpo. Os endpoints de health permanecem abertos. Mensagens SQS são tratadas como canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.
