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

  _getActualMediaType (mediaTypes) {
    return !!mediaTypes.audio ? 'audio' : 'video';
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

  _generateOffererProducerCaps (actualMediaType) {
    const codecs = config.util.cloneDeep(ROUTER_SETTINGS.mediaCodecs)
      .filter(codec => codec.kind === actualMediaType)
      .map(codec => {
        codec.payloadType = codec.preferredPayloadType
        return codec;
      });


    return {
      rtpParams: {
        mid: '1',
        codecs,
        encodings: [{}],
      },
      setup: 'actpass',
    }
  }

  _getRTPParameters (mediaTypes, { remoteDescriptor, sourceAdapterElementIds }) {
    const mode = this._getMode(sourceAdapterElementIds);
    const actualMediaType = this._getActualMediaType(mediaTypes);

    // If there's a remote descriptor in the options param, we need to extract
    // the RTP params for an answer
    if (remoteDescriptor) {
      const baseCaps = SoupSDPU.extractRtpCapabilities({ sdpObject: remoteDescriptor });
      return {
        rtpParams: SDPTranslator.extractRTPParams(baseCaps, remoteDescriptor, actualMediaType, mode),
        setup: 'active',
      }
    }

    // There's no remote description set. We need to extract RTP params for a
    // local description as an offer
    if (mode === 'consumer') {
      const producer = this._getConsumerSource(sourceAdapterElementIds);
      return {
        rtpParams: {
          codecs: producer.rtpParameters.codecs,
        },
        setup: 'actpass',
      }
    } else {
      return this._generateOffererProducerCaps(actualMediaType);
    }
  }

  processSDPOffer (mediaTypes, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const actualMediaType = this._getActualMediaType(mediaTypes);
        const mode = this._getMode(options.sourceAdapterElementIds);
        const { rtpParams, setup } = this._getRTPParameters(mediaTypes, options);
        let offerRtpParameters;
        let rtcpStreamId;

        if (mode === 'producer') {
          ({ offerRtpParameters, rtcpStreamId } = await this._processProducerSDPOffer(
            actualMediaType, rtpParams
          ));
        } else {
          ({ offerRtpParameters, rtcpStreamId } = await this._processConsumerSDPOffer(
            rtpParams, options
          ));
        }

        const localDescriptor = SDPTranslator.assembleSDP(mediaTypes, {
          transportOptions: this.transportSet.transportOptions,
          kind: actualMediaType,
          offerRtpParameters,
          streamId: rtcpStreamId,
          setup,
        });


        if (this.type === C.MEDIA_TYPE.WEBRTC && options.remoteDescriptor) {
          const dtlsParameters = SoupSDPU.extractDtlsParameters({ sdpObject: options.remoteDescriptor });
          this.dtlsParameters = dtlsParameters;
          this.transportSet.connect(dtlsParameters).then(() => {
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
        return resolve(localDescriptor);
      } catch (err) {
        return reject(handleError(err));
      }
    })
  }

  // BEGIN EVENT BLOCK
  _handleTransportIceStateChange (iceState) {
    Logger.debug(LOG_PREFIX, 'Media element ICE state changed',
      { elementId: this.id, iceState });

    if (iceState === 'completed') {
      // Not that great of an event mapping, but that's my fault for not abstracting
      // Kurento events out of this pit -- prlanzarin
      const event = {
        state: "FLOWING",
      };
      this.emit(C.EVENT.MEDIA_STATE.FLOW_OUT, event);
    }
  }

  _trackTransportSetEvents () {
    this.transportSet.transport.on('icestatechange', this._handleTransportIceStateChange.bind(this));
  }
  // END EVENT BLOCK

  stop () {
    if (this.transportSet && typeof this.transportSet.stop === 'function') {
      return this.transportSet.stop();
    }

    return Promise.resolve();
  }
}
