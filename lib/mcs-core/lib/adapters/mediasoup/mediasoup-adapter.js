'use strict'

const config = require('config');
const {
  NOF_WORKERS, WORKER_SETTINGS, ROUTER_SETTINGS, DEBUG, LOG_PREFIX,
} = require('./configs.js');
const ADU = require('../adapter-utils.js');

process.env.DEBUG = DEBUG;

const C = require('../../constants/constants.js');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');
const SDPMedia = require('../../model/sdp-media');
const RecordingMedia =require('../../model/recording-media');
const MediaElements = require('./media-elements.js');
const MediasoupSDPElement = require('./sdp-element.js');
const RecorderElement = require('./recorder-element.js');
const Routers = require('./routers.js');
const Workers = require('./workers.js');
const { ERRORS, handleError } = require('./errors.js');
const transform = require('sdp-transform');
const { annotateEventWithTimestamp } = require('../adapter-utils.js');
const MTransportSDPElement = require('./mtransport-sdp-element.js');

let instance = null;

module.exports = class MediasoupAdapter extends EventEmitter {
  constructor(name, balancer) {
    if (!instance){
      super();
      this.name = name;
      this.balancer = balancer;
      this._globalEmitter = GLOBAL_EVENT_EMITTER;
      this._globalEmitter.on(C.EVENT.ROOM_EMPTY, Routers.releaseAllRoutersWithIdSuffix.bind(this));
      Workers.createWorkers(
        NOF_WORKERS,
        WORKER_SETTINGS,
      );
      instance = this;
    }

    return instance;
  }

 negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateSDPEndpoint(
            roomId, userId, mediaSessionId, descriptor, type, options
          );
        case C.MEDIA_TYPE.RECORDING:
          return this._startRecording(
            roomId, userId, mediaSessionId, descriptor, type, options
          );
        case C.MEDIA_TYPE.URI:
          return this._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        default:
          throw(handleError(ERRORS[40107].error));
      }
    } catch (err) {
      throw(handleError(err));
    }
  }

  async _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, 'Negotiating SDP endpoint', { userId, roomId });
    try {
      const { mediaElement } = await this._createSDPMediaElement(roomId, type, options);
      const sdpMediaModel = new SDPMedia(
        roomId, userId, mediaSessionId, descriptor, null, type, this, null, null, options
      );

      if (sdpMediaModel.remoteDescriptor) {
        options.remoteDescriptor = sdpMediaModel.remoteDescriptor._jsonSdp;
      }

      const localDescriptor = await mediaElement.negotiate(
        sdpMediaModel.mediaTypes, options
      );
      sdpMediaModel.adapterElementId = mediaElement.id;
      sdpMediaModel.host = mediaElement.host;
      sdpMediaModel.trackMedia();
      const mediaProfile = ADU.parseMediaType(sdpMediaModel);
      sdpMediaModel.localDescriptor = ADU.appendContentTypeIfNeeded(
        localDescriptor, mediaProfile
      );

      return [sdpMediaModel];
    } catch (error) {
      throw (handleError(error));
    }
  }

  async _startRecording (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      const { uri, sourceMedia: sourceMediaSession } = options;
      const sourceMedia = sourceMediaSession.medias[0];
      const sourceId = sourceMedia.adapterElementId;
      const sourceElement = MediaElements.getElement(sourceId);

      if (sourceElement == null) {
        throw handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: "MEDIASOUP_RECORDER_SOURCE_NOT_FOUND",
        });
      }

      const recorderMediaModel = new RecordingMedia(
        roomId, userId, mediaSessionId, descriptor,
        null, type, this, null, null, options
      );

      // I care not for the router this one belongs to as of this moment
      const recorderElement = new RecorderElement(
        type, sourceElement.routerId, uri, sourceElement
      );

      // Notary office stuff
      recorderMediaModel.adapterElementId = recorderElement.id;
      recorderMediaModel.host = sourceElement.transportSet.host;
      MediaElements.storeElement(recorderElement.id, recorderElement);
      recorderMediaModel.trackMedia();

      await recorderElement.record(uri);

      return [recorderMediaModel];
    } catch (error) {
      // TODO rollback
      throw (handleError(error));
    }
  }

  async _getOrCreateRouter (routerIdSuffix, { sourceAdapterElementIds = [] }) {
    let targetRouterId;
    if (sourceAdapterElementIds.length >= 1) {
      const sourceElement = MediaElements.getElement(sourceAdapterElementIds[0]);
      if (sourceElement) {
        targetRouterId = sourceElement.routerId;
      }
    }

    if (targetRouterId) {
      const targetRouter = Routers.getRouter(targetRouterId);
      if (targetRouter) return targetRouter;
    }

    const worker = await Workers.getWorkerRR();
    const routerSettings = config.util.cloneDeep(ROUTER_SETTINGS);

    return Routers.getOrCreateRouter(worker, { routerIdSuffix, routerSettings });
  }

  _getSDPElementConstructor(options) {
    if (options.adapterOptions == null) return MediasoupSDPElement;
    if (options.adapterOptions.splitTransport) return MTransportSDPElement;
    return MediasoupSDPElement;
  }

  async _createSDPMediaElement (roomId, type, options = {}) {
    const router = await this._getOrCreateRouter(roomId, options);
    const ProxiedElementConstructor = this._getSDPElementConstructor(options);
    const mediaElement = new ProxiedElementConstructor(type, router.internalAdapterId);
    MediaElements.storeElement(mediaElement.id, mediaElement);
    return { mediaElement, host: mediaElement.host };
  }

  async stop (room, type, elementId) {
    try {
      const mediaElement = MediaElements.getElement(elementId);
      this._removeElementEventListeners(elementId);

      if (mediaElement) {
        await mediaElement.stop();
      } else {
        Logger.warn(LOG_PREFIX, 'Media element not found on stop', {
          elementId, roomId: room, type,
        });
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, 'CRITICAL: element stop failed', {
        errorMessage: error.message, elementId, roomId: room, type,
        errorStack: error.stack,
      });
    } finally {
      // TODO check if there's any more cleanup to be done
      MediaElements.deleteElement(elementId);
    }
  }

  async processAnswer (elementId, descriptorString, options) {
    try {
      const mediaElement = MediaElements.getElement(elementId);
      if (mediaElement) {
        Logger.trace(LOG_PREFIX, 'Processing direct answer', {
          elementId, answer: descriptorString
        });

        const localDescriptor = await mediaElement.processSDPOffer(
          options.mediaTypes, {
            remoteDescriptor: transform.parse(descriptorString),
            ...options
          }
        );
        return localDescriptor;
      }
    } catch (error) {
      throw (handleError(error));
    }
  }

  requestKeyframe (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const element = MediaElements.getElement(elementId);

        element.requestKeyframe((error) => {
          if (error) {
            return reject(handleError(error));
          }

          return resolve();
        });
      } catch (error) {
        return reject(handleError(error));
      }
    });
  }

  trackMediaState (elementId, type) {
    switch (type) {
      case C.MEDIA_TYPE.WEBRTC:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.DTLS_FAILURE, elementId)
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_FAILURE, elementId)
        break;

      case C.MEDIA_TYPE.RTP:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.RECORDING:
        this.addMediaEventListener(C.EVENT.RECORDING.STARTED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      default: return;
    }
  }

  addMediaEventListener (eventTag, elementId) {
    const mediaElement = MediaElements.getElement(elementId);

    try {
      if (mediaElement) {
        Logger.trace(LOG_PREFIX, `Adding media state listener ${eventTag}`, { eventTag, elementId });
        mediaElement.on(eventTag, (rawEvent) => {
          const event = {
            state: {
              name: eventTag,
              details: rawEvent.state || rawEvent.newState
            },
            elementId,
            rawEvent: { ...rawEvent },
          };

          this.emit(
            C.EVENT.MEDIA_STATE.MEDIA_EVENT+elementId,
            annotateEventWithTimestamp(event)
          );
        });
      }
    } catch (error) {
      handleError(error);
    }
  }

  _removeElementEventListeners (elementId) {
    const eventsToRemove = C.EVENT.ADAPTER_EVENTS.map(p => `${p}${elementId}`);
    Logger.trace(LOG_PREFIX, `Removing all event listeners for ${elementId}`);
    eventsToRemove.forEach(e => {
      this.removeAllListeners(e);
    });
  }

  // Warning: here be dragons

  _unsupported (details) {
    throw handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details,
    });
  }

  // This is fundamentally different than how Kurento (or Janus in the current
  // master/mstream branch) work and in how they allocate a peer for every
  // stream and allow you to switch producers in a single consumer without having
  // to spin up N tracks and do the pause/resume dance. In Kurento via connect,
  // in Janus (video room) via switch.
  //
  // mediasoup does not allow that (by design). The correct approach would be to
  // create a single transport per consumer and make the TRACKS in that transport
  // float up and down according to the number of publishers. And then, if you
  // do want to "switch" producers (Last N, pagination), the rationale should be:
  // 1 - Single transport for a top level subscriber
  // 2 - Multiple consumers for that single transport (M, where M is the TOTAL number
  // of producers)
  // 3 - N of those consumers should be in an active state (where N is the page size,
  // for instance). $(M-N | 0) should be PAUSED (which are the "derelict" endpoints which
  // fell out of the page.
  // 4 - When the N publisher set changes, a new consumer diff should be generated
  // and state transitions (pause<->resume) should be done accordingly for each
  // diff'd consumer
  //
  // So yeah. Some work needed (mainly client side) - prlanzarin mar 13 2021
  // eslint-disable-next-line no-unused-vars
  connect (sourceId, sinkId, type) {
    // Passthrough for now
    return Promise.resolve();
  }

  // See contract comment @connect method
  // eslint-disable-next-line no-unused-vars
  disconnect (sourceId, sinkId, type) {
    // Passthrough for now
    return Promise.resolve();
  }

  // TODO Isn't needed. Maybe figure out a way to notify adapter capabilities
  // upstream so we save some ticks trickling the call all the way down here?
  // eslint-disable-next-line no-unused-vars
  addIceCandidate (elementId, candidate) {
    return Promise.resolve();
  }

  // eslint-disable-next-line no-unused-vars
  dtmf (elementId, tone) {
    return this._unsupported("MEDIASOUP_DTMF_NOT_IMPLEMENTED");
  }
};
