'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const { getRouter } = require('./routers.js');
const { getElement } = require('./media-elements.js');
const TransportSet = require('./transports.js');
const { v4: uuidv4 }= require('uuid');
const EventEmitter = require('events').EventEmitter;
const {
  getMappedTransportType,
  getCodecFromMimeType,
} = require('./utils.js');
const {
  MCSPrometheusAgent,
  METRIC_NAMES,
} = require('../../metrics/index.js');

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
    this._transportSet;
    this.producers = new Map();
    this.consumers = new Map();
    this.connected = false;
    this.negotiated = false;
  }

  set transportSet (_transportSet) {
    this._transportSet = _transportSet;
  }

  get transportSet () {
    return this._transportSet;
  }

  _consumerSourceHasProducers (source) {
    if (source) {
      return (source.getNumberOfProducers() > 0);
    }

    return false;
  }

  _getMode (sourceAdapterElementIds = []) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      const source = this._getConsumerSource(sourceAdapterElementIds);
      if (this._consumerSourceHasProducers(source)) {
        return 'consumer';
      }
    }

    return 'producer';
  }

  _getConsumerSource (sourceAdapterElementIds = []) {
    // TODO multiple sources
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      return getElement(sourceAdapterElementIds[0]);
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
    MCSPrometheusAgent.increment(METRIC_NAMES.MEDIASOUP_PRODUCERS, {
      type: producer.type,
      kind: producer.kind,
      transport_type: getMappedTransportType(this.transportSet.type)
    });

    return true;
  }

  getProducerOfKind (kind) {
    let targetProducer;

    this.producers.forEach((producer) => {
      if (producer.kind === kind) {
        targetProducer = producer;
        return;
      }
    });

    return targetProducer;
  }

  getNumberOfProducers () {
    return this.producers.size;
  }

  getProducer (id) {
    return this.producers.get(id);
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

    if (producer && this.producers.delete(producer.id)) {
      MCSPrometheusAgent.decrement(METRIC_NAMES.MEDIASOUP_PRODUCERS, {
        type: producer.type,
        kind: producer.kind,
        transport_type: getMappedTransportType(this.transportSet.type)
      });

      return true;
    }

    return false;
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
    MCSPrometheusAgent.increment(METRIC_NAMES.MEDIASOUP_CONSUMERS, {
      type: consumer.type,
      kind: consumer.kind,
      transport_type: getMappedTransportType(this.transportSet.type)
    });

    return true;
  }

  getConsumer (id) {
    return this.consumers.get(id);
  }

  getConsumerOfKind (kind) {
    let targetConsumer;

    this.consumers.forEach((consumer) => {
      if (consumer.kind === kind) {
        targetConsumer = consumer;
        return;
      }
    });

    return targetConsumer;
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

    if (consumer && this.consumers.delete(consumer.id)) {
      MCSPrometheusAgent.decrement(METRIC_NAMES.MEDIASOUP_CONSUMERS, {
        type: consumer.type,
        kind: consumer.kind,
        transport_type: getMappedTransportType(this.transportSet.type)
      });

      return true;
    }

    return false;
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

  _extractRecConfigsFromProducers () {
    const recCodecs = {};
    const recCodecParameters = [];

    this.producers.forEach((producer) => {
      if (recCodecs[producer.kind] == null) {
        const producerCodecs = producer.rtpParameters.codecs;
        recCodecs[producer.kind] = 'copy';
        recCodecParameters.push({
          kind: producer.kind,
          rtpProfile: 'RTP/AVPF',
          codec: getCodecFromMimeType(producerCodecs[0].mimeType),
          codecRate: producerCodecs[0].clockRate,
          producerId: producer.id,
        });
      }
    });

    return { recCodecs, recCodecParameters };
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
        // Short-circuit: one producer per transport as it is now.
        // FIXME will change info the near future (single transport, N ps/cs)
        let producer = this.getProducerOfKind(kind);
        if (producer) return resolve(producer);

        producer = await this.transportSet.transport.produce({
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

  consume (kind, rtpCapabilities, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const source = this._getConsumerSource(options.sourceAdapterElementIds);
        const producer = source.getProducerOfKind(kind);

        if (source == null || producer == null) {
          throw handleError({
            ...C.ERROR.MEDIA_NOT_FOUND,
            details: "MEDIASOUP_CONSUMER_SOURCE_NOT_FOUND"
          });
        }

        // Short-circuit: one consumer per transport as it is now.
        // FIXME will change info the near future (single transport, N ps/cs)
        let consumer = this.getConsumerOfKind(kind);
        if (consumer) return resolve(consumer);

        consumer = await this.transportSet.transport.consume({
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

  _stop () { // : Promise<void> {
    // To be implemented by inheritors
    return Promise.resolve();
  }

  async stop () {
    if (this.transportSet && typeof this.transportSet.stop === 'function') {
      await this.transportSet.stop();
    }

    return this._stop();
  }
}
