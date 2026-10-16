-- manifest: chamada de IA cujo modelo o motor não sabe precificar ganha o custo pelo catálogo (ai_models / ai_pricing) no próprio banco, em vez de ficar com cost_cents nulo e sumir do painel Uso e orçamento; preenche o histórico que ficou nulo.
--
-- O defeito, medido numa VPS em 16/10/2026: 852 de 855 linhas de `llm_calls`
-- com `cost_cents` nulo. O preço que o motor usa mora só em
-- `lib/agent-engine/edge/llm/pricing.ts`, por id EXATO. Ficam de fora:
--   - todo modelo da OpenRouter (o id é `openai/gpt-6-luna`, não `gpt-6-luna`);
--   - todo modelo que entrou no catálogo depois da imagem que está rodando
--     (o `claude-haiku-5-5` da 0675 chegou ao banco antes do código).
-- `fn_gasto_de_ia_do_mes` soma `cost_cents`, então a tela mostrava gasto quase
-- zero e o teto de orçamento não enxergava nada disso.
--
-- O conserto não troca a fonte de preço: quando o motor manda um custo, ele
-- vale. Só a linha que chega SEM custo é completada, e só com preço que o
-- catálogo já tem — o mesmo que a tela mostra ao escolher o modelo:
--   1. `ai_models` por (provider, model_id) — inclui os da OpenRouter, que o
--      cron `sync-model-catalog` atualiza todo dia;
--   2. `ai_pricing` por model, como segunda fonte.
-- Modelo sem preço em nenhum dos dois continua NULO: "não sei" segue sendo
-- "não sei", e o aviso de gasto incompleto da tela continua acendendo.
-- Chamada que falhou (`status = 'erro'`) continua NULA, como o motor grava.
--
-- O catálogo só tem preço de entrada e de saída. O cache é estimado como o
-- `pricing.ts` faz para os modelos que ele conhece:
--   - leitura de cache: 0,1× a entrada (Anthropic, e a linha 5.x/6.x da OpenAI);
--   - gravação de cache: 2× a entrada na Anthropic (TTL de 1 hora, o padrão de
--     `LLM_CACHE_TTL`) e 1× nos demais, que não cobram gravação.
-- Não modela: a faixa de prompt acima de 100 mil tokens do Claude Haiku 5.5
-- (5× o preço) nem a de contexto longo da OpenAI. São estimativas, nunca o
-- valor da fatura; a fatura do provedor continua sendo a fonte da verdade.
--
-- O gatilho nunca recusa a linha: se o cálculo falhar, a linha entra nula, como
-- entraria sem ele. É BEFORE INSERT, então o `trg_llm_calls_budget` (AFTER
-- INSERT) já soma o custo calculado ao contador do mês.
--
-- O backfill do fim só preenche `cost_cents` de linhas antigas: é UPDATE, e o
-- contador `ai_budgets.current_month_consumed_cents` (AFTER INSERT) não se
-- mexe — um backfill nunca vira "gasto novo" (ver tests/invariants/orcamento-apos-backfill.test.ts).
-- A tela lê `fn_gasto_de_ia_do_mes`, que soma as linhas, e passa a mostrar o mês certo.
--
-- Idempotente: create or replace, drop trigger if exists, e o backfill só toca
-- linha com custo nulo.

create or replace function public.fn_custo_de_ia_pelo_catalogo(
  p_provider text,
  p_model text,
  p_input bigint,
  p_output bigint,
  p_cache_read bigint,
  p_cache_write bigint
) returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  with preco as (
    select m.input_price_per_million_cents::numeric as entrada,
           m.output_price_per_million_cents::numeric as saida,
           1 as ordem
      from public.ai_models m
     where m.provider = p_provider
       and m.model_id = p_model
       and m.input_price_per_million_cents is not null
       and m.output_price_per_million_cents is not null
    union all
    select p.prompt_cents_per_million_tokens, p.completion_cents_per_million_tokens, 2
      from public.ai_pricing p
     where p.model = p_model
       and p.superseded_at is null
       and p.prompt_cents_per_million_tokens is not null
       and p.completion_cents_per_million_tokens is not null
     order by ordem
     limit 1
  )
  select (
           greatest(0, coalesce(p_input, 0) - coalesce(p_cache_read, 0) - coalesce(p_cache_write, 0)) * entrada
         + coalesce(p_cache_read, 0) * entrada * 0.1
         + coalesce(p_cache_write, 0) * entrada
             * (case when p_provider = 'anthropic' or p_model like 'anthropic/%' then 2.0 else 1.0 end)
         + coalesce(p_output, 0) * saida
         ) / 1000000.0
    from preco;
$$;

revoke execute on function public.fn_custo_de_ia_pelo_catalogo(text, text, bigint, bigint, bigint, bigint)
  from public, anon, authenticated;

create or replace function public.fn_llm_calls_custo_pelo_catalogo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.cost_cents is null and new.status = 'ok' and new.model is not null then
    begin
      new.cost_cents := public.fn_custo_de_ia_pelo_catalogo(
        new.provider, new.model,
        new.input_tokens, new.output_tokens, new.cache_read_tokens, new.cache_write_tokens
      );
    exception when others then
      new.cost_cents := null;
    end;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_llm_calls_custo_pelo_catalogo()
  from public, anon, authenticated;

drop trigger if exists trg_llm_calls_custo_pelo_catalogo on public.llm_calls;
create trigger trg_llm_calls_custo_pelo_catalogo
  before insert on public.llm_calls
  for each row execute function public.fn_llm_calls_custo_pelo_catalogo();

update public.llm_calls c
   set cost_cents = public.fn_custo_de_ia_pelo_catalogo(
         c.provider, c.model, c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens)
 where c.cost_cents is null
   and c.status = 'ok'
   and c.model is not null
   and public.fn_custo_de_ia_pelo_catalogo(
         c.provider, c.model, c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens) is not null;
