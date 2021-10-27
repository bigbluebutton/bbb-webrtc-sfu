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
const { v4: uuidv4 }= require('uuid');
const { enrichCodecsArrayWithPreferredPT } = require('./utils.js');

module.exports = class MediasoupSDPElement extends BaseMediasoupElement {
  constructor(type, routerId, options) {
    super(type, routerId, options);
  }

  _negotiate (mediaTypes, options) {
    try {
      switch (this.type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiatePRTPEndpoint(mediaTypes, options);
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(mediaTypes, options);
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

  _negotiateSDPEndpoint (mediaTypes, options) {
    try {
      return new Promise(async (resolve, reject) => {
        try {
          await this.createTransportSet(options);
          this._trackTransportSetEvents();
          const localDescriptor = await this.processSDPOffer(mediaTypes, options);

          resolve(localDescriptor);
        } catch (err) {
          reject(handleError(err));
        }
      });
    } catch (err) {
      throw(handleError(err));
    }
  }

  async _negotiateWebRTCEndpoint (mediaTypes, options) {
    try {
      const medias = await this._negotiateSDPEndpoint(mediaTypes, options);
      return medias;
    } catch (err) {
      throw(handleError(err));
    }
  }

  async _negotiatePRTPEndpoint (mediaTypes, options) {
    try {
      const medias = await this._negotiateSDPEndpoint(mediaTypes, options);
      return medias;
    } catch (err) {
      throw(handleError(err));
    }
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

  _processProducerSDPOffer (kind, rtpParameters, paused = false) {
    return new Promise(async (resolve, reject) => {
      try {
        const producer = await this.produce(kind, rtpParameters, paused);
        // FIXME yeah... we really don't want to rely on single negotiation
        this.negotiated = true;

        return resolve({
          trackId: producer.id,
          offerRtpParameters: producer.rtpParameters,
          rtcpStreamId: producer.rtpParameters.rtcp.cname,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async _processConsumerSDPOffer (mediaType, rtpCapabilities, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const consumer = await this.consume(mediaType, rtpCapabilities, options)
        // FIXME yeah... we really don't want to rely on single negotiation
        this.negotiated = true;

        return resolve({
          trackId: consumer.id,
          offerRtpParameters: consumer.rtpParameters,
          rtcpStreamId: consumer.rtpParameters.rtcp.cname,
        });
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

  processSDPOffer (mediaTypes, options) {
    return new Promise(async (resolve, reject) => {
      try {
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

        let kindParametersMap = [];

        const transducingRoutines = actualMediaTypes.map((actualMediaType) => {
          return new Promise(async (resolve, reject) => {
            try {
              const { rtpParams, setup } = await this._getRTPParameters(actualMediaType, options);
              let offerRtpParameters;
              let rtcpStreamId;
              let trackId;

              // We as answerers
              if (this.remoteDescriptor) {
                if (mode === 'producer') {
                  ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processProducerSDPOffer(
                    actualMediaType, rtpParams
                  ));
                } else {
                  ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processConsumerSDPOffer(
                    actualMediaType, rtpParams, options
                  ));
                }
              } else { // We as offerers
                if (mode == 'consumer') {
                  ({ offerRtpParameters, rtcpStreamId, trackId } = await this._processConsumerSDPOffer(
                    actualMediaType, rtpParams, options
                  ));
                } else {
                  offerRtpParameters = rtpParams;
                  rtcpStreamId = rtpParams.rtcp.cname;
                  trackId = uuidv4();
                }
              }

              kindParametersMap.push({
                actualMediaType,
                offerRtpParameters,
                streamId: rtcpStreamId,
                trackId,
                setup,
              });

              return resolve();
            } catch (error) {
              reject(error);
            }
          });
        });

        await Promise.all(transducingRoutines);

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
        };

        if (options.remoteDescriptor) {
          await this.connectTransport(options.remoteDescriptor, actualMediaTypes[0]);
        }

        return resolve(this.localDescriptor);
      } catch (error) {
        return reject(handleError(error));
      }
    })
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
