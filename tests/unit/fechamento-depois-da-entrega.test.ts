/**
 * O FECHAMENTO QUE FALHA DEPOIS DA ENTREGA NÃO RE-RODA O TURNO.
 *
 * O caso medido em produção (2026-10-16) está no cabeçalho de
 * `fecharDepoisDaEntrega` (`lib/agent-engine/agent/inbound-turn.ts`): o turno
 * respondeu, o checkpoint veio com JSON inválido, a fila re-rodou o turno
 * inteiro, e a resposta ao "Sim" que chegou no intervalo saiu como
 * `already_sent` — o cliente não recebeu nada.
 *
 * A correção do formato é de `fecharOTurno` (`abertura/checkpoint.ts`): uma 2ª
 * chamada do fechamento, com o problema. `fecharDepoisDaEntrega` envolve a
 * chamada dela no turno e decide o que fazer com o que SOBRA — e é a composição
 * das duas, exatamente como o turno a monta, que este arquivo exercita: o
 * `pedir` falso faz o papel do modelo.
 *
 * O turno inteiro só roda contra Postgres
 * (`tests/invariants/mensagem-durante-o-retry-tem-resposta.test.ts`). Aqui fica o
 * contrato exato — quando desiste, quando sobe, e o que NÃO pode engolir.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fecharDepoisDaEntrega } from "@/lib/agent-engine/agent/inbound-turn";
import { FechamentoRecusado, fecharOTurno } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const CHECKPOINT = {
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "resumo",
};

type Desfecho = "json_invalido" | "ok" | Error;

/**
 * O fechamento do turno, montado como em `inbound-turn.ts`: `fecharOTurno` com
 * um `pedir` falso — cada chamada ao "modelo" consome o próximo desfecho.
 */
function fechamentoQue(...desfechos: Desfecho[]) {
  let chamada = 0;
  const pedir = vi.fn(async () => {
    const d = desfechos[chamada++] ?? "ok";
    if (d instanceof Error) throw d;
    return { text: d === "ok" ? JSON.stringify(CHECKPOINT) : "Claro! Fechei o turno.", callId: `call-${chamada}` };
  });
  return { pedir, fechar: () => fecharOTurno({ pedir }) };
}

function contexto(entregou: boolean, registrarFalha = vi.fn(async (_motivo: string) => {})) {
  return { entregou, log: { error: vi.fn() }, registrarFalha };
}

describe("turno que já entregou a resposta", () => {
  it("JSON inválido também na correção: encerra sem checkpoint, sem subir para a fila e sem 3ª chamada", async () => {
    const { pedir, fechar } = fechamentoQue("json_invalido", "json_invalido");
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();

    // A correção é a de `fecharOTurno`, e é uma só: esta função não acrescenta repetição.
    expect(pedir).toHaveBeenCalledTimes(2);
    expect(ctx.log.error).toHaveBeenCalledTimes(1);
    expect(ctx.registrarFalha).toHaveBeenCalledTimes(1);
    const motivo = ctx.registrarFalha.mock.calls[0]![0];
    expect(motivo).toContain("JSON de checkpoint");
    // A promessa de retry do parse deixa de valer aqui — o motivo gravado não pode repeti-la.
    expect(motivo).not.toContain("re-tentado pela fila");
  });

  it("a correção que acerta o formato devolve o checkpoint, sem anotar falha", async () => {
    const { pedir, fechar } = fechamentoQue("json_invalido", "ok");
    const ctx = contexto(true);

    const r = await fecharDepoisDaEntrega(fechar, ctx);

    expect(r?.content).toEqual(CHECKPOINT);
    expect(r?.corrigido).toBe(true);
    expect(r?.resposta.callId).toBe("call-2");
    expect(pedir).toHaveBeenCalledTimes(2);
    expect(ctx.registrarFalha).not.toHaveBeenCalled();
  });

  it("erro do provedor (o 400 da assinatura do `thinking`) encerra sem repetir — o SDK já re-tentou", async () => {
    const { pedir, fechar } = fechamentoQue(
      new Error("messages.1.content.0: Invalid `signature` in `thinking` block."),
    );
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();

    expect(pedir).toHaveBeenCalledTimes(1);
    expect(ctx.registrarFalha.mock.calls[0]![0]).toContain("Invalid `signature`");
  });

  it("erro do provedor NA CORREÇÃO também encerra sem checkpoint", async () => {
    const { pedir, fechar } = fechamentoQue("json_invalido", new Error("overloaded_error"));
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();

    expect(pedir).toHaveBeenCalledTimes(2);
    expect(ctx.registrarFalha.mock.calls[0]![0]).toContain("overloaded_error");
  });

  it("orçamento esgotado SOBE: é ele que a escolta de handoff precisa ver", async () => {
    await expect(
      fecharDepoisDaEntrega(fechamentoQue(new LlmBudgetExceededError()).fechar, contexto(true)),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });

  it("orçamento esgotado na CORREÇÃO sobe igual", async () => {
    const { pedir, fechar } = fechamentoQue("json_invalido", new LlmBudgetExceededError());

    await expect(fecharDepoisDaEntrega(fechar, contexto(true))).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
    expect(pedir).toHaveBeenCalledTimes(2);
  });

  it("fronteira de atendimento vencida SOBE: a fila cancela, não completa", async () => {
    await expect(
      fecharDepoisDaEntrega(fechamentoQue(new StaleServiceBoundaryError()).fechar, contexto(true)),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  });

  it("falha ao gravar o motivo não vira re-run: o cliente já foi atendido", async () => {
    const { fechar } = fechamentoQue("json_invalido", "json_invalido");
    const ctx = contexto(
      true,
      vi.fn(async () => {
        throw new Error("banco fora");
      }),
    );

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();
    expect(ctx.log.error).toHaveBeenCalledTimes(2);
  });
});

describe("turno que ainda não falou com o cliente — o contrato de `fecharOTurno`", () => {
  it("JSON inválido duas vezes sobe: a fila re-roda um turno que não tem o que engolir", async () => {
    const { pedir, fechar } = fechamentoQue("json_invalido", "json_invalido", "ok");
    const ctx = contexto(false);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).rejects.toBeInstanceOf(FechamentoRecusado);

    expect(pedir).toHaveBeenCalledTimes(2);
    expect(ctx.registrarFalha).not.toHaveBeenCalled();
  });

  it("erro do provedor sobe igual", async () => {
    const erro = new Error("provider fora");
    await expect(fecharDepoisDaEntrega(fechamentoQue(erro).fechar, contexto(false))).rejects.toBe(erro);
  });

  it("sem falha, o fechamento passa direto, entregue ou não", async () => {
    for (const entregou of [true, false]) {
      const { pedir, fechar } = fechamentoQue("ok");
      const r = await fecharDepoisDaEntrega(fechar, contexto(entregou));
      expect(r?.content).toEqual(CHECKPOINT);
      expect(r?.corrigido).toBe(false);
      expect(pedir).toHaveBeenCalledTimes(1);
    }
  });
});

describe("fiação em inbound-turn.ts", () => {
  const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

  it("o fechamento do turno é `fecharOTurno` chamado DENTRO de `fecharDepoisDaEntrega`", () => {
    // Uma chamada só de `fecharOTurno` no arquivo, e ela é o `fechar` do embrulho.
    expect(FONTE.match(/fecharOTurno\(\{/g)).toHaveLength(1);
    const embrulho = FONTE.indexOf("await fecharDepoisDaEntrega(");
    expect(embrulho).toBeGreaterThan(-1);
    const chamada = FONTE.indexOf("fecharOTurno({", embrulho);
    expect(FONTE.slice(embrulho, chamada)).toMatch(/^await fecharDepoisDaEntrega\(\s*async \(\)\s*=>\s*await\s*$/);
  });

  it("entregou conta toda mensagem que o cliente já tem: enviada, já aceita, retida pelo canal e a do roteiro", () => {
    const embrulho = FONTE.indexOf("await fecharDepoisDaEntrega(");
    const inicio = FONTE.indexOf("entregou:", embrulho);
    const trecho = FONTE.slice(inicio, FONTE.indexOf("registrarFalha:", inicio));
    for (const parte of ["!preview", "roteiroEntregou", "'sent'", "'already_sent'", "'queued'"]) {
      expect(trecho).toContain(parte);
    }
  });
});
