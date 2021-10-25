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

const MS_METRICS_PREFIX = 'mediasoup_'
const MS_METRIC_NAMES = {
  MEDIASOUP_WORKERS: 'workers',
  MEDIASOUP_ROUTERS: 'routers',
  MEDIASOUP_TRANSPORTS: 'transports',
  MEDIASOUP_PRODUCERS: 'producers',
  MEDIASOUP_CONSUMERS: 'consumers',
}

let MS_METRICS;
const buildMetrics = () => {
  if (MS_METRICS == null) {
    MS_METRICS = {
      [MS_METRIC_NAMES.MEDIASOUP_WORKERS]: new Gauge({
        name: `${MS_METRICS_PREFIX}workers`,
        help: 'Active mediasoup workers',
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
    }
  }

  return MS_METRICS;
};

injectMetrics(buildMetrics());

module.exports = {
  MS_METRICS_PREFIX,
  MS_METRIC_NAMES,
  MS_METRICS,
  PrometheusAgent: MCSPrometheusAgent,
};
