'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const Util = require('../../utils/util');
const isError = Util.isError;
const ERRORS = require('./errors.js');
const KMS_CLIENT = require('kurento-client');
const SdpWrapper = require('../../utils/sdp-wrapper');
const GLOBAL_EVENT_EMITTER = require('../../../../common/emitter.js');
const SDPMedia = require('../../model/sdp-media');
const RecordingMedia = require('../../model/recording-media');

const KURENTO_REMB_PARAMS = config.get('kurentoRembParams');
const ALLOWED_CANDIDATE_IPS = config.has('kurentoAllowedCandidateIps')
  ? config.get('kurentoAllowedCandidateIps')
  : [];
const KURENTO_ALLOW_MDNS = config.has('kurentoAllowMDNSCandidates')
  ? config.get('kurentoAllowMDNSCandidates')
  : false;
const KURENTO_TRACK_ICE_STATE_CHANGES = config.has('kurentoTrackIceStateChanges')
  ? config.get('kurentoTrackIceStateChanges')
  : false;
const KURENTO_REMOVE_REMB_RTCPFB = config.has('kurentoRemoveRembRtcpFb')
  ? config.get('kurentoRemoveRembRtcpFb')
  : false;
const LOG_PREFIX = "[mcs-kurento-adapter]";
const VANILLA_GATHERING_TIMEOUT = 30000;

let instance = null;

module.exports = class Kurento extends EventEmitter {
  constructor(name, balancer) {
    if (!instance){
      super();
      this.name = name;
      this.balancer = balancer;
      this._globalEmitter = GLOBAL_EVENT_EMITTER;
      this._mediaPipelines = {};
      this._mediaElements = {};
      this._pipelinePromises = [];
      this._transposingQueue = [];
      this.balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this._destroyElementsFromHost.bind(this));
      this._globalEmitter.on(C.EVENT.ROOM_DESTROYED, this._releaseAllRoomPipelines.bind(this));
      instance = this;
    }

    return instance;
  }

  setMediaElement (mediaElement) {
    // Enriched ID: internal media element ID from Kurento (UUIDv4 from pipeline,
    // +UUIv4 from element) + the host internal identification
    // The host append is a mitigation to possible UUID collisions Kurento might have
    // FIXME: Review this whole shenanigan in the future - prlanzarin Feb 23rd 2021.
    const enrichedId = `${mediaElement.id}/${mediaElement.host.id}`;

    // Might be an ID collision. Throw this peer out and let the client reconnect
    if (typeof this._mediaElements[enrichedId] === 'object') {
      return this._handleError({
        ...C.ERROR.MEDIA_ID_COLLISION,
        details: "KURENTO_ID_COLLISION"
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

  _releaseAllRoomPipelines ({ roomId }) {
    try {
      if (this._mediaPipelines[roomId]) {
        Object.keys(this._mediaPipelines[roomId]).forEach(async pk => {
          await this._releasePipeline(roomId, pk);
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
        const { stopOnEndOfStream, uri, recordingProfile } = options;
        const enrichedKMSRecURI = uri ? `file://${uri}` : undefined;
        pipeline.create(
          type,
          { stopOnEndOfStream, uri: enrichedKMSRecURI, mediaProfile: recordingProfile },
          (error, mediaElement) => {
            if (error) {
              return reject(this._handleError(error));
            }
            mediaElement.host = pipeline.host;
            mediaElement.pipeline = pipeline;
            mediaElement.transposers = {};
            mediaElement.mcsCoreMediaType = type;
            const ret = this.setMediaElement(mediaElement);
            if (ret === true) {
              return resolve(mediaElement);
            } else {
              return reject(ret);
            }
          });
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
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  static appendContentTypeIfNeeded (descriptor, mediaType) {
    // Check if we need to add :main or :slides
    // Since Kurento still does not treat a=content:x lines well, we
    // reappend it here manually to work around the issue
    switch (mediaType) {
      case C.MEDIA_PROFILE.MAIN:
        return descriptor + "a=content:main\r\n";
      case C.MEDIA_PROFILE.CONTENT:
        return descriptor + "a=content:slides\r\n";
      default:
        return descriptor;
    }
  }

  _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, `Negotiating SDP endpoint`, { userId, roomId });
    try {
      // We strip the SDP into media units of the same type because Kurento can't handle
      // bundling other than audio + video
      const partialDescriptors = SdpWrapper.getPartialDescriptions(descriptor);
      let medias = []
      const negotiationProcedures = partialDescriptors.map((d, i) => {
        return new Promise(async (resolve, reject) => {
          try {
            let mediaElement, host, answer;

            // Some props are initialized as null because this is an early instantiation
            // done to please the balancer accounting
            const media = new SDPMedia(roomId, userId, mediaSessionId, d, null, type, this, null, null, options);
            const mediaType = this._parseMediaType(media);
            ({ mediaElement, host } = await this.createMediaElement(roomId, type, { ...options, mediaType }));

            media.adapterElementId = mediaElement;
            media.host = host;
            media.trackMedia();

            if (d) {
              answer = await this.processOffer(mediaElement, d, options);
            } else {
              // If we're acting as offeree, we try to generate the least offensive SDP possible
              // for pure RTP endpoints as to minimize compatibility issues.
              // Hence the bizarre filters
              options.filterOptions = (type === C.MEDIA_TYPE.WEBRTC)
                ? []
                : [
                  { reg: /AVPF/ig, val: 'AVP' },
                  { reg: /a=mid:video0\r*\n*/ig, val: '' },
                  { reg: /a=mid:audio0\r*\n*/ig, val: '' },
                  { reg: /a=rtcp-fb:.*\r*\n*/ig, val: '' },
                  { reg: /a=extmap:3 http:\/\/www.webrtc.org\/experiments\/rtp-hdrext\/abs-send-time\r*\n*/ig, val: '' },
                  { reg: /a=setup:actpass\r*\n*/ig, val: '' }
                ];

              answer = await this.generateOffer(mediaElement, options);
            }

            answer = Kurento.appendContentTypeIfNeeded(answer, mediaType);

            // Just do a late-set of the properties that were nullified in the early
            // media instantiation
            media.localDescriptor = answer;
            media.remoteDescriptor = d;
            medias[i] = media;

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
      const isTrickled = typeof options.trickle === 'undefined' || options.trickle;
      options.trickle = isTrickled;
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

      // Some props are initialized as null because this is an early instantiation
      // done to please the balancer accounting
      const media = new RecordingMedia(roomId, userId, mediaSessionId, descriptor, null, type, this, null, null, options);
      const mediaType = this._parseMediaType(media);
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, {...options, mediaType }));
      const answer = await this.startRecording(mediaElement);
      // Just do a late-set of the properties that were nullified in the early
      // media instantiation
      media.adapterElementId = mediaElement;
      media.host = host;
      media.localDescriptor = answer;
      media.updateHostLoad();
      // Enable the event tracking
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  _parseMediaType (options) {
    // FIXME I'm not a fan of the mediaProfile vs mediaType boogaloo
    const { mediaProfile, mediaTypes }  = options;

    if (mediaProfile) {
      return mediaProfile;
    }

    if (mediaTypes) {
      const { video, audio, content } = mediaTypes;
      if (video) {
        return C.MEDIA_PROFILE.MAIN;
      } else if (audio) {
        return C.MEDIA_PROFILE.AUDIO;
      } else if (content) {
        return C.MEDIA_PROFILE.CONTENT;
      }
    }

    return C.MEDIA_PROFILE.ALL;
  }

  createMediaElement (roomId, type, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const { mediaType, keyframeInterval } = options;
        const host = await this.balancer.getHost(mediaType);
        await this._getMediaPipeline(host.id, roomId);
        const pipeline = this._mediaPipelines[roomId][host.id];
        const mediaElement = await this._createElement(pipeline, type, options);

        if (typeof mediaElement.setKeyframeInterval === 'function' && keyframeInterval) {
          mediaElement.setKeyframeInterval(keyframeInterval);
        }

        // TODO make the rembParams and In/Out BW values fetch from the conference
        // media specs
        if (type === C.MEDIA_TYPE.RTP || type === C.MEDIA_TYPE.WEBRTC) {
          this.setOutputBandwidth(mediaElement, 300, 1500);
          this.setInputBandwidth(mediaElement, 300, 1500);

          const rembParams = options.kurentoRembParams || KURENTO_REMB_PARAMS;
          if (rembParams) {
            const parsedRembParams = KMS_CLIENT.getComplexType('RembParams')(rembParams);
            mediaElement.setRembParams(parsedRembParams);
          }
        }

        this._mediaPipelines[roomId][host.id].activeElements++;

        return resolve({ mediaElement: this.getMediaElementId(mediaElement), host });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async startRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this.getMediaElement(sourceId);

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
      const source = this.getMediaElement(sourceId);

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
        const source = this.getMediaElement(sourceId);
        const sink = this.getMediaElement(sinkId);
        Logger.info(LOG_PREFIX, `Transposing elements`, {
          sourceId: this.getMediaElementId(source),
          sourceHostId: source.host.id,
          sinkId: this.getMediaElementId(sink),
          sinkHostId: sink.host.id,
        });

        let sourceTransposer, sinkTransposer, sourceOffer, sinkAnswer;

        sourceTransposer = source.transposers[sink.host.id];

        if (sourceTransposer == null) {
          source.transposers[sink.host.id] = {};
          this._transposingQueue.push(source.host.id+sourceId+sink.host.id);

          Logger.debug(LOG_PREFIX, "Source transposer not found",
            { sourceId, sinkHostId: sink.host.id });

          sourceTransposer = await this._createElement(source.pipeline, C.MEDIA_TYPE.RTP);
          source.transposers[sink.host.id] = sourceTransposer;
          sourceOffer = await this.generateOffer(this.getMediaElementId(sourceTransposer));
          // TODO force codec based on source media
          let filteredOffer = SdpWrapper.filterByVideoCodec(sourceOffer, "H264");
          sourceOffer = SdpWrapper.convertToString(filteredOffer);
          this.balancer.incrementHostStreams(source.host.id, C.MEDIA_PROFILE.MAIN);

          Logger.debug(LOG_PREFIX, "Sink transposer not found", {
            sinkPipelineId: sink.pipeline.id,
            sourceId,
            sourceHostId: source.host.id,
          });

          sink.pipeline.transposers[source.host.id+sourceId] = sinkTransposer = await this._createElement(sink.pipeline, C.MEDIA_TYPE.RTP);
          sinkAnswer = await this.processOffer(this.getMediaElementId(sinkTransposer), SdpWrapper.stReplaceServerIpv4(sourceOffer, source.host.ip));
          await this.processAnswer(this.getMediaElementId(sourceTransposer), SdpWrapper.stReplaceServerIpv4(sinkAnswer, sink.host.ip));
          this.balancer.incrementHostStreams(sink.host.id, C.MEDIA_PROFILE.MAIN);
          this._connect(source, sourceTransposer);
          this._connect(sinkTransposer, sink);
          this._transposingQueue = this._transposingQueue.filter(sm => sm !== source.host.id + sourceId + sink.host.id);
          this.emit(C.ELEMENT_TRANSPOSED + source.host.id + sourceId + sink.host.id);
          return resolve();
        } else {
          if (this._transposingQueue.includes(source.host.id + sourceId + sink.host.id)) {
            this.once(C.ELEMENT_TRANSPOSED + source.host.id + sourceId + sink.host.id, () => {
              sinkTransposer = sink.pipeline.transposers[source.host.id+sourceId];
              this._connect(sinkTransposer, sink);
              return resolve();
            });
          } else {
            sinkTransposer = sink.pipeline.transposers[source.host.id+sourceId];
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

        Logger.info(LOG_PREFIX, "Adapter elements to be connected", JSON.stringify({
          sourceId: this.getMediaElementId(source),
          sinkId: this.getMediaElementId(sink),
          connectionType: type,
        }));

        switch (type) {
          case C.CONNECTION_TYPE.ALL:
            source.connect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.AUDIO:
            source.connect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
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
      const source = this.getMediaElement(sourceId);
      const sink = this.getMediaElement(sinkId);

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
          case C.CONNECTION_TYPE.ALL:
            source.disconnect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.AUDIO:
            source.disconnect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
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
      const source = this.getMediaElement(sourceId);
      const sink = this.getMediaElement(sinkId);

      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      const isTransposed = source.host.id !== sink.host.id;

      try {
        if (isTransposed) {
          const transposerId = source.host.id + this.getMediaElementId(source);
          const transposedSink = sink.pipeline.transposers[transposerId]
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

          if (mediaElement.transposers) {
            Object.keys(mediaElement.transposers).forEach(t => {
              setTimeout(() => {
                mediaElement.transposers[t].release();
                Logger.debug(LOG_PREFIX, `Releasing transposer`,
                  { transposerId: t, elementId });
                this.balancer.decrementHostStreams(hostId, C.MEDIA_PROFILE.MAIN);
              }, 0);
            });
          }

          const transposerId = hostId + this.getMediaElementId(mediaElement);

          const sinkTransposersToRelease = Object.keys(this._mediaPipelines[room]).filter(ph => {
            if (this._mediaPipelines[room][ph] == null) {
              return false;
            }
            const keys = Object.keys(this._mediaPipelines[room][ph].transposers);
            let t = keys.includes(transposerId)
            return t;
          });


          sinkTransposersToRelease.forEach(st => {
            this._mediaPipelines[room][st].transposers[transposerId].release()
            this.balancer.decrementHostStreams(st, C.MEDIA_PROFILE.MAIN);
            delete this._mediaPipelines[room][st].transposers[transposerId];
          });

          if (typeof mediaElement.release === 'function') {
            mediaElement.release(async (error) => {
              if (error) {
                return reject(this._handleError(error));
              }

              if (pipeline) {
                pipeline.activeElements--;

                Logger.info(LOG_PREFIX, `Pipeline elements decreased for room ${room}`,
                  { activeElements: pipeline.activeElements, roomId: room, hostId });
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
          Logger.warn(LOG_PREFIX, `Media element not found on stop`, { elementId });
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
    if (candidate.match(/.local/ig)) {
      return true;
    }
    return false;
  }

  addIceCandidate (elementId, candidate) {
    return new Promise(async (resolve, reject) => {
      const mediaElement = this.getMediaElement(elementId);
      try {
        if (mediaElement  && candidate) {
          if (this._checkForMDNSCandidate(candidate.candidate) &&
            !KURENTO_ALLOW_MDNS) {
            Logger.trace(LOG_PREFIX, "Ignoring a mDNS obfuscated candidate", candidate.candidate);
            return resolve();
          }

          const parsedCandidate = KMS_CLIENT.getComplexType('IceCandidate')(candidate);
          mediaElement.addIceCandidate(parsedCandidate, (error) => {
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

  async _vanillaGatherCandidates (elementId) {
    const mediaElement = this.getMediaElement(elementId);
    if (mediaElement == null) {
      throw (this._handleError(ERRORS[40101].error));
    }

    const handleGatheringDone = new Promise((resolve, reject) => {
      mediaElement.once(C.EVENT.MEDIA_STATE.ICE_GATHERING_DONE, () => {
        mediaElement.getLocalSessionDescriptor((error, localDescriptor) => {
          if (error) {
            return reject(error);
          }
          return resolve(localDescriptor);
        });
      });
    });

    const failOver = () => {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          mediaElement.getLocalSessionDescriptor((error, localDescriptor) => {
            if (error) {
              return reject(error);
            }
            return resolve(localDescriptor);
          });
        }, VANILLA_GATHERING_TIMEOUT);
      });
    };

    try {
      await this.gatherCandidates(elementId)
      return Promise.race([handleGatheringDone, failOver()]);
    } catch (error) {
      Logger.error(LOG_PREFIX, `Vanilla candidate gathering failed`,
        { error, mediaElementId: elementId });
      return Promise.reject(this._handleError(error));
    }
  }

  gatherCandidates (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }
        mediaElement.gatherCandidates((error) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.debug(LOG_PREFIX, `Triggered ICE gathering for ${elementId}`);
          return resolve();
        });
      }
      catch (err) {
        return reject(err);
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
    const { replaceIp, trickle } = params;
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);
        if (mediaElement) {
          if (mediaElement.negotiated) {
            Logger.warn(LOG_PREFIX, `Element ${elementId} was already negotiated, ignoring processOffer`);
            return resolve();
          }

          const { adapterOptions = {} } = params;

          if (KURENTO_REMOVE_REMB_RTCPFB || adapterOptions.kurentoRemoveRembRtcpFb === true) {
            sdpOffer = sdpOffer.replace(/a=rtcp-fb:.* goog-remb\r*\n*/ig, '');
          }

          Logger.trace(LOG_PREFIX, `Processing ${elementId} offer`, { offer: sdpOffer });

          mediaElement.processOffer(sdpOffer, (error, answer) => {
            if (error) {
              return reject(this._handleError(error));
            }

            mediaElement.negotiated = true;

            if (replaceIp || mediaElement.mcsCoreMediaType === C.MEDIA_TYPE.RTP) {
              if (mediaElement.host.ip && typeof mediaElement.host.ip === 'string') {
                answer = SdpWrapper.stReplaceServerIpv4(answer, mediaElement.host.ip);
              }
            }

            if (trickle || typeof mediaElement.gatherCandidates !== 'function') {
              return resolve(answer);
            }

            this._vanillaGatherCandidates(elementId)
              .then((localDescriptor) => {
                Logger.info(LOG_PREFIX, `Vanilla candidate gathering succeeded`,
                  { mediaElementId: elementId });
                return resolve(localDescriptor);
              })
              .catch(error => {
                return reject(this._handleError(error));
              });
          });
        } else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      } catch (err) {
        return reject(this._handleError(err));
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

          mediaElement.processAnswer(answer, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }

            mediaElement.negotiated = true;
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

  _getNormalizedMProfiles (profiles) {
    const options = {
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    };

    if (Object.prototype.hasOwnProperty.call(profiles, 'video')
      && profiles.video) {
      options.offerToReceiveVideo = true;
    }

    if (options.offerToReceiveVideo === false
      && Object.prototype.hasOwnProperty.call(profiles, 'content')
      && profiles.content) {
      options.offerToReceiveVideo = true;
    }

    if (Object.prototype.hasOwnProperty.call(profiles, 'audio') && profiles.audio) {
      options.offerToReceiveAudio = true;
    }

    return options;
  }

  generateOffer (elementId, options = {}) {
    return new Promise((resolve, reject) => {
      let offerOptions;
      const isTrickled = typeof options.trickle === 'undefined' || options.trickle;

      try {
        if (options.profiles) {
          const mProf = this._getNormalizedMProfiles(options.profiles);
          offerOptions = new (KMS_CLIENT.getComplexType('OfferOptions'))(mProf);
        }
      } catch (error) {
        Logger.error(LOG_PREFIX, "Failed to digest media offer options", error);
      }

      try {
        const mediaElement = this.getMediaElement(elementId);

        if (mediaElement) {
          mediaElement.generateOffer(offerOptions, (error, offer) => {
            if (error) {
              return reject(this._handleError(error));
            }

            const sanitize = (descriptor) => {
              if (mediaElement.mcsCoreMediaType === C.MEDIA_TYPE.RTP) {
                if (mediaElement.host.ip && typeof mediaElement.host.ip === 'string') {
                  descriptor = SdpWrapper.stReplaceServerIpv4(descriptor, mediaElement.host.ip);
                }
              }

              if (options.filterOptions && options.filterOptions.length > 0) {
                options.filterOptions.forEach(({ reg, val }) => {
                  descriptor = descriptor.replace(reg, val);
                });
                return descriptor;
              }

              return descriptor;
            };

            if (isTrickled || typeof mediaElement.gatherCandidates !== 'function') {
              return resolve(sanitize(offer));
            }

            this._vanillaGatherCandidates(elementId)
              .then((localDescriptor) => {
                Logger.info(LOG_PREFIX, `Vanilla candidate gathering succeeded`,
                  { mediaElementId: elementId });
                return resolve(sanitize(localDescriptor));
              })
              .catch(error => {
                return reject(this._handleError(error));
              });
          });
        } else {
          // MEDIA_NOT_FOUND
          return reject(this._handleError(ERRORS[40101].error));
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  requestKeyframe (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this.getMediaElement(elementId);

        if (typeof mediaElement.requestKeyframe !== 'function') {
          throw this._handleError({
            ...C.ERROR.MEDIA_INVALID_OPERATION,
            details: "KURENTO_REQUEST_KEYFRAME_NOT_IMPLEMENTED"
          });
        }

        mediaElement.requestKeyframe((error) => {
          if (error) {
            return reject(this._handleError(error));
          }

          return resolve();
        });

      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  dtmf () {
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
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_GATHERING_DONE, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_CANDIDATE_PAIR_SELECTED, elementId);
        if (KURENTO_TRACK_ICE_STATE_CHANGES) {
          this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE_STATE_CHANGE, elementId);
        }
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

  _shouldSendCandidate (candidate) {
    if (ALLOWED_CANDIDATE_IPS == null || ALLOWED_CANDIDATE_IPS.length <= 0) {
      return true;
    }

    return ALLOWED_CANDIDATE_IPS.some(ip => candidate.includes(ip));
  }

  addMediaEventListener (eventTag, elementId) {
    const mediaElement = this.getMediaElement(elementId);
    let event;
    try {
      if (mediaElement) {
        Logger.trace(LOG_PREFIX, `Adding media state listener ${eventTag}`, { eventTag, elementId });
        mediaElement.on(eventTag, (rawEvent) => {
          const timestampUTC = Date.now();
          const timestampHR = Util.hrTime();
          switch (eventTag) {
            case C.EVENT.MEDIA_STATE.ICE:
              if (!this._shouldSendCandidate(rawEvent.candidate.candidate)) {
                return;
              }
              event = {
                candidate: KMS_CLIENT.getComplexType('IceCandidate')(rawEvent.candidate),
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
        Object.keys(this._mediaElements[mek].transposers).forEach(t => {
          if (t === hostId) {
            delete this._mediaElements[mek].transposers[t];
          }
        });

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

    // Checking if the error needs to be wrapped into a JS Error instance
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

  // Here be dragons

  // no-op
  // eslint-disable-next-line no-unused-vars
  consume (sinkId, sourceId, type) {
    return new Promise((resolve, reject) => {
      const sink = this.getMediaElement(sinkId);

      if (sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      sink.getLocalSessionDescriptor((error, localDescriptor) => {
        if (error) {
          return reject(error);
        }
        return resolve(localDescriptor);
      });
    });
  }
};
