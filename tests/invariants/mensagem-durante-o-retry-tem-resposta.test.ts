import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Debounce from "@/lib/agent-engine/edge/crm/debounce";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A MENSAGEM QUE CHEGA ENQUANTO O TURNO ANTERIOR ESPERA O RETRY TEM RESPOSTA.
 *
 * O caso medido em produção (2026-10-16, job 1a89b123): o turno respondeu em três
 * bolhas, o fechamento devolveu JSON inválido e a fila re-rodou o turno inteiro.
 * O "Sim" que o cliente mandou no intervalo pegou carona no job que esperava o
 * retry; o re-run respondeu, a cadeia aprovou, e o envio voltou `already_sent` —
 * a identidade do envio é (job, seq), e a bolha 1 do re-run colidiu com a bolha 1
 * já aceita. O cliente esperou três minutos e pediu um humano.
 *
 * O canal deste arquivo NÃO é um capturador: ele passa pelo `sendWithLedger` de
 * verdade, contra o `send_ledger` de verdade, e só a ida ao WhatsApp é trocada por
 * um INSERT em `messages`. Sem isso o defeito não se reproduz — é o ledger que
 * engole a resposta.
 *
 * Três blocos:
 *   1. a CARONA (`decidirRajada`) contra o banco: job que já tentou enviar não
 *      recebe mensagem nova;
 *   2. o FECHAMENTO depois da entrega: com a correção de `fecharOTurno` também
 *      recusada, o turno termina sem re-rodar;
 *   3. o CASO MEDIDO de ponta a ponta: o "Sim" recebe resposta, e só uma.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eee10000-0000-4000-8000-000000000001";
const CONTACT = "eee10000-0000-4000-8000-000000000002";
const SESSION = "eee10000-0000-4000-8000-000000000003";
const CONV = "eee10000-0000-4000-8000-000000000004";
const WORKER = "retry-com-resposta";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  debounce: typeof Debounce;
  ledger: typeof SendLedger;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

/** Respostas que o modelo fake vai escrevendo, uma por turno. Distintas: o spinning veta repetição. */
const RESPOSTAS = [
  "O plano mensal sai por R$ 365 com duas aulas por semana. Quer que eu reserve um horário?",
  "Perfeito! Separei terça às 19h para a sua aula experimental, combinado?",
  "Anotado, já deixo tudo pronto por aqui e te aviso se algo mudar.",
];

let chamadasDeFechamento = 0;
let turnosQueEnviaram = 0;

/**
 * Modelo fake roteado pelo PROMPT, não pela ordem: o fechamento é a chamada cuja
 * última mensagem é a instrução de checkpoint — ou a CORREÇÃO que `fecharOTurno`
 * pede quando o JSON volta recusado (`correcaoDoFechamento`); no laço principal,
 * o primeiro passo chama `send_message` e o passo depois do resultado da tool
 * encerra. `fechamentos` é a fila dos desfechos das chamadas de fechamento, a
 * correção incluída.
 */
function modelo(opts: { enviar: boolean; fechamentos: Array<"invalido" | "ok"> }) {
  return async (call: { prompt?: unknown }) => {
    const msgs = (call.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    const textoDaUltima = JSON.stringify(ultima?.content ?? "");
    if (
      ultima?.role === "user" &&
      (textoDaUltima.includes("Feche o turno AGORA") ||
        textoDaUltima.includes("O JSON do fechamento foi recusado"))
    ) {
      const desfecho = opts.fechamentos[chamadasDeFechamento] ?? "ok";
      chamadasDeFechamento += 1;
      return {
        content: [
          { type: "text" as const, text: desfecho === "ok" ? CHECKPOINT : "Claro! Turno encerrado." },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    if (!opts.enviar || ultima?.role === "tool") {
      return {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    const body = RESPOSTAS[turnosQueEnviaram] ?? `resposta extra ${turnosQueEnviaram}`;
    turnosQueEnviaram += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${turnosQueEnviaram}`,
          toolName: "send_message",
          input: JSON.stringify({ body }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/**
 * Canal com o LEDGER DE VERDADE (`sendWithLedger` + `pgSendLedger`): a única coisa
 * trocada é a ida ao WhatsApp, que vira um INSERT em `messages` com a
 * idempotency_key no metadata — o mesmo contrato do `sendMessageHandler`. O
 * mapeamento do desfecho é o do `WahaChannelAdapter`.
 */
function canalComLedger() {
  return {
    channel: "ledger-real",
    send: async (i: { tenantId: string; leadId: string | null; jobId: string; seq: number; body: string }) => {
      const outcome = await m.ledger.sendWithLedger(
        m.ledger.pgSendLedger(pool),
        { tenantId: i.tenantId, leadId: i.leadId, jobId: i.jobId, seq: i.seq, body: i.body },
        async (key, messageId) => {
          await pool.query(
            `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
               type, direction, status, body, sent_via, metadata)
             values ($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai', jsonb_build_object('idempotency_key', $7::text))`,
            [messageId, ORG, CONV, SESSION, CONTACT, i.body, key],
          );
          return { id: messageId, status: "sent" };
        },
      );
      switch (outcome.kind) {
        case "sent":
          return { kind: "sent" as const, idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case "blocked":
          return { kind: "blocked" as const, idempotencyKey: outcome.idempotencyKey };
        default:
          return { kind: outcome.kind, idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
      }
    },
    sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
    capabilities: () => ({ freeform: true, media: true, audio: true }),
    costPerMessage: () => ({ currency: "BRL", cents: 0 }),
  };
}

function montaHandler(doGenerate: unknown) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 20,
      maxContextTokens: 2000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () => canalComLedger() as never,
    // Dentro da janela anti-ban (7h-22h BRT), como os vizinhos.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

async function inbound(texto: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device')`,
    [id, ORG, CONV, SESSION, CONTACT, texto],
  );
  return id;
}

async function enfileira(msgId: string, runAfter?: Date): Promise<string> {
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    sourceEventId: crypto.randomUUID(),
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msgId,
      crm_event_id: crypto.randomUUID(),
    },
    ...(runAfter !== undefined ? { runAfter } : {}),
  });
  return job.id;
}

/**
 * O contrato do worker (`runJob` de `workers/agent-worker/main.ts`): claim,
 * handler, e `completeJob` no sucesso ou `failJob` na falha — que é o que devolve
 * o job a `pending` com o backoff do retry.
 */
async function rodaProximo(doGenerate: unknown): Promise<{ jobId: string; erro: Error | null } | null> {
  const [claimed] = await m.queue.claimJobs(pool, { workerId: WORKER, maxConcurrency: 1 });
  if (claimed === undefined) return null;
  try {
    await montaHandler(doGenerate)(claimed, pool, { workerId: WORKER });
    await m.queue.completeJob(pool, claimed.id, WORKER);
    return { jobId: claimed.id, erro: null };
  } catch (err) {
    await m.queue.failJob(pool, claimed.id, WORKER, err);
    return { jobId: claimed.id, erro: err as Error };
  }
}

/** O passo do drain que importa aqui: carona no job pendente OU job próprio. */
async function drenaMensagem(msgId: string): Promise<"coalescido" | "enfileirado"> {
  const rajada = await m.debounce.decidirRajada(
    pool as never,
    { organizationId: ORG, contactId: CONTACT },
    8_000,
  );
  if (rajada.tipo === "coalescido") return "coalescido";
  await enfileira(msgId, rajada.runAfter);
  return "enfileirado";
}

async function job(id: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
    "select status, attempts, last_error from job_queue where id = $1",
    [id],
  );
  return rows[0];
}

async function outbounds(depoisDe?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from messages o
      where o.organization_id = $1 and o.conversation_id = $2 and o.direction = 'outbound'
        and ($3::uuid is null or o.created_at > (select created_at from messages where id = $3))`,
    [ORG, CONV, depoisDe ?? null],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    debounce: await import("@/lib/agent-engine/edge/crm/debounce"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'retry-com-resposta','Retry Com Resposta','Retry Com Resposta') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'retry-com-resposta-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  chamadasDeFechamento = 0;
  turnosQueEnviaram = 0;
  await pool.query("delete from lead_checkpoints where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  // A janela do spinning é do NÚMERO e sobrevive aos deletes acima: sem limpá-la,
  // a mesma resposta de um caso anterior veta a do seguinte como copy em massa.
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  // O PG efêmero é do arquivo, mas o claim é global: nada alheio pode estar pendente.
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Cliente do Sim','+5511900000777')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

describe("a carona: job que já tentou enviar não recebe a mensagem nova", () => {
  it("controle: job na janela de debounce, sem envio, recebe a carona", async () => {
    const m1 = await inbound("Oi, tudo bem?");
    const jobId = await enfileira(m1, new Date(Date.now() + 60_000));

    const rajada = await m.debounce.decidirRajada(pool as never, { organizationId: ORG, contactId: CONTACT }, 8_000);

    expect(rajada).toEqual({ tipo: "coalescido", jobId });
  });

  it("job esperando o retry depois de ter enviado: a mensagem abre turno próprio", async () => {
    const m1 = await inbound("Oi, tudo bem?");
    const jobId = await enfileira(m1, new Date(Date.now() + 60_000));
    await pool.query(
      `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
       values ($1,$2,$3,1,'h','accepted')`,
      [ORG, CONTACT, jobId],
    );

    const rajada = await m.debounce.decidirRajada(pool as never, { organizationId: ORG, contactId: CONTACT }, 8_000);

    expect(rajada.tipo).toBe("enfileirar");
  });
});

describe("o fechamento depois da entrega", () => {
  it("JSON inválido também na correção: o turno termina sem checkpoint e SEM voltar para a fila", async () => {
    const m1 = await inbound("Quanto custa o plano?");
    const jobId = await enfileira(m1);

    const rodada = await rodaProximo(modelo({ enviar: true, fechamentos: ["invalido", "invalido"] }));

    expect(rodada?.erro).toBeNull();
    expect(chamadasDeFechamento).toBe(2);
    expect(await outbounds()).toBe(1);
    const j = await job(jobId);
    expect(j?.status).toBe("done");
    expect(j?.attempts).toBe(1);
    expect(j?.last_error).toMatch(/sem checkpoint depois da entrega/);
    const { rows } = await pool.query("select 1 from lead_checkpoints where job_id = $1", [jobId]);
    expect(rows).toHaveLength(0);
  });

  it("a correção do fechamento que acerta o formato grava o checkpoint", async () => {
    const m1 = await inbound("Quanto custa o plano?");
    const jobId = await enfileira(m1);

    const rodada = await rodaProximo(modelo({ enviar: true, fechamentos: ["invalido", "ok"] }));

    expect(rodada?.erro).toBeNull();
    const { rows } = await pool.query("select 1 from lead_checkpoints where job_id = $1", [jobId]);
    expect(rows).toHaveLength(1);
    expect((await job(jobId))?.last_error).toBeNull();
  });

  it("controle: sem entrega, o JSON inválido também na correção ainda devolve o job à fila (nada a engolir no re-run)", async () => {
    const m1 = await inbound("Quanto custa o plano?");
    const jobId = await enfileira(m1);

    const rodada = await rodaProximo(modelo({ enviar: false, fechamentos: ["invalido", "invalido"] }));

    expect(rodada?.erro?.message).toMatch(/JSON de checkpoint/);
    // A correção de `fecharOTurno` vale com ou sem entrega; sem entrega, o que sobra sobe.
    expect(chamadasDeFechamento).toBe(2);
    expect(await outbounds()).toBe(0);
    expect((await job(jobId))?.status).toBe("pending");
  });
});

describe("o caso medido, de ponta a ponta", () => {
  it("o 'Sim' que chega depois de um fechamento inválido recebe resposta — e uma só", async () => {
    const pergunta = await inbound("Quero saber do plano de duas aulas por semana");
    const primeiro = await enfileira(pergunta);
    // Primeira tentativa: responde e o fechamento vem inválido, a correção de
    // `fecharOTurno` também — e, no código de antes, a exceção ia para a fila.
    const doGenerate = modelo({ enviar: true, fechamentos: ["invalido", "invalido"] });
    await rodaProximo(doGenerate);
    expect(await outbounds()).toBe(1);

    const sim = await inbound("Sim");
    await drenaMensagem(sim);
    // O tempo passa: backoff do retry e janela de debounce vencidos.
    await pool.query(
      "update job_queue set run_after = now() where organization_id = $1 and status = 'pending'",
      [ORG],
    );
    for (let i = 0; i < 3; i += 1) {
      if ((await rodaProximo(doGenerate)) === null) break;
    }

    // A resposta ao "Sim" CHEGOU — no defeito, o re-run a escrevia e o ledger a engolia.
    expect(await outbounds(sim)).toBe(1);
    // E não houve resposta dupla: uma por mensagem do cliente.
    expect(await outbounds()).toBe(2);
    // O turno da pergunta terminou na primeira tentativa.
    expect((await job(primeiro))?.attempts).toBe(1);
  });
});
