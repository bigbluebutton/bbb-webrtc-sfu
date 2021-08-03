'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const { getRouter } = require('./routers.js');
const { getElement, storeElement, hasElement } = require('./media-elements.js');
const Logger = require('../../utils/logger');
const ADU = require('../adapter-utils.js');
const TransportSet = require('./transports.js');
const MSUtils = require('./utils.js');
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const RemoteSdp = require("mediasoup-client/lib/handlers/sdp/RemoteSdp");

module.exports = class MediasoupSDPElement {
  static _unsupported (details) {
    throw handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details,
    });
  }

  constructor(id, type, routerId) {
    this.id = id;
    this.type = type;
    this.routerId = routerId;
    this.transportSet;
    this.producers = new Map();
    this.consumers = new Map();
    this.connected = false;
    this.negotiated = false;
  }

  storeProducer (producer) {
    if (!producer) return false;

    if (this.hasProducer(producer.id)) {
      // Might be an ID collision. Throw this peer out and let the client reconnect
      throw handleError({
        ...C.ERROR.MEDIA_ID_COLLISION,
        details: "MEDIASOUP_MEL_PRD_COLLISION"
      });
    }

    this.producers.set(producer.id, producer);
    return true;
  }

  getProducer (id) {
    return this.producers.get(id);
  }

  // FIXME stop relying on this aberration
  getFirstProducer () {
    return this.producers.values().next().value;
  }

  hasProducer (id) {
    return this.producers.has(id);
  }

  deleteProducer (producerOrId) {
    let producer = producerOrId;

    if (typeof producerOrId === 'string') {
      // Get producer actual
      producer = this.getProducer(id);
    }

    if (producer == null) return false;
    return this.producers.delete(producer.id);
  }

  storeConsumer (consumer) {
    if (!consumer) return false;

    if (this.hasConsumer(id)) {
      // Might be an ID collision. Throw this peer out and let the client reconnect
      throw handleError({
        ...C.ERROR.MEDIA_ID_COLLISION,
        details: "MEDIASOUP_MEL_CSM_COLLISION"
      });
    }

    this.consumers.set(producer.id, producer);
    return true;
  }

  getConsumer (id) {
    return this.consumers.get(id);
  }

  hasConsumer (id) {
    return this.consumers.has(id);
  }

  deleteConsumer (consumerOrId) {
    let consumer = consumerOrId;

    if (typeof consumerOrId === 'string') {
      // Get consumer actual
      consumer = this.getConsumer(id);
    }

    if (consumer == null) return false;
    return this.consumers.delete(consumer.id);
  }

  createTransportSet (options = {}) {
    try {
      const router = getRouter(this.routerId);

      if (router == null) throw (C.ERROR.ROOM_NOT_FOUND);

      this.transportSet = new TransportSet(this.type, router.internalAdapterId);
      return this.transportSet.createTransportSet(options);
    } catch (error) {
      throw (handleError(error));
    }
  }

  negotiate (sdpMediaModel, options) {
    try {
      switch (this.type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiatePRTPEndpoint(sdpMediaModel, options);
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(sdpMediaModel, options);
        case C.MEDIA_TYPE.RECORDING:
          return MediasoupElement._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        case C.MEDIA_TYPE.URI:
          return Mediasoup._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
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
          let answer;

          const mediaType = ADU.parseMediaType(sdpMediaModel);
          await this.createTransportSet(options);
          const host = this.transportSet.host;

          sdpMediaModel.adapterElementId = sdpMediaModel;
          sdpMediaModel.host = host;
          sdpMediaModel.trackMedia();

          if (descriptor) {
            answer = await this.processOffer(
              sdpMediaModel,
              sdpMediaModel._remoteDescriptor._jsonSdp,
              sdpMediaModel.mediaTypes,
              options,
            );
          } else {
            answer = await this.generateOffer(media.mediaTypes, options);
          }

          answer = ADU.appendContentTypeIfNeeded(answer, mediaType);
          // media instantiation
          media.localDescriptor = answer;
          media.remoteDescriptor = descriptor;
          medias.push(media);

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

  _getMode ({ sourceAdapterElementIds = [] }) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      return 'consumer';
    }

    return 'producer';
  }

  _getConsumerSourceId ({ sourceAdapterElementIds = [] }) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      const source = getElement(options.sourceAdapterElementIds[0]);
      if (source) {
        const producer = source.getFirstProducer();
        if (producer) return producer.id;
      }
    }

    return false;
  }

  _getActualMediaType (mediaTypes) {
    return !!mediaTypes.audio ? 'audio' : 'video';
  }

  async _processProducerSDPOffer (kind, rtpParameters, paused = false) {
    try {
      const producer = await this.transport.produce({
        kind: actualMediaType,
        rtpParameters: sendRTPParams,
        paused,
      });

      this.storeProducer(producer);

      // FIXME yeah... we really don't want to rely on single negotiation
      this.negotiated = true;
      return resolve({ ...this.transport.transportOptions });
    } catch (error) {
      throw error;
    }
  }

  async _processConsumerSDPOffer (rtpCapabilities, options) {
    try {
      const producerId = this._getConsumerSourceId(options);

      if (!producerId) {
        throw handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: "MEDIASOUP_CONSUMER_SOURCE_NOT_FOUND"
        });
      }

      const consumer = await mediaElement.transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      this.storeConsumer(consumer);

      // FIXME
      this.negotiated = true;

      return resolve({ ...mediaElement.transportOptions });
    } catch (error) {
      throw error;
    }
  }

  processSDPOffer (sdpOffer, parsedSdp, mediaTypes, options)  {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.trace(LOG_PREFIX, `Processing ${elementId} offer`,
          { offer: sdpOffer });

        let mode = this._getMode(options);
        const actualMediaType = this._getActualMediaType(mediaTypes);
        const baseCaps = SoupSDPU.extractRtpCapabilities({ sdpObject: parsedSdp });
        const sendRTPParams = MSUtils.extractRTPParams(baseCaps, parsedSdp, actualMediaType);

        let opts;
        let consumer;

        if (mode === 'producer') {
          opts = await this._processProducerSDPOffer(actualMediaType, sendRTPParams);
        } else {
          opts = await this._processConsumerSDPOffer(baseCaps, options);
        }

        const reassembledSDP = new RemoteSdp.RemoteSdp({
          ...opts,
        });

        let offerRtpParameters;
        let streamId;

        if (mode === 'producer') {
          offerRtpParameters = producer.rtpParameters;
          streamId = producer.rtpParameters.rtcp.cname;
        } else {
          offerRtpParameters = consumer.rtpParameters;
          streamId = consumer.rtpParameters.rtcp.cname;
        }

        reassembledSDP.receive({
          mid: 0,
          kind: actualMediaType,
          offerRtpParameters,
          streamId,
        });

        let answer = reassembledSDP.getSdp();
        answer = answer.replace(/actpass/ig, 'active');

        if (mediaTypes.video == `sendonly` || mediaTypes.content == 'sendonly' || mediaTypes.audio === 'sendonly') {
          answer = answer.replace(/sendonly/ig, 'recvonly');
        } else {
          answer = answer.replace(/sendonly/ig, 'sendonly');
        }

        if (mediaElement.type === C.MEDIA_TYPE.WEBRTC) {
          const dtlsParameters = SoupSDPU.extractDtlsParameters({ sdpObject: parsedSdp });
          mediaElement.dtlsParameters = dtlsParameters;
        }

        return resolve(answer);
      } catch (err) {
        return reject(handleError(err));
      }
    })
  }

  stop () {
    if (this.transport && typeof this.transport.close === 'function') {
      return this.transport.close();
    }

    return Promise.resolve();
  }
}
