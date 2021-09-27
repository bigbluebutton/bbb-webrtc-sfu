const C = require('../../constants/constants');
const {
  LOG_PREFIX, WEBRTC_TRANSPORT_SETTINGS, RTP_TRANSPORT_SETTINGS,
  DEFAULT_MAX_BW, DEFAULT_INITIAL_BW,
} = require('./configs');
const { getRouter } = require('./routers.js');
const Logger = require('../../utils/logger');
const { getMappedTransportType } = require('./utils.js');
const {
  MCSPrometheusAgent,
  METRIC_NAMES,
} = require('../../metrics/index.js');

module.exports = class TransportSet {
  static getWebRTCTransportOpts (transport) {
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  static getPRTPTransportOpts (transport) {
    return {
      plainRtpParameters: {
        id: transport.id,
        ip: transport.tuple.localIp,
        port: transport.tuple.localPort,
        ipVersion: 4, // TODO IPvX aware
        // TODO account for RTCP-mux == false scenarios
      }
    };
  }

  constructor(type, routerId) {
    this.type = type;
    this.transportOptions;
    this.id;
    this.transport;
    this.routerId = routerId;
    this.connected = false;
  }

  set transport (newTransport) {
    this._transport = newTransport;
    this._transport.once("routerclose", () => { this.stop("routerclose") });
  }

  get transport () {
    return this._transport;
  }

  _createPRTPTransportSet ({
    transportSettings = RTP_TRANSPORT_SETTINGS,
  }) {
    return new Promise(async (resolve, reject) => {
      try {
        const router = getRouter(this.routerId);
        if (router == null) return reject(new Error('Router not found'));

        this.transport = await router.createPlainTransport(transportSettings);
        router.activeElements++;
        this.setInputBandwidth(DEFAULT_MAX_BW);

        Logger.info(LOG_PREFIX, "Transport creation success", {
          transportId: this.transport.id,
        });

        this.id = this.transport.id;
        this.transportOptions = TransportSet.getPRTPTransportOpts(this.transport);
        const localIp = RTP_TRANSPORT_SETTINGS.listenIp.ip;
        const publicIp = RTP_TRANSPORT_SETTINGS.listenIp.announcedIp || localIp;
        this.host = {
          id: this.routerId,
          ipClassMappings: {
            public: publicIp,
            private: publicIp || localIp,
            local: localIp,
          },
          routerId: this.routerId,
        }

        MCSPrometheusAgent.increment(METRIC_NAMES.MEDIASOUP_TRANSPORTS,
          { type: getMappedTransportType(this.type) }
        );

        return resolve(this);
      } catch (error) {
        Logger.error(LOG_PREFIX, "Transport creation failed", {
          errorCode: error.code, errorMessage: error.message,
        });
        return reject(error);
      }
    });
  }

  _createWebRTCTransportSet ({
    transportSettings = WEBRTC_TRANSPORT_SETTINGS,
  }) {
    return new Promise(async (resolve, reject) => {
      try {
        const router = getRouter(this.routerId);
        if (router == null) return reject(new Error('Router not found'));

        this.transport = await router.createWebRtcTransport({
          ...transportSettings,
          initialAvailableOutgoingBitrate: DEFAULT_INITIAL_BW,
        });
        this.setInputBandwidth(DEFAULT_MAX_BW);
        router.activeElements++;

        Logger.info(LOG_PREFIX, "Transport creation success", {
          transportId: this.transport.id,
        });

        this.id = this.transport.id;
        this.transportOptions = TransportSet.getWebRTCTransportOpts(this.transport);
        this.host = this.routerId;

        MCSPrometheusAgent.increment(METRIC_NAMES.MEDIASOUP_TRANSPORTS,
          { type: getMappedTransportType(this.type) }
        );

        return resolve(this);
      } catch (error) {
        Logger.error(LOG_PREFIX, "Transport creation failed", {
          errorCode: error.code, errorMessage: error.message,
        });
        return reject(error);
      }
    });
  }

  createTransportSet (options) {
    switch (this.type) {
      case C.MEDIA_TYPE.WEBRTC:
        return this._createWebRTCTransportSet(options);
      case C.MEDIA_TYPE.RTP:
        return this._createPRTPTransportSet(options);
      default:
        return reject(handleError({
          ...C.ERROR.MEDIA_INVALID_OPERATION,
          details: "MEDIASOUP_UNSUPPORTED_MEDIA_TYPE"
        }));
    }
  }

  connect (parameters) {
    return this.transport.connect(parameters);
  }

  setInputBandwidth (max = 0) {
    if (this.transport
      && typeof this.transport.setMaxIncomingBitrate === 'function'
      && max > 0
    ) {
      this.transport.setMaxIncomingBitrate(max).catch(error => {
        // Man shrugging
        Logger.debug(LOG_PREFIX, "Max incoming bitrate failure", error);
      });
    }
  }

  stop (reason) {
    // If a reason is specified it's worth logging
    if (reason) {
      Logger.info(LOG_PREFIX, "TransportSet closed", {
        transportId: this.id, reason,
      });
    }

    if (this.transport && typeof this.transport.close === 'function') {
      try {
        this.transport.close();
        MCSPrometheusAgent.decrement(METRIC_NAMES.MEDIASOUP_TRANSPORTS,
          { type: getMappedTransportType(this.type) }
        );
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return Promise.resolve()
  }
}
