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

    // Record event handlers
    this._handleRecorderFailure = this._handleRecorderFailure.bind(this);
    this._handleRecorderProgress = this._handleRecorderProgress.bind(this);
    this._handleRecorderStarted = this._handleRecorderStarted.bind(this);
    this._handleRecorderEnded = this._handleRecorderEnded.bind(this);
  }

  _handleRecorderEnded (reason) {
    Logger.info(LOG_PREFIX, 'Recorder stopped', {
      elementId: this.id, reason,
    });

    this.rtpPortsInUse.forEach((rtp) => {
      releasePortPair(rtp);
    });

    this.recorder = null;
  }

  _handleRecorderFailure (error) {
    Logger.error(LOG_PREFIX, 'Recording failure', {
      errorMessage: error.message, errorCode: error.code, elementId: this.id,
    });
  }

  _handleRecorderProgress (progress) {
    Logger.trace(LOG_PREFIX, 'Recording progress', {
      elementId: this.id, progress,
    });

    if (this.recordingMarkEventFired === true) {
      return;
    } else {
      let finalUTCInMs;
      let finalHRInMs
      const currentUTCInMs = Date.now();
      const currentHRInMs = hrTime();

      try {
        const timemarkInMs = timemarkToMs(progress.timemark);
        finalUTCInMs = currentUTCInMs - timemarkInMs;
        finalHRInMs = currentHRInMs - timemarkInMs;
      } catch (error) {
        finalUTCInMs = this.recorder.startedUTC;
        finalHRInMs = this.recorder.startedHR;
        Logger.warn(LOG_PREFIX, 'Failure in recording timemark offset check', {
          elementId: this.id, currentUTCInMs, currentHRInMs, finalUTCInMs, finalHRInMs,
          errorMessage: error.message,
        });
      } finally {
        const event = {
          state: 'FLOWING',
          timestampUTC: finalUTCInMs,
          timestampHR: finalHRInMs,
        };
        // Not that great of an event mapping, but that's my fault for not abstracting
        // Kurento events out of this pit (x2 rec edition) -- prlanzarin
        this.emit(C.EVENT.MEDIA_STATE.FLOW_OUT, event);
        this.recordingMarkEventFired = true;
      }
    }
  }

  _handleRecorderStarted () {
    Logger.info(LOG_PREFIX, 'Recording started', { elementId: this.id });
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

  async record () {
    const recordingRoutines = [];
    const { recCodecs, recCodecParameters } = this._extractRecConfigsFromProducers();

    recCodecParameters.forEach(codecParameters => {
      const recRoutine = new Promise(async (resolve, reject) => {
        const producer = this.sourceElement.getProducer(
          codecParameters.producerId
        );

        try {
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

          return resolve();
        } catch (error) {
          return reject(error);
        }
      });

      recordingRoutines.push(recRoutine);
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
    };

    try {
      await Promise.all(recordingRoutines);
      this.recorder = new FFmpegRecorder(recorderOpts);
      this.rtpPortsInUse = recCodecParameters.map(({ rtpPort }) => { return rtpPort });

      this.recorder.on('error', this._handleRecorderFailure);
      this.recorder.once('started', this._handleRecorderStarted);
      this.recorder.on('progress', this._handleRecorderProgress);
      this.recorder.once('end', this._handleRecorderEnded);

      await this.recorder.start();
    } catch (error) {
      throw error;
    }
  }

  async _stop () {
    Logger.trace(LOG_PREFIX, 'Stopping recorder', {
      elementId: this.id,
    });

    if (this.recorderConsumer) {
      this.recorderConsumer.close();
      this.recorderConsumer = null;
    }

    if (this.recorderTransport) {
      this.recorderTransport.close();
      this.recorderTransport = null;
    }

    if (this.recorder) {
      return this.recorder.stop();
    } else {
      return Promise.resolve()
    }
  }
}
