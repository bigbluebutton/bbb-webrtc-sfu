/*
 * Adapter specific:
 *  - mediasoup:
 *    mediasoup_workers: gauge
 *    mediasoup_routers: gauge
 *    mediasoup_transports: gauge
 *    mediasoup_producers: gauge
 *    mediasoup_consumers: gauge
 */

const { Gauge, Counter, Histogram } = require('prom-client');
const { injectMetrics, MCSPrometheusAgent } = require('../../metrics/index.js');
const Logger = require('../../utils/logger');
const { EXPORT_RTP_SCORES } = require('./configs.js');

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
  MEDIASOUP_ICE_TRANSPORT_PROTO: 'iceTransportProtocol',
}

if (EXPORT_RTP_SCORES) {
  MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE = 'rtp_score';
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

      [MS_METRIC_NAMES.MEDIASOUP_ICE_TRANSPORT_PROTO]: new Gauge({
        name: `${MS_METRICS_PREFIX}ice_transport_protocol`,
        help: 'mediasoup ICE transport active tuples by protocol (udp/tcp)',
        labelNames: ['protocol'],
      }),

      ...(EXPORT_RTP_SCORES && {
        [MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE]: new Histogram({
          name: `${MS_METRICS_PREFIX}${MS_METRIC_NAMES.MEDIASOUP_RTP_SCORE}`,
          help: 'mediasoup RTP score (producers and consumers)',
          // RTP scores, 1-10, 10 bins (to be reviewed as the bottom 5 bins are
          // probably not useful)
          buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          labelNames: ['mode', 'type', 'kind', 'transport_type'],
        })
      }),
    }
  }

  return MS_METRICS;
};

let WORKER_RESOURCE_METRICS;
const buildWorkerResouceMetrics = async (collector) => {
  let prevWorkerMetricsData = await collector();
  const collect = async () => {
    try {
      // Array<{
      //  workerId,
      //  workerPID,
      //  mediaType,
      //  metrics,
      // }>
      const workerMetricsData = await collector();

      Object.entries(workerMetricsData).forEach(([workerUID, workerMetricsEntry]) => {
        const { mediaType, metrics } = workerMetricsEntry;
        Object.entries(metrics).forEach(([metricName, metricValue]) => {
          const metric = WORKER_RESOURCE_METRICS[metricName]
          if (metric) {
            // This collector only works for sure with Gauges and Counters
            const type = metric.set
              ? 'Gauge'
              : 'Counter';
            if (type === 'Gauge') {
              metric.set({ mediaType, workerUID }, metricValue);
            } else {
              const prevMetricValue = prevWorkerMetricsData[workerUID]?.metrics[metricName];
              const metricValDiff = metricValue - (prevMetricValue || 0);
              if (metricValDiff > 0) metric.inc({ mediaType, workerUID }, metricValDiff);
            }
          }
        });
      });

      prevWorkerMetricsData = workerMetricsData;
    } catch (error) {
      Logger.warn('mediasoup: failed to update worker resource usage metrics', {
        errorMessage: error.message,
      });
    }
  };

  if (WORKER_RESOURCE_METRICS == null) {
    WORKER_RESOURCE_METRICS = {
      ru_nivcsw: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_nivcsw_total`,
        help: 'Involuntary context switches of mediasoup workers',
        labelNames: ['mediaType', 'workerUID'],
        // Specify the collector only once for this group of metrics - it'll
        // fill the rest once it's called
        collect,
      }),

      ru_nvcsw: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_nvcsw_total`,
        help: 'Voluntary context switches of mediasoup workers',
        labelNames: ['mediaType', 'workerUID'],
      }),

      ru_stime: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_stime_total`,
        help: 'System CPU time used by mediasoup workers (s)',
        labelNames: ['mediaType', 'workerUID'],
      }),

      ru_utime: new Counter({
        name: `${MS_METRICS_PREFIX}worker_ru_utime_total`,
        help: 'User CPU time used by mediasoup workers (s)',
        labelNames: ['mediaType', 'workerUID'],
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
  injectMetrics,
};
