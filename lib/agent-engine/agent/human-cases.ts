import { currentExecutionBoundary, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import { TIPOS_DE_CASO, type TipoDeCaso } from "@/lib/ai/case-copy";
/**
 * Casos humanos (spec 15) — o loop assíncrono IA↔humano quando o agente esbarra
 * num bloqueio que só um humano resolve (aprovar desconto, confirmar política,
 * decidir algo fora do playbook). Duas tools nativas do engine:
 *   - open_human_case: o agente abre um caso (status='awaiting_human') com o
 *     bloqueio explicado — vira item na inbox humana (wiring da Wave 3+).
 *   - provide_case_update: quando o caso está 'awaiting_lead' (humano pediu algo
 *     ao lead) e o lead responde, o agente repassa a info e o caso volta a
 *     'awaiting_human'.
 * As transições disparadas pela RESPOSTA do humano (resolver/pedir info ao
 * lead/escalar) são chamadas pela rota API da Wave 5 — aqui só a mecânica de
 * estado, sempre idempotente.
 *
 * Disciplina (mesma dos irmãos schedule-followup/human-handoff): ids SEMPRE do
 * closure/args confiáveis, nunca do payload do modelo; toda transição é UPDATE
 * condicional (WHERE status = <precondição>) que nunca pisa em estado terminal;
 * UPDATE + INSERT do(s) evento(s) na MESMA transação — aqui via um único
 * statement (WITH ... INSERT ... SELECT FROM <cte>), que é atômico por natureza
 * e dispensa BEGIN/COMMIT explícito, então funciona tanto com pg.Pool quanto
 * com pg.PoolClient (Queryable).
 *
 * `agent_cases.lead_id` é FK para `crm_leads` (o lead do pipeline do CRM) — uma
 * entidade DIFERENTE do `contact_id`/`leadId` usado no resto do agent-engine (ver
 * draft-reply.ts). O espelho de estágio (mirrorLeadStageToCrm) já resolve o
 * negócio do contato para MOVER o card, mas nada aqui lê esse id, então
 * `agent_cases.lead_id` fica NULL sempre — o caso ancora em `conversation_id`
 * (CaseIds não carrega o contact_id: nada aqui o lê).
 */
import { z } from 'zod';
import type pg from 'pg';

import type { Queryable } from '../queue/queue';

export interface CaseIds {
  tenantId: string;
  conversationId: string;
  agentId?: string | null;
}

/**
 * O vocabulário de `agent_case_events.kind`, do lado do TypeScript.
 *
 * Existe para ser comparado com o CHECK do banco em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` — é a única classe de
 * divergência que o compilador não enxerga, e o sintoma seria um `23514` num
 * INSERT de caminho pouco exercitado (o registro do agente no chamado é
 * exatamente um desses).
 */
export type CaseEventKind =
  | 'opened'
  | 'human_replied'
  | 'lead_asked'
  | 'lead_provided'
  | 'lead_unresponsive'
  | 'resolved'
  | 'escalated'
  | 'cancelled'
  | 'agent_noted'
  // (migration 0292) A equipe foi avisada no WhatsApp de que este caso abriu.
  // Escrito pelo handler do aviso DEPOIS do envio, com `actor_kind='system'`.
  | 'alert_sent';

/**
 * A tupla que o `z.enum` exige, derivada de `TIPOS_DE_CASO` — a fonte única do
 * vocabulário. Escrever a lista de novo aqui criaria a segunda cópia, e é assim
 * que o seletor da tela e o que a IA pode escolher divergem.
 */
const TIPOS_DE_CASO_KEYS = Object.keys(TIPOS_DE_CASO) as [TipoDeCaso, ...TipoDeCaso[]];

/** Whitelist EXATA do payload de open_human_case — mesmo padrão .strict() da F2-10/F3-02. */
export const openHumanCaseInputSchema = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4_000),
  blocker: z.string().min(1).max(1_000),
  /**
   * Do que o caso trata. OPCIONAL e com default: um modelo antigo, um clone com
   * prompt diferente ou o fail-safe do guardrail continuam abrindo caso sem ele,
   * e o caso cai em `outro` em vez de ser recusado. Classificação é conveniência
   * de triagem — nunca pode ser motivo para o pedido do cliente não chegar.
   */
  kind: z.enum(TIPOS_DE_CASO_KEYS).optional(),
});
export type OpenHumanCaseInput = z.infer<typeof openHumanCaseInputSchema>;

/** Whitelist EXATA do payload de provide_case_update. */
export const provideCaseUpdateInputSchema = z.strictObject({
  case_id: z.string().uuid(),
  info: z.string().min(1).max(4_000),
});
export type ProvideCaseUpdateInput = z.infer<typeof provideCaseUpdateInputSchema>;

const OPEN_STATUSES = ['awaiting_human', 'awaiting_lead'] as const;

/**
 * True se há um caso 'awaiting_human'|'awaiting_lead' aberto para a conversa.
 * Checa UMA conversa (conversation_id), não o contato inteiro — um contato pode
 * ter >1 conversa por channel_session; o caso pertence a uma conversa.
 */
export async function hasOpenCaseForContact(
  db: Queryable,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ open: boolean }>(
    `select exists (
       select 1 from agent_cases
        where organization_id = $1 and conversation_id = $2
          and status = any($3::text[])
     ) as open`,
    [tenantId, conversationId, OPEN_STATUSES],
  );
  return rows[0]?.open === true;
}

export interface CaseAwaitingLead {
  id: string;
  /** O que o HUMANO pediu ao lead (body do evento need_lead_info mais recente) —
   * NÃO `agent_cases.blocker` (motivo original da IA travar; `markAwaitingLead`
   * nunca o atualiza — usá-lo aqui daria ao modelo a pergunta ERRADA). */
  ask: string;
}

/**
 * O caso 'awaiting_lead' da conversa (humano pediu algo ao lead), se houver.
 * Usado no turno normal (inbound_turn) para dar ao modelo o `case_id` real que
 * `provide_case_update` exige — sem isso o modelo nunca tem como chamar a tool
 * quando o lead simplesmente responde a mensagem (o caminho comum; case_reply_turn
 * só cobre a ação do HUMANO, não a resposta do lead). No máximo 1 por conversa
 * (mesma garantia de `openCase`/dedup).
 */
export async function getCaseAwaitingLead(
  db: Queryable,
  tenantId: string,
  conversationId: string,
): Promise<CaseAwaitingLead | null> {
  const { rows } = await db.query<CaseAwaitingLead>(
    `select c.id, e.body as ask
       from agent_cases c
       join lateral (
         select body from agent_case_events
          where case_id = c.id and kind = 'human_replied' and human_action = 'need_lead_info'
          order by created_at desc
          limit 1
       ) e on true
      where c.organization_id = $1 and c.conversation_id = $2 and c.status = 'awaiting_lead'
      limit 1`,
    [tenantId, conversationId],
  );
  return rows[0] ?? null;
}

export type OpenCaseResult =
  | { ok: true; caseId: string }
  | { ok: false; error: { code: string; message: string } };

/** O caso aberto que a recusa devolve ao modelo, para ele acrescentar em vez de abrir outro. */
export interface CasoAbertoNaRecusa {
  id: string;
  title: string;
  summary: string;
  blocker: string;
}

/**
 * A FRASE AO CLIENTE quando o pedido novo cai num caso que JÁ está aberto (#3097).
 *
 * Ela existe porque a alternativa era a IA improvisar — e o que ela improvisava
 * era "já registrei com a equipe"/"a equipe foi acionada", que é FALSO neste
 * caminho. Medido no relato do defeito: `agent_noted` não gera `alert_sent` e
 * não nasce linha em `entregas_de_aviso_de_caso` — a única superfície desta
 * feature que avisa alguém. O cliente ficava esperando quem nunca foi chamado.
 *
 * A frase diz só o que é verdade em QUALQUER caso: o pedido foi anotado na
 * conversa. Ela não afirma o registro no caso aberto, porque o agente só consegue
 * registrar quando tem a ferramenta `crm_add_case_note`; sem ela, a frase ainda
 * seria verdadeira. Também não promete aviso novo, prazo, nem que uma pessoa vai
 * responder por causa dele.
 */
export const FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO =
  'anotei seu pedido aqui na nossa conversa; por enquanto não consigo te dar um prazo.';

/**
 * A RECUSA da guarda de caso aberto — com a instrução que impede a promessa.
 *
 * ## Por que INSTRUÇÃO, e não reenvio do aviso (issue #3097)
 *
 * O autor aceitava as duas saídas. O reenvio do aviso à equipe (opção a) esbarra
 * no MESMO controle de repetição do aviso inicial — a `unique (organization_id,
 * case_id, destino)` de `entregas_de_aviso_de_caso` (migration 0292, replicada
 * aqui no `reivindicaEntrega` de `lib/escalacao/aviso-ao-suporte.ts`). Com a
 * entrega do caso já `enviado`, o reenvio cai em `ja_resolvido:enviado`: nenhuma
 * linha nasce e ninguém é avisado justamente no cenário do relato. Fazer o
 * segundo pedido avisar exigiria OUTRA chave de entrega — coluna nova, decisão
 * do mantenedor, e o próprio goal manda preferir a instrução nesse caso.
 *
 * ## O que a instrução faz
 *
 * Devolve ao agente a verdade do caminho (`ninguém foi avisado agora`), proíbe a
 * promessa que o relato flagrou ("a equipe foi acionada", "já registrei para a
 * equipe", prazo, "alguém vai responder") e entrega a frase que o cliente PODE
 * ouvir — para a mensagem ao cliente mudar junto, sem depender de o modelo
 * adivinhar o que é honesto dizer.
 *
 * O registro do pedido novo no caso aberto é o destino certo quando o agente tem
 * a ferramenta `crm_add_case_note`: a nota entra na linha do tempo que quem
 * continuar o caso vai ler. Neste fork a recusa traz o `case_id` e o texto atual
 * do caso aberto, para a nota reescrever o resumo e o bloqueio sem perder o que
 * segue pendente (e a ferramenta reavisa a Central). A única ferramenta nativa
 * que recebe o caso (`provide_case_update`, no caso `awaiting_lead`) trataria o
 * pedido novo como a resposta que o caso esperava; por isso a instrução veta esse
 * uso. O registro é condicional, e a frase ao cliente só afirma o registro se ele
 * aconteceu. O que não pode é o cliente ouvir que alguém foi ACIONADO.
 *
 * Pura e exportada de propósito: é o texto exato que o modelo lê no resultado da
 * tool `open_human_case` (o caminho `if (!res.ok) return res`), e é ele que o
 * teste de `aviso-de-pedido-novo-no-caso.test.ts` prende.
 */
export function recusaDeCasoAberto(aberto?: CasoAbertoNaRecusa): OpenCaseResult {
  return {
    ok: false,
    error: {
      code: 'case_already_open',
      message:
        'já existe um caso humano aberto para esta conversa' +
        (aberto
          ? ` (case_id: ${aberto.id}) e só cabe um. Hoje ele diz — título: "${aberto.title}"; ` +
            `o que o cliente precisa: "${aberto.summary}"; por que a IA travou: "${aberto.blocker}". Não abra outro`
          : '') +
        ': a equipe NÃO foi avisada deste pedido novo, e ' +
        'nada novo saiu para ninguém agora. NÃO diga ao cliente que a equipe foi acionada, avisada ou que o ' +
        'pedido foi encaminhado, e não prometa prazo nem que alguém vai responder por causa dele. Se você ' +
        'tiver a ferramenta crm_add_case_note, registre o pedido novo no caso aberto (a nota entra na linha do ' +
        'tempo que quem continuar o caso vai ler)' +
        (aberto
          ? ': chame-a com esse case_id, a nota do que é novo e `summary`/`blocker` reescritos com o quadro atual — ' +
            'o pedido novo JUNTO com o que continua pendente do anterior. '
          : '. ') +
        'NÃO use provide_case_update para isso: ela é só para a ' +
        'informação que o caso pediu ao cliente. Só diga ao cliente que o pedido ficou registrado no caso se ' +
        'você registrou de fato. Responda ao cliente apenas neste espírito: ' +
        `"${FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO}" Aguarde a resposta do atendente antes de abrir outro caso.`,
    },
  };
}

/**
 * Abre o caso: INSERT agent_cases(status='awaiting_human') + INSERT
 * agent_case_events(kind='opened') em UM statement atômico. A guarda de dedup
 * (não abrir 2º caso pra mesma conversa) mora no `where not exists` do próprio
 * INSERT — sem essa condição haveria corrida entre a checagem e a escrita;
 * aqui checagem e escrita são a MESMA operação. Essa atomicidade check-and-write
 * vale DENTRO do statement; a garantia de não-duplicação entre transações
 * CONCORRENTES vem da serialização per-contact do job_queue
 * (uniq_job_queue_one_running_per_contact), não deste statement sozinho.
 */
export async function openCase(
  db: pg.Pool,
  ids: CaseIds,
  input: {
    title: string;
    summary: string;
    blocker: string;
    contextSnapshot?: Record<string, unknown>;
    source?: 'agent' | 'guardrail_autofallback';
    kind?: string;
  },
): Promise<OpenCaseResult> {
  await guardServiceEffect();
  const source = input.source ?? 'agent';
  const actorKind = source === 'agent' ? 'agent' : 'system';

  const { rows } = await db.query<{ case_id: string }>(
    `with new_case as (
       insert into agent_cases
         (organization_id, conversation_id, agent_id, title, summary, blocker, context_snapshot, source, kind)
       select $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $11
        where not exists (
          select 1 from agent_cases
           where organization_id = $1 and conversation_id = $2
             and status = any($9::text[])
        )
       returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind)
     select $1, id, 'opened', $10
       from new_case
     returning case_id`,
    [
      ids.tenantId,
      ids.conversationId,
      ids.agentId ?? null,
      input.title,
      input.summary,
      input.blocker,
      JSON.stringify({ ...(input.contextSnapshot ?? {}), ...(currentExecutionBoundary() ? { service_boundary: currentExecutionBoundary() } : {}) }),
      source,
      OPEN_STATUSES,
      actorKind,
      // O default mora aqui e no banco: se um caminho novo esquecer de passar, a
      // linha nasce classificada como 'outro' em vez de nula.
      input.kind ?? 'outro',
    ],
  );

  const caseId = rows[0]?.case_id;
  if (caseId === undefined) {
    // A recusa é uma INSTRUÇÃO (não só um erro): é o texto que o modelo lê no
    // resultado da tool, e é ele que impede a promessa de que a equipe foi
    // acionada quando ninguém foi avisado (#3097).
    //
    // Só cabe um caso aberto por conversa, e o pedido NOVO do cliente (a visita
    // pedida com o caso da proposta aberto) entra nele pela crm_add_case_note —
    // para isso o modelo precisa do id do caso E do texto atual: sem o texto, o
    // resumo reescrito descrevia só o pedido novo e apagava do topo o que o
    // anterior ainda esperava da equipe (medido com o Haiku na conversa de 26/10:
    // 5 de 7 reescritas perderam a proposta pendente).
    const { rows: abertos } = await db.query<CasoAbertoNaRecusa>(
      `select id, title, summary, blocker from agent_cases
        where organization_id = $1 and conversation_id = $2 and status = any($3::text[])
        order by created_at desc
        limit 1`,
      [ids.tenantId, ids.conversationId, OPEN_STATUSES],
    );
    return recusaDeCasoAberto(abertos[0]);
  }
  return { ok: true, caseId };
}

export type ProvideCaseUpdateResult = { ok: true } | { ok: false; error: { code: string; message: string } };

/**
 * awaiting_lead -> awaiting_human (o lead respondeu o que o humano pediu) +
 * evento 'lead_provided' (actor_kind='lead' — a info veio do lead, não do
 * agente nem do humano). De qualquer outro estado é no-op: {ok:false,
 * error.code:'invalid_case_state'}.
 *
 * O caso tem de ser DA CONVERSA do turno (`ids.conversationId`): o `case_id`
 * vem do modelo, e caso de outra conversa cai na mesma resposta de estado
 * errado — sem alterar nada e sem distinguir os dois.
 */
export async function provideCaseUpdate(
  db: pg.Pool,
  ids: CaseIds,
  input: { caseId: string; info: string },
): Promise<ProvideCaseUpdateResult> {
  const { rows } = await db.query<{ case_id: string }>(
    `with updated as (
       update agent_cases
          set status = 'awaiting_human', updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_lead'
          and conversation_id = $4
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1, id, 'lead_provided', 'lead', $3
       from updated
     returning case_id`,
    [ids.tenantId, input.caseId, input.info, ids.conversationId],
  );

  if (rows.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_case_state',
        message: 'o caso não está aguardando informação do lead (awaiting_lead); nada foi alterado.',
      },
    };
  }
  return { ok: true };
}

/**
 * As transições abaixo guardam o estado de entrada no próprio `where`, então o
 * statement insere os 2 eventos APENAS quando o update casou. `rowCount` é o
 * número de eventos inseridos: 0 = a corrida foi perdida (outro atendente já
 * respondeu) e nada mudou. Quem chama precisa saber disso para não reportar
 * sucesso de um no-op — daí o boolean em vez de void.
 */
function transitioned(rowCount: number | null): boolean {
  return (rowCount ?? 0) > 0;
}

/**
 * awaiting_human -> resolved (closed_at=now). Dois eventos no mesmo statement:
 * 'human_replied' (human_action='resolved', o registro da AÇÃO do humano) e
 * 'resolved' (o registro da transição do CASO). De qualquer outro estado é
 * no-op — nunca pisa em caso já resolvido/escalado/cancelado.
 */
export async function resolveCaseFromHuman(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  note: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'resolved', closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'resolved', $4::text from updated
     union all
     select $1::uuid, id, 'resolved', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, note],
  );
  return transitioned(rowCount);
}

/**
 * awaiting_human -> awaiting_lead (o humano precisa de mais info do lead).
 * Eventos: 'human_replied' (human_action='need_lead_info') + 'lead_asked'.
 */
export async function markAwaitingLead(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  ask: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'awaiting_lead', updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'need_lead_info', $4::text from updated
     union all
     select $1::uuid, id, 'lead_asked', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, ask],
  );
  return transitioned(rowCount);
}

/**
 * awaiting_human -> escalated (closed_at=now). Eventos: 'human_replied'
 * (human_action='escalate') + 'escalated'. O handoff humano em si (force_human
 * etc.) é acionado pela ROTA (Wave 5), não aqui — este só fecha o caso.
 */
export async function escalateCase(
  db: Queryable,
  tenantId: string,
  caseId: string,
  actorUserId: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = 'escalated', closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = 'awaiting_human'
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, actor_user_id, human_action, body)
     select $1::uuid, id, 'human_replied', 'human', $3::uuid, 'escalate', $4::text from updated
     union all
     select $1::uuid, id, 'escalated', 'human', $3::uuid, null::text, null::text from updated`,
    [tenantId, caseId, actorUserId, reason],
  );
  return transitioned(rowCount);
}

/**
 * O que a nota pode reescrever no topo do chamado. Campo ausente fica como está.
 */
export interface AtualizacaoDoChamado {
  title?: string;
  summary?: string;
  blocker?: string;
}

/**
 * O AGENTE registrando o que aconteceu num chamado ABERTO — e, quando o pedido
 * mudou, reescrevendo o topo dele.
 *
 * Ator `agent` e kind `agent_noted` (0100) porque a alternativa seria reusar
 * 'lead_provided'/'human_replied' — e aí a linha do tempo do chamado diria que
 * quem falou foi o lead ou a pessoa. Timeline que mente sobre o autor é pior que
 * timeline curta: ela é OBEDECIDA.
 *
 * Título, resumo e bloqueio eram escritos uma vez, na abertura. Como só cabe um
 * chamado aberto por conversa (`openCase`), o pedido novo do cliente entrava como
 * nota e o topo seguia descrevendo o pedido antigo — medido numa conversa real: a
 * visita pedida às 12:28 ficou abaixo de um resumo das 10:43 que ainda dizia
 * "falta decidir entre visita ou contratação". Agora a nota pode trazer a versão
 * atual de cada campo. O que ela substitui não se perde: vai para o `metadata`
 * do próprio evento (`anterior`), que a anonimização da LGPD zera junto com o
 * corpo (0280).
 *
 * A guarda de estado mora no `where` do próprio statement (mesma disciplina do
 * `openCase`): registrar em chamado já fechado seria escrever história depois do
 * fato, e checar antes num statement separado abriria corrida entre a checagem e
 * a escrita.
 *
 * @returns false quando o chamado não existe, é de outra organização ou já fechou.
 */
export async function registrarNotaDoAgente(
  db: Queryable,
  tenantId: string,
  caseId: string,
  body: string,
  atualizacao: AtualizacaoDoChamado = {},
): Promise<boolean> {
  const title = atualizacao.title?.trim() || null;
  const summary = atualizacao.summary?.trim() || null;
  const blocker = atualizacao.blocker?.trim() || null;
  const { rowCount } = await db.query(
    `with antes as (
       select c.id, c.title, c.summary, c.blocker
         from agent_cases c
        where c.organization_id = $1 and c.id = $2 and c.status = any($4::text[])
        for update
     ), topo as (
       update agent_cases c
          set title = coalesce($5::text, c.title),
              summary = coalesce($6::text, c.summary),
              blocker = coalesce($7::text, c.blocker),
              updated_at = now()
         from antes a
        where c.id = a.id
          and ($5::text is not null or $6::text is not null or $7::text is not null)
       returning c.id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body, metadata)
     select $1::uuid, a.id, 'agent_noted', 'agent', $3::text,
            case when $5::text is null and $6::text is null and $7::text is null then '{}'::jsonb
                 else jsonb_build_object('anterior', jsonb_strip_nulls(jsonb_build_object(
                   'title', case when $5::text is not null then a.title end,
                   'summary', case when $6::text is not null then a.summary end,
                   'blocker', case when $7::text is not null then a.blocker end)))
            end
       from antes a`,
    [tenantId, caseId, body, OPEN_STATUSES, title, summary, blocker],
  );
  return transitioned(rowCount);
}

/**
 * Quanto tempo um aviso da Central que a equipe AINDA NÃO VIU segura a próxima
 * novidade do mesmo caso. O Operador registra nota a cada turno; sem esta janela,
 * uma conversa movimentada mandaria um push por mensagem do cliente.
 */
export const JANELA_DO_REAVISO_SEGUNDOS = 30 * 60;

export type ResultadoDoReaviso = 'reavisado' | 'aviso_recente' | 'caso_nao_espera_pessoa';

/**
 * O caso ganhou novidade (uma nota do agente) e a Central tem de saber.
 *
 * Só existe UM caso aberto por conversa (`openCase`). Quando o cliente pede outra
 * coisa com o caso aberto, o pedido novo entra como nota — e a nota, sozinha, não
 * avisa ninguém: o aviso da Central nasce com o caso (`caso-na-central.handler`) e
 * fica parado ali. Medido numa conversa real: a visita pedida às 12:28 ficou só na
 * linha do tempo de um caso cujo aviso era das 10:44.
 *
 * Aviso aberto e recente (a equipe ainda não viu) já cobre a novidade: nada muda.
 * Fora disso, o aviso anterior do caso sai e entra um novo — INSERT, e não UPDATE,
 * porque é o INSERT que dispara `central.aviso_criado` e o push no celular. O
 * texto vem pronto de quem chama e é GENÉRICO pelo mesmo motivo do aviso de
 * abertura: o que a IA escreve sobre o cliente fica fora da anonimização da LGPD.
 *
 * Só para caso `awaiting_human`; tudo num statement, como o resto deste arquivo.
 */
export async function reavisarCasoNaCentral(
  db: Queryable,
  tenantId: string,
  caseId: string,
  texto: { titulo: string; corpo: string },
): Promise<ResultadoDoReaviso> {
  const { rows } = await db.query<{ caso: number; recente: number }>(
    `with caso as (
       select c.id from agent_cases c
        where c.organization_id = $1 and c.id = $2 and c.status = 'awaiting_human'
     ), recente as (
       select 1 from agent_inbox_items i
        where i.organization_id = $1 and i.kind = 'other' and i.ref_kind = 'agent_case'
          and i.ref_id = $2 and i.status = 'open'
          and i.created_at > now() - make_interval(secs => $5)
     ), anteriores as (
       update agent_inbox_items i
          set status = 'resolved', resolved_at = now()
        where i.organization_id = $1 and i.kind = 'other' and i.ref_kind = 'agent_case'
          and i.ref_id = $2 and i.status in ('open', 'ack')
          and exists (select 1 from caso) and not exists (select 1 from recente)
        returning i.id
     ), novo as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'other', 'warn', $3, $4, 'agent_case', c.id
         from caso c
        where not exists (select 1 from recente)
       returning id
     )
     select (select count(*) from caso)::int as caso,
            (select count(*) from recente)::int as recente,
            (select count(*) from anteriores)::int as anteriores,
            (select count(*) from novo)::int as novo`,
    [tenantId, caseId, texto.titulo, texto.corpo, JANELA_DO_REAVISO_SEGUNDOS],
  );
  const r = rows[0];
  if (!r || r.caso === 0) return 'caso_nao_espera_pessoa';
  return r.recente > 0 ? 'aviso_recente' : 'reavisado';
}

/** Como um chamado pode terminar pela mão do agente. */
export type DesfechoDoChamado = 'resolvido' | 'sem_necessidade';

const STATUS_DO_DESFECHO: Record<DesfechoDoChamado, string> = {
  resolvido: 'resolved',
  sem_necessidade: 'cancelled',
};

const EVENTO_DO_DESFECHO: Record<DesfechoDoChamado, CaseEventKind> = {
  resolvido: 'resolved',
  sem_necessidade: 'cancelled',
};

/**
 * awaiting_human|awaiting_lead -> resolved|cancelled, pela mão do AGENTE.
 *
 * Separado de `resolveCaseFromHuman` de propósito: aquela grava
 * `actor_kind='human'` + `human_action='resolved'`, que é a afirmação de que uma
 * PESSOA decidiu. Chamá-la a partir do agente colocaria uma decisão humana
 * inventada no registro do chamado — e é desse registro que sai o resumo entregue
 * ao próximo atendente.
 *
 * Aceita os DOIS estados abertos (diferente das transições do humano, que só
 * saem de `awaiting_human`): o caso comum é o chamado ficar `awaiting_lead`, o
 * lead resolver sozinho, e ninguém ter como fechar aquilo — chamado imortal na
 * fila de outra pessoa.
 */
export async function encerrarChamadoPeloAgente(
  db: Queryable,
  tenantId: string,
  caseId: string,
  input: { desfecho: DesfechoDoChamado; nota: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `with updated as (
       update agent_cases
          set status = $3, closed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and status = any($6::text[])
        returning id
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1::uuid, id, 'agent_noted', 'agent', $5::text from updated
     union all
     select $1::uuid, id, $4::text, 'agent', null::text from updated`,
    [
      tenantId,
      caseId,
      STATUS_DO_DESFECHO[input.desfecho],
      EVENTO_DO_DESFECHO[input.desfecho],
      input.nota,
      OPEN_STATUSES,
    ],
  );
  return transitioned(rowCount);
}

/** Resumo curto do caso para o inbox de escalação (mesmo espírito de buildHandoffSummary). */
export function buildCaseSummary(caseRow: { title: string; summary: string; blocker: string }): string {
  return `${caseRow.title}\n${caseRow.summary}\nBloqueio: ${caseRow.blocker}`;
}
