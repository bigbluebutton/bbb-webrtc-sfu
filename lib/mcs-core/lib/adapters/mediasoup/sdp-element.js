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
const {
  enrichCodecsArrayWithPreferredPT,
  mapMTypesOrProfilesToKindDirection,
  mapConnectionTypeToKind,
} = require('./utils.js');
const {  MS_MODES } = require('./constants.js');

module.exports = class MediasoupSDPElement extends BaseMediasoupElement {
  constructor(type, routerId, options) {
    super(type, routerId, options);

    this._negotiateSDPEndpoint = this._negotiateSDPEndpoint.bind(this);
    this.kindParametersMap = [];
    this.adapterOptions = {};
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

  _processNegotiationOptions (options) {
    if (options.adapterOptions) {
      this.adapterOptions = options.adapterOptions;
    }
  }

  async _negotiate (mediaTypes, options = {}) {
    this._processNegotiationOptions(options);

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

  _getKindDirectionMap (mediaTypes, profiles = {}) {
    let kindDirectionMap = mapMTypesOrProfilesToKindDirection(mediaTypes);

    if (kindDirectionMap.length > 0) return kindDirectionMap;

    // Fallback to API profiles
    return mapMTypesOrProfilesToKindDirection(profiles);
  }

  async _processProducerSDPOffer (kind, options) {
    const { rtpParams, setup } = await this._getRTPParameters(kind, 'producer', options);
    const producer = await this.produce(kind, rtpParams);
    // FIXME yeah... we really don't want to rely on single negotiation
    this.negotiated = true;

    return [{
      trackId: producer.id,
      offerRtpParameters: producer.rtpParameters,
      rtcpStreamId: producer.rtpParameters.rtcp.cname,
      setup,
      direction: 'sendonly',
    }];
  }

  async _processConsumerSDPOffer (kind, options) {
    const { rtpParams, setup } = await this._getRTPParameters(kind, 'consumer', options);
    const consumer = await this.consume(kind, rtpParams, options)
    // FIXME yeah... we really don't want to rely on single negotiation
    this.negotiated = true;

    return [{
      trackId: consumer.id,
      offerRtpParameters: consumer.rtpParameters,
      rtcpStreamId: consumer.rtpParameters.rtcp.cname,
      setup,
      direction: 'recvonly',
    }];
  }

  async _processTransceiverSDPOffer (kind, options) {
    const producerParameters = await this._processProducerSDPOffer(kind, options);
    const consumerParameters = await this._processConsumerSDPOffer(kind, options)
    // FIXME yeah... we really don't want to rely on single negotiation
    this.negotiated = true;

    return [...producerParameters, ...consumerParameters];
  }

  async _generateOffererProducerCaps (targetKind) {
    const codecs = config.util.cloneDeep(ROUTER_SETTINGS.mediaCodecs)
      .filter(codec => codec.kind === targetKind)
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
        codecs,
        encodings: [{ ssrc }],
        headerExtensions: [],
        rtcp,
      },
      setup: 'actpass',
    }
  }

  _getRTPParameters (kind, mode, { remoteDescriptor, sourceAdapterElementIds }) {
    // If there's a remote descriptor in the options param, we need to extract
    // the RTP params for an answer
    if (remoteDescriptor) {
      const baseCaps = SoupSDPU.extractRtpCapabilities({ sdpObject: remoteDescriptor });
      return {
        rtpParams: SDPTranslator.extractRTPParams(
          baseCaps, remoteDescriptor, kind, mode
        ),
        setup: 'active',
      }
    }

    // There's no remote description set. We need to extract RTP params for a
    // local description as an offer

    if (mode === 'consumer') {
      const source = this._getConsumerSource(sourceAdapterElementIds);
      const producer = source.getProducerOfKind(kind);
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
      return this._generateOffererProducerCaps(kind);
    }
  }

  async _generateProducerOffer (kind, options) {
    const { rtpParams, setup } = await this._getRTPParameters(kind, 'producer', options);
    return Promise.resolve([{
      offerRtpParameters: rtpParams,
      rtcpStreamId: rtpParams.rtcp.cname,
      trackId: uuidv4(),
      setup,
      direction: 'sendonly',
    }]);
  }

  async _processAsOfferer (kind, mode, options) {
    switch (mode) {
      case MS_MODES.CONSUMER:
        return this._processConsumerSDPOffer(kind, options);
      case MS_MODES.PRODUCER:
        return this._generateProducerOffer(kind, options);
      case MS_MODES.TRANSCEIVER: {
        const producerParameters = await this._generateProducerOffer(kind, options);
        const consumerParameters = await this._processConsumerSDPOffer(kind, options)
        // FIXME yeah... we really don't want to rely on single negotiation
        this.negotiated = true;
        return [...producerParameters, ...consumerParameters];
      }
      default:
        throw new TypeError('Invalid mode');
    }
  }

  _processAsAnswerer (kind, mode, options) {
    switch (mode) {
      case MS_MODES.PRODUCER:
        return this._processProducerSDPOffer(kind, options);
      case MS_MODES.CONSUMER:
        return this._processConsumerSDPOffer(kind, options);
      case MS_MODES.TRANSCEIVER:
        return this._processTransceiverSDPOffer(kind, options);
    }
  }

  async _processMediaOffer (kind, direction, options) {
    const mode = this._getMode(direction, options);

    let streamDictionaries = [];
    // We as answerers
    if (this.remoteDescriptor) {
      streamDictionaries = await this._processAsAnswerer(
        kind, mode, options
      );
    } else { // We as offerers
      streamDictionaries = await this._processAsOfferer(
        kind, mode, options
      );
    }

    return streamDictionaries.map(({
      offerRtpParameters, rtcpStreamId, trackId, direction, setup,
    }) => {
     return {
        kind,
        direction,
        offerRtpParameters,
        streamId: rtcpStreamId,
        trackId,
        setup,
      };
    });
  }

  async processSDPOffer (mediaTypes, options) {
    this._processNegotiationOptions(options);
    const kindDirectionMap = this._getKindDirectionMap(
      mediaTypes, options.profiles,
    );

    if (this.remoteDescriptor == null && options.remoteDescriptor) {
      this.remoteDescriptor = options.remoteDescriptor;
      Logger.trace(LOG_PREFIX, "Remote descriptor set", {
        elementId: this.id, type: this.type, router: this.routerId,
        transport: this.transportSet.id,
      });
    }

    const transducingRoutines = kindDirectionMap.map(({ kind, direction }) => {
      return this._processMediaOffer(kind, direction, options);
    });

    this.kindParametersMap = await Promise.all(transducingRoutines).then(explodedKmap => {
      return explodedKmap.flatMap(x => x);
    });

    if (this.localDescriptor == null) {
      this.localDescriptor = SDPTranslator.assembleSDP(this.kindParametersMap, {
        transportOptions: this.transportSet.transportOptions,
        adapterOptions: this.adapterOptions,
      });


      Logger.trace(LOG_PREFIX, "Local descriptor set", {
        elementId: this.id, type: this.type, routerId: this.routerId,
        transportId: this.transportSet.id, descriptor: this.localDescriptor,
      });
    }

    if (options.remoteDescriptor) {
      // TODO *ahem*
      await this.connectTransport(options.remoteDescriptor, kindDirectionMap[0].kind);
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

  async _connect (sourceElement, connectionType) {
    const kinds = mapConnectionTypeToKind(connectionType);
    const kmapPatch = await Promise.all(kinds.map(kind => {
      const producer = sourceElement.getProducerOfKind(kind);
      const rtpParams = {
        codecs: enrichCodecsArrayWithPreferredPT(
          producer.rtpParameters.codecs
        ),
      };

      return this._consume(producer, kind, rtpParams).then((consumer) => {
        return {
          kind,
          direction: 'recvonly',
          offerRtpParameters: consumer.rtpParameters,
          streamId: consumer.rtpParameters.rtcp.cname,
          trackId: consumer.id,
        };
      })
    }));

    if (kmapPatch.length >= 1) {
      this.kindParametersMap = [...this.kindParametersMap, ...kmapPatch];
      this.localDescriptor = SDPTranslator.assembleSDP(this.kindParametersMap, {
        transportOptions: this.transportSet.transportOptions,
        adapterOptions: this.adapterOptions,
      });

      this._resumeAllConsumers();
      return this.localDescriptor;
    } else {
      return this.localDescriptor;
    }
  }
}
