const mediasoup = require('mediasoup');
const {
  PrometheusAgent,
  MS_METRIC_NAMES,
  exportWorkerResourceUsageMetrics,
} = require('./prom-metrics.js');
const {
  WORKER_EXPORT_RESOURCE_USAGE,
} = require('./configs.js');
const Logger = require('../../utils/logger');

const workers = new Map();
const routers = new Map();
const transports = new Map();
const producers = new Map();
const consumers = new Map();

const OFFSET = 500;
const PAD = 50;

const _getAllWorkers = () => {
  return Array.from(workers.values());
};

const _resourceUsageCollector = () => {
  const resourceDict = {};

  return Promise.all(
    _getAllWorkers().map(async worker => {
      const { workerUID, mediaType } = worker.appData;

      try {
        const msMetrics = await worker.getResourceUsage();
        const workerResourceUsage = {
          workerUID,
          workerId: worker.appData.internalAdapterId,
          workerPID: worker.pid,
          mediaType: mediaType,
          metrics: msMetrics,
        };

        resourceDict[workerUID] = workerResourceUsage;
      } catch (error) {
        Logger.debug('mediasoup: failure collecting worker resource metrics', {
          errorMessage: error.message, workerId: worker.appData.internalAdapterId,
          workerPID: worker.pid, mediaType,
        });
      }
    }),
  ).then(() => resourceDict);
};

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const observe = () => {
  if (WORKER_EXPORT_RESOURCE_USAGE) {
    exportWorkerResourceUsageMetrics(_resourceUsageCollector);
  }

  // Worker metrics observer
  mediasoup.observer.on('newworker', async (worker) => {
    let workerMediaType, workerUID;

    worker.observer.on('close', async() => {
      // Still populating data, wait a bit
      if (workerUID == null || workerMediaType == null) await waitFor(OFFSET);

      if (workers.delete(worker.pid)) {
        PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_WORKERS, {
          pool: workerMediaType, workerUID,
        });

        if (worker.died) {
          PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKER_CRASHES, {
            pool: workerMediaType, workerUID,
          });
        }
      }
    });

    // Router metrics observer
    worker.observer.on('newrouter', async (router) => {
      router.observer.on('close', async () => {
        // Still populating data, wait a bit
        if (workerUID == null) await waitFor(OFFSET + PAD);

        if (routers.delete(router.id)) {
          PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_ROUTERS, {
            workerUID,
          });
        }
      });

      // Transport metrics observer
      router.observer.on('newtransport', async (transport) => {
        let type;

        // Producer metrics observer
        transport.observer.on('newproducer', async (producer) => {
          producer.observer.on('close', async () => {
            // Still populating data, wait a bit
            if (type == null || workerUID == null) await waitFor(OFFSET + PAD * 5);

            if (producers.delete(producer.id)) {
              PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_PRODUCERS, {
                type: producer.type,
                kind: producer.kind,
                transport_type: type,
                workerUID,
              });
            }
          });

          if (MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE) {
            producer.observer.on('score', async (scores) => {
              // Still populating data, wait a bit
              if (type == null) await waitFor(OFFSET + PAD * 5);
              // All layers handled the same way -- review when simulcast is a thing here
              scores.forEach(({ score }) => {
                PrometheusAgent.observe(MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE,
                  score, {
                    mode: 'producer',
                    type: producer.type,
                    kind: producer.kind,
                    transport_type: type,
                  }
                );
              });
            });
          }

          // Still populating data, wait a bit
          if (type == null || workerUID == null) await waitFor(OFFSET + PAD * 4);
          producers.set(producer.id, producer);
          PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_PRODUCERS, {
            type: producer.type,
            kind: producer.kind,
            transport_type: type,
            workerUID,
          });
        });

        // Consumer metrics observer
        transport.observer.on('newconsumer', async (consumer) => {
          consumer.observer.on('close', async () => {
            // Still populating data, wait a bit
            if (type == null || workerUID == null) await waitFor(OFFSET + PAD * 5);
            if (consumers.delete(consumer.id)) {
              PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_CONSUMERS, {
                type: consumer.type,
                kind: consumer.kind,
                transport_type: type,
                workerUID,
              });
            }
          });

          if (MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE) {
            consumer.observer.on('score', async ({ score }) => {
              // Still populating data, wait a bit
              if (type == null) await waitFor(OFFSET + PAD * 5);
              PrometheusAgent.observe(MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE,
                score, {
                  mode: 'consumer',
                  type: consumer.type,
                  kind: consumer.kind,
                  transport_type: type,
                }
              );
            });
          }

          // Still populating data, wait a bit
          if (type == null || workerUID == null) await waitFor(OFFSET + PAD * 4);
          consumers.set(consumer.id, consumer);
          PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_CONSUMERS, {
            type: consumer.type,
            kind: consumer.kind,
            transport_type: type,
            workerUID,
          });
        });

        transport.observer.on('close', async () => {
          // Still populating data, wait a bit
          if (type == null || workerUID == null) await waitFor(OFFSET + PAD * 3);
          if (transports.delete(transport.id)) {
            PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS, {
              type,
              workerUID,
            });
          }
        });

        transports.set(transport.id, transport);
        // Still populating data, wait a bit
        if (Object.keys(transport.appData).length === 0) await waitFor(OFFSET + PAD * 2);
        ({ mappedType: type } = transport.appData);
        PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS, {
          type,
          workerUID,
        });
      });

      // Save router data
      routers.set(router.id, router);
      // Still populating data, wait a bit
      if (workerUID == null) await waitFor(OFFSET + PAD);
      PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_ROUTERS, {
        workerUID,
      });
    });

    // Save worker data
    workers.set(worker.pid, worker);
    // Still populating data, wait a bit
    if (Object.keys(worker.appData).length === 0) await waitFor(OFFSET);
    ({ mediaType: workerMediaType, workerUID } = worker.appData);
    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKERS, {
      pool: workerMediaType, workerUID,
    });
  });
};

module.exports = {
  observe,
}
