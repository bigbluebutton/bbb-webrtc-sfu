const config = require('config');
const C = require('../../constants/constants');
const {
  WEBRTC_TRANSPORT_SETTINGS, RTP_TRANSPORT_SETTINGS,
  DEFAULT_MAX_BW, DEFAULT_INITIAL_BW,
} = require('./configs');
const { getRouter } = require('./routers.js');
const Logger = require('../../utils/logger');
const { getMappedTransportType } = require('./utils.js');
const { PrometheusAgent, MS_METRIC_NAMES } = require('./prom-metrics.js');
const { handleError } = require('./errors.js');

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
        rtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
        ipVersion: 4, // TODO IPvX aware
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

    // Event handlers
    this._handleRouterClose = this._handleRouterClose.bind(this);
  }

  set transport (newTransport) {
    this._transport = newTransport;
    if (this.transport) {
      this.transport.once("routerclose", this._handleRouterClose);
    }
  }

  get transport () {
    return this._transport;
  }


  set rtcpMux (state = true) {
    this._rtcpMux = state;
  }

  get rtcpMux () {
    return this._rtcpMux;
  }

  set comedia (state = false) {
    this._comedia = state;
  }

  get comedia () {
    return this._comedia;
  }

  set transportSettings (tSettings) {
    this._transportSettings = tSettings;

    // The defaults are mediasoup defaults.
    this.rtcpMux = !(this.transportSettings.rtcpMux == null)
      ? this.transportSettings.rtcpMux
      : true;
    this.comedia = !(this.transportSettings.comedia == null)
      ? this.transportSettings.comedia
      : false;
  }

  get transportSettings () {
    return this._transportSettings;
  }

  _handleRouterClose() {
    this.stop("routerclose");
  }

  async _createPRTPTransportSet ({
    transportSettings = RTP_TRANSPORT_SETTINGS,
    adapterOptions,
  }) {
    try {
      const router = getRouter(this.routerId);
      let tSettings = transportSettings;

      if (router == null) throw (new Error('Router not found'));

      if (adapterOptions && adapterOptions.transportOptions) {
        tSettings = config.util.cloneDeep(transportSettings);
        if (!(adapterOptions.transportOptions.comedia == null)) {
          tSettings.comedia = adapterOptions.transportOptions.comedia;
        }
        if (!(adapterOptions.transportOptions.rtcpMux == null)) {
          tSettings.rtcpMux = adapterOptions.transportOptions.rtcpMux;
        }
      }

      this.transport = await router.createPlainTransport(tSettings);
      this.transportSettings = tSettings;
      this.setInputBandwidth(DEFAULT_MAX_BW);
      this.transportOptions = TransportSet.getPRTPTransportOpts(this.transport);
      const localIp = this.transportSettings.listenIp.ip;
      const publicIp = this.transportSettings.listenIp.announcedIp || localIp;

      this.host = {
        id: this.routerId,
        ipClassMappings: {
          public: publicIp,
          private: publicIp || localIp,
          local: localIp,
        },
        routerId: this.routerId,
      }

      PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS,
        { type: getMappedTransportType(this.type) }
      );

      this.id = this.transport.id;

      Logger.info("mediasoup: transport created", {
        transportId: this.id, type: this.type, routerId: this.routerId,
      });

      return this;
    } catch (error) {
      Logger.error("mediasoup: transport creation failed", {
        errorMessage: error.message, type: this.type, routerId: this.routerId,
      });
      throw error;
    }
  }

  async _createWebRTCTransportSet ({
    transportSettings = WEBRTC_TRANSPORT_SETTINGS,
    adapterOptions,
  }) {
    try {
      const router = getRouter(this.routerId);
      let tSettings = transportSettings;

      if (router == null) throw (new Error('Router not found'));

      if (adapterOptions && adapterOptions.transportOptions) {
        tSettings = config.util.cloneDeep(transportSettings);

        if (!(adapterOptions.transportOptions.enableTcp == null)) {
          tSettings.enableTcp = adapterOptions.transportOptions.enableTcp;
        }

        if (!(adapterOptions.transportOptions.initialAvailableOutgoingBitrate == null)) {
          tSettings.initialAvailableOutgoingBitrate = adapterOptions.transportOptions.initialAvailableOutgoingBitrate;
        }

        if (!(adapterOptions.transportOptions.port == null)) {
          tSettings.port= adapterOptions.transportOptions.port;
        }
      }

      if (!(tSettings.initialAvailableOutgoingBitrate == null)) {
        tSettings = {...tSettings, initialAvailableOutgoingBitrate: DEFAULT_INITIAL_BW };
      }

      this.transport = await router.createWebRtcTransport(tSettings);
      this.transportSettings = tSettings;
      this.setInputBandwidth(DEFAULT_MAX_BW);

      this.transportOptions = TransportSet.getWebRTCTransportOpts(this.transport);
      this.host = {
        id: this.routerId,
      }

      PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS,
        { type: getMappedTransportType(this.type) }
      );

      this.id = this.transport.id;

      Logger.info("mediasoup: transport created", {
        transportId: this.transport.id, type: this.type, routerId: this.routerId,
      });

      return this;
    } catch (error) {
      Logger.error("mediasoup: transport creation failed", {
        errorMessage: error.message, type: this.type, routerId: this.routerId,
      });
      throw error;
    }
  }

  createTransportSet (options) {
    switch (this.type) {
      case C.MEDIA_TYPE.WEBRTC:
        return this._createWebRTCTransportSet(options);
      case C.MEDIA_TYPE.RTP:
        return this._createPRTPTransportSet(options);
      default:
        throw(handleError({
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
        Logger.debug("mediasoup: max incoming bitrate failure", { errorMessage: error.message });
      });
    }
  }

  stop (reason) {
    if (this.transport
      && typeof this.transport.close === 'function'
      && !this.transport.closed) {
      try {
        this.transport.removeListener('routerclose', this._handleRouterClose);
        this.transport.removeAllListeners('icestatechange');
        this.transport.removeAllListeners('dtlsstatechange');
        this.transport.removeAllListeners('tuple');
        this.transport.removeAllListeners('rtcptuple');
        this.transport.close();
        this.transport = null;
        this.connected = false;

        // If a reason is specified it's worth logging
        if (reason) {
          Logger.info("mediasoup: TransportSet closed", {
            transportId: this.id, type: this.type, routerId: this.routerId, reason,
          });
        }

        PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_TRANSPORTS,
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
