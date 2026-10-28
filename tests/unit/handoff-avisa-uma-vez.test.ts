/**
 * O LEAD É AVISADO DA PASSAGEM UMA VEZ — nem zero, nem duas.
 *
 * ─── O defeito, medido em produção (2026-10-16, UTC) ────────────────────────
 *
 * A cliente perguntou "Vai me transferir para um atendente?". O modelo decidiu
 * passar a conversa e, ele mesmo, escreveu: "Dra. Vanessa, entendi. Vou passar
 * o atendimento para uma pessoa da equipe…" (18:13:28, `send_ledger.seq = 1`).
 * Dois segundos depois saiu o aviso fixo do sistema, no MESMO job
 * (`seq = 0`, o `SEQ_DO_AVISO`): "Claro! Já estou chamando alguém da equipe
 * para falar com você. No momento ninguém está disponível…". O robô disse a
 * mesma coisa duas vezes, trocou "a senhora" por "você" e contou a uma cliente
 * de vendas que não havia ninguém.
 *
 * O piso já existia (`seq === 0` na tool `request_human_handoff`) e estava
 * certo em sequência. O que o furava é o paralelismo: o AI SDK executa as
 * ferramentas de UM passo juntas, e `seq` só anda no fim da cadeia
 * `before_send`. Os traces do job confirmam: a cadeia da fala do agente fechou
 * às 18:13:28.47; a do aviso, às 18:13:29.00 — as duas abertas ao mesmo tempo.
 *
 * ─── O que este arquivo prova, e como ──────────────────────────────────────
 *
 * As `execute` das ferramentas são closures dentro do turno (~4800 linhas), sem
 * ponto de injeção barato — a mesma situação de `send-message-corpo-vazio.test.ts`.
 * Então são duas metades:
 *
 *   1. COMPORTAMENTO, com o AI SDK REAL (`generateText` + `MockLanguageModelV3`)
 *      fazendo o modelo chamar `send_message` e `request_human_handoff` no
 *      mesmo passo. As ferramentas do teste reproduzem as duas regras do turno
 *      (o `seq` que só anda no fim da cadeia e o piso que o lê) e usam o
 *      `criarFalaDoTurno` de produção. O CONTROLE roda a regra antiga no mesmo
 *      cenário e tem de ver as DUAS mensagens — sem ele, um SDK que executasse
 *      em série deixaria tudo verde medindo nada.
 *   2. FIAÇÃO no fonte de `inbound-turn.ts`: o piso espera as falas ANTES de ler
 *      `seq`, e as ferramentas que falam estão no registro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { criarFalaDoTurno } from "@/lib/agent-engine/agent/aviso-de-escalacao";

const FALA_DO_AGENTE =
  "Dra. Vanessa, entendi. Vou passar o atendimento para uma pessoa da equipe.";
const AVISO_FIXO = "<aviso de código da passagem>";

type Ferramenta = "send_message" | "request_human_handoff";

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Um modelo que pede as ferramentas dadas NUM passo só, e depois encerra. */
function modeloQueChamaNoMesmoPasso(ferramentas: Ferramenta[]): MockLanguageModelV3 {
  let passo = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      passo += 1;
      if (passo === 1) {
        return {
          content: ferramentas.map((nome, i) => ({
            type: "tool-call" as const,
            toolCallId: `chamada-${i}`,
            toolName: nome,
            input: JSON.stringify(nome === "send_message" ? { body: FALA_DO_AGENTE } : {}),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USO,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    },
  });
}

/**
 * Um turno em miniatura com as duas regras de `inbound-turn.ts` que se cruzam:
 *
 *   - `send_message` só incrementa `seq` no envio físico, depois da cadeia
 *     (aqui, 30 ms de "classificador + lock + throttle");
 *   - o piso de `request_human_handoff` manda o aviso quando `seq === 0`.
 *
 * `comRegistro` liga o `criarFalaDoTurno` de produção; desligado, é a regra de
 * antes. Devolve o que o cliente recebeu, na ordem.
 */
async function turno(
  ferramentas: Ferramenta[],
  opts: { comRegistro: boolean; falaVetada?: boolean },
): Promise<string[]> {
  const cliente: string[] = [];
  let seq = 0;
  const fala = criarFalaDoTurno();

  const enviar = async ({ body }: { body: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (opts.falaVetada === true) {
      // Veto da cadeia: o envio não acontece e `seq` não anda (inbound-turn.ts).
      return { ok: false as const, error: { code: "case_promise_without_case" } };
    }
    seq += 1;
    cliente.push(body);
    return { ok: true as const };
  };

  await generateText({
    model: modeloQueChamaNoMesmoPasso(ferramentas),
    prompt: "Vai me transferir para um atendente?",
    stopWhen: stepCountIs(3),
    tools: {
      send_message: tool({
        inputSchema: z.object({ body: z.string() }),
        execute: opts.comRegistro ? fala.acompanhar(enviar) : enviar,
      }),
      request_human_handoff: tool({
        inputSchema: z.object({}),
        execute: async () => {
          if (opts.comRegistro) await fala.assentar();
          if (seq === 0) cliente.push(AVISO_FIXO);
          return { ok: true as const };
        },
      }),
    },
  });

  return cliente;
}

describe("a fala do agente e a passagem no MESMO passo", () => {
  it("CONTROLE: com a regra de antes, o cliente recebe as duas (é o defeito de produção)", async () => {
    const recebido = await turno(["send_message", "request_human_handoff"], { comRegistro: false });
    expect(recebido).toHaveLength(2);
    expect(recebido).toContain(AVISO_FIXO);
    expect(recebido).toContain(FALA_DO_AGENTE);
  });

  it("o agente anunciou a passagem: o aviso fixo NÃO sai", async () => {
    expect(await turno(["send_message", "request_human_handoff"], { comRegistro: true })).toEqual([
      FALA_DO_AGENTE,
    ]);
  });

  it("vale também quando o modelo pede a passagem ANTES da fala, no mesmo passo", async () => {
    expect(await turno(["request_human_handoff", "send_message"], { comRegistro: true })).toEqual([
      FALA_DO_AGENTE,
    ]);
  });

  it("o modelo não disse nada: o piso avisa — o lead nunca fica no vazio", async () => {
    expect(await turno(["request_human_handoff"], { comRegistro: true })).toEqual([AVISO_FIXO]);
  });

  it("a fala do mesmo passo foi VETADA pela cadeia: o piso avisa", async () => {
    // Tentar não é dizer. Se o veto não sobra para o piso, o cliente que pediu
    // uma pessoa fica sem resposta nenhuma — o defeito que o piso veio acabar.
    expect(
      await turno(["send_message", "request_human_handoff"], { comRegistro: true, falaVetada: true }),
    ).toEqual([AVISO_FIXO]);
  });
});

describe("criarFalaDoTurno", () => {
  it("sem fala em curso, assentar não espera nada", async () => {
    await expect(criarFalaDoTurno().assentar()).resolves.toBeUndefined();
  });

  it("registra a tentativa no ato da chamada, antes do primeiro await dela", async () => {
    const fala = criarFalaDoTurno();
    let terminou = false;
    const executar = fala.acompanhar(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      terminou = true;
    });
    void executar();
    await fala.assentar();
    expect(terminou).toBe(true);
  });

  it("enxerga a irmã que começa DEPOIS de quem assenta, na mesma volta do laço", async () => {
    const fala = criarFalaDoTurno();
    let terminou = false;
    const espera = fala.assentar();
    // A irmã começa por microtarefa, como dentro do `executeTools` do SDK.
    queueMicrotask(() => {
      void fala.acompanhar(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminou = true;
      })();
    });
    await espera;
    expect(terminou).toBe(true);
  });

  it("a falha da ferramenta continua sendo de quem a chamou, e não trava o assentar", async () => {
    const fala = criarFalaDoTurno();
    const falha = fala.acompanhar(async () => {
      throw new Error("canal fora");
    })();
    await expect(falha).rejects.toThrow("canal fora");
    await expect(fala.assentar()).resolves.toBeUndefined();
  });
});

describe("fiação em inbound-turn.ts", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("o piso do request_human_handoff espera as falas ANTES de ler seq", () => {
    const i = FONTE.indexOf("request_human_handoff: tool({");
    expect(i).toBeGreaterThan(-1);
    const corpo = FONTE.slice(i, FONTE.indexOf("applyRequestHumanHandoff(", i));
    const espera = corpo.indexOf("await falaDoTurno.assentar();");
    const leitura = corpo.indexOf("seq === 0");
    // Presença antes de posição: −1 é menor que qualquer índice.
    expect(espera).toBeGreaterThan(-1);
    expect(leitura).toBeGreaterThan(-1);
    expect(espera).toBeLessThan(leitura);
  });

  it("send_message e send_template entram no registro antes de o modelo recebê-las", () => {
    const registro = FONTE.indexOf("for (const nome of ['send_message', 'send_template'] as const) {");
    expect(registro).toBeGreaterThan(-1);
    expect(FONTE.slice(registro, registro + 400)).toContain("falaDoTurno.acompanhar(");
    // Desde a 1.94 o breaker vem embrulhado pelo traço do turno
    // (`envolverFerramentasComTraco`): a âncora é a chamada do breaker.
    const entrega = FONTE.indexOf("wrapToolsWithBreaker(previewTools");
    expect(entrega).toBeGreaterThan(registro);
  });

  it("o registro é do TURNO — declarado no closure, nunca em escopo de módulo", () => {
    // Em módulo, a fala de um cliente seguraria (ou calaria) o aviso de outro.
    expect(FONTE).toMatch(/^ {2}const falaDoTurno = criarFalaDoTurno\(\);$/m);
  });
});
