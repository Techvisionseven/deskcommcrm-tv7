/**
 * O FECHAMENTO QUE FALHA DEPOIS DA ENTREGA NÃO RE-RODA O TURNO.
 *
 * O caso medido em produção (2026-10-16) está no cabeçalho de
 * `fecharDepoisDaEntrega` (`lib/agent-engine/agent/inbound-turn.ts`): o turno
 * respondeu, o checkpoint veio com JSON inválido, a fila re-rodou o turno
 * inteiro, e a resposta ao "Sim" que chegou no intervalo saiu como
 * `already_sent` — o cliente não recebeu nada.
 *
 * A função é de módulo para poder ser exercitada sozinha, como a escolta do
 * orçamento: o turno inteiro só roda contra Postgres
 * (`tests/invariants/mensagem-durante-o-retry-tem-resposta.test.ts`). Aqui fica o
 * contrato exato — quando repete, quando desiste, e o que NÃO pode engolir.
 */
import { describe, expect, it, vi } from "vitest";

import { fecharDepoisDaEntrega } from "@/lib/agent-engine/agent/inbound-turn";
import { CheckpointInvalidoError, parseCheckpointText } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const CHECKPOINT = {
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "resumo",
};

/** Fechamento falso: cada chamada consome o próximo desfecho da lista. */
function fechamentoQue(...desfechos: Array<"json_invalido" | "ok" | Error>) {
  let chamada = 0;
  const fechar = vi.fn(async () => {
    const d = desfechos[chamada++] ?? "ok";
    if (d instanceof Error) throw d;
    // O parse de verdade: a falha de formato é a MESMA que o turno vê.
    return parseCheckpointText(d === "ok" ? JSON.stringify(CHECKPOINT) : "Claro! Fechei o turno.");
  });
  return fechar;
}

function contexto(entregou: boolean, registrarFalha = vi.fn(async (_motivo: string) => {})) {
  return { entregou, log: { error: vi.fn() }, registrarFalha };
}

describe("turno que já entregou a resposta", () => {
  it("JSON inválido não sobe para a fila: repete SÓ o fechamento uma vez e encerra sem checkpoint", async () => {
    const fechar = fechamentoQue("json_invalido", "json_invalido");
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();

    expect(fechar).toHaveBeenCalledTimes(2);
    expect(ctx.log.error).toHaveBeenCalledTimes(1);
    expect(ctx.registrarFalha).toHaveBeenCalledTimes(1);
    const motivo = ctx.registrarFalha.mock.calls[0]![0];
    expect(motivo).toContain("JSON de checkpoint");
    // A promessa de retry do parse deixa de valer aqui — o motivo gravado não pode repeti-la.
    expect(motivo).not.toContain("re-tentado pela fila");
  });

  it("a segunda chamada do fechamento que acerta o formato devolve o checkpoint", async () => {
    const fechar = fechamentoQue("json_invalido", "ok");
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toEqual(CHECKPOINT);

    expect(fechar).toHaveBeenCalledTimes(2);
    expect(ctx.registrarFalha).not.toHaveBeenCalled();
  });

  it("erro do provedor (o 400 da assinatura do `thinking`) encerra sem repetir — o SDK já re-tentou", async () => {
    const fechar = fechamentoQue(
      new Error("messages.1.content.0: Invalid `signature` in `thinking` block."),
    );
    const ctx = contexto(true);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).resolves.toBeNull();

    expect(fechar).toHaveBeenCalledTimes(1);
    expect(ctx.registrarFalha.mock.calls[0]![0]).toContain("Invalid `signature`");
  });

  it("orçamento esgotado SOBE: é ele que a escolta de handoff precisa ver", async () => {
    const fechar = fechamentoQue(new LlmBudgetExceededError());

    await expect(fecharDepoisDaEntrega(fechar, contexto(true))).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
  });

  it("fronteira de atendimento vencida SOBE: a fila cancela, não completa", async () => {
    const fechar = fechamentoQue(new StaleServiceBoundaryError());

    await expect(fecharDepoisDaEntrega(fechar, contexto(true))).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
  });

  it("falha ao gravar o motivo não vira re-run: o cliente já foi atendido", async () => {
    const fechar = fechamentoQue("json_invalido", "json_invalido");
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

describe("turno que ainda não falou com o cliente — o contrato de antes", () => {
  it("JSON inválido sobe na primeira vez: a fila re-roda um turno que não tem o que engolir", async () => {
    const fechar = fechamentoQue("json_invalido", "ok");
    const ctx = contexto(false);

    await expect(fecharDepoisDaEntrega(fechar, ctx)).rejects.toBeInstanceOf(CheckpointInvalidoError);

    expect(fechar).toHaveBeenCalledTimes(1);
    expect(ctx.registrarFalha).not.toHaveBeenCalled();
  });

  it("erro do provedor sobe igual", async () => {
    const erro = new Error("provider fora");
    await expect(fecharDepoisDaEntrega(fechamentoQue(erro), contexto(false))).rejects.toBe(erro);
  });

  it("sem falha, o fechamento passa direto, entregue ou não", async () => {
    for (const entregou of [true, false]) {
      const fechar = fechamentoQue("ok");
      await expect(fecharDepoisDaEntrega(fechar, contexto(entregou))).resolves.toEqual(CHECKPOINT);
      expect(fechar).toHaveBeenCalledTimes(1);
    }
  });
});

it("o parse do checkpoint lança CheckpointInvalidoError nas três formas de falha", () => {
  for (const texto of ["sem chaves", "{ isto não é json }", '{"commitments": "não é lista"}']) {
    expect(() => parseCheckpointText(texto)).toThrow(CheckpointInvalidoError);
  }
});
