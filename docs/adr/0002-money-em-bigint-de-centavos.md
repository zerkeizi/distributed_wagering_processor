# Money representado internamente como bigint de centavos

> Referência no README: §5 Restrições invioláveis, item 1; §6.1 Money; §14 Falhas eliminatórias ("`number` para dinheiro").

O esqueleto do README sugere um `Decimal`, mas como a escala é fixa em 2 casas usamos `bigint` em unidades mínimas, sem biblioteca decimal. A entrada é validada por regex estrita (`^(0|[1-9]\d{0,17})\.\d{2}$`): exige **exatamente** 2 casas, como o README pede ("recebido e serializado sempre com escala fixa de 2 casas"). Valores com mais ou menos casas (`"1.001"`, `"1.5"`, `"25"`), notação científica, `NaN`, `Infinity`, sinal, zeros à esquerda ou strings vazias são **rejeitados**, nunca arredondados. Exigir a escala exata também garante que `"25.0"` e `"25.00"` nunca cheguem ao `payloadHash` como payloads diferentes para o mesmo valor. No banco, o valor fica em `NUMERIC(20,2)`, lido e gravado como string, e a moeda em coluna separada `CHAR(3)`.

## Consequences

Suportar moedas com outra escala (JPY = 0, BHD = 3) exigiria guardar a escala por moeda. Isso fica fora de escopo e está registrado como limitação.
