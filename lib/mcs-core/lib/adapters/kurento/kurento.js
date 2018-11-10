'use strict'

const C = require('../../constants/Constants.js');
const config = require('config');
const mediaServerClient = require('kurento-client');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../../../utils/Logger');
const isError = require('../../utils/util').isError;
const ERRORS = require('./errors.js');
const KMS_CLIENT = require('kurento-client');
const SdpWrapper = require('../../utils/SdpWrapper');
const h264_sdp = require('../../../../h264-sdp');
const Queue = require('kue');

let instance = null;

module.exports = class MediaServer extends EventEmitter {
  constructor(balancer, globalEmitter) {
    if (!instance){
      super();
      this.balancer = balancer;
      this._globalEmitter = globalEmitter;
      this._mediaPipelines = {};
      this._mediaElements = {};
      this._mediaServer;
      this._status;
      this._reconnectionRoutine = null;
      this._transposingQueue = [];
      this._jobs = Queue.createQueue({
        redis: {
          port: config.get('redisPort'),
          host: config.get('redisHost'),
          //auth: 'password'
        }
      });
      this._jobs.process('transposeAndConnect', async (job, done) => {
        try {
          await this._transposeAndConnect(job.data.sourceId, job.data.sinkId);
          done();
        } catch (e) {
          done(e);
        }
      });
      this._jobs.process('getMediaPipeline', async (job, done) => {
        try {
          await this._getMediaPipeline(job.data.hostId, job.data.roomId);
          done();
        } catch (e) {
          done(e);
        }
      });

      this._jobs.process('createMediaPipeline', async (job, done) => {
        try {
          const p = await this._createMediaPipeline(job.data.hostId);
          done(null, p);
        } catch (e) {
          done(e);
        }
      });

      this._globalEmitter.on(C.EVENT.ROOM_EMPTY, this._releaseAllRoomPipelines.bind(this));
      instance = this;
    }

    return instance;
  }

  init () {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this._mediaServer) {
          // TODO monitor connection state on Balancer
          //this._monitorConnectionState();

          return resolve();
        }
        resolve();
      }
      catch (error) {
        this.emit(C.ERROR.MEDIA_SERVER_OFFLINE);
        reject(this._handleError(error));
      }
    });
  }

  _monitorConnectionState () {
    Logger.debug('[mcs-media] Monitoring connection state');
    try {
      this._mediaServer.on('disconnect', this._onDisconnection.bind(this));
      this._mediaServer.on('reconnected',this._onReconnection.bind(this));
    }
    catch (err) {
      this._handleError(err);
    }
  }

  _onDisconnection () {
    Logger.error('[mcs-media] Media server was disconnected for some reason, will have to clean up all elements and notify users');
    this._destroyElements();
    this._destroyMediaServer();
    this.emit(C.ERROR.MEDIA_SERVER_OFFLINE);
    this._reconnectToServer();
  }

  _onReconnection (sameSession) {
    if (!sameSession) {
      Logger.info('[mcs-media] Media server is back online');
      this.emit(C.EVENT.MEDIA_SERVER_ONLINE);
    }
  }

  _reconnectToServer () {
    if (this._reconnectionRoutine == null) {
      this._reconnectionRoutine = setInterval(async () => {
        try {
          // TODO move to Balancer
          //this._mediaServer = await this._getMediaServerClient(this._serverUri);
          //this._monitorConnectionState();
          //clearInterval(this._reconnectionRoutine);
          //this._reconnectionRoutine = null;
          Logger.warn("[mcs-media] Reconnection to media server succeeded");
        }
        catch (error) {
          delete this._mediaServer;
        }
      }, 2000);
    }
  }

  _createMediaPipeline (hostId) {
    return new Promise((resolve, reject) => {
      const host = this.balancer.retrieveHost(hostId);
      const { client } = host;
      client.create('MediaPipeline', (e, p) => {
        if (e) {
          return reject(e);
        }
        return resolve(p);
      });
    });
  }

  _getMediaPipeline (hostId, roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const host = this.balancer.retrieveHost(hostId);
        const { client } = host;
        if (this._mediaPipelines[roomId] && this._mediaPipelines[roomId][host.id]) {
          Logger.info('[mcs-media] Pipeline for', roomId, 'at host', host.id, ' already exists.');
          return resolve()
        } else {
          const pipeline = await this._createMediaPipeline(hostId);
          pipeline.host = host;
          pipeline.transposers = {};
          if (this._mediaPipelines[roomId] == null) {
            this._mediaPipelines[roomId] = {};
          }
          this._mediaPipelines[roomId][host.id] = pipeline;
          Logger.info("[mcs-media] Created pipeline at room", roomId, "with host", hostId, host.id, pipeline.id);
          pipeline.activeElements = 0;

          return resolve();
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
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
        Logger.debug("[mcs-media] Releasing room", room, "pipeline at host", hostId);
        const pipeline = this._mediaPipelines[room][hostId];
        if (pipeline && typeof pipeline.release === 'function') {
          pipeline.release((error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            delete this._mediaPipelines[room][hostId];
            return resolve()
          });
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  _createElement (pipeline, type, options) {
    return new Promise((resolve, reject) => {
      try {
        pipeline.create(type, options, (error, mediaElement) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.info("[mcs-media] Created [" + type + "] media element: " + mediaElement.id);
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

  createMediaElement (roomId, type, options = {}) {
    options = options || {};
    return new Promise(async (resolve, reject) => {
      try {
        const host = await this.balancer.getHost();
        const job = await this._jobs.create('getMediaPipeline', {
          hostId: host.id,
          roomId
        }).save().priority('high');

        const onPipelineCreated = async (cjob) => {
            const pipeline = this._mediaPipelines[roomId][host.id];
            const mediaElement = await this._createElement(pipeline, type, options);
            if (typeof mediaElement.setKeyframeInterval === 'function' && options.keyframeInterval) {
              Logger.debug("[mcs-media] Creating element with keyframe interval set to", options.keyframeInterval);
              mediaElement.setKeyframeInterval(options.keyframeInterval);
            }
            this._mediaPipelines[roomId][host.id].activeElements++;
            return resolve({ mediaElement: mediaElement.id , host });
        };

        job.on('complete', onPipelineCreated).on('failed', (e) => {
          return reject(e);
        });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async startRecording (sourceId) {
    const source = this._mediaElements[sourceId];
    return new Promise((resolve, reject) => {
      if (source == null) {
        return reject(this._handleError(ERRORS[40101]));
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
    const source = this._mediaElements[sourceId];

    return new Promise((resolve, reject) => {
      if (source == null) {
        return reject(this._handleError(ERRORS[40101]));
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
        Logger.info("[mcs-media] Transposing from", source.id, "| host", source.host.id,  "to", sink.id, "| host", sink.host.id);
        let sourceTransposer, sinkTransposer, sourceOffer, sinkAnswer;

        sourceTransposer = source.transposers[sink.host.id];

        if (sourceTransposer == null) {
          source.transposers[sink.host.id] = {};
          this._transposingQueue.push(source.host.id+source.id+sink.host.id);
          Logger.info("[mcs-media] Source transposer for", source.id, "to host", sink.host.id, "not found");
          sourceTransposer = await this._createElement(source.pipeline, C.MEDIA_TYPE.RTP);
          source.transposers[sink.host.id] = sourceTransposer;
          sourceOffer = await this.generateOffer(sourceTransposer.id);
          // TODO force codec based on source media
          sourceOffer = h264_sdp.transform(sourceOffer);
          this.balancer.incrementHostStreams(source.host.id, 'video');

          Logger.info("[mcs-media] Sink transposer for pipeline", sink.pipeline.id, "for host", source.id, source.host.id, "not found");
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
          return reject(this._handleError(ERRORS[40101]));
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
            return reject(this._handleError(ERRORS[40107]));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  connect (sourceId, sinkId, type) {
    const source = this._mediaElements[sourceId];
    const sink = this._mediaElements[sinkId];
    const shouldTranspose = source.host.id !== sink.host.id;

    return new Promise(async (resolve, reject) => {
      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101]));
      }
      try {
        if (shouldTranspose) {
          const job = await this._jobs.create('transposeAndConnect', {
            sourceId,
            sinkId
          }).save().priority('high');
          job.on('complete', () => {
            return resolve();
          }).on('failed', (e) => {
            return reject(e);
          });
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

  async disconnect (sourceId, sinkId, type) {
    const source = this._mediaElements[sourceId];
    const sink = this._mediaElements[sinkId];
    // TODO temporarily disabled disconnect because of transposing
    return;

    return new Promise((resolve, reject) => {
      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101]));
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
            source.disconnect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          default:
            return reject(this._handleError(ERRORS[40107]));
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
        Logger.info("[mcs-media] Releasing endpoint", elementId, "from room", room);
        const mediaElement = this._mediaElements[elementId];
        const pipeline = this._mediaPipelines[room][mediaElement.host.id];
        const hostId = mediaElement.host.id;

        if (type === 'RecorderEndpoint') {
          await this._stopRecording(elementId);
        }

        if (mediaElement && typeof mediaElement.release === 'function') {
          delete this._mediaElements[elementId];

          if (mediaElement.transposers) {
            Object.keys(mediaElement.transposers).forEach(t => {
              setTimeout(() => {
                mediaElement.transposers[t].release();
                Logger.debug("[mcs-media] Releasing transposer", t, "for", elementId);
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

          mediaElement.release(async (error) => {
            if (error) {
              return reject(this._handleError(error));
            }

            if (pipeline) {
              pipeline.activeElements--;

              Logger.info("[mcs-media] Pipeline has a total of", pipeline.activeElements, "active elements");
              if (pipeline.activeElements <= 0) {
                await this._releasePipeline(room, hostId);
              }
            }
            return resolve();
          });
        }
        else {
          Logger.warn("[mcs-media] Media element", elementId, "could not be found to stop");
          return resolve();
        }
      }
      catch (err) {
        this._handleError(err);
        resolve();
      }
    });
  }

  addIceCandidate (elementId, candidate) {
    return new Promise((resolve, reject) => {
      const mediaElement = this._mediaElements[elementId];
      try {
        if (mediaElement  && candidate) {
          mediaElement.addIceCandidate(candidate, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            Logger.trace("[mcs-media] Added ICE candidate for => ", elementId, candidate);
            return resolve();
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101]));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  gatherCandidates (elementId) {
    Logger.info('[mcs-media] Gathering ICE candidates for ' + elementId);
    const mediaElement = this._mediaElements[elementId];

    return new Promise((resolve, reject) => {
      try {
        if (mediaElement == null) {
          return reject(this._handleError(ERRORS[40101]));
        }
        mediaElement.gatherCandidates((error) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.info('[mcs-media] Triggered ICE gathering for ' + elementId);
          return resolve();
        });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  setInputBandwidth (elementId, min, max) {
    let mediaElement = this._mediaElements[elementId];

    if (mediaElement) {
      mediaElement.setMinVideoRecvBandwidth(min);
      mediaElement.setMaxVideoRecvBandwidth(max);
    } else {
      return ("[mcs-media] There is no element " + elementId);
    }
  }

  setOutputBandwidth (elementId, min, max) {
    let mediaElement = this._mediaElements[elementId];

    if (mediaElement) {
      mediaElement.setMinVideoSendBandwidth(min);
      mediaElement.setMaxVideoSendBandwidth(max);
    } else {
      return ("[mcs-media] There is no element " + elementId );
    }
  }

  setOutputBitrate (elementId, min, max) {
    let mediaElement = this._mediaElements[elementId];

    if (mediaElement) {
      mediaElement.setMinOutputBitrate(min);
      mediaElement.setMaxOutputBitrate(max);
    } else {
      return ("[mcs-media] There is no element " + elementId);
    }
  }

  processOffer (elementId, sdpOffer, params = {})  {
    const { replaceIp } = params;
    const mediaElement = this._mediaElements[elementId];
    Logger.trace("[mcs-media] Processing offer", sdpOffer, "for element", elementId);

    return new Promise((resolve, reject) => {
      try {
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
          return reject(this._handleError(ERRORS[40101]));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  processAnswer (elementId, answer) {
    const mediaElement = this._mediaElements[elementId];
    return new Promise((resolve, reject) => {
      try {
        if (mediaElement) {
          mediaElement.processAnswer(answer, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            return resolve();
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101]));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  generateOffer (elementId) {
    const mediaElement = this._mediaElements[elementId];
    return new Promise((resolve, reject) => {
      try {
        if (mediaElement) {
          mediaElement.generateOffer((error, offer) => {
            if (error) {
              return reject(this._handleError(error));
            }
            return resolve(offer);
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101]));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
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
        Logger.debug('[mcs-media] Adding media state listener [' + eventTag + '] for ' + elementId);
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

  _destroyElements () {
    for (var pipeline in this._mediaPipelines) {
      if (this._mediaPipelines.hasOwnProperty(pipeline)) {
        delete this._mediaPipelines[pipeline];
      }
    }

    for (var element in this._mediaElements) {
      if (this._mediaElements.hasOwnProperty(element)) {
        delete this._mediaElements[element];
      }
    }
  }

  _destroyMediaServer() {
    delete this._mediaServer;
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

    // Checking if the error needs to be wrapped into a JS Error instance
    if (!isError(err)) {
      err = new Error(message);
    }

    err.code = code;
    err.message = message;
    err.details = oldMessage;
    err.stack = stack

    Logger.debug('[mcs-media] Media Server returned an', err.code, err.message);
    Logger.trace(err.stack);
    return err;
  }
};
