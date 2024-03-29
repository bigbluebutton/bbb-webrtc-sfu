const { Gauge, Counter, } = require('prom-client');
const { injectMetrics, VideoPrometheusAgent } = require('./index.js');

const SFUV_NAMES = {
  SESSIONS: 'sfu_video_sessions',
  REQS: 'sfu_video_reqs_total',
  QUEUED_REQUESTS: 'sfu_video_queued_reqs',
  QUEUE_FAILURES: 'sfu_video_queue_failures_total',
  RECORDER_STATUS: 'sfu_video_recorder_status',
  RECORDER_RESTARTS: 'sfu_video_recorder_restarts_total',
  RECORDING_ERRORS : 'sfu_video_recording_errors_total',
  ERRORS: 'sfu_video_errors_total',
}

let VIDEO_METRICS;
const buildDefaultMetrics = () => {
  if (VIDEO_METRICS == null) {
    VIDEO_METRICS = {
      [SFUV_NAMES.SESSIONS]: new Gauge({
        name: SFUV_NAMES.SESSIONS,
        help: 'Number of active sessions in the video module',
      }),

      [SFUV_NAMES.REQS]: new Counter({
        name: SFUV_NAMES.REQS,
        help: 'Total requisitions received by the video module',
      }),

      [SFUV_NAMES.RECORDER_STATUS]: new Gauge({
        name: SFUV_NAMES.RECORDER_STATUS,
        help: 'Status of bbb-webrtc-recorder (video module)',
      }),

      [SFUV_NAMES.RECORDER_RESTARTS]: new Counter({
        name: SFUV_NAMES.RECORDER_RESTARTS,
        help: 'Total restarts of bbb-webrtc-recorder (video module)',
      }),

      [SFUV_NAMES.RECORDING_ERRORS]: new Counter({
        name: SFUV_NAMES.RECORDING_ERRORS,
        help: 'Total recording errors generated by the video module',
        labelNames: ['error', 'recordingAdapter'],
      }),

      [SFUV_NAMES.ERRORS]: new Counter({
        name: SFUV_NAMES.ERRORS,
        help: 'Total error responses generated by the video module',
        labelNames: ['method', 'errorCode'],
      }),

      [SFUV_NAMES.QUEUED_REQUESTS]: new Gauge({
        name: SFUV_NAMES.QUEUED_REQUESTS,
        help: 'Queued requests in the video module',
      }),

      [SFUV_NAMES.QUEUE_FAILURES]: new Counter({
        name: SFUV_NAMES.QUEUE_FAILURES,
        help: 'Total queue failures in the video module',
        labelNames: ['reason'],
      }),
    }
  }

  return VIDEO_METRICS;
};

injectMetrics(buildDefaultMetrics());

module.exports = {
  SFUV_NAMES,
  VIDEO_METRICS,
  PrometheusAgent: VideoPrometheusAgent,
};
