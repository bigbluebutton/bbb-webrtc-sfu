const config = require('config');
const C = require('../constants/constants.js');
const Agent = require('./prom-agent.js');
const {
  METRICS_PREFIX,
  METRIC_NAMES,
  buildMetrics
} = require('./core-metrics.js');

const {
  enabled: METRICS_ENABLED,
  host: METRICS_HOST,
  port: METRICS_PORT,
  path: METRICS_PATH,
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
} = config.has('prometheus')
    ? config.get('prometheus')
    : { enabled: false };

const MCSPrometheusAgent = new Agent(METRICS_HOST, METRICS_PORT, {
  path: METRICS_PATH,
  prefix: METRICS_PREFIX,
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
});


const registerMediaUnitTypeMetrics = (operation, media) => {
  if (media.mediaTypes.video) {
    const direction =  media.mediaTypes.video === true ? 'sendrecv' : media.mediaTypes.video;
    MCSPrometheusAgent[operation](
      METRIC_NAMES.MEDIA_UNITS,
      { media_type: C.MEDIA_PROFILE.MAIN, unit_type: media.type, direction }
    );
  }

  if (media.mediaTypes.audio) {
    const direction =  media.mediaTypes.audio === true ? 'sendrecv' : media.mediaTypes.audio;
    MCSPrometheusAgent[operation](
      METRIC_NAMES.MEDIA_UNITS,
      { media_type: C.MEDIA_PROFILE.AUDIO, unit_type: media.type, direction }
    );
  }

  if (media.mediaTypes.content) {
    const direction =  media.mediaTypes.content === true ? 'sendrecv' : media.mediaTypes.content;
    MCSPrometheusAgent[operation](
      METRIC_NAMES.MEDIA_UNITS,
      { media_type: C.MEDIA_PROFILE.CONTENT, unit_type: media.type, direction }
    );
  }
};

const registerMediaSessionTypeMetrics = (operation, mediaSession) => {
  if (!METRICS_ENABLED) return;
  mediaSession.medias.forEach(media => {
    registerMediaUnitTypeMetrics(operation, media);
  });
};

const injectMetrics = (metricsDictionary) => {
  if (METRICS_ENABLED) {
    MCSPrometheusAgent.injectMetrics(metricsDictionary);
    return true;
  }

  return false;
}

// Inject default mcs-core metrics
MCSPrometheusAgent.injectMetrics(buildMetrics());
MCSPrometheusAgent.start();

module.exports = {
  METRIC_NAMES,
  METRICS_PREFIX,
  Agent,
  MCSPrometheusAgent,
  registerMediaUnitTypeMetrics,
  registerMediaSessionTypeMetrics,
  injectMetrics,
};
