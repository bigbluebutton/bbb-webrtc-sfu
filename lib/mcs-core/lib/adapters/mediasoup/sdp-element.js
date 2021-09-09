'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const ADU = require('../adapter-utils.js');
const SDPTranslator = require('./sdp-translator.js');
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const { LOG_PREFIX, ROUTER_SETTINGS } = require('./configs.js');
const BaseMediasoupElement = require('./base-element.js');
const config = require('config');

module.exports = class MediasoupSDPElement extends BaseMediasoupElement {
  constructor(type, routerId) {
    super(type, routerId);
  }

  _negotiate (sdpMediaModel, options) {
    try {
      switch (this.type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiatePRTPEndpoint(sdpMediaModel, options);
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(sdpMediaModel, options);
        case C.MEDIA_TYPE.RECORDING:
          return BaseMediasoupElement._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        case C.MEDIA_TYPE.URI:
          return BaseMediasoupElement._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        default:
          // FIXME ERRORS should not be used.
          //throw(handleError(ERRORS[40107].error));
      }
    } catch (err) {
      throw(handleError(err));
    }
  }

  _negotiateSDPEndpoint (sdpMediaModel, options) {
    try {
      return new Promise(async (resolve, reject) => {
        try {
          let medias = [];
          let localDescriptor;

          const mediaType = ADU.parseMediaType(sdpMediaModel);
          await this.createTransportSet(options);
          this._trackTransportSetEvents();
          const host = this.transportSet.host;

          sdpMediaModel.adapterElementId = this.id;
          sdpMediaModel.host = host;
          sdpMediaModel.trackMedia();

          if (sdpMediaModel.remoteDescriptor) {
            options.remoteDescriptor = sdpMediaModel.remoteDescriptor._jsonSdp;
          }

          localDescriptor = await this.processSDPOffer(
            sdpMediaModel.mediaTypes, options
          );

          localDescriptor = ADU.appendContentTypeIfNeeded(localDescriptor, mediaType);
          sdpMediaModel.localDescriptor = localDescriptor;
          medias.push(sdpMediaModel);

          resolve(medias);
        } catch (err) {
          reject(handleError(err));
        }
      });
    } catch (err) {
      throw(handleError(err));
    }
  }

  async _negotiateWebRTCEndpoint (sdpMediaModel, options) {
    try {
      const medias = await this._negotiateSDPEndpoint(sdpMediaModel, options);
      return medias;
    } catch (err) {
      throw(handleError(err));
    }
  }

  async _negotiatePRTPEndpoint (sdpMediaModel, options) {
    try {
      const medias = await this._negotiateSDPEndpoint(sdpMediaModel, options);
      return medias;
    } catch (err) {
      throw(handleError(err));
    }
  }

  _getActualMediaType (mediaTypes, mediaProfile = null) {
    if (mediaProfile) {
      switch (mediaProfile) {
        case C.MEDIA_PROFILE.MAIN:
          return 'video';
        case C.MEDIA_PROFILE.AUDIO:
          return 'audio';
        case C.MEDIA_PROFILE.CONTENT:
          return 'video';
        default: break
      }
    }

    if (!!mediaTypes.audio) return 'audio';
    if (!!mediaTypes.video || !!mediaTypes.content) return 'video';

    // FIXME this default is bug prone
    return 'video';
  }

  _processProducerSDPOffer (kind, rtpParameters, paused = false) {
    return new Promise(async (resolve, reject) => {
      try {
        const producer = await this.produce(kind, rtpParameters, paused);

        // FIXME yeah... we really don't want to rely on single negotiation
        this.negotiated = true;
        const offerRtpParameters = producer.rtpParameters;
        const rtcpStreamId = producer.rtpParameters.rtcp.cname;

        return resolve({ offerRtpParameters, rtcpStreamId });
      } catch (error) {
        reject(error);
      }
    });
  }

  async _processConsumerSDPOffer (rtpCapabilities, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const consumer = await this.consume(rtpCapabilities, options)

        // FIXME
        this.negotiated = true;

        const offerRtpParameters = consumer.rtpParameters;
        const rtcpStreamId = consumer.rtpParameters.rtcp.cname;

        return resolve({ offerRtpParameters, rtcpStreamId });
      } catch (error) {
        reject(error);
      }
    });
  }

  async _generateOffererProducerCaps (actualMediaType) {
    try {
      const codecs = config.util.cloneDeep(ROUTER_SETTINGS.mediaCodecs)
        .filter(codec => codec.kind === actualMediaType)
        .map(codec => {
          codec.payloadType = codec.preferredPayloadType
          // Pre-start pmts if not present
          if (typeof codec.parameters !== 'object') codec.parameters = {};
          if (typeof codec.rtcpFeedback !== 'object') codec.rtcpFeedback = [];

          return codec;
        });

      const ssrc = await ADU.getNewSsrcId();
      const rtcp = {
        reducedSize: true,
        cname: ADU.getNewCNAME(),
      };

      return {
        rtpParams: {
          mid: '1',
          codecs,
          encodings: [{ ssrc }],
          headerExtensions: [],
          rtcp,
        },
        setup: 'actpass',
      }
    } catch (error) {
      throw error;
    }
  }

  _getRTPParameters (mediaType, { remoteDescriptor, sourceAdapterElementIds }) {
    const mode = this._getMode(sourceAdapterElementIds);

    // If there's a remote descriptor in the options param, we need to extract
    // the RTP params for an answer
    if (remoteDescriptor) {
      const baseCaps = SoupSDPU.extractRtpCapabilities({ sdpObject: remoteDescriptor });
      return {
        rtpParams: SDPTranslator.extractRTPParams(baseCaps, remoteDescriptor, mediaType, mode),
        setup: 'active',
      }
    }

    // There's no remote description set. We need to extract RTP params for a
    // local description as an offer

    if (mode === 'consumer') {
      const producer = this._getConsumerSource(sourceAdapterElementIds);
      return Promise.resolve({
        rtpParams: {
          codecs: producer.rtpParameters.codecs,
        },
        setup: 'actpass',
      });
    } else {
      return this._generateOffererProducerCaps(mediaType);
    }
  }

  processSDPOffer (mediaTypes, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const actualMediaType = this._getActualMediaType(mediaTypes, options.mediaProfile);
        const mode = this._getMode(options.sourceAdapterElementIds);
        const { rtpParams, setup } = await this._getRTPParameters(actualMediaType, options);
        let offerRtpParameters;
        let rtcpStreamId;

        if (this.remoteDescriptor == null && options.remoteDescriptor) {
          this.remoteDescriptor = options.remoteDescriptor;
          if (mode === 'producer') {
            ({ offerRtpParameters, rtcpStreamId } = await this._processProducerSDPOffer(
              actualMediaType, rtpParams
            ));
          } else {
            ({ offerRtpParameters, rtcpStreamId } = await this._processConsumerSDPOffer(
              rtpParams, options
            ));
          }
          // We are offerers; local is set, remote has to be processed. Do your
          // thing.
          if (options.remoteDescriptor) {
            this.connectTransport(options.remoteDescriptor, actualMediaType);
          }
        } else {
          if (mode == 'consumer') {
            ({ offerRtpParameters, rtcpStreamId } = await this._processConsumerSDPOffer(
              rtpParams, options
            ));
          } else {
            offerRtpParameters = rtpParams;
            rtcpStreamId = rtpParams.rtcp.cname;
          }
        }

        if (this.localDescriptor == null) {
          this.localDescriptor = SDPTranslator.assembleSDP(mediaTypes, {
            transportOptions: this.transportSet.transportOptions,
            kind: actualMediaType,
            offerRtpParameters,
            streamId: rtcpStreamId,
            setup,
            adapterOptions: options.adapterOptions,
          });
        }

        return resolve(this.localDescriptor);
      } catch (err) {
        return reject(handleError(err));
      }
    })
  }

  _connectWRTCTransport (description) {
    const dtlsParameters = SoupSDPU.extractDtlsParameters({ sdpObject: description });
    this.dtlsParameters = dtlsParameters;
    this.transportSet.connect({ dtlsParameters }).then(() => {
      Logger.debug(LOG_PREFIX, "Transport connected", {
        elementId: this.id, dtlsParameters,
      });
    }).catch(error => {
      // TODO preferably re-throw
      Logger.error(LOG_PREFIX, "Transport connect failure", {
        errorMessage: error.message, elementId: this.id, dtlsParameters,
      });
    });
  }

  _connectPRTPTransport (description, kind) {
    const prtpParameters = SDPTranslator.extractPlainRtpParameters(description, kind);
    this.prtpParameters = prtpParameters;
    this.transportSet.connect(prtpParameters).then(() => {
      Logger.debug(LOG_PREFIX, "Transport connected", {
        elementId: this.id, prtpParameters,
      });
    }).catch(error => {
      // TODO preferably re-throw
      Logger.error(LOG_PREFIX, "Transport connect failure", {
        errorMessage: error.message, elementId: this.id, prtpParameters,
      });
    });
  }

  connectTransport (description, kind) {
    switch (this.type) {
      case C.MEDIA_TYPE.WEBRTC:
        return this._connectWRTCTransport(description);
      case C.MEDIA_TYPE.RTP:
        return this._connectPRTPTransport(description, kind);
      default:
        return;
    }
  }

  // BEGIN EVENT BLOCK
  _handleTransportIceStateFailed () {
    // TODO eject media
    Logger.error(LOG_PREFIX, "Transport ICE state: failed", {
      elementId: this.id, transportId: this.transportSet.id,
    });
  }

  _handleTransportIceStateCompleted () {
    // Not that great of an event mapping, but that's my fault for not abstracting
    // Kurento events out of this pit -- prlanzarin
    const event = { state: "FLOWING" };
    this.emit(C.EVENT.MEDIA_STATE.FLOW_OUT, event);

    // Look up for a list of consumers that are paused to resume them.
    this.consumers.forEach((consumer) => {
      if (!consumer.paused) return;
      consumer.resume();
    });
  }

  _handleTransportIceStateChange (iceState) {
    Logger.debug(LOG_PREFIX, 'Media element ICE state changed',
      { elementId: this.id, iceState });

    switch (iceState) {
      case 'completed':
        this._handleTransportIceStateCompleted();
        break;
      case 'failed':
        this._handleTransportIceStateFailed();
        break;
    }
  }

  _handleTransportDTLSStateFailed () {
    // TODO eject media
    Logger.error(LOG_PREFIX, "Transport DTLS state: failed", {
      elementId: this.id,
      transportId: this.transportSet.id,
      dtlsParameters: this.dtlsParameters,
    });
  }

  _handleTransportDTLSStateConnected () {}

  _handleTransportDTLSStateChange (dtlsState) {
    Logger.debug(LOG_PREFIX, 'Media element DTLS state changed',
      { elementId: this.id, dtlsState });

    switch (dtlsState) {
      case 'connected':
        this._handleTransportDTLSStateConnected();
        break;
      case 'failed':
        this._handleTransportDTLSStateFailed();
        break;
    }
  }

  _trackTransportSetEvents () {
    if (this.type === C.MEDIA_TYPE.WEBRTC) {
      this.transportSet.transport.on('icestatechange', this._handleTransportIceStateChange.bind(this));
      this.transportSet.transport.on('dtlsstatechange', this._handleTransportDTLSStateChange.bind(this));
    }
  }

  // END EVENT BLOCK

  stop () {
    if (this.transportSet && typeof this.transportSet.stop === 'function') {
      return this.transportSet.stop();
    }

    return Promise.resolve();
  }
}
