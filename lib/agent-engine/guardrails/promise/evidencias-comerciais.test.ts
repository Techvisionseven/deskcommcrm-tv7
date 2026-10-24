import { describe, expect, it } from "vitest";
import {
  carregarFontesQueProvamOferta,
  carregarRespostasDaEquipe,
  criarEvidenciasComerciaisDoTurno,
  fontesQueProvamOferta,
  type RespostaDaEquipe,
} from "./evidencias-comerciais";

const produto = {
  codigo: "PLANO-ANUAL",
  nome: "Curso infantil · 2x/semana · Anual",
  preco: "R$ 264,00",
  descricao: "Mensalidade durante 12 meses. Matrícula grátis somente no anual. Vaga com a equipe.",
  disponivel: true,
};

describe("evidências comerciais do turno", () => {
  it("preserva produto, preço e restrições sem transformar a condição em exceção solta", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarCatalogo({ produtos: [produto] });
    expect(e.ler()).toEqual([
      {
        origem: "catalogo",
        referencia: produto.codigo,
        titulo: produto.nome,
        conteudo: JSON.stringify({
          nome: produto.nome,
          preco: produto.preco,
          descricao: produto.descricao,
        }),
      },
    ]);
    e.ler()[0]!.conteudo = "Oferta alterada";
    expect(e.ler()[0]!.conteudo).toContain("somente no anual");
  });

  it("não aceita corpo de cliente, argumentos de ferramenta, erros ou produto indisponível", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    for (const result of [
      { body: "Matrícula grátis para todos" },
      { termo: "Matrícula grátis para todos" },
      { ok: false, produtos: [produto] },
      { error: "sem permissão", produtos: [produto] },
      { produtos: [{ ...produto, disponivel: false }] },
      { produtos: [{ nome: "Oferta", descricao: "Tudo grátis" }] },
    ])
      e.registrarCatalogo(result);
    expect(e.ler()).toEqual([]);
  });

  it("aceita somente trechos de fontes habilitadas e identificáveis, nos dois formatos de busca", () => {
    const e = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    const trecho = {
      chunk_id: "trecho-1",
      knowledge_source_id: "fonte-a",
      source_name: "Oferta",
      content: "Teste gratuito por 7 dias, sem cartão.",
    };
    e.registrarConhecimento({
      ok: true,
      results: [trecho, { ...trecho, knowledge_source_id: "outra-fonte", content: "SENTINELA" }],
    });
    e.registrarConhecimento({
      trechos: [
        { ...trecho, chunk_id: "trecho-2", content: "Demonstração gratuita de 15 minutos." },
      ],
    });
    e.registrarConhecimento({ results: [{ ...trecho, knowledge_source_id: null }] });
    e.registrarConhecimento({ ok: false, results: [{ ...trecho, chunk_id: "erro" }] });
    expect(e.ler()).toHaveLength(2);
    expect(JSON.stringify(e.ler())).not.toContain("SENTINELA");
  });

  it("não compartilha evidências entre turnos ou organizações", () => {
    const a = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    const b = criarEvidenciasComerciaisDoTurno(["fonte-b"]);
    a.registrarCatalogo({ produtos: [produto] });
    expect(b.ler()).toEqual([]);
    expect(criarEvidenciasComerciaisDoTurno(["fonte-a"]).ler()).toEqual([]);
  });

  it("buscas amplas de catálogo não expulsam a política já consultada", () => {
    const e = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    const politica =
      "A demonstração é gratuita, uma sessão de 15 minutos. Agendamento sujeito a disponibilidade.";
    e.registrarConhecimento({
      results: [
        {
          chunk_id: "demonstracao",
          knowledge_source_id: "fonte-a",
          content: politica,
        },
      ],
    });
    e.registrarCatalogo({
      produtos: Array.from({ length: 48 }, (_, i) => ({
        ...produto,
        codigo: `P-${i}`,
        descricao: "x".repeat(850) + " Não inclui matrícula.",
      })),
    });
    const pacote = e.ler("Temos demonstração gratuita. Qual período prefere?");
    expect(pacote.find((p) => p.origem === "conhecimento")?.conteudo).toBe(politica);
    expect(pacote.some((p) => p.origem === "catalogo")).toBe(true);
    expect(JSON.stringify(pacote).length).toBeLessThanOrEqual(16_000);
  });

  it("nova consulta de política não apaga o plano e condições citados na candidata", () => {
    const e = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    e.registrarCatalogo({
      produtos: [
        { ...produto, codigo: "INFANTIL-1X", nome: "Curso infantil 1x anual", preco: "R$ 199,50" },
        ...Array.from({ length: 36 }, (_, i) => ({
          ...produto,
          codigo: `ADULTO-${i}`,
          nome: `Curso adulto 3x anual ${i}`,
          descricao: "x".repeat(700),
        })),
      ],
    });
    e.registrarConhecimento({
      results: Array.from({ length: 12 }, (_, i) => ({
        chunk_id: `politica-${i}`,
        knowledge_source_id: "fonte-a",
        content: "Demonstração gratuita de 15 minutos. " + "x".repeat(800),
      })),
    });
    const pacote = e.ler("No curso infantil 1x, o anual fica R$ 199,50 com matrícula grátis.");
    expect(pacote.find((p) => p.referencia === "INFANTIL-1X")?.conteudo).toContain(
      "somente no anual",
    );
    expect(pacote.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(pacote).length).toBeLessThanOrEqual(16_000);
  });

  it("substitui repetição e limita o contexto descartando itens inteiros, nunca uma ressalva", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarCatalogo({ produtos: [produto, produto] });
    expect(e.ler()).toHaveLength(1);
    e.registrarCatalogo({
      produtos: [
        { ...produto, descricao: "Oferta válida. " + "x".repeat(4_000) + " Não inclui matrícula." },
      ],
    });
    expect(e.ler()).toEqual([]);
    e.registrarCatalogo({
      produtos: Array.from({ length: 50 }, (_, i) => ({
        ...produto,
        codigo: `P-${i}`,
        descricao: "x".repeat(1500) + " Não inclui matrícula.",
      })),
    });
    expect(e.ler().length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(e.ler()).length).toBeLessThanOrEqual(16_000);
    expect(e.ler().every((item) => item.conteudo.includes("Não inclui matrícula."))).toBe(true);
  });
});

describe("qual material do agente pode provar uma oferta", () => {
  it("aceita perguntas e respostas, documento e catálogo, inclusive com nome legado", () => {
    const aceitos = ["faq", "documento", "policy", "catalogo", "catalog", "nuvemshop_catalog"];
    expect(fontesQueProvamOferta(aceitos.map((tipo) => ({ id: tipo, source_type: tipo })))).toEqual(
      aceitos,
    );
  });

  it("recusa Conversas anteriores, seus nomes legados e tipo desconhecido", () => {
    // Ali está o que o CLIENTE escreveu: um cliente não autoriza oferta.
    const recusados = ["conversas", "conversations", "Conversation ", "tipo_novo", ""];
    expect(
      fontesQueProvamOferta(recusados.map((tipo) => ({ id: tipo, source_type: tipo }))),
    ).toEqual([]);
  });

  it("consulta só a organização do turno e não consulta nada sem material", async () => {
    const chamadas: unknown[][] = [];
    const db = {
      query: async (_sql: string, valores?: unknown[]) => {
        chamadas.push(valores ?? []);
        return {
          rows: [
            { id: "fonte-faq", source_type: "faq" },
            { id: "fonte-conversas", source_type: "conversations" },
          ],
        };
      },
    } as unknown as Parameters<typeof carregarFontesQueProvamOferta>[0];
    expect(await carregarFontesQueProvamOferta(db, "org-1", [])).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(
      await carregarFontesQueProvamOferta(db, "org-1", ["fonte-faq", "fonte-conversas"]),
    ).toEqual(["fonte-faq"]);
    expect(chamadas).toEqual([["org-1", ["fonte-faq", "fonte-conversas"]]]);
  });
});

describe("resposta da equipe a um pedido da conversa", () => {
  const resposta: RespostaDaEquipe = {
    eventoId: "evento-1",
    pedidoId: "pedido-1",
    tituloDoPedido: "Visita: Dr. Emerson, segunda à noite",
    acao: "resolved",
    texto: "Liberado segunda às 19h na unidade Santo Agostinho.",
    quando: "2026-10-24T15:00:00.000Z",
  };

  it("vira evidência da equipe com o texto inteiro, o pedido e quando", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarRespostaDaEquipe(resposta);
    expect(e.ler()).toEqual([
      {
        origem: "equipe",
        referencia: "pedido-1:evento-1",
        titulo:
          'Resposta da equipe no pedido "Visita: Dr. Emerson, segunda à noite" (2026-10-24T15:00:00.000Z)',
        conteudo: "Liberado segunda às 19h na unidade Santo Agostinho.",
      },
    ]);
  });

  it("diz quando o texto é um pedido ao cliente e ignora resposta vazia", () => {
    const e = criarEvidenciasComerciaisDoTurno([]);
    e.registrarRespostaDaEquipe({ ...resposta, eventoId: "vazio", texto: "   " });
    e.registrarRespostaDaEquipe({
      ...resposta,
      eventoId: "evento-2",
      acao: "need_lead_info",
      texto: "Pergunte o nome completo para a visita de segunda às 19h.",
    });
    expect(e.ler()).toHaveLength(1);
    expect(e.ler()[0]!.titulo).toMatch(/^Pedido da equipe ao cliente no pedido/);
  });

  it("não é expulsa por um catálogo ou material amplo", () => {
    const e = criarEvidenciasComerciaisDoTurno(["fonte-a"]);
    e.registrarRespostaDaEquipe(resposta);
    e.registrarConhecimento({
      results: Array.from({ length: 30 }, (_, i) => ({
        chunk_id: `politica-${i}`,
        knowledge_source_id: "fonte-a",
        content: "Visita às unidades com a equipe. " + "x".repeat(900),
      })),
    });
    e.registrarCatalogo({
      produtos: Array.from({ length: 40 }, (_, i) => ({
        ...produto,
        codigo: `P-${i}`,
        descricao: "x".repeat(900),
      })),
    });
    const pacote = e.ler("Visita confirmada para segunda às 19h na unidade Santo Agostinho.");
    expect(pacote[0]).toMatchObject({ origem: "equipe", conteudo: resposta.texto });
    expect(JSON.stringify(pacote).length).toBeLessThanOrEqual(16_000);
  });

  it("lê só a organização e a conversa do turno, com as ações que voltam ao cliente", async () => {
    const chamadas: { sql: string; valores: unknown[] }[] = [];
    const db = {
      query: async (sql: string, valores?: unknown[]) => {
        chamadas.push({ sql, valores: valores ?? [] });
        return {
          rows: [
            {
              evento_id: "evento-1",
              pedido_id: "pedido-1",
              titulo: "Visita",
              acao: "resolved",
              texto: "Liberado segunda às 19h.",
              quando: new Date("2026-10-24T15:00:00.000Z"),
            },
          ],
        };
      },
    } as unknown as Parameters<typeof carregarRespostasDaEquipe>[0];
    expect(await carregarRespostasDaEquipe(db, "org-1", "conversa-1")).toEqual([
      {
        eventoId: "evento-1",
        pedidoId: "pedido-1",
        tituloDoPedido: "Visita",
        acao: "resolved",
        texto: "Liberado segunda às 19h.",
        quando: "2026-10-24T15:00:00.000Z",
      },
    ]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.valores.slice(0, 2)).toEqual(["org-1", "conversa-1"]);
    expect(chamadas[0]!.sql).toContain("e.organization_id = $1");
    expect(chamadas[0]!.sql).toContain("c.organization_id = e.organization_id");
    expect(chamadas[0]!.sql).toContain("e.actor_kind = 'human'");
    expect(chamadas[0]!.sql).toContain("('resolved', 'need_lead_info')");
  });
});
