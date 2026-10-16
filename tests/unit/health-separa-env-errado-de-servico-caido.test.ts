import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "SEU ARQUIVO ESTÁ ERRADO" E "O SERVIÇO CAIU" SÃO DIAGNÓSTICOS OPOSTOS.
 *
 * ─── O que estava indistinguível ────────────────────────────────────────────
 *
 * `UPSTASH_REDIS_REST_URL` e `_TOKEN` são `required()` puro em `lib/env.ts` —
 * sem `.url()`. Um `.env` de self-host com as aspas do arquivo sobrando no valor
 * passa pelo Zod, chega ao `fetch`, e falha. O `reason` que saía era o de
 * ALCANCE, o mesmo que sai quando o contêiner da fila está parado de verdade.
 *
 * As duas leituras mandam quem opera para lugares opostos: uma para reiniciar um
 * serviço saudável, a outra para abrir o editor. É o modo de falha já catalogado
 * nesta casa como ".env sem aspas", e ele custou uma sessão inteira de QA de
 * instalação em VPS.
 *
 * ─── Por que as DUAS metades ────────────────────────────────────────────────
 *
 * Só provar que a forma errada vira `configuracao_invalida` deixaria verde um
 * validador que reprovasse tudo — e aí toda instalação em VPS passaria a
 * reportar `.env` quebrado com o `.env` correto. O segundo caso é o controle:
 * mesma falha de rede, configuração BEM formada, motivo de alcance preservado.
 *
 * Achado de @prevprocesso-maker no PR #465.
 */

const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";

function pedido(): NextRequest {
  return new NextRequest("https://crm.exemplo.com.br/api/v1/health");
}

function comEnv(redisUrl: string, redisToken: string) {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
      UPSTASH_REDIS_REST_URL: redisUrl,
      UPSTASH_REDIS_REST_TOKEN: redisToken,
      INTERNAL_CRON_SECRET: SEGREDO,
      INTERNAL_SECRET: "",
    },
  }));
}

describe("GET /api/v1/health — o motivo aponta para o que precisa ser feito", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("⭐ `.env` com as aspas sobrando: o motivo é a CONFIGURAÇÃO, e o serviço nem é procurado", async () => {
    // A forma exata que um heredoc de instalador produz.
    comEnv('"https://fila-do-cliente.exemplo:80"', "token-de-teste");
    // Toda ida à rede é ANOTADA e recusada na hora. O que se mede é a AUSÊNCIA
    // da tentativa contra a fila, então ela é observada direto, não inferida
    // pelo relógio. A versão anterior cronometrava o `GET` inteiro contra 2 s,
    // e o `GET` roda em paralelo o check do Supabase, que fazia um `fetch` de
    // verdade com timeout de 3 s: no runner do CI ele estourou (3.014 ms em
    // 16/10/2026) e o teste reprovou o Redis por culpa do Supabase.
    const idas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (alvo: string | URL | Request) => {
        idas.push(alvo instanceof Request ? alvo.url : String(alvo));
        throw new TypeError("fetch failed");
      }),
    );
    const { GET } = await import("@/app/api/v1/health/route");

    const { data } = await (await GET(pedido())).json();

    expect(data.checks.redis.reason).toBe("configuracao_invalida");
    expect(data.checks.redis.status).toBe("down");
    // Controle do instrumento: o check do Supabase passou pelo `fetch` anotado.
    // Sem isto, um `fetch` que a rota não usasse deixaria a lista vazia e o
    // teste verde sem medir nada.
    expect(idas.some((u) => u.includes("projeto-do-cliente.supabase.co"))).toBe(true);
    // Sem ida à rede: um endereço que não é endereço não tem o que ser tentado.
    expect(
      idas.filter((u) => u.includes("fila-do-cliente")),
      "houve ida à rede para um endereço malformado",
    ).toEqual([]);
  });

  it("⭐ configuração BEM formada e serviço inalcançável: o motivo volta a ser de alcance", async () => {
    // CONTROLE POSITIVO. Sem ele, um validador que reprovasse tudo deixaria o
    // caso acima verde e faria toda instalação saudável reportar `.env` quebrado.
    // A porta 9 é reservada (discard) e recusa na hora — nada fica pendurado.
    comEnv("http://127.0.0.1:9", "token-de-teste");
    const { GET } = await import("@/app/api/v1/health/route");

    const { data } = await (await GET(pedido())).json();

    expect(data.checks.redis.status).toBe("down");
    expect(
      data.checks.redis.reason,
      "a configuração é válida — chamar isto de erro de configuração manda o operador editar um arquivo correto",
    ).not.toBe("configuracao_invalida");
    expect(data.checks.redis.reason).toBeTruthy();
  });

  it("o endereço malformado continua sem sair para quem não tem o segredo", async () => {
    // A redação de `semAlvo()` não pode ter sido furada pelo caminho novo: ele
    // é o único que monta o `error` à mão, e um caminho novo é exatamente onde
    // uma guarda de saída deixa de alcançar.
    comEnv('"https://fila-do-cliente.exemplo:80"', "token-de-teste");
    const { GET } = await import("@/app/api/v1/health/route");

    const corpo = JSON.stringify(await (await GET(pedido())).json());
    expect(corpo).not.toContain("fila-do-cliente.exemplo");
  });
});
