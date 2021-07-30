const C = require('../../constants/constants');
const {
  LOG_PREFIX, WEBRTC_TRANSPORT_SETTINGS, DEFAULT_MAX_BW, DEFAULT_INITIAL_BW
} = require('./configs');
const { getRouter } = require('./routers.js');
const Logger = require('../../utils/logger');

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
      id: transport.id,
      rtcpMux: transport.rtcpMux,
      comedia: transport.comedia,
      enableSrtp: transport.enableSrtp,
      srtpCryptoSuite: transport.srtpCryptoSuite,
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

  _createPRTPTransportSet ({
    transportSettings = RTP_TRANSPORT_SETTINGS,
  }) {
    return new Promise(async (resolve, reject) => {
      try {
        const router = getRouter(this.routerId);
        if (router == null) return reject(new Error('Router not found'));

        const transport = await router.createPlainTransport(transportSettings);
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

        Logger.info(LOG_PREFIX, "Transport creation success", {
          transportId: this.transport.id,
        });

        this.id = this.transport.id;
        this.transportOptions = TransportSet.getWebRTCTransportOpts(this.transport);
        this.host = this.routerId;

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

  setInputBandwidth (max) {
    if (this.transport && typeof this.transport.setMaxIncomingBitrate === 'function') {
      return this.transport.setMaxIncomingBitrate(max)
    }
  }

  stop () {
    if (this.transport && typeof this.transport.close === 'function') {
      return this.transport.close();
    }

    return Promise.resolve();
  }
}
