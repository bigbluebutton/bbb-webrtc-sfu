'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const mediaServerClient = require('kurento-client');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const isError = require('../../utils/util').isError;
const ERRORS = require('./errors.js');
const KMS_CLIENT = require('kurento-client');
const SdpWrapper = require('../../utils/sdp-wrapper');
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');
const SDPMedia = require('../../model/sdp-media');
const RecordingMedia = require('../../model/recording-media');

const LOG_PREFIX = "[mcs-kurento-adapter]";
let instance = null;

module.exports = class Kurento extends EventEmitter {
  constructor(balancer) {
    if (!instance){
      super();
      this.balancer = balancer;
      this._globalEmitter = GLOBAL_EVENT_EMITTER;
      this._mediaPipelines = {};
      this._mediaElements = {};
      this._pipelinePromises = [];
      this._mediaServer;
      this._status;
      this._reconnectionRoutine = null;
      this._transposingQueue = [];
      this.balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this._destroyElementsFromHost.bind(this));
      this._globalEmitter.on(C.EVENT.ROOM_EMPTY, this._releaseAllRoomPipelines.bind(this));
      instance = this;

    }

    return instance;
  }

  _createMediaPipeline (hostId) {
    return new Promise((resolve, reject) => {
      const host = this.balancer.retrieveHost(hostId);
      const { client } = host;
      client.create('MediaPipeline', (e, p) => {
        if (e) {
          return reject(e);
        }

        p.host = host;
        p.transposers = {};
        p.activeElements = 0;

        return resolve(p);
      });
    });
  }

  async _getMediaPipeline (hostId, roomId) {
    try {
      const host = this.balancer.retrieveHost(hostId);
      const { client } = host;
      if (this._mediaPipelines[roomId] && this._mediaPipelines[roomId][host.id]) {
        Logger.info(LOG_PREFIX, 'Pipeline for', roomId, 'at host', host.id, ' already exists.');
        return this._mediaPipelines[roomId][host.id];
      } else {
        let pPromise;

        const pPromiseObj = this._pipelinePromises.find(pp => pp.id === roomId + hostId);

        if (pPromiseObj) {
          ({ pPromise } = pPromiseObj);
        }

        if (pPromise) {
          return pPromise;
        };

        pPromise = this._createMediaPipeline(hostId);

        this._pipelinePromises.push({ id: roomId + hostId, pPromise});

        const pipeline = await pPromise;

        if (this._mediaPipelines[roomId] == null) {
          this._mediaPipelines[roomId] = {};
        }

        this._mediaPipelines[roomId][host.id] = pipeline;

        this._pipelinePromises = this._pipelinePromises.filter(pp => pp.id !== roomId + hostId);

        Logger.info(LOG_PREFIX, "Created pipeline at room", roomId, "with host", hostId, host.id, pipeline.id);

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
        Logger.debug(LOG_PREFIX, "Releasing room", room, "pipeline at host", hostId);
        const pipeline = this._mediaPipelines[room][hostId];
        if (pipeline && typeof pipeline.release === 'function') {
          pipeline.release((error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            delete this._mediaPipelines[room][hostId];
            return resolve()
          });
        } else {
          return resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  _createElement (pipeline, type, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        // Filter only the appropriate options for this adapter call
        const { stopOnEndOfStream, uri, mediaProfile } = options;
        pipeline.create(type, { stopOnEndOfStream, uri, mediaProfile } , (error, mediaElement) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.info(LOG_PREFIX, "Created [" + type + "] media element: " + mediaElement.id);
          mediaElement.host = pipeline.host;
          mediaElement.pipeline = pipeline;
          mediaElement.transposers = {};
          this._mediaElements[mediaElement.id] = mediaElement;
          return resolve(mediaElement);
        });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    let media;
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.RECORDING:
          return this._negotiateRecordingEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.URI:
          // TODO no-op
          break;
        default:
          throw(this._handleError(ERRORS[40107].error));
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, "Negotiating SDP endpoint for", userId, "at", roomId);
    try {
      // We strip the SDP into media units of the same type because Kurento can't handle
      // bundling other than audio + video
      const partialDescriptors = SdpWrapper.getPartialDescriptions(descriptor);
      let medias = []
      const negotiationProcedures = partialDescriptors.map(d => {
        return new Promise(async (resolve, reject) => {
          try {
            let mediaElement, host;
            const ret = await this.createMediaElement(roomId, type, options);
            mediaElement = ret.mediaElement;
            host = ret.host;
            const answer = await this.processOffer(mediaElement, d);
            const media = new SDPMedia(roomId, userId, mediaSessionId, d, answer, type, this, mediaElement, host, options);
            media.trackMedia();
            medias.push(media);
            resolve();
          } catch (err) {
            reject(this._handleError(err));
          }
        });
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
      const medias = await this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
      medias.forEach(m => {
        if (m.type === C.MEDIA_TYPE.WEBRTC) {
          this.gatherCandidates(m.adapterElementId);
        }
      });
      return medias;
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateRecordingEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      let mediaElement, host;
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, options));
      const answer = await this.startRecording(mediaElement);
      const media = new RecordingMedia(roomId, userId, mediaSessionId, descriptor, answer, type, this, mediaElement, host, options);
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  createMediaElement (roomId, type, options = {}) {
    options = options || {};
    return new Promise(async (resolve, reject) => {
      try {
        const host = await this.balancer.getHost();
        await this._getMediaPipeline(host.id, roomId);
        const pipeline = this._mediaPipelines[roomId][host.id];
        const mediaElement = await this._createElement(pipeline, type, options);
        if (typeof mediaElement.setKeyframeInterval === 'function' && options.keyframeInterval) {
          Logger.debug(LOG_PREFIX, "Creating element with keyframe interval set to", options.keyframeInterval);
          mediaElement.setKeyframeInterval(options.keyframeInterval);
        }

        // TODO make the rembParams and In/Out BW values fetch from the conference
        // media specs
        if (type === C.MEDIA_TYPE.RTP || type === C.MEDIA_TYPE.WEBRTC) {
          this.setOutputBandwidth(mediaElement, 300, 1500);
          this.setInputBandwidth(mediaElement, 300, 1500);

          const rembOptions = {
            rembOnConnect: 500,
            upLosses: 25,
            decrementFactor: 0.85,
            thresholdFactor: 0.9,
          };
          const rembParams = KMS_CLIENT.getComplexType('RembParams')(rembOptions);

          mediaElement.setRembParams(rembParams);
        }

        this._mediaPipelines[roomId][host.id].activeElements++;

        return resolve({ mediaElement: mediaElement.id , host });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async startRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this._mediaElements[sourceId];

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        source.record((err) => {
          if (err) {
            return reject(this._handleError(err));
          }
          return resolve();
        });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _stopRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this._mediaElements[sourceId];

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        source.stopAndWait((err) => {
          if (err) {
            return reject(this._handleError(err));
          }
          return resolve();
        });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _transposeAndConnect(sourceId, sinkId) {
    return new Promise(async (resolve, reject) => {
      try {
        const source = this._mediaElements[sourceId];
        const sink = this._mediaElements[sinkId];
        Logger.info(LOG_PREFIX, "Transposing from", source.id, "| host", source.host.id,  "to", sink.id, "| host", sink.host.id);
        let sourceTransposer, sinkTransposer, sourceOffer, sinkAnswer;

        sourceTransposer = source.transposers[sink.host.id];

        if (sourceTransposer == null) {
          source.transposers[sink.host.id] = {};
          this._transposingQueue.push(source.host.id+source.id+sink.host.id);
          Logger.info(LOG_PREFIX, "Source transposer for", source.id, "to host", sink.host.id, "not found");
          sourceTransposer = await this._createElement(source.pipeline, C.MEDIA_TYPE.RTP);
          source.transposers[sink.host.id] = sourceTransposer;
          sourceOffer = await this.generateOffer(sourceTransposer.id);
          // TODO force codec based on source media
          let filteredOffer = SdpWrapper.filterByVideoCodec(sourceOffer, "H264");
          sourceOffer = SdpWrapper.convertToString(filteredOffer);
          this.balancer.incrementHostStreams(source.host.id, 'video');

          Logger.info(LOG_PREFIX, "Sink transposer for pipeline", sink.pipeline.id, "for host", source.id, source.host.id, "not found");
          sink.pipeline.transposers[source.host.id+source.id] = sinkTransposer = await this._createElement(sink.pipeline, C.MEDIA_TYPE.RTP);
          sinkAnswer = await this.processOffer(sinkTransposer.id, SdpWrapper.nonPureReplaceServerIpv4(sourceOffer, source.host.ip));
          await this.processAnswer(sourceTransposer.id, SdpWrapper.nonPureReplaceServerIpv4(sinkAnswer, sink.host.ip));
          this.balancer.incrementHostStreams(sink.host.id, 'video');
          this._connect(source, sourceTransposer);
          this._connect(sinkTransposer, sink);
          this._transposingQueue = this._transposingQueue.filter(sm => sm !== source.host.id + source.id + sink.host.id);
          this.emit(C.ELEMENT_TRANSPOSED + source.host.id + source.id + sink.host.id);
          return resolve();
        } else {
          if (this._transposingQueue.includes(source.host.id + source.id + sink.host.id)) {
            this.once(C.ELEMENT_TRANSPOSED + source.host.id + source.id + sink.host.id, () => {
              sinkTransposer = sink.pipeline.transposers[source.host.id+source.id];
              this._connect(sinkTransposer, sink);
              return resolve();
            });
          } else {
            sinkTransposer = sink.pipeline.transposers[source.host.id+source.id];
            this._connect(sinkTransposer, sink);
            return resolve();
          }
        }
      } catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  async _connect (source, sink, type = 'ALL') {
    return new Promise((resolve, reject) => {
      try {
        if (source == null || sink == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }

        switch (type) {
          case 'ALL':
            source.connect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case 'AUDIO':
            source.connect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });

          case 'VIDEO':
            source.connect(sink, 'VIDEO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  connect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      const source = this._mediaElements[sourceId];
      const sink = this._mediaElements[sinkId];

      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      const shouldTranspose = source.host.id !== sink.host.id;

      try {
        if (shouldTranspose) {
          await this._transposeAndConnect(sourceId, sinkId);
          return resolve();
        } else {
          await this._connect(source, sink, type);
          resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async _disconnect (source, sink, type) {
    return new Promise((resolve, reject) => {
      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }
      try {
        switch (type) {
          case 'ALL':
            source.disconnect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case 'AUDIO':
            source.disconnect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });

          case 'VIDEO':
            source.disconnect(sink, 'VIDEO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  disconnect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      const source = this._mediaElements[sourceId];
      const sink = this._mediaElements[sinkId];

      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      const isTransposed = source.host.id !== sink.host.id;

      try {
        if (isTransposed) {
          const transposedSink = sink.pipeline.transposers[source.host.id+source.id]
          await this._disconnect(transposedSink, sink, type);
          resolve();
        } else {
          await this._disconnect(source, sink, type);
          resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }


  stop (room, type, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "Releasing endpoint", elementId, "from room", room);
        const mediaElement = this._mediaElements[elementId];

        if (type === 'RecorderEndpoint') {
          await this._stopRecording(elementId);
        }

        if (mediaElement) {
          const pipeline = this._mediaPipelines[room][mediaElement.host.id];
          const hostId = mediaElement.host.id;

          delete this._mediaElements[elementId];

          if (mediaElement.transposers) {
            Object.keys(mediaElement.transposers).forEach(t => {
              setTimeout(() => {
                mediaElement.transposers[t].release();
                Logger.debug(LOG_PREFIX, "Releasing transposer", t, "for", elementId);
                this.balancer.decrementHostStreams(hostId, 'video');
              }, 0);
            });
          }

          const sinkTransposersToRelease = Object.keys(this._mediaPipelines[room]).filter(ph => {
            if (this._mediaPipelines[room][ph] == null) {
              return false;
            }
            const keys = Object.keys(this._mediaPipelines[room][ph].transposers);
            let t = keys.includes(hostId+mediaElement.id)
            return t;
          });


          sinkTransposersToRelease.forEach(st => {
            this._mediaPipelines[room][st].transposers[hostId+mediaElement.id].release()
            this.balancer.decrementHostStreams(st, 'video');
            delete this._mediaPipelines[room][st].transposers[hostId+mediaElement.id];
          });

          if (typeof mediaElement.release === 'function') {
            mediaElement.release(async (error) => {
              if (error) {
                return reject(this._handleError(error));
              }

              if (pipeline) {
                pipeline.activeElements--;

                Logger.info(LOG_PREFIX, "Pipeline has a total of", pipeline.activeElements, "active elements");
                if (pipeline.activeElements <= 0) {
                  await this._releasePipeline(room, hostId);
                }
              }

              return resolve();
            });
          } else {
            // Element is not available for release anymore, so it's pipeline
            // was probably already released altogether. Just resolve the call.
            return resolve();
          }
        }
        else {
          Logger.warn(LOG_PREFIX, "Media element", elementId, "could not be found to stop");
          return resolve();
        }
      }
      catch (err) {
        this._handleError(err);
        resolve();
      }
    });
  }

  _checkForMDNSCandidate (candidate) {
    // Temporary stub for ignoring mDNS .local candidates. It'll just check
    // for it and make the calling procedure resolve if it's a mDNS.
    // The commented code below is a general procedure to enabling mDNS
    // lookup. We just gotta find a proper librabry or way to do it once the
    // time is right

    const mDNSRegex = /([\d\w-]*)(.local)/ig
    if (candidate.match(/.local/ig)) {
      return true;
    }
    return false;

    //const parsedAddress = mDNSRegex.exec(candidate)[1];
    //Logger.trace(LOG_PREFIX, "Got a mDNS obfuscated candidate with addr", parsedAddress);
    //dns.lookup(parsedAddress, (e, resolvedAddress) => {
    //  if (e) {
    //    Logger.trace(LOG_PREFIX, "mDNS not found with error", e);
    //    return reject(ERRORS[40401].error);
    //  }

    //  candidate.replace(mDNSRegex,  resolvedAddress);

    //  return resolve(candidate);
  }

  addIceCandidate (elementId, candidate) {
    return new Promise(async (resolve, reject) => {
      const mediaElement = this._mediaElements[elementId];
      try {
        if (mediaElement  && candidate) {
          if (this._checkForMDNSCandidate(candidate.candidate)) {
            Logger.trace(LOG_PREFIX, "Ignoring a mDNS obfuscated candidate", candidate.candidate);
            return resolve();
          }

          mediaElement.addIceCandidate(candidate, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            Logger.trace(LOG_PREFIX, "Added ICE candidate for => ", elementId, candidate);
            return resolve();
          });
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
    Logger.info(LOG_PREFIX, 'Gathering ICE candidates for ' + elementId);

    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];
        if (mediaElement == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }
        mediaElement.gatherCandidates((error) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.info(LOG_PREFIX, 'Triggered ICE gathering for ' + elementId);
          return resolve();
        });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  setInputBandwidth (element, min, max) {
    if (element) {
      element.setMinVideoRecvBandwidth(min);
      element.setMaxVideoRecvBandwidth(max);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBandwidth (element, min, max) {
    if (element) {
      element.setMinVideoSendBandwidth(min);
      element.setMaxVideoSendBandwidth(max);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBitrate (element, bitrate) {
    if (element) {
      element.setOutputBitrate(bitrate);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  processOffer (elementId, sdpOffer, params = {})  {
    const { replaceIp } = params;
    Logger.trace(LOG_PREFIX, "Processing", elementId, "offer", sdpOffer);

    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];

        if (mediaElement) {
          mediaElement.processOffer(sdpOffer, (error, answer) => {
            if (error) {
              return reject(this._handleError(error));
            }
            if (replaceIp) {
              answer = answer.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + mediaElement.host.ip);

            }
            return resolve(answer);
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

  processAnswer (elementId, answer) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];

        if (mediaElement) {
          mediaElement.processAnswer(answer, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            return resolve();
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

  generateOffer (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];

        if (mediaElement) {
          mediaElement.generateOffer((error, offer) => {
            if (error) {
              return reject(this._handleError(error));
            }
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

  dtmf (elementId, tone) {
    throw this._handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: "KURENTO_DTMF_NOT_IMPLEMENTED"
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
        break;

      case C.MEDIA_TYPE.RTP:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.RECORDING:
        this.addMediaEventListener(C.EVENT.RECORDING.STOPPED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.PAUSED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.STARTED. elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      default: return;
    }
    return;
  }

  addMediaEventListener (eventTag, elementId) {
    const mediaElement = this._mediaElements[elementId];
    let event = {};
    try {
      if (mediaElement) {
        Logger.debug(LOG_PREFIX, 'Adding media state listener [' + eventTag + '] for ' + elementId);
        mediaElement.on(eventTag, (e) => {
          switch (eventTag) {
            case C.EVENT.MEDIA_STATE.ICE:
              event.candidate = KMS_CLIENT.getComplexType('IceCandidate')(e.candidate);
              event.elementId = elementId;
              this.emit(C.EVENT.MEDIA_STATE.ICE+elementId, event);
              break;
            default:
              event.state = { name: eventTag, details: e.state };
              event.elementId = elementId;
              this.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT+elementId, event);
          }
        });
      }
    }
    catch (err) {
      err = this._handleError(err);
    }
  }

  notifyMediaState (elementId, eventTag, event) {
    this.emit(C.MEDIA_STATE.MEDIA_EVENT , {elementId, eventTag, event});
  }

  _destroyElementsFromHost (hostId) {
    try {
      Object.keys(this._mediaPipelines).forEach(r => {
        if (this._mediaPipelines[r][hostId]) {
          delete this._mediaPipelines[r][hostId];
        }
      });

      Object.keys(this._mediaElements).forEach(mek => {
        Object.keys(this._mediaElements[mek].transposers).forEach(t => {
          if (t === hostId) {
            delete this._mediaElements[mek].transposers[t];
          }
        });

        if (this._mediaElements[mek].host.id === hostId) {
          delete this._mediaElements[mek];
        }
      });
    } catch (e) {
      Logger.error(e);
    }
  }

  _handleError(err) {
    let { message: oldMessage , code, stack } = err;
    let message;

    Logger.trace(LOG_PREFIX, 'Error stack', err);

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

    // Checking if the error needs to be wrapped into a JS Error instance
    if (!isError(err)) {
      err = new Error(message);
    }

    err.code = code;
    err.message = message;
    err.details = oldMessage;
    err.stack = stack

    Logger.debug(LOG_PREFIX, 'Media Server returned an', err.code, err.message);
    return err;
  }
};
