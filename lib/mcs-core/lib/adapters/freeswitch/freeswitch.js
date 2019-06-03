'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const MediaHandlerV2 = require('./sip-media-handler-v2');
const Logger = require('../../utils/logger');
const SIPJS = require('sip.js');
const Kurento = require('../kurento/kurento');
const isError = require('../../utils/util').isError;
const convertRange = require('../../utils/util').convertRange;
const rid = require('readable-id');
const { handleError } = require('../../utils/util');
const LOG_PREFIX = "[mcs-freeswitch]";
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');

const SdpWrapper = require('../../utils/sdp-wrapper');
const FREESWITCH_IP = config.get('freeswitch').ip;
const FREESWITCH_PORT = config.get('freeswitch').port;
const SDPMedia = require('../../model/sdp-media');
const EslWrapper = require('./esl-wrapper');

const UA_STOP_TIMEOUT = 15000;

let instance = null;

module.exports = class Freeswitch extends EventEmitter {
  constructor(balancer) {
    if(!instance){
      super();
      this._userAgents = {};
      this._rtpConverters = {};
      this._rtpProxies = {};
      this._channelIds = {};
      this._channelIdInfos = {};
      this._memberIdsToUa = {};
      this.balancer = balancer;
      this._Kurento = new Kurento(balancer);
      this._eslWrapper = new EslWrapper();
      this._eslWrapper.start();
      this._trackESLEvents();

      instance = this;
    }

    return instance;
  }

  _trackESLEvents() {
      this._eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, this._handleChannelAnswer.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, this._handleChannelHangup.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.START_TALKING, this._handleStartTalking.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, this._handleStopTalking.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.CONFERENCE_MEMBER, this._handleConferenceMember.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.VOLUME_CHANGED, this._handleVolumeChanged.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.MUTED, this._handleMuted.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.UNMUTED, this._handleUnmuted.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, this._handleFloorChanged.bind(this));
  }

  _handleChannelAnswer (channelId, callId, sdpOffer, sdpAnswer) {
    Logger.debug(LOG_PREFIX,'Associating channelUUID',channelId,'to callID',callId);
    this._channelIds[callId] = channelId;

    let channelInfo = this._channelIdInfos[channelId];
    if (!channelInfo) {
      channelInfo = {};
      this._channelIdInfos[channelId] = channelInfo;
    }

    channelInfo.callId = callId;
    channelInfo.sdpOffer = sdpOffer;
    channelInfo.sdpAnswer = sdpAnswer;

    for (var ua in this._userAgents) {
      let userAgent = this._userAgents[ua];
      if (userAgent.callId === callId) {
        userAgent.channelId = channelId;
        channelInfo.ua = ua;
      }
    }
  }

  _handleChannelHangup (channelId, callId) {
    let channelInfo = this._channelIdInfos[channelId];
    if (channelInfo) {
      const elementId = channelInfo.ua;
      //const elementId = this._channelIdInfos[channelId].ua;
      const userAgent = this._userAgents[elementId];
      if (userAgent && !userAgent.session) {
        // user joined externally, need to cleanup;
        this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
        this._deleteChannelMappings(elementId);
      }
    }
  }

  _handleStartTalking (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    Logger.debug(LOG_PREFIX,'Emitting User agent',elementId,'start talking event');
    this.emit(C.EVENT.MEDIA_START_TALKING+elementId);
  }

  _handleStopTalking (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    Logger.debug(LOG_PREFIX,'Emitting User agent',elementId,'stop talking event');
    this.emit(C.EVENT.MEDIA_STOP_TALKING+elementId);
  }

  async _handleConferenceMember (channelId, memberId, callerIdNumber,roomId) {
    Logger.debug(LOG_PREFIX,'Associating channelUUID',channelId,'to memberId',memberId);

    let channelInfo = this._channelIdInfos[channelId];
    channelInfo.memberId = memberId;
    let elementId = channelInfo.ua;

    if (!elementId) {
      // FIXME
      // this is temporary workaround to create media that joins freeswitch externally
      const splitted = callerIdNumber.split("-");
      // userId-bbbID-userName
      const userId = splitted[0];
      const userName = splitted[2];
      Logger.info(LOG_PREFIX,'External audio media joined!',callerIdNumber, roomId);
      const { sdpOffer, sdpAnswer } = this._channelIdInfos[channelId];

      let mediaElement, host;
      ({ mediaElement, host } = await this.createMediaElement(roomId, C.MEDIA_TYPE.WEBRTC, {}));
      elementId = mediaElement;
      //mediaSessionId is empty because we don't have it yet, will be set later
      let media = new SDPMedia(roomId, userId, "", sdpOffer, sdpAnswer, C.MEDIA_TYPE.WEBRTC, this, elementId, host, {});
      media.trackMedia();

      let userAgent = this._userAgents[elementId];
      userAgent.callId = channelInfo.callId;
      userAgent.channelId = channelId;
      channelInfo.ua = elementId;

      const event = {
        roomId,
        userId,
        userName,
        sdpOffer,
        sdpAnswer,
        media
      }

      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_EXTERNAL_AUDIO_CONNECTED,event);
    }
    this._memberIdsToUa[memberId] = elementId;
  }

  _handleVolumeChanged (channelId, volume) {
    const elementId = this._channelIdInfos[channelId].ua;
    const convertedVolume = convertRange({floor: -4, ceiling: 4},
      {floor: 0, ceiling: 100}, volume);
    Logger.debug(LOG_PREFIX,'Emitting User ',elementId,'Volume Changed',convertedVolume);
    this.emit(C.EVENT.MEDIA_VOLUME_CHANGED+elementId, convertedVolume);
  }

  _handleMuted (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    Logger.debug(LOG_PREFIX,'Emitting User ',elementId,'muted');
    this.emit(C.EVENT.MEDIA_MUTED+elementId);
  }

  _handleUnmuted (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    Logger.debug(LOG_PREFIX,'Emitting User ',elementId,'unmuted');
    this.emit(C.EVENT.MEDIA_UNMUTED+elementId);
  }

  _handleFloorChanged (roomId, newFloorMemberId) {
    const newFloorElementId = this._memberIdsToUa[newFloorMemberId];
    Logger.debug(LOG_PREFIX,'Emitting conference ',roomId,'video floor changed to',newFloorElementId);
    this.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED+newFloorElementId, { roomId: roomId, newFloor: newFloorElementId });
  }

  negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    let media;
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        default:
          throw(this._handleError(ERRORS[40107]));
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    let mediaElement, host;
    Logger.debug(LOG_PREFIX,"Negotiating SDP endpoint for", userId, "at", roomId);
    try {
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, options));
      const answer = await this.processOffer(mediaElement, descriptor, options);
      const media = new SDPMedia(roomId, userId, mediaSessionId, descriptor, answer, type, this, mediaElement, host, options);
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async createMediaElement (roomId, type, params) {
    try {
      const userAgentId = rid();
      let userAgent = await this._createUserAgent(type, params.name, roomId);
      userAgent.userAgentId = userAgentId;
      userAgent.voiceBridge = roomId;
      this._userAgents[userAgentId] = userAgent;
      // TODO integrate FS adapter with Balancer
      return Promise.resolve({ mediaElement: userAgentId, host: {ip: FREESWITCH_IP, port: FREESWITCH_PORT} });
    }
    catch (err) {
      return Promise.reject(err);
    }
  }

  async connect (sourceId, sinkId, type) {
    const userAgent = this._userAgents[sourceId];
    const { voiceBridge, session } = userAgent;
    const rtpConverter = this._rtpConverters[sourceId];

    Logger.debug(LOG_PREFIX,"Connecting", sourceId, "to", sinkId);

    if (session) {
      return new Promise(async (resolve, reject) => {
        if (rtpConverter == null) {
          return reject(C.ERROR.MEDIA_NOT_FOUND);
        }

        switch (type) {
          case C.CONNECTION_TYPE.ALL:

          case C.CONNECTION_TYPE.AUDIO:

          case C.CONNECTION_TYPE.VIDEO:
            try {
              await this._Kurento.connect(rtpConverter.elementId, sinkId, type);
              return resolve();
            } catch (e) {
              return reject(e);
            }
            break;
          default:
            return reject(C.ERROR.MEDIA_INVALID_OPERATION);
        }
      });
    }
    else {
      return Promise.reject(C.ERROR.MEDIA_NOT_FOUND);
    }
  }

  stop (roomId, type = {}, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX,"Releasing endpoint", elementId, "from room", roomId);

        await this._stopUserAgent(elementId);
        await this._stopRtpConverter(roomId, elementId);
        await this._stopRtpProxy(roomId, elementId);
        this._removeElementEventListeners(elementId);
        return resolve();
      }
      catch (error) {
        error = this._handleError(error);
        return reject(error);
      }
    });
  }

  _deleteChannelMappings(elementId) {
    if (elementId in this._channelIds) {
      let channelId = this._channelIds[elementId];
      delete this._channelIds[elementId];
      let memberId = this._channelIdInfos[channelId].memberId;
      delete this._memberIdsToUa[memberId];
      delete this._channelIdInfos[channelId];
    };
  }

  async _stopUserAgent (elementId) {
    let userAgent = this._userAgents[elementId];

    if (userAgent) {
      let stopped = false;

      Logger.debug(LOG_PREFIX,"Stopping user agent", elementId);
      const { session } = userAgent;

      const uaWaitForDisconnection = () => {
        return new Promise((resolve, reject) => {
          userAgent.once('disconnected', () => {
            stopped = true;
            Logger.warn(LOG_PREFIX, "SIP.js user agent disconnected on stop procedure for", elementId);
            delete this._userAgents[elementId];
            this._deleteChannelMappings(elementId);
            return resolve();
          });
        });
      };

      const uaStopFailover = () => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (!stopped) {
              Logger.warn(LOG_PREFIX, "User agent hit failover timeout, sockets might be leaking", { elementId });
            }
            resolve();
          }, UA_STOP_TIMEOUT);
        });
      }

      userAgent.stop();

      return Promise.race([uaWaitForDisconnection(), uaStopFailover()]);
    }
    else {
      Logger.debug(LOG_PREFIX,"User agent not found, probably already released", elementId);
      return Promise.resolve();
    }
  }

  async _stopRtpConverter (voiceBridge, elementId) {
    return new Promise(async (resolve, reject) => {
      let rtpConverter = this._rtpConverters[elementId];
      if (rtpConverter) {
        Logger.debug(LOG_PREFIX,"Stopping converter", rtpConverter.elementId);
        await this._Kurento.stop(voiceBridge, C.MEDIA_TYPE.RTP, rtpConverter.elementId);
        this.balancer.decrementHostStreams(rtpConverter.host.id, C.MEDIA_PROFILE.AUDIO);
        delete this._rtpConverters[elementId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  async _stopRtpProxy (voiceBridge, elementId) {
    return new Promise(async (resolve, reject) => {
      let rtpProxy = this._rtpProxies[elementId];
      if (rtpProxy) {
        Logger.debug(LOG_PREFIX,"Stopping proxy", rtpProxy.elementId);
        await this._Kurento.stop(voiceBridge, C.MEDIA_TYPE.RTP, rtpProxy.elementId);
        this.balancer.decrementHostStreams(rtpProxy.host.id, C.MEDIA_PROFILE.AUDIO);
        delete this._rtpProxies[elementId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  _processProxyElement (voiceBridge, elementId, offer) {
    return new Promise(async (resolve, reject) => {
      try {
        let mediaElement, host;

        ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP, { mediaProfile: C.MEDIA_PROFILE.AUDIO }));
        this._rtpProxies[elementId] = { elementId: mediaElement, host };
        let answer;
        if (offer) {
          answer = await this._Kurento.processOffer(mediaElement, offer, { replaceIp: true });
        } else {
          answer = await this._Kurento.generateOffer(mediaElement);
        }

        this.balancer.incrementHostStreams(host.id, C.MEDIA_PROFILE.AUDIO);
        return resolve(answer);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  processAnswer (elementId, descriptor) {
    const { session } = this._userAgents[elementId];

    if (session == null) {
      throw (C.ERROR.MEDIA_NOT_FOUND);
    }

    return session.mediaHandler.setRemoteOffer(descriptor);
  }

  async processOffer (elementId, sdpOffer, params) {
    const userAgent = this._userAgents[elementId];
    const { voiceBridge } = userAgent;
    const { name, hackProxyViaKurento } = params
    let mediaElement, host, proxyAnswer, isNegotiated = false;

    return new Promise(async (resolve, reject) => {
      try {
        if (userAgent) {
          if (hackProxyViaKurento) {
            if (this._rtpConverters[elementId]) {
              mediaElement = this._rtpConverters[elementId].elementId;
            }
            else {
              ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP, { mediaProfile: C.MEDIA_PROFILE.AUDIO }));
              this._rtpConverters[elementId] = { elementId: mediaElement, host };
              this.balancer.incrementHostStreams(host.id, C.MEDIA_PROFILE.AUDIO);
            }

            Logger.info(LOG_PREFIX,"Proxying audio to FS via Kurento for", elementId, "at", voiceBridge);
            proxyAnswer = await this._processProxyElement(voiceBridge, elementId, sdpOffer);
            this._Kurento.connect(this._rtpProxies[elementId].elementId, this._rtpConverters[elementId].elementId, C.CONNECTION_TYPE.AUDIO);
            this._Kurento.connect(this._rtpConverters[elementId].elementId, this._rtpProxies[elementId].elementId, C.CONNECTION_TYPE.AUDIO);

            sdpOffer = null;

            Logger.info(LOG_PREFIX,"RTP endpoint equivalent to SIP instance is", mediaElement, "indexed at", voiceBridge);
          }

          const session = this.sipCall(userAgent,
            name,
            userAgent.voiceBridge,
            FREESWITCH_IP,
            FREESWITCH_PORT,
            this._rtpConverters[elementId]? this._rtpConverters[elementId].elementId : null,
            sdpOffer,
          );

          session.sessionId = userAgent.userAgentId;
          userAgent.session = session;

          const handleOffer = async (offer) => {
            if (!hackProxyViaKurento) {
              return resolve(offer);
            }

            const procOffer = SdpWrapper.getAudioSDP(offer);
            const procAns = await this._Kurento.processOffer(
              this._rtpConverters[elementId].elementId,
              procOffer,
              { replaceIp: true }
            );
            session.mediaHandler.setRemoteOffer(procAns);
          }

          session.once(C.EVENT.REMOTE_SDP_RECEIVED, handleOffer.bind(this));

          const handleNegotiationError = (c) => {
            this._deleteChannelMappings(elementId);
            if (!isNegotiated) {
              isNegotiated = true;
              return reject(this._handleError(C.ERROR.MEDIA_PROCESS_OFFER_FAILED));
            }
          }

          session.on('accepted', (response, cause) => {
            if (response) {
              session.callId = response.call_id;
            }

            const answer = hackProxyViaKurento ? proxyAnswer : session.mediaHandler._sdpResponse;
            isNegotiated = true;

            return resolve(answer);
          });

          session.on('progress', (response) => {
            if (response) {
              userAgent.callId = response.call_id;
              let channelId = this._channelIds[response.call_id];
              if (channelId) {
                Logger.debug(LOG_PREFIX,'Setting channelId',channelId,'of',response.call_id);
                userAgent.channelId = channelId;
                let channelInfo = this._channelIdInfos[channelId];
                if (!channelInfo) {
                  channelInfo = {};
                  this._channelIdInfos[channelId] = channelInfo;
                }
                channelInfo.ua = elementId;
                let memberId = channelInfo.memberId;
                if (memberId) {
                  this._memberIdsToUa[memberId] = elementId;
                }
              }
            }
          });

          session.once('rejected', (response, cause) => {
            Logger.info(LOG_PREFIX,"Session", elementId, "rejected", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.once('failed', (response, cause) => {
            Logger.info(LOG_PREFIX,"Session", elementId, "failed", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.once('terminated', (response) => {
            Logger.info(LOG_PREFIX,"Session", elementId, "terminated")
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError();
          });

        } else {
          return reject(C.ERROR.MEDIA_NOT_FOUND);
        }
      }
      catch (error) {
        this._handleError(error);
        reject(error);
      }
    });
  }

  async setVolume (mediaElementId, volume) {
    return new Promise(async (resolve, reject) => {
      try {
        const userAgent = this._userAgents[mediaElementId];
        const { voiceBridge, callId } = userAgent;
        Logger.info(LOG_PREFIX,'setVolume ' + mediaElementId + ' volume with ' +
        volume);
        if (callId) {
          let channelId = userAgent.channelId;
          let memberId = this._channelIdInfos[channelId].memberId;

          if (volume != 0 && userAgent.muted) {
            //unmute
            await this._eslWrapper.unmute(voiceBridge, memberId);
            userAgent.muted = false;
          }
          if (volume != 0) {
            const convertedVolume = convertRange({floor: 0, ceiling: 100},
              {floor: -4, ceiling: 4}, volume);
            Logger.info(LOG_PREFIX,"Setting new volume", convertedVolume, "to media", mediaElementId, "with channelId ID", channelId);
            await this._eslWrapper.setVolume(voiceBridge, memberId, convertedVolume);
            userAgent.volume = convertedVolume;
          } else if (volume == 0 && !userAgent.muted) {
            //mute
            await this._eslWrapper.mute(voiceBridge, memberId);
            userAgent.muted = true;
          }
          return resolve();

        } else {
          return reject(LOG_PREFIX,"There is no session for element " + mediaElementId);
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async mute (mediaElementId) {
    return new Promise(async (resolve, reject) => {
      try {
        const userAgent = this._userAgents[mediaElementId];
        const { voiceBridge, callId } = userAgent;
        if (callId) {
          let channelId = userAgent.channelId;
          let memberId = this._channelIdInfos[channelId].memberId;

          Logger.info(LOG_PREFIX,"Setting mute to media",mediaElementId, "with channelId ID", channelId);
          await this._eslWrapper.mute(voiceBridge, memberId);
          userAgent.muted = true;
          return resolve();

        } else {
          return reject(LOG_PREFIX,"There is no session for element " + mediaElementId);
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async unmute (mediaElementId) {
    return new Promise(async (resolve, reject) => {
      try {
        const userAgent = this._userAgents[mediaElementId];
        const { voiceBridge, callId } = userAgent;
        if (callId) {
          let channelId = userAgent.channelId;
          let memberId = this._channelIdInfos[channelId].memberId;

          Logger.info(LOG_PREFIX,"Setting unmute to media",mediaElementId, "with channelId ID", channelId);
          await this._eslWrapper.unmute(voiceBridge, memberId);
          userAgent.muted = false;
          if (userAgent.volume) {
            this._handleVolumeChanged(channelId, userAgent.volume);
          } else {
            this._handleVolumeChanged(channelId, 0);
          }
          return resolve();

        } else {
          return reject(LOG_PREFIX,"There is no session for element " + mediaElementId);
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  };

  trackMediaState (elementId, type) {
    let userAgent = this._userAgents[elementId];
    if (userAgent) {
      userAgent.on('invite', function(session) {
        Logger.info(LOG_PREFIX,"On UserAgentInvite");
      });

      userAgent.on('message', function(message) {
        Logger.info(LOG_PREFIX,"On UserAgentMessage", message);
      });

      userAgent.on('connected', function() {
        Logger.info(LOG_PREFIX,"On UserAgentConnected");
      });

      userAgent.on('disconnected', function (){
        Logger.warn(LOG_PREFIX,"UserAgent disconnected");
      });

      return;
    }
  }

  _destroyElements() {
    for (var ua in this._userAgents) {
      if (this._userAgents.hasOwnProperty(ua)) {
        delete this._mediaElements[ua];
      }
    }
  }

  _createUserAgent (type, displayName, roomId) {
    const uriUser = displayName ? displayName : roomId;
    const newUA = new SIPJS.UA({
      uri: `sip:${uriUser}@${FREESWITCH_IP}`,
      wsServers: `ws://${FREESWITCH_IP}:${FREESWITCH_PORT}`,
      displayName: displayName,
      register: false,
      mediaHandlerFactory: MediaHandlerV2,
      userAgentString: C.STRING.SIP_USER_AGENT,
      log: {
        builtinEnabled: false,
        level: 3,
        connector: this.sipjsLogConnector
      },
      traceSip: true,
      hackIpInContact: FREESWITCH_IP
    });

    Logger.info(LOG_PREFIX,"Created new user agent for endpoint " + displayName);

    return newUA;
  }

/**
   * Makes a sip call to a Freeswitch instance
   * @param {UA} caller's SIP.js User Agent
   * @param {String} username The user identifier (Kurento Endpoint ID)
   * @param {String} voiceBridge The voiceBridge we are going to call to
   * @param {String} host Freeswitch host address
   * @param {String} port Freeswitch port
   */
  sipCall (userAgent, username, voiceBridge, host, port, rtp, descriptor) {
    const inviteWithoutSdp = !descriptor;

    // Call options
    const options = {
      media: {
        constraints: {
          audio: true,
          video: false
        },
      },
      inviteWithoutSdp,
      params: {
        from_displayName : username
      }
    };

    const sipUri = new SIPJS.URI('sip', voiceBridge, host, port);

    Logger.info(LOG_PREFIX,'Making SIP call to: ' + sipUri + ' from: ' + username);

    const session = userAgent.invite(sipUri, options);

    // Avoid leaking DTMF transactions. We will ignore inbound INFO DTMF
    // for now because they are useless, but if the transaction is pending
    // that's problematic for UA stop. FIXME emit DTMF event to interested clients
    session.on('dtmf', (request, dtmf) => {
      request.reply(200);
    });

    // We have a descriptor, set the offer and trigger the INVITE
    if (!inviteWithoutSdp) {
      session.mediaHandler.setRemoteOffer(descriptor);
    }

    return session;
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }

  _removeElementEventListeners (elementId) {
    const eventsToRemove = C.EVENT.ADAPTER_EVENTS.map(p => `${p}${elementId}`);
    Logger.trace(LOG_PREFIX, "Removing all event listeners for", elementId);
    eventsToRemove.forEach(e => {
      this.removeAllListeners(e);
    });
  }

  sipjsLogConnector (level, category, label, content) {
    Logger.debug('[SIP.js]  ' + content);
  }
};
