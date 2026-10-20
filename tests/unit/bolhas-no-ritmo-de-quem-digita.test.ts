/**
 * CADA BOLHA SEGUINTE ESPERA O TEMPO DE SER DIGITADA.
 *
 * ─── O defeito, medido em produção (2026-10-16, UTC) ────────────────────────
 *
 * Uma resposta partida em três bolhas — 189, 187 e 84 caracteres, um único
 * `send_message` (um só trace de `before_send` para as três) — chegou às
 * 18:09:59, 18:10:01 e 18:10:04. A pausa humana (`atraso-humano.ts`) só era
 * paga antes da 1ª; entre as outras ficava o jitter anti-ban, 1,2s + ≤0,8s.
 * Ninguém digita 187 caracteres em 1,9 segundo, e o cliente percebe.
 *
 * ─── O que se prende aqui ──────────────────────────────────────────────────
 *
 *   1. a conta: digitar a bolha, na mesma taxa da 1ª, sem o tempo de "notar" —
 *      e "a mesma taxa" é a EFETIVA da conexão (knobs de `channel_knobs`, 0499),
 *      com o piso e o teto dela;
 *   2. o anti-ban continua PISO — a pausa é o maior dos dois, nunca a soma;
 *   3. o teto por turno: a pausa dorme com o lock do número na mão (#654), e o
 *      que ela acrescenta ao jitter é limitado;
 *   4. a fiação no turno, que é o único chamador de produção.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ATRASO_ENTRE_BOLHAS_MAXIMO_MS,
  ATRASO_EXTRA_ENTRE_BOLHAS_POR_TURNO_MS,
  ATRASO_MINIMO_MS,
  MS_POR_CARACTERE,
  calcularDigitacaoDaBolha,
  criarPausaEntreBolhas,
} from "@/lib/agent-engine/agent/atraso-humano";
import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";

/** As três bolhas do turno medido, no tamanho exato. */
const BOLHAS_DO_TURNO_MEDIDO = ["a".repeat(189), "b".repeat(187), "c".repeat(84)];

describe("calcularDigitacaoDaBolha", () => {
  it("é a digitação da bolha na taxa da 1ª, sem o tempo de notar a conversa", () => {
    expect(calcularDigitacaoDaBolha("b".repeat(187))).toBe(187 * MS_POR_CARACTERE);
  });

  it("bolha curta não fica abaixo do piso anti-ban", () => {
    expect(calcularDigitacaoDaBolha("Ok!")).toBe(ATRASO_MINIMO_MS);
  });

  it("bolha longa para no teto — silêncio longo entre bolhas lê como 'parou no meio'", () => {
    expect(calcularDigitacaoDaBolha("x".repeat(2000))).toBe(ATRASO_ENTRE_BOLHAS_MAXIMO_MS);
  });
});

/**
 * A conexão que configurou o atraso humano (Conexões › Proteção de envio, 0499)
 * recebe o ritmo dela em TODA bolha, não só na 1ª: a taxa por caractere e o
 * piso são os mesmos que `calcularAtrasoHumano` usa, e o teto da conexão vale
 * quando é menor que o teto de bolha.
 */
describe("calcularDigitacaoDaBolha com os knobs da conexão", () => {
  it("a taxa por caractere é a da conexão", () => {
    expect(calcularDigitacaoDaBolha("b".repeat(100), { msPorCaractere: 40 })).toBe(100 * 40);
  });

  it("o piso é o da conexão — para cima e para baixo", () => {
    expect(calcularDigitacaoDaBolha("Ok!", { atrasoMinimoMs: 2500 })).toBe(2500);
    // Piso 0: a bolha curta espera só a digitação (o anti-ban continua por fora, no laço).
    expect(calcularDigitacaoDaBolha("Ok!", { atrasoMinimoMs: 0 })).toBe(3 * MS_POR_CARACTERE);
  });

  it("o teto da conexão vale quando é menor que o teto de bolha; maior, não o afrouxa", () => {
    expect(calcularDigitacaoDaBolha("x".repeat(2000), { atrasoMaximoMs: 3000 })).toBe(3000);
    expect(calcularDigitacaoDaBolha("x".repeat(2000), { atrasoMaximoMs: 20_000 })).toBe(
      ATRASO_ENTRE_BOLHAS_MAXIMO_MS,
    );
  });

  it("knob ausente (NULL na tabela) é o default — regressão zero", () => {
    const knobsVazios = {
      atrasoNotarMs: undefined,
      msPorCaractere: undefined,
      atrasoMinimoMs: undefined,
      atrasoMaximoMs: undefined,
    };
    for (const texto of ["Ok!", "b".repeat(187), "x".repeat(2000)]) {
      expect(calcularDigitacaoDaBolha(texto, knobsVazios)).toBe(calcularDigitacaoDaBolha(texto));
    }
  });

  it("criarPausaEntreBolhas leva os knobs até a conta de cada bolha", () => {
    const pausa = criarPausaEntreBolhas({ msPorCaractere: 30 });
    expect(pausa("b".repeat(100), 1500)).toBe(100 * 30);
  });
});

describe("criarPausaEntreBolhas", () => {
  it("é o MAIOR entre anti-ban e digitação, nunca a soma", () => {
    const pausa = criarPausaEntreBolhas();
    expect(pausa("b".repeat(187), 1500)).toBe(187 * MS_POR_CARACTERE);
    // Bolha curta: a digitação cabe dentro do anti-ban, que fica como está.
    expect(pausa("Ok!", 1700)).toBe(1700);
  });

  it("nunca devolve menos que o anti-ban, nem com o saldo do turno zerado", () => {
    const pausa = criarPausaEntreBolhas(undefined, 0);
    expect(pausa("x".repeat(400), 1900)).toBe(1900);
  });

  it("o saldo é do TURNO: dois send_message somam no mesmo teto", () => {
    const pausa = criarPausaEntreBolhas();
    const antiBan = 1200;
    let extra = 0;
    for (let i = 0; i < 10; i++) extra += pausa("x".repeat(300), antiBan) - antiBan;
    expect(extra).toBe(ATRASO_EXTRA_ENTRE_BOLHAS_POR_TURNO_MS);
  });
});

describe("sendInBubbles com a digitação da bolha seguinte", () => {
  it("o turno medido: a 2ª e a 3ª bolhas esperam o tempo de serem digitadas", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));

    await sendInBubbles(BOLHAS_DO_TURNO_MEDIDO.join("\n\n"), {
      enabled: true,
      maxChars: 600,
      send,
      sleep,
      jitter: () => 1500,
      entreBolhas: criarPausaEntreBolhas(),
    });

    expect(send).toHaveBeenCalledTimes(3);
    // Antes: [1500, 1500] — as três bolhas em ~3s. Agora: 187 e 84 caracteres
    // digitados, cada um no MAIOR entre o jitter e a digitação.
    expect(sleep.mock.calls).toEqual([[187 * MS_POR_CARACTERE], [84 * MS_POR_CARACTERE]]);
  });

  it("o que a resposta acrescenta ao anti-ban, somado, não passa do teto do turno", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const bolhas = Array.from({ length: 6 }, (_, i) => String(i).repeat(300));

    await sendInBubbles(bolhas.join("\n\n"), {
      enabled: true,
      maxChars: 600,
      send,
      sleep,
      jitter: () => 1200,
      entreBolhas: criarPausaEntreBolhas(),
    });

    const pausas = sleep.mock.calls.map(([ms]) => ms);
    expect(pausas).toHaveLength(5);
    for (const ms of pausas) expect(ms).toBeGreaterThanOrEqual(1200);
    const extra = pausas.reduce((s, ms) => s + (ms - 1200), 0);
    expect(extra).toBeLessThanOrEqual(ATRASO_EXTRA_ENTRE_BOLHAS_POR_TURNO_MS);
  });
});

describe("fiação em inbound-turn.ts", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("o send_message passa a digitação da bolha seguinte ao sendInBubbles", () => {
    const tool = FONTE.indexOf("send_message: tool({");
    expect(tool).toBeGreaterThan(-1);
    const chamada = FONTE.indexOf("sendInBubbles(texto, {", tool);
    expect(chamada).toBeGreaterThan(-1);
    const fim = FONTE.indexOf("}),", chamada);
    expect(FONTE.slice(chamada, fim)).toContain("entreBolhas: pausaEntreBolhas,");
  });

  it("o saldo é do TURNO — declarado no closure, nunca em escopo de módulo — e leva os knobs da conexão", () => {
    // Em módulo, o saldo de um cliente seria gasto pelo turno de outro. E sem os
    // knobs a conexão que configurou outro ritmo o perderia da 2ª bolha em diante.
    expect(FONTE).toMatch(/^ {2}const pausaEntreBolhas = criarPausaEntreBolhas\(knobsDeAtrasoHumano\);$/m);
    // Os MESMOS knobs que a 1ª bolha recebe em `esperarComoHumano`.
    expect(FONTE).toContain("knobs: knobsDeAtrasoHumano,");
    expect(FONTE.indexOf("const knobsDeAtrasoHumano = {")).toBeLessThan(
      FONTE.indexOf("const pausaEntreBolhas = criarPausaEntreBolhas("),
    );
  });
});
