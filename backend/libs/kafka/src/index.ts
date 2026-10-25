/**
 * Thin wrapper over the Confluent Kafka client (KafkaJS-compatible API). Redpanda locally, any Kafka in the cloud.
 * Producers are idempotent; consumers commit after the handler succeeds, so handlers MUST be idempotent
 * (@mc/nest-common's consumer dedupes on the event id per database).
 */
import type { KafkaJS as KafkaJSNs } from '@confluentinc/kafka-javascript';

let lib: typeof KafkaJSNs | undefined;
/** Loaded lazily: a broken native install fails with a clear message instead of crashing every import. */
async function kafkaJS(): Promise<typeof KafkaJSNs> {
  if (!lib) {
    try {
      lib = (await import('@confluentinc/kafka-javascript')).KafkaJS;
    } catch (e) {
      throw new Error(`Kafka native module failed to load (${(e as Error).message.split('\n')[0]}) — run: pnpm rebuild @confluentinc/kafka-javascript`);
    }
  }
  return lib;
}

export interface KafkaMessageOut {
  key: string;
  value: string;
  headers?: Record<string, string>;
}
export interface KafkaMessageIn {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

const brokers = () => (process.env.KAFKA_BROKERS ?? 'localhost:61092').split(',').map((b) => b.trim());

export async function createKafka(clientId: string) {
  const KafkaJS = await kafkaJS();
  return new KafkaJS.Kafka({ kafkaJS: { clientId, brokers: brokers(), logLevel: KafkaJS.logLevel.WARN } });
}

export interface Producer {
  send(topic: string, messages: KafkaMessageOut[]): Promise<unknown>;
  disconnect(): Promise<void>;
}

export async function createProducer(clientId: string): Promise<Producer> {
  const producer = (await createKafka(clientId)).producer({ kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  return {
    send: (topic, messages) => producer.send({ topic, messages }),
    disconnect: () => producer.disconnect(),
  };
}

export async function createConsumer(
  clientId: string,
  groupId: string,
  topics: string[],
  handler: (msg: KafkaMessageIn) => Promise<void>,
  opts: { fromBeginning?: boolean } = {},
) {
  const consumer = (await createKafka(clientId)).consumer({ kafkaJS: { groupId, fromBeginning: opts.fromBeginning ?? true } });
  await consumer.connect();
  await consumer.subscribe({ topics });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) if (v != null) headers[k] = v.toString();
      await handler({ topic, partition, offset: message.offset, key: message.key?.toString() ?? null, value: message.value?.toString() ?? null, headers });
    },
  });
  return { disconnect: () => consumer.disconnect() };
}

/** Create topics if missing (idempotent). Used by `mc db bootstrap` style tooling and tests. */
export async function ensureTopics(topics: string[], partitions = 3) {
  const admin = (await createKafka('mc-admin')).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((t) => !existing.has(t));
    if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: partitions })) });
    return missing;
  } finally {
    await admin.disconnect();
  }
}
