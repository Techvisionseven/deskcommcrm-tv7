import { describe, expect, it } from "vitest";

import type { CaseEvent } from "@/hooks/ai/useCases";

import { caseEventLabel, novidadeDaIA } from "./case-copy";

describe("caseEventLabel — quem respondeu", () => {
  it("resposta do cliente fora do atendimento atual fica marcada; o resto segue igual", () => {
    const lead = { kind: "lead_provided", actor_kind: "lead", human_action: null } as const;
    expect(caseEventLabel({ ...lead, fora_da_fronteira: "true" })).toBe(
      "O cliente respondeu fora do atendimento atual (sem aviso no WhatsApp)",
    );
    expect(caseEventLabel({ ...lead, fora_da_fronteira: "false" })).toBe("O cliente respondeu");
    expect(caseEventLabel({ ...lead, fora_da_fronteira: null })).toBe("O cliente respondeu");
  });

  it("resposta pelo WhatsApp de avisos não é atribuída a quem olha a tela", () => {
    for (const human_action of ["resolved", "need_lead_info"] as const) {
      expect(
        caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action, source: "whatsapp" }),
      ).toBe("A equipe respondeu pelo WhatsApp");
    }
  });

  it("resposta pela tela continua na segunda pessoa", () => {
    expect(
      caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action: "resolved", source: null }),
    ).toBe("Você concluiu o caso");
    expect(caseEventLabel({ kind: "human_replied", actor_kind: "human", human_action: "resolved" })).toBe(
      "Você concluiu o caso",
    );
  });
});

describe("novidadeDaIA", () => {
  const ev = (kind: CaseEvent["kind"], actor_kind: CaseEvent["actor_kind"], body: string | null, min: number) => ({
    kind,
    actor_kind,
    body,
    created_at: `2026-10-26T12:${String(min).padStart(2, "0")}:00.000Z`,
  });

  it("devolve a nota mais recente da IA quando a equipe ainda não respondeu depois dela", () => {
    expect(
      novidadeDaIA([
        ev("opened", "agent", null, 0),
        ev("agent_noted", "agent", "quer conhecer a unidade", 15),
        ev("agent_noted", "agent", "terça 27/10 à noite", 28),
      ]),
    ).toEqual({ body: "terça 27/10 à noite", created_at: "2026-10-26T12:28:00.000Z" });
  });

  it("some quando a equipe respondeu depois da nota", () => {
    expect(
      novidadeDaIA([ev("agent_noted", "agent", "terça à noite", 28), ev("human_replied", "human", "Liberado 19h", 40)]),
    ).toBeNull();
  });

  it("ignora nota vazia e caso sem nota", () => {
    expect(novidadeDaIA([ev("opened", "agent", null, 0), ev("agent_noted", "agent", "   ", 5)])).toBeNull();
    expect(novidadeDaIA([])).toBeNull();
  });
});
