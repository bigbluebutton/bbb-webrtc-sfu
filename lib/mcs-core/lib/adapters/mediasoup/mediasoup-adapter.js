'use strict'

const config = require('config');
const {
  NOF_WORKERS, WORKER_SETTINGS, ROUTER_SETTINGS, DEBUG, LOG_PREFIX,
} = require('./configs.js');

process.env.DEBUG = DEBUG;

const C = require('../../constants/constants.js');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const { hrTime } = (require('../../utils/util'));
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');
const SDPMedia = require('../../model/sdp-media');
const MediaElements = require('./media-elements.js');
const MediasoupSDPElement = require('./sdp-element.js');
const Routers = require('./routers.js');
const Workers = require('./workers.js');
const { ERRORS, handleError } = require('./errors.js');
const transform = require('sdp-transform');

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
        this._handleWorkerEvents.bind(this)
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
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
        case C.MEDIA_TYPE.RECORDING:
          return this._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        case C.MEDIA_TYPE.URI:
          return this._unsupported("MEDIASOUP_UNSUPPORTED_MEDIA_TYPE");
        default:
          throw(handleError(ERRORS[40107].error));
      }
    } catch (err) {
      throw(handleError(err));
    }
  }

  _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, 'Negotiating SDP endpoint', { userId, roomId });

    return new Promise(async (resolve, reject) => {
      try {
        let mediaElement, host;

        const sdpMediaModel = new SDPMedia(roomId, userId, mediaSessionId, descriptor, null, type, this, null, null, options);
        ({ mediaElement, host } = await this._createMediaElement(roomId, type, options));
        const medias = await mediaElement.negotiate(sdpMediaModel, options);
        resolve(medias);
      } catch (error) {
        reject(handleError(error));
      }
    });
  }

  _getOrCreateRouter (routerIdSuffix, { sourceAdapterElementIds = [] }) {
    return new Promise(async (resolve, reject) => {
      let targetRouterId;
      let router;
      try {
        if (sourceAdapterElementIds.length >= 1) {
          const sourceElement = MediaElements.getElement(sourceAdapterElementIds[0]);
          if (sourceElement) {
            targetRouterId = sourceElement.routerId;
          }
        }

        if (targetRouterId) {
          router = Routers.getRouter(targetRouterId);
          if (router) return resolve(router);
        }

        const worker = await Workers.getWorkerRR();
        const routerSettings = config.util.cloneDeep(ROUTER_SETTINGS);
        router = await Routers.getOrCreateRouter(worker, { routerIdSuffix, routerSettings });

        return resolve(router);
      } catch (error) {
        reject(error);
      }
    });
  }

  _createMediaElement (roomId, type, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const router = await this._getOrCreateRouter(roomId, options);
        const mediaElement = new MediasoupSDPElement(type, router.internalAdapterId);
        MediaElements.storeElement(mediaElement.id, mediaElement);
        router.activeElements++;
        return resolve({ mediaElement, host: mediaElement.host });
      } catch (error) {
        reject(handleError(error));
      }
    });
  }

  stop (room, type, elementId) {
    return new Promise(async (resolve) => {
      try {
        Logger.info(LOG_PREFIX, 'Releasing endpoint', { elementId, roomId: room });
        const mediaElement = MediaElements.getElement(elementId);

        this._removeElementEventListeners(elementId);

        if (mediaElement) {
          const router = Routers.getRouter(mediaElement.routerId);

          if (router) {
            router.activeElements--;
          }

          try {
            await mediaElement.stop();
            Logger.info(LOG_PREFIX, `Router elements decreased for room ${room}`,
              { activeElements: router.activeElements, roomId: room });
            if (router.activeElements <= 0) {
              await Routers.releaseRouter(router.internalAdapterId);
            }
          } catch (error) {
            Logger.error("Error releasing transpts", error);
          }

          MediaElements.deleteElement(elementId);

          return resolve();
        } else {
          Logger.warn(LOG_PREFIX, `Media element not found on stop`, { elementId });
          return resolve();
        }
      } catch (err) {
        handleError(err);
        resolve();
      }
    });
  }

  processAnswer (elementId, descriptorString, options) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaElement = MediaElements.getElement(elementId);
        if (mediaElement) {
          Logger.trace(LOG_PREFIX, `Direct processing of ${elementId} answer `, { answer: descriptorString });

          const localDescriptor = await mediaElement.processSDPOffer(
            options.mediaTypes, {
              remoteDescriptor: transform.parse(descriptorString),
              ...options
            }
          );
          return resolve(localDescriptor);
        }
      } catch (error) {
        return reject(handleError(error));
      }
    });
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
    let event;
    const mediaElement = MediaElements.getElement(elementId);

    try {
      if (mediaElement) {
        Logger.trace(LOG_PREFIX, `Adding media state listener ${eventTag}`, { eventTag, elementId });
        mediaElement.on(eventTag, (rawEvent) => {
          const timestampUTC = Date.now();
          const timestampHR = hrTime();
          switch (eventTag) {
            default:
              event = {
                state: {
                  name: eventTag,
                  details: rawEvent.state || rawEvent.newState
                },
                elementId,
                timestampUTC,
                timestampHR,
                rawEvent: { ...rawEvent },
              };
              this.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT+elementId, event);
          }
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

  _notifyWorkerDeath (workerId) {
    Logger.error(LOG_PREFIX, 'Worker died', { workerId });
  }

  _handleWorkerEvents (event, workerId) {
    switch (event) {
      case 'died':
        this._notifyWorkerDeath(workerId);
        break;
      default:
        return; //ignore
    }
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
  connect (sourceId, sinkId, type) {
    // Passthrough for now
    return resolve();
  }

  // See contract comment @connect method
  disconnect (sourceId, sinkId, type) {
    // Passthrough for now
    return resolve();
  }

  // TODO Isn't needed. Maybe figure out a way to notify adapter capabilities
  // upstream so we save some ticks trickling the call all the way down here?
  addIceCandidate (elementId, candidate) {
    return Promise.resolve();
  }

  dtmf (elementId, tone) {
    return this._unsupported("MEDIASOUP_DTMF_NOT_IMPLEMENTED");
  }

  startRecording (sourceId) {
    return this._unsupported("MEDIASOUP_START_RECORDING_NOT_IMPLEMENTED");
  }

  stopRecording (sourceId) {
    return this._unsupported("MEDIASOUP_STOP_RECORDING_NOT_IMPLEMENTED");
  }
};
