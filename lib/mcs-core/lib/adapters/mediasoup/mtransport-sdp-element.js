'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const { filterValidMediaTypes } = require('./utils.js');
const { getRouter } = require('./routers.js');
const BaseMediasoupElement = require('./base-element.js');
const MediasoupSDPElement = require('./sdp-element.js');
const TransportSet = require('./transports.js');
const MediaElements = require('./media-elements.js');
const SDPTranslator = require('./sdp-translator.js');
const Logger = require('../../utils/logger');
const { LOG_PREFIX } = require('./configs.js');

module.exports = class MultiTransportSDPElement extends BaseMediasoupElement {
  constructor(type, routerId, options) {
    super(type, routerId, options);
    this._transportSets = new Map();
    this._internalSDPElements = new Map();
    this.mappedMediaTypes;
  }

  get host () {
    // Host pseudo-models should be the same for all transports in split-transport
    // elements, so the first one is good enough
    const firstTransportSet = this._transportSets.values().next().value;
    return firstTransportSet ? firstTransportSet.host : null;
  }

  _cleanup () {
    this._transportSets.forEach(async (transportSet, mediaType) => {
      try {
        await transportSet.stop();
      } catch (error) {
        Logger.error(LOG_PREFIX, 'Failure cleaning multi-transport transport set', {
          errorMessage: error.message, elementId: this.id, mediaType,
          transportId: transportSet.id,
        });
      } finally {
        this._transportSets.delete(mediaType);
      }
    });

    this._internalSDPElements.forEach(async (internalElement, mediaType) => {
      try {
        await internalElement.stop();
      } catch (error) {
        Logger.error(LOG_PREFIX, 'Failure cleaning multi-transport internal element', {
          errorMessage: error.message, elementId: this.id, mediaType,
          internalElementId: internalElement.id,
        });
      } finally {
        this._internalSDPElements.delete(mediaType);
      }
    });
  }

  _stop () { // : Promise<void> {
    this._cleanup();
    return Promise.resolve();
  }

  _negotiate (mediaTypes, options) {
    switch (this.type) {
      case C.MEDIA_TYPE.RTP:
      case C.MEDIA_TYPE.WEBRTC:
        return this._negotiateSDPEndpoint(mediaTypes, options);
      case C.MEDIA_TYPE.RECORDING:
      case C.MEDIA_TYPE.URI:
      default:
        BaseMediasoupElement._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
    }
  }

  _createTransportSet (options = {}) {
    try {
      const router = getRouter(this.routerId);
      if (router == null) throw (C.ERROR.ROOM_NOT_FOUND);
      const transportSet = new TransportSet(this.type, router.internalAdapterId);
      return transportSet.createTransportSet(options);
    } catch (error) {
      throw (handleError(error));
    }
  }

  async _negotiateSDPEndpoint (mediaTypes, options) {
    try {
      const profiles = options.profiles || {};
      this.mappedMediaTypes = filterValidMediaTypes({ ...mediaTypes, ...profiles });
      let partialDescriptorsWithMType = [];

      if (options.remoteDescriptor) {
        partialDescriptorsWithMType = SDPTranslator.generateOneSDPObjectPerMediaType(
          options.remoteDescriptor
        );
        this.remoteDescriptor = options.remoteDescriptor;
      }

      const transducingRoutines = Object.entries(this.mappedMediaTypes)
        .map(async ([ mediaType, direction ]) => {
          let shortCircuitedNegotiation = false;
          const partialMediaType = { [mediaType]: direction };

          let transportSet = this._transportSets.get(mediaType);

          if (transportSet == null) {
            transportSet = await this._createTransportSet(options);
            this._transportSets.set(mediaType, transportSet);
          }

          let internalSDPElement = this._internalSDPElements.get(mediaType);

          if (internalSDPElement == null) {
            internalSDPElement = new MediasoupSDPElement(this.type, this.routerId, {
              transportSet,
            });
            MediaElements.storeElement(internalSDPElement.id, internalSDPElement);
            this._internalSDPElements.set(mediaType, internalSDPElement);
          } else {
            shortCircuitedNegotiation = true;
          }

          let internalElementOptions = options;
          if (partialDescriptorsWithMType.length > 0)  {
            const descriptorWithType = partialDescriptorsWithMType.find((dWMT) => {
              dWMT.mediaType === mediaType;
            });

            if (descriptorWithType && descriptorWithType.descriptor) {
              internalElementOptions = {
                ...options,
                remoteDescriptor: SDPTranslator.stringifySDP(descriptorWithType.descriptor),
              }
            }
          }

          let localDescriptor;

          if (!shortCircuitedNegotiation) {
            localDescriptor = await internalSDPElement.negotiate(
              partialMediaType, internalElementOptions,
            );
          } else {
            localDescriptor = await internalSDPElement.processSDPOffer(
              partialMediaType, internalElementOptions,
            );
          }
          return localDescriptor;
        });

      const localPartialDescriptors = await Promise.all(transducingRoutines);
      const mergedSDP = SDPTranslator.mergeSameSourceSDPs(localPartialDescriptors);

      return mergedSDP
    } catch (error) {
      // Rollback
      this._cleanup();
      throw error;
    }
  }

  processSDPOffer (mediaTypes, options) {
    return this._negotiateSDPEndpoint(mediaTypes, options)
  }
}
