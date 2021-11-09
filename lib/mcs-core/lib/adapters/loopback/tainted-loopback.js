'use strict'

const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants.js');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const Util = require('../../utils/util');
const ADPUtils = require('../adapter-utils.js');
const isError = Util.isError;
const ERRORS = require('../kurento/errors.js');
const SdpWrapper = require('../../utils/sdp-wrapper');
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');
const SDPMedia = require('../../model/sdp-media');
const RecordingMedia = require('../../model/recording-media');

const LOG_PREFIX = "[tainted-loopback-adapter]";

let instance = null;

module.exports = class TaintedLoopbackAdapter extends EventEmitter {
  constructor(name, balancer) {
    if (!instance){
      super();
      this.name = name;
      this.balancer = balancer;
      this._globalEmitter = GLOBAL_EVENT_EMITTER;
      this._mediaPipelines = {};
      this._mediaElements = {};
      this._pipelinePromises = [];
      this.balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this._destroyElementsFromHost.bind(this));
      this._globalEmitter.on(C.EVENT.ROOM_EMPTY, this._releaseAllRoomPipelines.bind(this));
      this._bogusHost = {
        id: uuidv4(),
        ip: '198.51.100.13',
        ipClassMappings: {
          public: '198.51.100.13',
          local: '198.51.100.13',
          private: '198.51.100.0',
        },
      }

      instance = this;
    }

    return instance;
  }

  setMediaElement (mediaElement) {
    const enrichedId = `${mediaElement.id}/${mediaElement.host.id}`;
    if (typeof this._mediaElements[enrichedId] === 'object') {
      return this._handleError({
        ...C.ERROR.MEDIA_ID_COLLISION,
        details: "TLA_ID_COLLISION"
      });
    }

    mediaElement.enrichedId = enrichedId;
    this._mediaElements[enrichedId] = mediaElement;
    return true;
  }

  getMediaElement (elementId) {
    return this._mediaElements[elementId];
  }

  getMediaElementId (mediaElement) {
    return mediaElement.enrichedId;
  }

  _createMediaPipeline () {
    return new Promise((resolve) => {
      return resolve({
        host: this._bogusHost,
        activeElements: 0,
      });
    });
  }

  async _getMediaPipeline (hostId, roomId) {
    try {
      const host = this._bogusHost;
      if (this._mediaPipelines[roomId] && this._mediaPipelines[roomId][host.id]) {
        return this._mediaPipelines[roomId][host.id];
      } else {
        let pPromise;

        const pPromiseObj = this._pipelinePromises.find(pp => pp.id === roomId + hostId);

        if (pPromiseObj) {
          ({ pPromise } = pPromiseObj);
        }

        if (pPromise) {
          return pPromise;
        }

        pPromise = this._createMediaPipeline(hostId);

        this._pipelinePromises.push({ id: roomId + hostId, pPromise});

        const pipeline = await pPromise;

        if (this._mediaPipelines[roomId] == null) {
          this._mediaPipelines[roomId] = {};
        }

        this._mediaPipelines[roomId][host.id] = pipeline;

        this._pipelinePromises = this._pipelinePromises.filter(pp => pp.id !== roomId + hostId);

        Logger.debug(LOG_PREFIX, `Created pipeline at room ${roomId}`,
          { hostId: host.id, pipeline: pipeline.id, roomId });

        return pipeline;
      }
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  _releaseAllRoomPipelines (room) {
    try {
      if (this._mediaPipelines[room]) {
        Object.keys(this._mediaPipelines[room]).forEach(async pk => {
          await this._releasePipeline(room, pk);
        });
      }
    } catch (e) {
      this._handleError(e);
    }
  }

  _releasePipeline (room, hostId) {
    return new Promise((resolve, reject) => {
      try {
        Logger.debug(LOG_PREFIX, `Releasing pipeline of room ${room}`,
          { hostId, roomId: room });
        delete this._mediaPipelines[room][hostId];
        return resolve()

      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  _createElement (pipeline ) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = {
          id: uuidv4(),
          host: pipeline.host,
          pipeline,
          on: GLOBAL_EVENT_EMITTER.on,
          emit: GLOBAL_EVENT_EMITTER.emit,
        };
        const ret = this.setMediaElement(mediaElement);
        if (ret === true) {
          return resolve(mediaElement);
        } else {
          return reject(ret);
        }
      } catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
        case C.MEDIA_TYPE.RECORDING:
          return this._negotiateRecordingEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
        case C.MEDIA_TYPE.URI:
        default:
          throw(this._handleError(ERRORS[40107].error));
      }
    } catch (error) {
      throw(this._handleError(error));
    }
  }

  _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, `Negotiating SDP endpoint`, { userId, roomId });
    try {
      const partialDescriptors = SdpWrapper.getPartialDescriptions(descriptor);
      let medias = []
      const negotiationProcedures = partialDescriptors.map(async (d, i) => {
        try {
          let mediaElement, host, answer;
          const media = new SDPMedia(roomId, userId, mediaSessionId, d, null, type, this, null, null, options);
          const mediaType = ADPUtils.parseMediaType(media);
          ({ mediaElement, host } = await this.createMediaElement(roomId, type, { ...options, mediaType }));

          media.adapterElementId = mediaElement;
          media.host = host;
          media.trackMedia();

          if (d) {
            answer = await this.processOffer(mediaElement, d, options);
          } else {
            const filterOptions = [
              { reg: /AVPF/ig, val: 'AVP' },
              { reg: /a=mid:video0\r*\n*/ig, val: '' },
              { reg: /a=mid:audio0\r*\n*/ig, val: '' },
              { reg: /a=rtcp-fb:.*\r*\n*/ig, val: '' },
              { reg: /a=extmap:3 http:\/\/www.webrtc.org\/experiments\/rtp-hdrext\/abs-send-time\r*\n*/ig, val: '' },
              { reg: /a=setup:actpass\r*\n*/ig, val: '' }
            ]

            answer = await this.generateOffer(mediaElement, filterOptions);
          }

          answer = ADPUtils.appendContentTypeIfNeeded(answer, mediaType);
          media.localDescriptor = answer;
          media.remoteDescriptor = d;
          medias[i] = media;
        } catch (error) {
          throw (this._handleError(error));
        }
      });

      return Promise.all(negotiationProcedures).then(() => {
        return medias;
      });
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateWebRTCEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      const isTrickled = typeof options.trickle === 'undefined' || options.trickle;
      options.trickle= isTrickled;
      const medias = await this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
      if (isTrickled) {
        medias.forEach(m => {
          if (m.type === C.MEDIA_TYPE.WEBRTC) {
            this.gatherCandidates(m.adapterElementId).catch(error => {
              Logger.error(LOG_PREFIX, `Candidate gathering for media ${m.id} failed due to ${error.message}`,
                { mediaId: m.id, adapterElementId: m.adapterElementId, errorMessage: error.message, errorCode: error.code });
            });
          }
        });

        return medias;
      } else {
        return medias;
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateRecordingEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      let mediaElement, host;
      const media = new RecordingMedia(roomId, userId, mediaSessionId, descriptor, null, type, this, null, null, options);
      const mediaType = ADPUtils.parseMediaType(media);
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, {...options, mediaType }));
      const answer = await this.startRecording(mediaElement);
      media.adapterElementId = mediaElement;
      media.host = host;
      media.localDescriptor = answer;
      media.updateHostLoad();
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async createMediaElement (roomId, type, options = {}) {
    try {
      const host = this._bogusHost;
      await this._getMediaPipeline(host.id, roomId);
      const pipeline = this._mediaPipelines[roomId][host.id];
      const mediaElement = await this._createElement(pipeline, type, options);

      if (type === C.MEDIA_TYPE.RTP || type === C.MEDIA_TYPE.WEBRTC) {
        this.setOutputBandwidth(mediaElement, 300, 1500);
        this.setInputBandwidth(mediaElement, 300, 1500);
      }

      this._mediaPipelines[roomId][host.id].activeElements++;

      return { mediaElement: this.getMediaElementId(mediaElement), host };
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async startRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this.getMediaElement(sourceId);

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        return resolve();
      } catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _stopRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this.getMediaElement(sourceId);

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        return resolve();
      } catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _connect (source, sink, type = 'ALL') {
    return new Promise((resolve, reject) => {
      try {
        if (source == null || sink == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }

        Logger.info(LOG_PREFIX, "Adapter elements to be connected", JSON.stringify({
          sourceId: this.getMediaElementId(source),
          sinkId: this.getMediaElementId(sink),
          connectionType: type,
        }));

        switch (type) {
          case C.CONNECTION_TYPE.ALL:
            return resolve();
          case C.CONNECTION_TYPE.AUDIO:
            return resolve();
          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
            return resolve();
          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async connect (sourceId, sinkId, type) {
    const source = this.getMediaElement(sourceId);
    const sink = this.getMediaElement(sinkId);

    if (source == null || sink == null) {
      throw (this._handleError(ERRORS[40101].error));
    }

    try {
      await this._connect(source, sink, type);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async _disconnect (source, sink, type) {
    return new Promise((resolve, reject) => {
      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        switch (type) {
          case C.CONNECTION_TYPE.ALL:
            return resolve();
          case C.CONNECTION_TYPE.AUDIO:
            return resolve();
          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
            return resolve();
          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async disconnect (sourceId, sinkId, type) {
    const source = this.getMediaElement(sourceId);
    const sink = this.getMediaElement(sinkId);

    if (source == null || sink == null) {
      throw (this._handleError(ERRORS[40101].error));
    }

    try {
      await this._disconnect(source, sink, type);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async stop (room, type, elementId) {
    try {
      Logger.info(LOG_PREFIX, `Releasing endpoint`, { elementId, roomId: room });
      const mediaElement = this.getMediaElement(elementId);

      this._removeElementEventListeners(elementId);

      if (type === 'RecorderEndpoint') {
        await this._stopRecording(elementId);
      }

      if (mediaElement) {
        const pipeline = this._mediaPipelines[room][mediaElement.host.id];
        const hostId = mediaElement.host.id;

        delete this._mediaElements[elementId];

        if (pipeline) {
          pipeline.activeElements--;

          Logger.info(LOG_PREFIX, `Pipeline elements decreased for room ${room}`,
            { activeElements: pipeline.activeElements, roomId: room, hostId });

          if (pipeline.activeElements <= 0) {
            await this._releasePipeline(room, hostId);
          }
        }
      } else {
        Logger.warn(LOG_PREFIX, `Media element not found on stop`, { elementId });
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Element stop failed', {
        roomId: room, elementId, type, error,
      });
    }
  }

  _checkForMDNSCandidate (candidate) {
    if (candidate.match(/.local/ig)) {
      return true;
    }
    return false;
  }

  addIceCandidate (elementId, candidate) {
    return new Promise((resolve, reject) => {
      const mediaElement = this.getMediaElement(elementId);
      try {
        if (mediaElement  && candidate) {
          if (this._checkForMDNSCandidate(candidate.candidate)) {
            Logger.trace(LOG_PREFIX, "Ignoring a mDNS obfuscated candidate", candidate.candidate);
            return resolve();
          }

          mediaElement.emit(`${C.EVENT.MEDIA_STATE.ICE}${elementId}`, {
            candidate,
          });
          Logger.trace(LOG_PREFIX, "Added ICE candidate for => ", elementId, candidate);
          return resolve();
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  gatherCandidates (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }
        Logger.debug(LOG_PREFIX, `Triggered ICE gathering for ${elementId}`);
        return resolve();
      } catch (error) {
        return reject(error);
      }
    });
  }

  setInputBandwidth (element) {
    if (element) {
      return;
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBandwidth (element) {
    if (element) {
      return;
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBitrate (element) {
    if (element) {
      return;
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  processOffer (elementId, sdpOffer, params = {})  {
    const { replaceIp } = params;
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement) {
          if (mediaElement.negotiated) {
            Logger.warn(LOG_PREFIX, `Element ${elementId} was already negotiated, ignoring processOffer`);
            return resolve();
          }

          Logger.trace(LOG_PREFIX, `Processing ${elementId} offer`, { offer: sdpOffer });
          mediaElement.negotiated = true;
          let answer = sdpOffer;

          if (replaceIp) {
            answer = answer.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + mediaElement.host.ip);
          }

          return resolve(answer);
        } else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  processAnswer (elementId, answer) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement) {
          if (mediaElement.negotiated) {
            Logger.warn(LOG_PREFIX, `Element ${elementId} was already negotiated, ignoring processAnswer`);
            return resolve();
          }
          Logger.trace(LOG_PREFIX, `Processing ${elementId} answer`, { answer });
          mediaElement.negotiated = true;
          return resolve();
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  // TODO
  generateOffer (elementId, filterOptions = []) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement) {
          mediaElement.generateOffer((error, offer) => {
            if (error) {
              return reject(this._handleError(error));
            }
            filterOptions.forEach(({ reg, val }) => {
              offer = offer.replace(reg, val);
            });
            Logger.trace(LOG_PREFIX, `Generated offer for ${elementId}`, { offer });
            return resolve(offer);
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  requestKeyframe (elementId) {
    return new Promise((resolve, reject) => {
      try {
        this.getMediaElement(elementId);
        return resolve();
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  dtmf (elementId, tone) {
    return new Promise((resolve, reject) => {
      try {
        this.getMediaElement(elementId);
        return resolve(tone);
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  trackMediaState (elementId, type) {
    switch (type) {
      case C.MEDIA_TYPE.URI:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ENDOFSTREAM, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.WEBRTC:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_GATHERING_DONE, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_CANDIDATE_PAIR_SELECTED, elementId);
        break;

      case C.MEDIA_TYPE.RTP:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.RECORDING:
        this.addMediaEventListener(C.EVENT.RECORDING.STOPPED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.PAUSED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.STARTED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      default: return;
    }
    return;
  }

  addMediaEventListener (eventTag, elementId) {
    const mediaElement = this.getMediaElement(elementId);
    let event;
    try {
      if (mediaElement) {
        Logger.trace(LOG_PREFIX, `Adding media state listener ${eventTag}`, { eventTag, elementId });
        mediaElement.on(`${eventTag}${elementId}`, (rawEvent) => {
          const timestampUTC = Date.now();
          const timestampHR = Util.hrTime();
          switch (eventTag) {
            case C.EVENT.MEDIA_STATE.ICE:
              event = {
                candidate: rawEvent.candidate,
                elementId,
                timestampUTC,
                timestampHR,
                rawEvent: { ...rawEvent },
              }
              this.emit(C.EVENT.MEDIA_STATE.ICE+elementId, event);
              break;
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
      Logger.error(LOG_PREFIX, 'Failure in addMediaEventListener', {
        errorMessage: error.message, error,
      });
    }
  }

  _removeElementEventListeners (elementId) {
    const eventsToRemove = C.EVENT.ADAPTER_EVENTS.map(p => `${p}${elementId}`);
    Logger.trace(LOG_PREFIX, `Removing all event listeners for ${elementId}`);
    eventsToRemove.forEach(e => {
      this.removeAllListeners(e);
    });
  }

  _destroyElementsFromHost (hostId) {
    try {
      Object.keys(this._mediaPipelines).forEach(r => {
        if (this._mediaPipelines[r][hostId]) {
          delete this._mediaPipelines[r][hostId];
        }
      });

      Object.keys(this._mediaElements).forEach(mek => {
        if (this._mediaElements[mek].host.id === hostId) {
          delete this._mediaElements[mek];
        }
      });
    } catch (error) {
      Logger.error(LOG_PREFIX, `Error destroying elements from host ${hostId}`,
        { error, hostId });
    }
  }

  _handleError(err) {
    let { message: oldMessage , code, stack } = err;
    let message;

    if (code && code >= C.ERROR.MIN_CODE && code <= C.ERROR.MAX_CODE) {
      return err;
    }

    const error = ERRORS[code]? ERRORS[code].error : null;

    if (error == null) {
      switch (oldMessage) {
        case "Request has timed out":
          ({ code, message }  = C.ERROR.MEDIA_SERVER_REQUEST_TIMEOUT);
          break;

        case "Connection error":
          ({ code, message } = C.ERROR.CONNECTION_ERROR);
          break;

        default:
          ({ code, message } = C.ERROR.MEDIA_SERVER_GENERIC_ERROR);
      }
    }
    else {
      ({ code, message } = error);
    }

    if (!isError(err)) {
      err = new Error(message);
    }

    err.code = code;
    err.message = message;
    err.details = oldMessage;
    err.stack = stack

    if (stack && !err.stackWasLogged)  {
      Logger.error(LOG_PREFIX, `Stack trace for error ${err.code} | ${err.message} ->`,
        { errorStack: err.stack.toString() });
      err.stackWasLogged = true;
    }
    return err;
  }
};
