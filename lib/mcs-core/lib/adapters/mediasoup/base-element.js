'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const { getRouter } = require('./routers.js');
const { getElement } = require('./media-elements.js');
const TransportSet = require('./transports.js');
const { v4: uuidv4 }= require('uuid');
const EventEmitter = require('events').EventEmitter;

module.exports = class BaseMediasoupElement extends EventEmitter {
  static _unsupported (details) {
    throw handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details,
    });
  }

  constructor(type, routerId) {
    super();
    this.id = uuidv4();
    this.type = type;
    this.routerId = routerId;
    this.transportSet;
    this.producers = new Map();
    this.consumers = new Map();
    this.connected = false;
    this.negotiated = false;
  }

  _getMode (sourceAdapterElementIds = []) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      if (this._getConsumerSource(sourceAdapterElementIds)) {
        return 'consumer';
      }
    }

    return 'producer';
  }

  _getConsumerSource (sourceAdapterElementIds = []) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      const source = getElement(sourceAdapterElementIds[0]);
      if (source) {
        const producer = source.getFirstProducer();
        if (producer) return producer;
      }
    }

    return false;
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

    producer.once("transportclose", () => this._closeProducer(producer));
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

  _closeProducer (producer) {
    producer.close();
    this.deleteProducer(producer);
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

    if (this.hasConsumer(consumer.id)) {
      // Might be an ID collision. Throw this peer out and let the client reconnect
      throw handleError({
        ...C.ERROR.MEDIA_ID_COLLISION,
        details: "MEDIASOUP_MEL_CSM_COLLISION"
      });
    }

    consumer.once("transportclose", () => this._closeConsumer(consumer));
    consumer.once("producerclose", () => this._closeConsumer(consumer));
    this.consumers.set(consumer.id, consumer);
    return true;
  }

  getConsumer (id) {
    return this.consumers.get(id);
  }

  hasConsumer (id) {
    return this.consumers.has(id);
  }

  _closeConsumer (consumer) {
    consumer.close();
    this.deleteConsumer(consumer);
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
      if (this.transportSet && this.transportSet.transport) {
        return this.transportSet;
      }

      const router = getRouter(this.routerId);
      if (router == null) throw (C.ERROR.ROOM_NOT_FOUND);
      this.transportSet = new TransportSet(this.type, router.internalAdapterId);
      this.host = this.transportSet.host;
      return this.transportSet.createTransportSet(options);
    } catch (error) {
      throw (handleError(error));
    }
  }

  _negotiate (descriptor, options) {
    return BaseMediasoupElement._unsupported("MEDIASOUP_MUST_IMPLEMENT_NEGOTIATE");
  }

  negotiate (descriptor, options) {
    return this._negotiate(descriptor, options);
  }

  produce (kind, rtpParameters, paused = false) {
    return new Promise(async (resolve, reject) => {
      try {
        const producer = await this.transportSet.transport.produce({
          kind,
          rtpParameters,
          paused,
        });

        this.storeProducer(producer);
        return resolve(producer);
      } catch (error) {
        reject(error);
      }
    });
  }

  consume (rtpCapabilities, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const producer = this._getConsumerSource(options.sourceAdapterElementIds);

        if (producer == null) {
          throw handleError({
            ...C.ERROR.MEDIA_NOT_FOUND,
            details: "MEDIASOUP_CONSUMER_SOURCE_NOT_FOUND"
          });
        }

        const consumer = await this.transportSet.transport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        this.storeConsumer(consumer);
        return resolve(consumer);
      } catch (error) {
        reject(error);
      }
    });
  }

  // BEGIN EVENT BLOCK
  _trackTransportSetEvents () {}

  trackTransportSetEvents () {
    this._trackTransportSetEvents();
  }
  // END EVENT BLOCK

  stop () {
    if (this.transportSet && typeof this.transportSet.stop === 'function') {
      return this.transportSet.stop();
    }

    return Promise.resolve();
  }
}
