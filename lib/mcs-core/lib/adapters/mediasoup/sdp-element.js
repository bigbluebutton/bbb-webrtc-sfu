'use strict';

const C = require('../../constants/constants');
const Logger = require('../../utils/logger');
const ADU = require('../adapter-utils.js');
const SDPTranslator = require('./sdp-translator.js');
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const { LOG_PREFIX, ROUTER_SETTINGS } = require('./configs.js');
const BaseMediasoupElement = require('./base-element.js');
const config = require('config');
const { v4: uuidv4 }= require('uuid');
const { enrichCodecsArrayWithPreferredPT } = require('./utils.js');

module.exports = class MediasoupSDPElement extends BaseMediasoupElement {
  constructor(type, routerId, options) {
    super(type, routerId, options);

    this._negotiateSDPEndpoint = this._negotiateSDPEndpoint.bind(this);
  }

  _getNegotiationRoutine () {
    switch (this.type) {
      case C.MEDIA_TYPE.RTP:
      case C.MEDIA_TYPE.WEBRTC:
        return this._negotiateSDPEndpoint;
      case C.MEDIA_TYPE.RECORDING:
      case C.MEDIA_TYPE.URI:
      default:
        // @throws
        BaseMediasoupElement._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
    }
  }

  async _negotiate (mediaTypes, options) {
    try {
      const negotiationRoutine = this._getNegotiationRoutine();
      const localDescriptor = await negotiationRoutine(mediaTypes, options);

      return localDescriptor;
    } catch (error) {
      // Rollback whatever is needed
      this.stop();
      throw error;
    }
  }

  async _negotiateSDPEndpoint (mediaTypes, options) {
    await this.createTransportSet(options);
    this._trackTransportSetEvents();

    return this.processSDPOffer(mediaTypes, options);
  }

  _getMappedMType (apiProfileOrMType) {
    switch (apiProfileOrMType) {
      case C.MEDIA_PROFILE.MAIN:
      case 'video':
        return 'video';
      case C.MEDIA_PROFILE.AUDIO:
        return 'audio';
      case C.MEDIA_PROFILE.CONTENT:
        return 'video';
      default: return;
    }
  }

  _mapMTypesOrProfiles (mTypesOrProfiles) {
    const actualMediaTypes = [];
    for (const [mediaType, mediaTypeDir] of Object.entries(mTypesOrProfiles)) {
      if (mediaTypeDir) actualMediaTypes.push(this._getMappedMType(mediaType));
    }

    return actualMediaTypes;
  }

  _getActualMediaTypes (mediaTypes, profiles = {}) {
    let actualMediaTypes = this._mapMTypesOrProfiles(mediaTypes);

    if (actualMediaTypes.length > 0) return actualMediaTypes;

    // Fallback to API profiles
    return this._mapMTypesOrProfiles(profiles);
  }

  async _processProducerSDPOffer (kind, rtpParameters, paused = false) {
    const producer = await this.produce(kind, rtpParameters, paused);
    // FIXME yeah... we really don't want to rely on single negotiation
    this.negotiated = true;

    return {
      trackId: producer.id,
      offerRtpParameters: producer.rtpParameters,
      rtcpStreamId: producer.rtpParameters.rtcp.cname,
    };
  }

  async _processConsumerSDPOffer (mediaType, rtpCapabilities, options) {
    const consumer = await this.consume(mediaType, rtpCapabilities, options)
    // FIXME yeah... we really don't want to rely on single negotiation
    this.negotiated = true;

    return {
      trackId: consumer.id,
      offerRtpParameters: consumer.rtpParameters,
      rtcpStreamId: consumer.rtpParameters.rtcp.cname,
    };
  }

  async _generateOffererProducerCaps (actualMediaType) {
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
      const source = this._getConsumerSource(sourceAdapterElementIds);
      const producer = source.getProducerOfKind(mediaType);
      return Promise.resolve({
        rtpParams: {
          codecs: enrichCodecsArrayWithPreferredPT(
            producer.rtpParameters.codecs
          ),
        },
        setup: 'actpass',
      });
    } else {
      // Promisified
      return this._generateOffererProducerCaps(mediaType);
    }
  }

  async _processMediaOffer (mediaType, mode,  options) {
    let offerRtpParameters;
    let rtcpStreamId;
    let trackId;

    const { rtpParams, setup } = await this._getRTPParameters(mediaType, options);

    // We as answerers
    if (this.remoteDescriptor) {
      if (mode === 'producer') {
        ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processProducerSDPOffer(
          mediaType, rtpParams
        ));
      } else {
        ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processConsumerSDPOffer(
          mediaType, rtpParams, options
        ));
      }
    } else { // We as offerers
      if (mode == 'consumer') {
        ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processConsumerSDPOffer(
          mediaType, rtpParams, options
        ));
      } else {
        offerRtpParameters = rtpParams;
        rtcpStreamId = rtpParams.rtcp.cname;
        trackId = uuidv4();
      }
    }

    return {
      actualMediaType: mediaType,
      offerRtpParameters,
      streamId: rtcpStreamId,
      trackId,
      setup,
    };
  }

  async processSDPOffer (mediaTypes, options) {
    const mode = this._getMode(options.sourceAdapterElementIds);
    const actualMediaTypes = this._getActualMediaTypes(
      mediaTypes, options.profiles,
    );

    if (this.remoteDescriptor == null && options.remoteDescriptor) {
      this.remoteDescriptor = options.remoteDescriptor;
      Logger.trace(LOG_PREFIX, "Remote descriptor set", {
        elementId: this.id, type: this.type, router: this.routerId,
        transport: this.transportSet.id,
      });
    }

    const transducingRoutines = actualMediaTypes.map((actualMediaType) => {
      return this._processMediaOffer(actualMediaType, mode, options);
    });

    const kindParametersMap = await Promise.all(transducingRoutines);

    if (this.localDescriptor == null) {
      this.localDescriptor = SDPTranslator.assembleSDP(mediaTypes, {
        transportOptions: this.transportSet.transportOptions,
        kindParametersMap,
        adapterOptions: options.adapterOptions,
      });

      Logger.trace(LOG_PREFIX, "Local descriptor set", {
        elementId: this.id, type: this.type, routerId: this.routerId,
        transportId: this.transportSet.id, descriptor: this.localDescriptor,
      });
    }

    if (options.remoteDescriptor) {
      await this.connectTransport(options.remoteDescriptor, actualMediaTypes[0]);
    }

    return this.localDescriptor;
  }

  _connectWRTCTransport (description) {
    const dtlsParameters = SoupSDPU.extractDtlsParameters({ sdpObject: description });
    this.dtlsParameters = dtlsParameters;
    return this.transportSet.connect({ dtlsParameters }).then(() => {
      Logger.debug(LOG_PREFIX, "Transport connected", {
        elementId: this.id, type: this.type, routerId: this.routerId, dtlsParameters,
      });
    }).catch(error => {
      Logger.error(LOG_PREFIX, "Transport connect failure", {
        errorMessage: error.message, elementId: this.id, type: this.type,
        routerId: this.routerId, dtlsParameters,
      });
      throw error;
    });
  }

  _connectPRTPTransport (description, kind) {
    const rtcpMux = !(this.transportSet.transportSettings.rtcpMux == null)
      ? this.transportSet.transportSettings.rtcpMux
      : true;
    const prtpParameters = SDPTranslator.extractPlainRtpParameters(
      description, kind, rtcpMux,
    );
    this.prtpParameters = prtpParameters;
    return this.transportSet.connect(prtpParameters).then(() => {
      Logger.debug(LOG_PREFIX, "Transport connected", {
        elementId: this.id, type: this.type, routerId: this.routerId, prtpParameters,
      });

      // If COMEDIA is enabled, the consumer resume will happen at the transport's
      // 'tuple' event handler. See @BaseMediasoupElement#_handleRTPTupleDiscovered
      if (!this.transportSet.comedia) {
        this._handleRTPTupleDiscovered(this.transportSet.transport.tuple)
      }
    }).catch(error => {
      Logger.error(LOG_PREFIX, "Transport connect failure", {
        errorMessage: error.message, elementId: this.id, type: this.type,
        routerId: this.routerId, prtpParameters,
      });
      throw error;
    });
  }

  connectTransport (description, kind) {
    switch (this.type) {
      case C.MEDIA_TYPE.WEBRTC:
        return this._connectWRTCTransport(description);
      case C.MEDIA_TYPE.RTP:
        return this._connectPRTPTransport(description, kind);
      default:
        return Promise.reject(new TypeError('Invalid transport type'));
    }
  }
}
