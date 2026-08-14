import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';

/**
 * The job queue.
 *
 * Redis and BullMQ, on the same box as the app. Uploads return the moment the
 * bytes are on disk; making thumbnails happens behind them, so a phone on shop
 * wifi is never waiting on a HEIC decode.
 *
 * Without Redis reachable the app still runs — `enqueue` reports that it could
 * not queue, and the caller does the work in the request instead.
 */

export const QUEUE_NAME = 'derivatives';

let connection: IORedis | null = null;
let queue: Queue | null = null;
let queueBroken = false;

function redis(): IORedis {
  if (!connection) {
    connection = new IORedis(config.redis.url, {
      maxRetriesPerRequest: null,       // BullMQ requires this
      enableOfflineQueue: false,
      retryStrategy: (n) => Math.min(n * 500, 5000)
    });
    connection.on('error', () => { queueBroken = true; });
    connection.on('ready', () => { queueBroken = false; });
  }
  return connection;
}

export function jobQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: redis(),
      defaultJobOptions: {
        // Three tries backing off — a box under load or a momentarily locked
        // file gets another chance before anyone sees a glyph.
        attempts: 3,
        backoff: { type: 'exponential', delay: 4000 },
        removeOnComplete: 500,
        removeOnFail: 200
      }
    });
  }
  return queue;
}

export interface DerivativeJob {
  companyId: number;
  documentId: number;
}

/** Returns false when Redis is not there, so the caller can fall back. */
export async function enqueueDerivative(data: DerivativeJob, opts?: JobsOptions): Promise<boolean> {
  if (!config.redis.url) return false;
  try {
    await jobQueue().add('thumb', data, opts);
    return true;
  } catch {
    queueBroken = true;
    return false;
  }
}

export function queueHealthy(): boolean {
  return !!config.redis.url && !queueBroken;
}

/**
 * Start the worker in this process. The app already runs as one service, so the
 * worker rides along with it rather than being a second unit to keep alive —
 * one thing to start, one thing to watch.
 */
export function startWorker(
  handler: (data: DerivativeJob) => Promise<void>,
  log: (msg: string, err?: unknown) => void
): Worker | null {
  if (!config.redis.url) {
    log('No REDIS_URL — thumbnails will be made in the request instead of on a queue.');
    return null;
  }
  const worker = new Worker<DerivativeJob>(QUEUE_NAME, async job => handler(job.data), {
    connection: redis(),
    concurrency: config.media.concurrency
  });
  worker.on('failed', (job, err) => {
    log(`derivative job failed (document ${job?.data?.documentId}, try ${job?.attemptsMade})`, err);
  });
  return worker;
}

export async function closeQueue(): Promise<void> {
  await queue?.close().catch(() => undefined);
  connection?.disconnect();
}
