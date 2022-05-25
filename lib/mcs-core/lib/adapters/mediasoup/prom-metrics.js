/*
 * Adapter specific:
 *  - mediasoup:
 *    mediasoup_workers: gauge
 *    mediasoup_routers: gauge
 *    mediasoup_transports: gauge
 *    mediasoup_producers: gauge
 *    mediasoup_consumers: gauge
 */

const { Gauge, Counter, } = require('prom-client');
const { injectMetrics, MCSPrometheusAgent } = require('../../metrics/index.js');
const Logger = require('../../utils/logger');

const MS_METRICS_PREFIX = 'mediasoup_'
const MS_METRIC_NAMES = {
  MEDIASOUP_WORKERS: 'workers',
  MEDIASOUP_ROUTERS: 'routers',
  MEDIASOUP_TRANSPORTS: 'transports',
  MEDIASOUP_PRODUCERS: 'producers',
  MEDIASOUP_CONSUMERS: 'consumers',
  MEDIASOUP_WORKER_CRASHES: 'workerCrashes',
  MEDIASOUP_DTLS_ERRORS: 'transportDtlsErrors',
  MEDIASOUP_ICE_ERRORS: 'transportIceErrors',
}

let MS_METRICS;
const buildDefaultMetrics = () => {
  if (MS_METRICS == null) {
    MS_METRICS = {
      [MS_METRIC_NAMES.MEDIASOUP_WORKERS]: new Gauge({
        name: `${MS_METRICS_PREFIX}workers`,
        help: 'Active mediasoup workers',
        labelNames: ['pool'],
      }),

      [MS_METRIC_NAMES.MEDIASOUP_ROUTERS]: new Gauge({
        name: `${MS_METRICS_PREFIX}routers`,
        help: 'Active mediasoup routers',
      }),

      [MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS]: new Gauge({
        name: `${MS_METRICS_PREFIX}transports`,
        help: 'Number of active mediasoup transports',
        labelNames: ['type'],
      }),

      [MS_METRIC_NAMES.MEDIASOUP_PRODUCERS]: new Gauge({
        name: `${MS_METRICS_PREFIX}producers`,
        help: 'Number of active mediasoup producers',
        labelNames: ['type', 'kind', 'transport_type'],
      }),

      [MS_METRIC_NAMES.MEDIASOUP_CONSUMERS]: new Gauge({
        name: `${MS_METRICS_PREFIX}consumers`,
        help: 'Number of active mediasoup consumers',
        labelNames: ['type', 'kind', 'transport_type'],
      }),

      [MS_METRIC_NAMES.MEDIASOUP_WORKER_CRASHES]: new Counter({
        name: `${MS_METRICS_PREFIX}worker_crashes`,
        help: 'Detected mediasoup worker crashes',
        labelNames: ['pool'],
      }),

      [MS_METRIC_NAMES.MEDIASOUP_DTLS_ERRORS]: new Counter({
        name: `${MS_METRICS_PREFIX}transport_dtls_errors`,
        help: 'mediasoup DTLS failures',
      }),

      [MS_METRIC_NAMES.MEDIASOUP_ICE_ERRORS]: new Counter({
        name: `${MS_METRICS_PREFIX}transport_ice_errors`,
        help: 'mediasoup ICE failures',
      }),
    }
  }

  return MS_METRICS;
};


let WORKER_RESOURCE_METRICS;
const buildWorkerResouceMetrics = async (collector) => {
  let lastResourceUsageSum = await collector();
  const collect = async () => {
    try {
      // WorkerResourceUsage (Object)
      const workersUsageTotal = await collector();
      Object.entries(workersUsageTotal).forEach(([metricName, metricValue]) => {
        const metric = WORKER_RESOURCE_METRICS[metricName]
        if (metric) {
          // This collector only works for sure with Gauges and Counters
          const type = metric.set
            ? 'Gauge'
            : 'Counter';
          if (type === 'Gauge') {
            metric.set(metricValue);
          } else {
            const metricValDiff = metricValue - (lastResourceUsageSum[metricName] || 0);
            if (metricValDiff > 0) {
              metric.inc(metricValDiff);
            }
          }
        }
      });

      lastResourceUsageSum = workersUsageTotal;
    } catch (error) {
      Logger.warn('mediasoup: failed to update worker resource usage metrics', {
        errorMessage: error.message,
      });
    }
  };

  if (WORKER_RESOURCE_METRICS == null) {
    WORKER_RESOURCE_METRICS = {
      ru_idrss: new Gauge({
        name: `${MS_METRICS_PREFIX}worker_ru_idrss_total`,
        help: 'Integral unshared data size of all mediasoup workers (libuv)',
        // Only collect things once; the collect method will fill everything.
        collect,
      }),

      ru_isrss: new Gauge({
        name: `${MS_METRICS_PREFIX}worker_ru_isrss_total`,
        help: 'Integral unshared stack size of all mediasoup workers (libuv)',
      }),

      ru_ixrss: new Gauge({
        name: `${MS_METRICS_PREFIX}worker_ru_ixrss_total`,
        help: 'Integral shared memory size of all mediasoup workers (libuv)',
      }),

      ru_maxrss: new Gauge({
        name: `${MS_METRICS_PREFIX}worker_ru_maxrss_total`,
        help: 'Maximum resident set size of all mediasoup workers (libuv)',
      }),

      ru_msgrcv: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_msgrcv_total`,
        help: 'IPC messages received by all mediasoup workers (libuv)',
      }),

      ru_msgsnd: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_msgsnd_total`,
        help: 'IPC messages sent by all mediasoup workers (libuv)',
      }),

      ru_nivcsw: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_nivcsw_total`,
        help: 'Involuntary context switches of all mediasoup workers (libuv)',
      }),

      ru_nvcsw: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_nvcsw_total`,
        help: 'Voluntary context switches of all mediasoup workers (libuv)',
      }),

      ru_stime: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_stime_total`,
        help: 'System CPU time used by all mediasoup workers (libuv)',
      }),

      ru_utime: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_utime_total`,
        help: 'User CPU time used by all mediasoup workers (libuv)',
      }),
    }
  }

  return WORKER_RESOURCE_METRICS;
}

const exportWorkerResourceUsageMetrics = async (collector) => {
  try {
    if (WORKER_RESOURCE_METRICS) return;
    const metrics = await buildWorkerResouceMetrics(collector);
    injectMetrics(metrics);
  } catch (error) {
    Logger.debug('mediasoup: failure building worker resource metrics', {
      errorMessage: error.message,
    });
  }
}

injectMetrics(buildDefaultMetrics());

module.exports = {
  MS_METRICS_PREFIX,
  MS_METRIC_NAMES,
  MS_METRICS,
  PrometheusAgent: MCSPrometheusAgent,
  exportWorkerResourceUsageMetrics,
};
