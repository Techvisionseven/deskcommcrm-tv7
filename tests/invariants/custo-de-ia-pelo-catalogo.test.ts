/**
 * CHAMADA DE IA COM PREÇO NO CATÁLOGO NÃO SOME DO PAINEL (migration 0676).
 *
 * O motor calcula `llm_calls.cost_cents` pelo `pricing.ts`, que casa o id
 * exato. Numa VPS real, em 16/10/2026, 852 de 855 linhas estavam com custo
 * nulo: nenhum modelo da OpenRouter (`openai/gpt-6-luna`) casa, e o
 * `claude-haiku-5-5` chegou ao catálogo antes do código. `fn_gasto_de_ia_do_mes`
 * soma `cost_cents`, então a tela Uso e orçamento mostrava gasto quase zero.
 *
 * A 0676 completa no banco o custo da linha que chega nula, com o preço do
 * próprio catálogo. Este arquivo fixa o contrato inteiro, nos dois sentidos:
 * completa o que tem preço, e NÃO inventa preço, NÃO sobrescreve o motor, NÃO
 * precifica falha e NÃO conta o backfill como gasto novo do mês.
 *
 * O backfill é EXTRAÍDO do `supabase/baseline.sql` e executado como texto, não
 * reimplementado aqui: reimplementar mediria a minha cópia.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");
const MARCA =
  "-- ---- custo de IA pelo catálogo quando o motor não sabe o preço (migration 0676) ----";

const ORG = "d6760000-0000-4000-8000-000000000676";
/** Modelo de fixture, com preço só neste teste — não depende do sync da OpenRouter. */
const MODELO_OR = "invariante/modelo-0676";

function blocoDoBaseline(): string | null {
  const texto = readFileSync(BASELINE, "utf8");
  const inicio = texto.indexOf(MARCA);
  if (inicio === -1) return null;
  const resto = texto.slice(inicio + MARCA.length);
  const fim = resto.indexOf("\n-- ---- ");
  return resto.slice(0, fim === -1 ? undefined : fim);
}

const BLOCO = blocoDoBaseline();

/** Insere uma chamada e devolve o `cost_cents` com que ela ficou ('' = nulo). */
function inserir(c: {
  provider: string;
  model: string;
  input: number;
  output: number;
  read?: number;
  write?: number;
  cost?: number | null;
  status?: "ok" | "erro";
}): string {
  // SELECT sobre o RETURNING: o psql não imprime a etiqueta "INSERT 0 1" de um SELECT.
  return sql(`
    with x as (
      insert into public.llm_calls
        (organization_id, purpose, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_cents, latency_ms, status)
      values ('${ORG}', 'agent_turn', '${c.provider}', '${c.model}', ${c.input}, ${c.output},
              ${c.read ?? 0}, ${c.write ?? 0}, ${c.cost ?? "null"}, 100, '${c.status ?? "ok"}')
      returning cost_cents
    )
    select coalesce(cost_cents::text, '') from x;`);
}

function contador(): number {
  return Number(
    sql(
      `select coalesce(current_month_consumed_cents, 0) from public.ai_budgets where organization_id = '${ORG}';`,
    ) || "0",
  );
}

function limpar(): void {
  sql(`
    delete from public.llm_calls where organization_id = '${ORG}';
    delete from public.ai_budgets where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    delete from public.ai_models where provider = 'openrouter' and model_id = '${MODELO_OR}';`);
}

describe("o custo de IA vem do catálogo quando o motor não sabe o preço", () => {
  beforeAll(() => {
    expect(
      BLOCO,
      "não achei o bloco da 0676 no baseline.sql — o instrumento perdeu o alvo, e perder o alvo não é aprovação",
    ).not.toBeNull();
    limpar();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'inv-custo-catalogo', 'Invariante Custo LTDA', 'Invariante Custo');
      insert into public.ai_models
        (provider, model_id, display_name, input_price_per_million_cents, output_price_per_million_cents, supports_tools)
        values ('openrouter', '${MODELO_OR}', 'Modelo do invariante', 100, 400, true);`);
  });

  afterAll(() => {
    limpar();
  });

  it("o Claude Haiku 5.5 sem custo ganha o preço do catálogo, com o cache a 0,1×", () => {
    // Números de uma resposta real da VPS: 44.211 de entrada, 39.138 lidos do cache.
    // (5.073 × 10 + 39.138 × 1 + 1.214 × 50) / 1.000.000 = 0,150568 centavo.
    expect(
      Number(
        inserir({
          provider: "anthropic",
          model: "claude-haiku-5-5",
          input: 44211,
          output: 1214,
          read: 39138,
        }),
      ),
    ).toBeCloseTo(0.150568, 6);
  });

  it("gravação de cache custa 2× a entrada na Anthropic e 1× nos demais", () => {
    expect(
      Number(
        inserir({
          provider: "anthropic",
          model: "claude-haiku-5-5",
          input: 1000,
          output: 0,
          write: 1000,
        }),
      ),
    ).toBeCloseTo(0.02, 6);
    expect(
      Number(
        inserir({ provider: "openrouter", model: MODELO_OR, input: 1000, output: 0, write: 1000 }),
      ),
    ).toBeCloseTo(0.1, 6);
  });

  it("modelo da OpenRouter é precificado por (provider, model_id) do ai_models", () => {
    // 1.000 × 100 + 500 × 400 = 300.000 / 1.000.000 = 0,3 centavo.
    expect(
      Number(inserir({ provider: "openrouter", model: MODELO_OR, input: 1000, output: 500 })),
    ).toBeCloseTo(0.3, 6);
  });

  it("o custo enviado pelo motor nunca é sobrescrito", () => {
    expect(
      Number(
        inserir({
          provider: "anthropic",
          model: "claude-haiku-5-5",
          input: 1000,
          output: 1000,
          cost: 7,
        }),
      ),
    ).toBe(7);
  });

  it("modelo sem preço no catálogo continua nulo (não inventa preço)", () => {
    expect(
      inserir({ provider: "anthropic", model: "modelo-que-nao-existe", input: 1000, output: 1000 }),
    ).toBe("");
  });

  it("chamada que falhou continua nula", () => {
    expect(
      inserir({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        input: 0,
        output: 0,
        status: "erro",
      }),
    ).toBe("");
  });

  it("o custo calculado entra no contador do mês, como gasto novo", () => {
    const antes = contador();
    inserir({ provider: "openrouter", model: MODELO_OR, input: 10000, output: 0 });
    expect(contador() - antes).toBeCloseTo(1, 6);
  });

  it("o backfill preenche a linha antiga sem mexer no contador, e re-aplicar não muda nada", () => {
    // Uma linha gravada antes da 0676 existir: o gatilho desligado reproduz isso.
    sql(`alter table public.llm_calls disable trigger trg_llm_calls_custo_pelo_catalogo;`);
    let id: string;
    try {
      id = sql(`
        with x as (
          insert into public.llm_calls
            (organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms, status)
            values ('${ORG}', 'agent_turn', 'openrouter', '${MODELO_OR}', 2000, 0, null, 100, 'ok')
            returning id
        )
        select id from x;`);
    } finally {
      sql(`alter table public.llm_calls enable trigger trg_llm_calls_custo_pelo_catalogo;`);
    }
    expect(
      sql(`select coalesce(cost_cents::text, '') from public.llm_calls where id = '${id}';`),
      "controle: a linha antiga nasceu nula",
    ).toBe("");
    const contadorAntes = contador();

    sql(BLOCO!);
    expect(Number(sql(`select cost_cents from public.llm_calls where id = '${id}';`))).toBeCloseTo(
      0.2,
      6,
    );
    expect(contador(), "backfill virou gasto novo do mês — é o defeito da 0140 de volta").toBe(
      contadorAntes,
    );

    sql(BLOCO!);
    expect(Number(sql(`select cost_cents from public.llm_calls where id = '${id}';`))).toBeCloseTo(
      0.2,
      6,
    );
    expect(contador()).toBe(contadorAntes);
  });

  it("nenhuma das duas funções é executável por anon ou authenticated", () => {
    for (const fn of [
      "public.fn_custo_de_ia_pelo_catalogo(text, text, bigint, bigint, bigint, bigint)",
      "public.fn_llm_calls_custo_pelo_catalogo()",
    ]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(
          sql(`select has_function_privilege('${papel}', '${fn}'::regprocedure, 'EXECUTE');`),
          `${papel} executa ${fn}`,
        ).toBe("f");
      }
    }
  });
});
