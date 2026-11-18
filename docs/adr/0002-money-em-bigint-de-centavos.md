# Money representado internamente como bigint de centavos

> Referência no README: §5 Restrições invioláveis, item 1; §6.1 Money; §14 Falhas eliminatórias ("`number` para dinheiro").

O esqueleto do README sugere um `Decimal`, mas como a escala é fixa em 2 casas usamos `bigint` em unidades mínimas, sem biblioteca decimal. A entrada é validada por regex estrita (`^\d+(\.\d{1,2})?$`), então valores com mais casas, notação científica, `NaN`, `Infinity` ou strings vazias são **rejeitados**, nunca arredondados. No banco, o valor fica em `NUMERIC(20,2)`, lido e gravado como string, e a moeda em coluna separada `CHAR(3)`.

## Consequences

Suportar moedas com outra escala (JPY = 0, BHD = 3) exigiria guardar a escala por moeda. Isso fica fora de escopo e está registrado como limitação.
