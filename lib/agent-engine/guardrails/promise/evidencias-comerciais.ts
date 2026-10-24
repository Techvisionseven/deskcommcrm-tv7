/**
 * Evidências já consultadas pelo servidor NESTE turno. Não são uma lista de
 * exceções: o classificador continua lendo a candidata inteira e suas condições.
 * Não recebe histórico, notas do contato, prompt do agente ou argumentos de tool.
 *
 * `equipe` é a resposta que uma PESSOA da empresa deu a um pedido aberto NESTA
 * conversa (`agent_case_events`, `human_replied`). Sem ela, a equipe liberava o
 * horário da visita e o agente era vetado ao repassá-lo, porque nenhum material
 * diz "segunda às 19h para este cliente". Só a pessoa autoriza isso.
 */
export interface EvidenciaComercial {
  origem: "catalogo" | "conhecimento" | "equipe";
  referencia: string;
  titulo: string;
  conteudo: string;
}

import { canonizarTipoDeFonte, type TipoDeFonteId } from "@/lib/ai/rag/tipos-de-fonte";
import type { Queryable } from "../../queue/queue";

/**
 * Lista de PERMISSÃO, não de bloqueio: "Conversas anteriores" guarda o que o
 * CLIENTE escreveu, e um cliente não autoriza oferta. Tipo legado é canonizado
 * antes (`conversations` vira `conversas`), e tipo desconhecido fica de fora.
 */
const TIPOS_QUE_PROVAM_OFERTA: ReadonlySet<TipoDeFonteId> = new Set([
  "faq",
  "documento",
  "catalogo",
]);

export function fontesQueProvamOferta(
  fontes: readonly { id: string; source_type: string }[],
): string[] {
  return fontes
    .filter((f) => {
      const tipo = canonizarTipoDeFonte(f.source_type);
      return tipo !== null && TIPOS_QUE_PROVAM_OFERTA.has(tipo);
    })
    .map((f) => f.id);
}

/** Fontes do agente que podem provar oferta. Org da linha do job, nunca do modelo. */
export async function carregarFontesQueProvamOferta(
  db: Queryable,
  tenantId: string,
  fontesDoAgente: readonly string[],
): Promise<string[]> {
  if (fontesDoAgente.length === 0) return [];
  const { rows } = await db.query<{ id: string; source_type: string }>(
    "select id::text as id, source_type from ai_knowledge_sources where organization_id = $1 and id = any($2::uuid[])",
    [tenantId, fontesDoAgente],
  );
  return fontesQueProvamOferta(rows);
}

/** Uma resposta da equipe a um pedido desta conversa, como o banco a guardou. */
export interface RespostaDaEquipe {
  eventoId: string;
  pedidoId: string;
  tituloDoPedido: string;
  /** `resolved` (concluiu) ou `need_lead_info` (pediu algo ao cliente). */
  acao: string;
  texto: string;
  quando: string;
}

const MAX_RESPOSTAS_DA_EQUIPE = 5;
const JANELA_DAS_RESPOSTAS_DA_EQUIPE_DIAS = 30;

/**
 * As últimas respostas da equipe aos pedidos DESTA conversa. Org e conversa vêm
 * da linha do job, nunca do modelo. `escalate` fica de fora: ali a conversa
 * passou para uma pessoa, e o texto é para ela, não para o cliente.
 */
export async function carregarRespostasDaEquipe(
  db: Queryable,
  tenantId: string,
  conversationId: string,
): Promise<RespostaDaEquipe[]> {
  const { rows } = await db.query<{
    evento_id: string;
    pedido_id: string;
    titulo: string;
    acao: string;
    texto: string;
    quando: Date | string;
  }>(
    `select e.id::text as evento_id, c.id::text as pedido_id, c.title as titulo,
            e.human_action as acao, e.body as texto, e.created_at as quando
       from agent_case_events e
       join agent_cases c on c.id = e.case_id and c.organization_id = e.organization_id
      where e.organization_id = $1
        and c.conversation_id = $2
        and e.kind = 'human_replied'
        and e.actor_kind = 'human'
        and e.human_action in ('resolved', 'need_lead_info')
        and btrim(coalesce(e.body, '')) <> ''
        and e.created_at > now() - make_interval(days => $3)
      order by e.created_at desc
      limit $4`,
    [tenantId, conversationId, JANELA_DAS_RESPOSTAS_DA_EQUIPE_DIAS, MAX_RESPOSTAS_DA_EQUIPE],
  );
  return rows.map((r) => ({
    eventoId: r.evento_id,
    pedidoId: r.pedido_id,
    tituloDoPedido: r.titulo,
    acao: r.acao,
    texto: r.texto,
    quando: new Date(r.quando).toISOString(),
  }));
}

const MAX_EVIDENCIAS = 20;
const MAX_CARACTERES = 16_000;
const MAX_POR_EVIDENCIA = 4_000;
// O orçamento enviado ao revisor é menor que o acervo do turno. Um catálogo
// amplo não deve eliminar a política antes de sabermos o que será afirmado.
const MAX_ACERVO_POR_ORIGEM = 100;
const MAX_CARACTERES_POR_ORIGEM = 100_000;

function termos(value: string): Set<string> {
  return new Set(
    (
      value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .match(/[a-z0-9]+(?:[.,][0-9]+)?/g) ?? []
    )
      .filter((t) => t.length >= 2)
      .map((t) => t.replace(",", ".")),
  );
}

function objeto(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function criarEvidenciasComerciaisDoTurno(fontesHabilitadas: readonly string[]) {
  const fontes = new Set(fontesHabilitadas);
  const evidencias = new Map<string, EvidenciaComercial>();

  function guardar(evidencia: EvidenciaComercial) {
    const chave = `${evidencia.origem}:${evidencia.referencia}`;
    evidencias.delete(chave);
    // Nunca cortar uma frase: a ressalva no fim pode mudar toda a autorização.
    if (JSON.stringify(evidencia).length > MAX_POR_EVIDENCIA) return;
    evidencias.set(chave, evidencia);
    const daOrigem = () =>
      [...evidencias.entries()].filter(([, e]) => e.origem === evidencia.origem);
    while (
      daOrigem().length > MAX_ACERVO_POR_ORIGEM ||
      JSON.stringify(daOrigem().map(([, e]) => e)).length > MAX_CARACTERES_POR_ORIGEM
    ) {
      const primeira = daOrigem()[0]?.[0];
      if (primeira === undefined) break;
      evidencias.delete(primeira);
    }
  }

  function registrarConhecimento(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false) return;
    const trechos = r.results ?? r.trechos;
    if (!Array.isArray(trechos)) return;
    for (const item of trechos) {
      const t = objeto(item);
      if (!t) continue;
      const fonte = texto(t.knowledge_source_id);
      const id = texto(t.chunk_id);
      const conteudo = texto(t.content);
      // Nem outro agente, nem o índice legado sem fonte identificável autorizam
      // uma oferta aqui. A consulta original continua disponível ao Conversador.
      if (!fonte || !fontes.has(fonte) || !id || !conteudo) continue;
      guardar({
        origem: "conhecimento",
        referencia: `${fonte}:${id}`,
        titulo: texto(t.source_name) ?? "Material habilitado para o agente",
        conteudo,
      });
    }
  }

  /** Apenas retornos bem-sucedidos da busca de produtos ativos da organização. */
  function registrarCatalogo(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false || !Array.isArray(r.produtos)) return;
    for (const item of r.produtos) {
      const p = objeto(item);
      if (!p) continue;
      const codigo = texto(p.codigo);
      const nome = texto(p.nome);
      const descricao = texto(p.descricao);
      const preco = texto(p.preco);
      if (!codigo || !nome || !descricao || !preco || p.disponivel !== true) continue;
      guardar({
        origem: "catalogo",
        referencia: codigo,
        titulo: nome,
        conteudo: JSON.stringify({ nome, preco, descricao }),
      });
    }
  }

  /**
   * A resposta da equipe vale como evidência só com o texto que a pessoa
   * escreveu, o pedido a que respondeu e quando. O título diz o que ela é,
   * para o classificador não a confundir com política geral.
   */
  function registrarRespostaDaEquipe(resposta: RespostaDaEquipe) {
    const corpo = texto(resposta.texto);
    if (!corpo) return;
    const tipo =
      resposta.acao === "need_lead_info" ? "Pedido da equipe ao cliente" : "Resposta da equipe";
    guardar({
      origem: "equipe",
      referencia: `${resposta.pedidoId}:${resposta.eventoId}`,
      titulo: `${tipo} no pedido "${resposta.tituloDoPedido}" (${resposta.quando})`,
      conteudo: corpo,
    });
  }

  return {
    registrarConhecimento,
    registrarCatalogo,
    registrarRespostaDaEquipe,
    // Relevância escolhe o CONTEXTO, nunca concede autorização. O classificador
    // recebe os trechos completos, inclusive condições/negações, e decide.
    ler: (candidata = ""): EvidenciaComercial[] => {
      const consulta = termos(candidata);
      const acervo = [...evidencias.values()].map((e, ordem) => ({
        e,
        ordem,
        palavras: termos(`${e.titulo} ${e.conteudo}`),
      }));
      const frequencias = new Map<string, number>();
      for (const { palavras } of acervo)
        for (const palavra of palavras)
          frequencias.set(palavra, (frequencias.get(palavra) ?? 0) + 1);
      const ordenadas = acervo
        .map((item) => ({
          ...item,
          pontos: [...consulta].reduce(
            (n, t) => n + (item.palavras.has(t) ? 1 / (frequencias.get(t) ?? 1) : 0),
            0,
          ),
        }))
        .sort((a, b) => b.pontos - a.pontos || b.ordem - a.ordem);
      const escolhidas: EvidenciaComercial[] = [];
      const usadas = new Set<EvidenciaComercial>();
      function adicionar(e: EvidenciaComercial) {
        if (usadas.has(e) || escolhidas.length >= MAX_EVIDENCIAS) return;
        if (JSON.stringify([...escolhidas, e]).length > MAX_CARACTERES) return;
        escolhidas.push(e);
        usadas.add(e);
      }
      // Reserva mínima para cada origem: política e produto complementam-se.
      // O restante segue a relevância global, sem duplicar ou truncar itens.
      // A equipe vem primeiro: é a única que decide algo para ESTE cliente.
      for (let i = 0; i < 3; i++)
        for (const origem of ["equipe", "conhecimento", "catalogo"] as const) {
          const item = ordenadas.filter(({ e }) => e.origem === origem)[i];
          if (item) adicionar(item.e);
        }
      for (const { e } of ordenadas) adicionar(e);
      return escolhidas.map((e) => ({ ...e }));
    },
    // Inclui também itens fora do pacote selecionado: uma consulta pode mudar
    // qual item é pertinente à mesma candidata. Usado só no memo do turno.
    contexto: (): string => JSON.stringify([...evidencias.values()]),
  };
}
