'use strict';

const C = require('../../constants/constants');
const { getRouter } = require('./routers.js');
const {
  getCodecFromMimeType,
  enrichCodecsArrayWithPreferredPT,
} = require('./utils.js');
const { FFmpegRecorder } = require('bbb-sfurec-adapter');
const { getPortPair, releasePortPair } = require('./rec-port-warden.js');
const { LOG_PREFIX, RTP_TRANSPORT_SETTINGS, RECORDER_FFMPEG } = require('./configs.js');
const Logger = require('../../utils/logger');
const BaseMediasoupElement = require('./base-element.js');
const { hrTime } = require('../../utils/util.js');
const { timemarkToMs } = require('../adapter-utils.js');
const PRESTART_INTRAFRAME_INTERVAL_MS = RECORDER_FFMPEG.prestartIntraframeInterval || 0
const PERIODIC_INTRAFRAME_INTERVAL_MS = RECORDER_FFMPEG.periodicIntraframeInterval || 0;

module.exports = class RecorderElement extends BaseMediasoupElement {
  constructor(type, routerId, uri, sourceElement) {
    super(type, routerId);
    // The recording file path
    this.uri = uri;
    // BaseMediasoupElement or children
    this.sourceElement = sourceElement;
    this.recorderTransport = null;
    this.recorderConsumer = null;
    this.rtpPortsInUse = null;
    this.recordingMarkEventFired = false;
    this.keyframeReqInterval = null;

    // Record event handlers
    this._handleRecorderFailure = this._handleRecorderFailure.bind(this);
    this._handleRecorderProgress = this._handleRecorderProgress.bind(this);
    this._handleRecorderStarted = this._handleRecorderStarted.bind(this);
    this._handleRecorderEnded = this._handleRecorderEnded.bind(this);
  }

  _handleRecorderEnded (reason) {
    Logger.info(LOG_PREFIX, 'Recorder stopped', {
      elementId: this.id, type: this.type, routerId: this.routerId, reason,
    });

    this.rtpPortsInUse.forEach((rtp) => {
      releasePortPair(rtp);
    });

    this.recorder = null;
  }

  _handleRecorderFailure (error) {
    Logger.error(LOG_PREFIX, 'Recording failure', {
      errorMessage: error.message, elementId: this.id, type: this.type,
      routerId: this.routerId,
    });
  }

  _handleRecorderProgress (progress) {
    Logger.trace(LOG_PREFIX, 'Recording progress', {
      elementId: this.id, type: this.type, routerId: this.routerId, progress,
    });

    if (this.recordingMarkEventFired === true) {
      return;
    } else {
      let finalUTCInMs;
      let finalHRInMs
      const currentUTCInMs = Date.now();
      const currentHRInMs = hrTime();

      try {
        if (RECORDER_FFMPEG.estimateInitialTimestamp) {
          const timemarkInMs = timemarkToMs(progress.timemark);
          finalUTCInMs = currentUTCInMs - timemarkInMs;
          finalHRInMs = currentHRInMs - timemarkInMs;
        } else {
          finalUTCInMs = this.recorder.startedUTC;
          finalHRInMs = this.recorder.startedHR;
        }
      } catch (error) {
        finalUTCInMs = this.recorder.startedUTC;
        finalHRInMs = this.recorder.startedHR;
        Logger.warn(LOG_PREFIX, 'Failure in recording timemark offset check', {
          elementId: this.id, currentUTCInMs, currentHRInMs, finalUTCInMs, finalHRInMs,
          errorMessage: error.message,
        });
      } finally {
        this._fireRecordingStartedEvent(finalUTCInMs, finalHRInMs);
      }
    }
  }

  _clearKeyframeReqInterval () {
    if (this.keyframeReqInterval) {
      clearInterval(this.keyframeReqInterval);
      this.keyframeReqInterval = null;
    }
  }

  _setKeyframeReqInterval (intervalInMs) {
    if (this.keyframeReqInterval == null && intervalInMs > 0) {
      this.keyframeReqInterval = setInterval(() => {
        this.recorderConsumer.requestKeyFrame();
      }, intervalInMs);
    }
  }

  _fireRecordingStartedEvent (timestampUTC, timestampHR) {
    if (this.recordingMarkEventFired === false) {
      this._clearKeyframeReqInterval();
      this._setKeyframeReqInterval(PERIODIC_INTRAFRAME_INTERVAL_MS);
      const event = {
        state: 'FLOWING',
        timestampUTC,
        timestampHR,
      };
      // Not that great of an event mapping, but that's my fault for not abstracting
      // Kurento events out of this pit (x2 rec edition) -- prlanzarin
      this.emit(C.EVENT.MEDIA_STATE.FLOW_OUT, event);
      this.emit(C.EVENT.RECORDING.STARTED, event);

      this.recordingMarkEventFired = true;
    }
  }

  _handleRecorderStarted () {
    Logger.info(LOG_PREFIX, 'Recording started', { elementId: this.id });
    this._setKeyframeReqInterval(PRESTART_INTRAFRAME_INTERVAL_MS);
    this.recorder.startedUTC = Date.now();
    this.recorder.startedHR = hrTime();
  }

  _extractRecConfigsFromProducers () {
    const recCodecs = {};
    const recCodecParameters = [];

    this.sourceElement.producers.forEach((producer) => {
      if (recCodecs[producer.kind] == null) {
        const producerCodecs = producer.rtpParameters.codecs;
        recCodecs[producer.kind] = 'copy';
        recCodecParameters.push({
          kind: producer.kind,
          rtpProfile: 'RTP/AVPF',
          codec: getCodecFromMimeType(producerCodecs[0].mimeType),
          codecRate: producerCodecs[0].clockRate,
          producerId: producer.id,
        });
      }
    });

    return { recCodecs, recCodecParameters };
  }

  _createRecorderTransport () {
    if (this.recorderTransport == null) {
      const router = getRouter(this.routerId);

      return router.createPlainTransport({
        ...RTP_TRANSPORT_SETTINGS,
        rtcpMux: false,
        comedia: false,
      }).then((transport) => {
        this.recorderTransport = transport;
        return transport;
      });
    }

    return Promise.resolve(this.recorderTransport);
  }

  _createRecorderConsumer (transport, producer) {
    if (this.recorderConsumer == null) {
      return transport.consume({
        producerId: producer.id,
        rtpCapabilities: {
          codecs: enrichCodecsArrayWithPreferredPT(
            producer.rtpParameters.codecs
          ),
        },
      }).then((consumer) => {
        this.recorderConsumer = consumer;
        return consumer;
      });
    }

    return Promise.resolve(this.recorderConsumer);
  }

  async _recordStream (codecParameters) {
    try {
      const producer = this.sourceElement.getProducer(
        codecParameters.producerId
      );

      const transport = await this._createRecorderTransport();
      const consumer = await this._createRecorderConsumer(transport, producer);

      // Annotate correct payload type based on what the consumer merged
      // between input, producer and router
      codecParameters.codecId = consumer.rtpParameters.codecs[0].payloadType
        || producer.rtpParameters.codecs[0].payloadType;

      const { rtp, rtcp } = getPortPair();
      codecParameters.rtpPort = rtp;
      transport.connect({
        ip: transport.tuple.localIp,
        port: rtp,
        rtcpPort: rtcp,
      });

    } catch (error) {
      // TODO rollback/cleanup
      Logger.debug(LOG_PREFIX, 'Internal stream recording failure', {
        errorMessage: error.message, elementId: this.id, type: this.type,
        routerId: this.routerId, codecParameters,
      });

      throw error;
    }
  }

  async record () {
    const { recCodecs, recCodecParameters } = this._extractRecConfigsFromProducers();

    const recordingRoutines = recCodecParameters.map(codecParameters => {
      return this._recordStream(codecParameters);
    });

    const recorderOpts = {
      outputFile: this.uri,
      ffmpegParameters: {
        codecs: recCodecs,
        // FIXME API specifies the format; get it.
        outputFormat: 'webm',
        inputOptions: RECORDER_FFMPEG.inputOptions,
        outputOptions: RECORDER_FFMPEG.outputOptions,
      },
      sdpParameters: {
        topLevelIP: RTP_TRANSPORT_SETTINGS.listenIp.announcedIp,
        codecParameters: recCodecParameters,
      },
      logger: Logger,
    };

    await Promise.all(recordingRoutines);
    this.recorder = new FFmpegRecorder(recorderOpts);
    this.rtpPortsInUse = recCodecParameters.map(({ rtpPort }) => { return rtpPort });

    this.recorder.on('error', this._handleRecorderFailure);
    this.recorder.once('started', this._handleRecorderStarted);
    this.recorder.on('progress', this._handleRecorderProgress);
    this.recorder.once('end', this._handleRecorderEnded);

    await this.recorder.start();
  }

  async _stop () {
    Logger.trace(LOG_PREFIX, 'Stopping recorder', {
      elementId: this.id,
    });

    this._clearKeyframeReqInterval();

    if (this.recorderConsumer) {
      this.recorderConsumer.close();
      this.recorderConsumer = null;
    }

    if (this.recorderTransport) {
      this.recorderTransport.close();
      this.recorderTransport = null;
    }

    if (this.recorder) {
      return this.recorder.stop().finally(() => {
        const event = {
          state: 'NOT_FLOWING',
          timestampUTC: Date.now(),
          timestampHR: hrTime(),
        };
        // Not that great of an event mapping, but that's my fault for not abstracting
        // Kurento events out of this pit (x3 rec edition) -- prlanzarin
        this.emit(C.EVENT.RECORDING.STOPPED, event);
      });
    } else {
      return Promise.resolve()
    }
  }
}
