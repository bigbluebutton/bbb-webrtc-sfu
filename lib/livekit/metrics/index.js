const config = require('config');
const PrometheusAgent = require('../../common/prometheus-agent.js');

const {
  enabled: METRICS_ENABLED = false,
  livekit: LIVEKIT_METRICS_CONFIG = {},
} = config.has('prometheus') ? config.get('prometheus') : { enabled: false, livekit: {} };
const {
  host: METRICS_HOST = 'localhost',
  port: METRICS_PORT = '6759',
  path: METRICS_PATH = '/metrics',
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
} = LIVEKIT_METRICS_CONFIG;

const LiveKitPrometheusAgent = new PrometheusAgent(METRICS_HOST, METRICS_PORT, {
  path: METRICS_PATH,
  prefix: 'sfu_livekit_',
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
});

const injectMetrics = (metricsDictionary) => {
  if (METRICS_ENABLED) {
    LiveKitPrometheusAgent.injectMetrics(metricsDictionary);
    return true;
  }

  return false;
}

LiveKitPrometheusAgent.start();

module.exports = {
  PrometheusAgent,
  LiveKitPrometheusAgent,
  injectMetrics,
};
