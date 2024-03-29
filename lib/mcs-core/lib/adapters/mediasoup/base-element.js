'use strict';

const config = require('config');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const { getRouter } = require('./routers.js');
const { getElement } = require('./media-elements.js');
const TransportSet = require('./transports.js');
const { v4: uuidv4 }= require('uuid');
const EventEmitter = require('events').EventEmitter;
const {
  getSpecEntryFromMimeType,
  mapConnectionTypeToKind,
} = require('./utils.js');
const { PrometheusAgent, MS_METRIC_NAMES } = require('./prom-metrics.js');
const Logger = require('../../utils/logger');
const { MS_MODES } = require('./constants.js');
const {
  WEBRTC_HEADER_EXTS,
  DEFAULT_MAX_IN_BW,
  DEFAULT_MAX_OUT_BW,
  ENABLE_WORKER_TRANSPOSING,
} = require('./configs.js');

module.exports = class BaseMediasoupElement extends EventEmitter {
  static _unsupported (details) {
    throw handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details,
    });
  }

  _processOptions (options) {
    // There's a pre-built transportSet that someone's passed to the constructor.
    if (typeof options.transportSet === 'object') {
      this.transportSet = options.transportSet;
    }

    if (typeof options.adapterOptions === 'object') {
      this.adapterOptions = options.adapterOptions;
    }

    if (typeof options.mediaSpecs === 'object') {
      this.mediaSpecs = options.mediaSpecs;
    }
  }

  constructor(type, routerId, options = {}) {
    super();
    this.id = uuidv4();
    this.type = type;
    this.routerId = routerId;
    this._transportSet;
    this.producers = new Map();
    this.consumers = new Map();
    this.connected = false;
    this.negotiated = false;
    this.adapterOptions = {};
    this.rtpHeaderExtensions = WEBRTC_HEADER_EXTS;
    this.pipes = new Map();

    this._currentMaxIncomingBitrate = DEFAULT_MAX_IN_BW;
    this._currentMaxOutgoingBitrate = DEFAULT_MAX_OUT_BW;

    this._processOptions(options);

    this._handleTransportIceStateChange = this._handleTransportIceStateChange.bind(this);
  }

  set adapterOptions (aOpt) {
    this._adapterOptions = { ...this._adapterOptions, ...aOpt };

    // Update sibling options
    if (this.adapterOptions.rtpHeaderExtensions) {
      this.rtpHeaderExtensions = this.adapterOptions.rtpHeaderExtensions;
    }
  }

  get adapterOptions () {
    return this._adapterOptions;
  }

  set transportSet (_transportSet) {
    this._transportSet = _transportSet;
  }

  get transportSet () {
    return this._transportSet;
  }

  get host () {
    return this._host;
  }

  set host (host) {
    this._host = host;
  }

  _consumerSourceHasProducers (source) {
    if (source) {
      return (source.getNumberOfProducers() > 0);
    }

    return false;
  }

  _getMode (direction, options = {}) {
    const { sourceAdapterElementIds = [] } = options;
    let inferredDirection;

    // This is producer-only until verified otherwise in the next if block
    // Which means: sendrecv => sendonly
    //              sendonly|recvonly => sendonly|recvonly
    // Those inferred values are later enriched with a consumer direction if
    // it's necessary (ie if consumer && sendonly => sendrecv)
    switch (direction) {
      case 'sendrecv':
        inferredDirection = 'sendonly';
        break;
      case 'sendonly':
      case 'recvonly':
      default:
        inferredDirection = direction;
        break;
    }

    if (direction !== 'recvonly' && sourceAdapterElementIds.length >= 1) {
      const sources = this._getConsumerSources(sourceAdapterElementIds);
      if (sources.some(source => this._consumerSourceHasProducers(source))) {
        inferredDirection = 'sendrecv';
      }
    }

    switch (inferredDirection) {
      case 'sendonly':
        return MS_MODES.PRODUCER;
      case 'recvonly':
        return MS_MODES.CONSUMER;
      case 'sendrecv':
      default:
        return MS_MODES.TRANSCEIVER;
    }
  }

  _getConsumerSource (sourceAdapterElementIds = []) {
    // TODO multiple sources
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      return getElement(sourceAdapterElementIds[0]);
    }

    return;
  }

  _getConsumerSources (sourceAdapterElementIds = []) {
    if (sourceAdapterElementIds && sourceAdapterElementIds.length >= 1) {
      return sourceAdapterElementIds.reduce((sources, sourceId) => {
        const source = getElement(sourceId);
        if (source) {
          sources.push(source);
        }

        return sources;
      }, []);
    }

    return [];
  }

  _resumeAllConsumers () {
    // Look up for a list of consumers that are paused to resume them.
    this.consumers.forEach((consumer) => {
      if (!consumer.paused) return;
      consumer.resume().catch(error => {
        Logger.error('mediasoup: consumer.resume failed', {
          elementId: this.id,
          type: this.type,
          routerId: this.routerId,
          transportId: this.transportSet.id,
          consumerInfo: {
            consumerId: consumer.id,
            consumerKind: consumer.kind,
            consumerType: consumer.type,
            consumerPaused: consumer.paused,
            producerId: consumer.producerId,
            producerPaused: consumer.producerPaused,
          },
          error,
        });
      });
    });
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
    this.updateMaxIncomingBitrate();
    Logger.debug('mediasoup: producer added', {
      elementId: this.id, type: this.type, producerId: producer.id,
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

  _closePipe (pipe) {
    if (!pipe) return;
    if (pipe.pipeProducer) pipe.pipeProducer.close();
    if (pipe.pipeConsumer) pipe.pipeConsumer.close();
    if (pipe.pipeDataConsumer) pipe.pipeDataConsumer.close();
    if (pipe.pipeDataProducer) pipe.pipeDataProducer.close();
    this.pipes.delete(pipe.id);

    Logger.debug('mediasoup: pipe closed', {
      elementId: this.id,
      type: this.type,
      pipeId: pipe.id,
      sourceRouterId: this.routerId,
      targetRouterId: pipe.routerId,
      producerId: pipe.producerId,
      pipedProducerId: pipe.pipeProducer.id,
    });
  }

  _closeProducer (producer) {
    producer.close();
    this.deleteProducer(producer);

    // Check if there are any pipes associated with this producer
    // Keep in mind pipe ids are in the format of `${producerId}::${routerId}`
    // So we need to filter out the pipes that are associated with this producer
    // in an unoptimized way for now
    this.pipes.forEach((pipe, pipeId) => {
      if (pipeId.startsWith(producer.id)) this._closePipe(pipe);
    });
  }

  deleteProducer (producerOrId) {
    let producer = producerOrId;

    if (typeof producerOrId === 'string') {
      // Get producer actual
      producer = this.getProducer(producerOrId);
    }

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
    this.updateMaxOutgoingBitrate();

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
      consumer = this.getConsumer(consumerOrId);
    }

    return this.consumers.delete(consumer.id);
  }

  createTransportSet (options = {}) {
    try {
      if (this.transportSet && this.transportSet.transport) {
        return this.transportSet;
      }

      const router = getRouter(this.routerId);
      if (router == null) throw (C.ERROR.ROOM_NOT_FOUND);
      this.transportSet = new TransportSet(this.type, router.appData.internalAdapterId);
      return this.transportSet.createTransportSet(options).then(() => {
        this.host = this.transportSet.host;
        this.transportSet.setMaxIncomingBitrate(this._currentMaxIncomingBitrate);
        this.transportSet.setMaxOutgoingBitrate(this._currentMaxOutgoingBitrate);
      });
    } catch (error) {
      throw (handleError(error));
    }
  }

  // eslint-disable-next-line no-unused-vars
  _negotiate (mediaTypes, options) {
    return BaseMediasoupElement._unsupported("MEDIASOUP_MUST_IMPLEMENT_NEGOTIATE");
  }

  negotiate (mediaTypes, options) {
    return this._negotiate(mediaTypes, options);
  }

  _filterUnsupportedExts (desiredExts) {
    return desiredExts.filter(ext =>
      this.rtpHeaderExtensions.some(targetExt => ext.uri === targetExt.uri)
    );
  }

  async pipeToRouter (producerId, routerId) {
    const sourceRouter = getRouter(this.routerId);
    const targetRouter = getRouter(routerId);

    if (sourceRouter == null || targetRouter == null) {
      throw handleError({
        ...C.ERROR.ROOM_NOT_FOUND,
        details: "MEDIASOUP_ROUTER_NOT_FOUND",
      });
    }

    const pipeId = `${producerId}::${routerId}`;

    if (this.pipes.has(pipeId)) return this.pipes.get(pipeId);

    const pipe = await sourceRouter.pipeToRouter({
      producerId,
      router: targetRouter,
    });
    pipe.id = pipeId;

    this.pipes.set(pipeId, pipe);

    Logger.info('mediasoup: pipe created', {
      elementId: this.id,
      type: this.type,
      pipeId,
      sourceRouterId: this.routerId,
      targetRouterId: routerId,
      producerId,
      pipedProducerId: pipe.pipeProducer.id,
    });

    return pipe;
  }

  async produce (kind, rtpParameters, {
    paused = false,
    appData = {},
  }) {
    try {
      // Short-circuit: one producer per transport as it is now.
      // FIXME will change info the near future (single transport, N ps/cs)
      let producer = this.getProducerOfKind(kind);
      if (producer) return producer;

      if (this.type === C.MEDIA_TYPE.WEBRTC) {
        if (rtpParameters.headerExtensions == null) {
          rtpParameters.headerExtensions = this.rtpHeaderExtensions;
        } else {
          rtpParameters.headerExtensions = this._filterUnsupportedExts(rtpParameters.headerExtensions);
        }
      }

      producer = await this.transportSet.transport.produce({
        kind,
        rtpParameters,
        paused,
        appData,
      });

      this.storeProducer(producer);
      return producer;
    } catch (error) {
      const transportId = this.transportSet ? this.transportSet.id : undefined;
      Logger.error('mediasoup: producer creation failed', {
        errorMessage: error.message, elementId: this.id, transportId,
        type: this.type, kind, rtpParameters,
      });
      throw error;
    }
  }

  _getEnrichedRtpCapsHeaderExts (kind, sourceExts) {
    sourceExts.forEach(ext => {
      ext.kind = kind;
      ext.preferredId = ext.id;
    });

    return sourceExts;
  }

  async _consume (source, producer, kind, rtpCapabilities, {
    appData = {},
  } = {}) {
    let actualProducer = producer;

    if (this.type === C.MEDIA_TYPE.WEBRTC) {
      if (rtpCapabilities.headerExtensions == null) {
        if (!Object.isExtensible(this.rtpHeaderExtensions)) {
          this.rtpHeaderExtensions = config.util.cloneDeep(this.rtpHeaderExtensions);
        }
        rtpCapabilities.headerExtensions = this._getEnrichedRtpCapsHeaderExts(kind, this.rtpHeaderExtensions);
      } else {
        rtpCapabilities.headerExtensions = this._filterUnsupportedExts(rtpCapabilities.headerExtensions);
      }
    }

    if (source.routerId !== this.routerId) {
      if (ENABLE_WORKER_TRANSPOSING) {
        // Pipe the source to this router
        ({ pipeProducer: actualProducer } = await source.pipeToRouter(producer.id, this.routerId));
      } else {
        throw handleError({
          ...C.ERROR.MEDIA_INVALID_OPERATION,
          details: "MEDIASOUP_CONSUMER_SOURCE_IN_ANOTHER_ROUTER",
        });
      }
    }

    const consumer = await this.transportSet.transport.consume({
      producerId: actualProducer.id,
      rtpCapabilities,
      paused: true,
      appData,
    });

    this.storeConsumer(consumer);

    Logger.debug('mediasoup: consumer added', {
      elementId: this.id, type: this.type, consumerId: consumer.id,
      producerId: producer.id,
      piped: source.routerId !== this.routerId,
    });

    return consumer;
  }

  async consume (kind, rtpCapabilities, options) {
    try {
      const source = this._getConsumerSource(options.sourceAdapterElementIds);
      const producer = source?.getProducerOfKind(kind);

      if (source == null || producer == null) {
        throw handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: "MEDIASOUP_CONSUMER_SOURCE_NOT_FOUND"
        });
      }

      // Short-circuit: one consumer per transport as it is now.
      // FIXME will change info the near future (single transport, N ps/cs)
      let consumer = this.getConsumerOfKind(kind);
      if (consumer) return consumer;

      consumer = await this._consume(source, producer, kind, rtpCapabilities, options);

      return consumer;
    } catch (error) {
      const transportId = this.transportSet ? this.transportSet.id : undefined;
      Logger.error('mediasoup: consumer creation failed', {
        errorMessage: error.message,
        details: error.details,
        elementId: this.id,
        transportId,
        type: this.type,
        kind,
        rtpCapabilities,
      });
      throw error;
    }
  }

  async connect (sourceElement, type) {
    return this._connect(sourceElement, type);
  }

  // Users changeProducer to set this element's consumers to sourceElement's
  // producers
  async changeProducer(sourceElement, type) {
    try {
      const mappedType = mapConnectionTypeToKind(type)[0];
      const change = async (consumer) => {
        // consumer.changeProducer is only available in a forked version of mediasoup
        // If it's unavailable, no-op
        if (typeof consumer.changeProducer !== 'function') {
          Logger.debug('mediasoup: changeProducer not available');
          return;
        }

        if (consumer.kind !== mappedType) return;

        const producer = sourceElement.getProducerOfKind(consumer.kind);
        let actualProducer = producer;

        if (sourceElement.routerId !== this.routerId) {
          if (ENABLE_WORKER_TRANSPOSING) {
            // Pipe the source to this router
            ({ pipeProducer: actualProducer } = await sourceElement.pipeToRouter(producer.id, this.routerId));
          } else {
            throw handleError({
              ...C.ERROR.MEDIA_INVALID_OPERATION,
              details: "MEDIASOUP_CONSUMER_SOURCE_IN_ANOTHER_ROUTER",
            });
          }
        }

        if (actualProducer && consumer.producerId !== actualProducer.id) {
          consumer.changeProducer(producer.id);
        }
      };

      const promiseChain = [];

      this.consumers.forEach((consumer) => {
        promiseChain.push(change(consumer));
      });

      await Promise.all(promiseChain);
    } catch (error) {
      Logger.error('mediasoup: changeProducer failed', {
        error,
        errorMessage: error.message,
        elementId: this.id,
        sourceElementId: sourceElement.id,
        type,
      });
    }
  }

  _restartIce () {
    // To be implemented by inheritors
    throw new TypeError('element::restartIce::not-implemented');
  }

  async restartIce () {
    if (this.type === C.MEDIA_TYPE.WEBRTC) {
      return this._restartIce();
    } else throw handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: 'Invalid type for restartIce',
    });
  }

  _fetchSourceBitrateFromSpec(source) {
    let bitrate = 0;
    const codecs = source.rtpParameters.codecs;
    if (codecs == null || !codecs.length) return bitrate;

    try {
      const specCodec = getSpecEntryFromMimeType(this.mediaSpecs, codecs[0].mimeType);
      if (specCodec) {
        switch (source.appData.mediaTypeHint) {
          case 'main':
          case 'video':
            bitrate = parseInt(specCodec['tias_main']);
            break;
          case 'content':
            bitrate = parseInt(specCodec['tias_content']);
            break;
          case 'audio':
            bitrate = parseInt(specCodec['maxaveragebitrate']);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      Logger.debug('mediasoup: failed to get bitrate for source from spec', {
        elementId: this.id,
        type: this.type,
        sourceId: source.id,
        errorMessage: error.message,
      });
    }

    return bitrate;
  }

  updateMaxIncomingBitrate () {
    if (this.mediaSpecs) {
      let estimatedBitrate = 0;
      this.producers.forEach((producer) => {
        const bitrate = this._fetchSourceBitrateFromSpec(producer);
        if (bitrate > 0) estimatedBitrate += bitrate;
      });

      if (typeof estimatedBitrate === 'number'
        && estimatedBitrate > 0
        && estimatedBitrate !== this._currentMaxIncomingBitrate) {
        // Math.min of default
        this._currentMaxIncomingBitrate = estimatedBitrate;
        this.transportSet.setMaxIncomingBitrate(this._currentMaxIncomingBitrate);
      }
    }
  }

  updateMaxOutgoingBitrate () {
    if (this.mediaSpecs) {
      let estimatedBitrate = 0;
      this.consumers.forEach((consumer) => {
        const bitrate = this._fetchSourceBitrateFromSpec(consumer);
        if (bitrate > 0) estimatedBitrate += bitrate;
      });

      if (typeof estimatedBitrate === 'number'
        && estimatedBitrate > 0
        && estimatedBitrate !== this._currentMaxOutgoingBitrate) {
        // Math.min of default
        this._currentMaxOutgoingBitrate = estimatedBitrate;
        this.transportSet.setMaxOutgoingBitrate(this._currentMaxOutgoingBitrate);
      }
    }
  }

  requestKeyframe () {
    this.consumers.forEach((consumer) => {
      try {
        consumer.requestKeyFrame();
      } catch (error) {
        Logger.warn('mediasoup: consumer.requestKeyFrame failed', {
          errorMessage: error.message,
          elementId: this.id,
          type: this.type,
        });
      }
    });

    return Promise.resolve();
  }

  // BEGIN EVENT BLOCK

  _emitIceFailureEvent () {
    const event = {
      state: 'failed',
      elementId: this.id,
    };
    this.emit(C.EVENT.MEDIA_STATE.ICE_FAILURE, event);
  }

  _emitDtlsFailureEvent () {
    const event = {
      state: 'failed',
      elementId: this.id,
    };
    this.emit(C.EVENT.MEDIA_STATE.DTLS_FAILURE, event);
  }

  _emitFlowingEvent () {
    // Not that great of an event mapping, but that's my fault for not abstracting
    // Kurento events out of this pit -- prlanzarin
    const event = { state: "FLOWING" };
    this.emit(C.EVENT.MEDIA_STATE.FLOW_OUT, event);
  }

  _handleTransportIceStateFailed (iceState) {
    Logger.error("mediasoup: transport ICE state failed", {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id, iceState,
    });

    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_ICE_ERRORS);
    this._emitIceFailureEvent();
    if (this.transportSet?.transport) {
      this.transportSet.transport.removeListener('icestatechange', this._handleTransportIceStateChange);
    }
  }

  _handleTransportIceStateCompleted () {
    Logger.info('mediasoup: transport ICE state completed', {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id,
    });

    const iceSelectedTuple = this.transportSet.transport.iceSelectedTuple;

    Logger.debug('mediasoup: transport ICE tuple selected', {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id,
      iceSelectedTuple,
    });

    if (iceSelectedTuple?.protocol) {
      PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_ICE_TRANSPORT_PROTO, {
        protocol: iceSelectedTuple.protocol,
      });
    }

    this._emitFlowingEvent();
    this._resumeAllConsumers();
  }

  _handleTransportIceStateChange (iceState) {
    Logger.trace('mediasoup: media element ICE state changed',
      { elementId: this.id, iceState });

    switch (iceState) {
      case 'completed':
        this._handleTransportIceStateCompleted();
        break;
      case 'disconnected':
      case 'failed':
        this._handleTransportIceStateFailed(iceState);
        break;
    }
  }

  _handleTransportDTLSStateFailed () {
    Logger.error("mediasoup: wransport DTLS state failed", {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id, dtlsParameters: this.dtlsParameters,
    });

    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_DTLS_ERRORS);
    this._emitDtlsFailureEvent();
  }

  _handleTransportDTLSStateConnected () {}

  _handleTransportDTLSStateChange (dtlsState) {
    Logger.trace('mediasoup: DTLS state changed',
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

  _handleRTPTupleDiscovered (rtpTuple) {
    Logger.info('mediasoup: remote origin RTP tuple discovered', {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id, rtpTuple,
    });
    this._emitFlowingEvent();
    this._resumeAllConsumers();
  }

  _handleRTCPTupleDiscovered (rtcpTuple) {
    Logger.info('mediasoup: remote origin RTCP tuple discovered', {
      elementId: this.id, type: this.type, routerId: this.routerId,
      transportId: this.transportSet.id, rtcpTuple,
    });
  }

  _handleIceSelectedTupleChange (iceSelectedTuple) {
    Logger.trace('mediasoup: transport ICE selected tuple changed', {
      elementId: this.id,
      type: this.type,
      routerId: this.routerId,
      transportId: this.transportSet.id,
      iceSelectedTuple,
    });
  }

  _trackTransportSetEvents () {
    switch (this.type) {
      case C.MEDIA_TYPE.WEBRTC:
        this.transportSet.transport.on('icestatechange', this._handleTransportIceStateChange);
        this.transportSet.transport.on('dtlsstatechange', this._handleTransportDTLSStateChange.bind(this));
        this.transportSet.transport.on('iceselectedtuplechange', this._handleIceSelectedTupleChange.bind(this));
        break;

      case C.MEDIA_TYPE.RTP:
        this.transportSet.transport.on('tuple', this._handleRTPTupleDiscovered.bind(this));
        this.transportSet.transport.on('rtcptuple', this._handleRTCPTupleDiscovered.bind(this));
        break;

      default:
        return;
    }
  }

  trackTransportSetEvents () {
    this._trackTransportSetEvents();
  }
  // END EVENT BLOCK

  _stop () { // : Promise<void>
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
