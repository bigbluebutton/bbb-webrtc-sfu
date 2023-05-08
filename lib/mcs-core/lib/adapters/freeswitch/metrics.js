const { Counter, } = require('prom-client');
const { injectMetrics, MCSPrometheusAgent } = require('../../metrics/index.js');

const FS_METRICS_PREFIX = 'freeswitch_'
const FS_METRIC_NAMES = {
  FREESWITCH_CRASHES: 'freeswitch_crashes',
}

let FS_METRICS;
const buildDefaultMetrics = () => {
  if (FS_METRICS == null) {
    FS_METRICS = {
      [FS_METRIC_NAMES.FREESWITCH_CRASHES]: new Counter({
        name: `${FS_METRICS_PREFIX}crashes`,
        help: 'Detected FreeSWITCH crashes',
      }),
    }
  }

  return FS_METRICS;
};

injectMetrics(buildDefaultMetrics());

module.exports = {
  FS_METRICS_PREFIX,
  FS_METRIC_NAMES,
  FS_METRICS,
  PrometheusAgent: MCSPrometheusAgent,
};
