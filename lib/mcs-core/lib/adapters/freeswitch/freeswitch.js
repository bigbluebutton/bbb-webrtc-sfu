'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const mediaHandler = require('./sip-media-handler');
const Logger = require('../../utils/logger');
const SIPJS = require('sip.js');
const Kurento = require('../kurento/kurento');
const isError = require('../../utils/util').isError;
const convertRange = require('../../utils/util').convertRange;
const rid = require('readable-id');
const { handleError } = require('../../utils/util');
const LOG_PREFIX = "[mcs-freeswitch]";

const FREESWITCH_IP = config.get('freeswitch').ip;
const FREESWITCH_PORT = config.get('freeswitch').port;
const SDPMedia = require('../../model/sdp-media');
//const sendEslCommand = require('./esl.js');
const EventSocket = require('./eventSocket');

let instance = null;

module.exports = class Freeswitch extends EventEmitter {
  constructor(balancer) {
    if(!instance){
      super();
      this._userAgents = {};
      this._rtpConverters = {};
      this._rtpProxies = {};
      this._channelIds = {};
      //map channelId to UserAgent
      this._channelIdsToUa = {};
      this._memberIds = {};
      this._memberIdsToUa = {};
      this.balancer = balancer;
      this._Kurento = new Kurento(balancer);
      this._eventSocket = new EventSocket();
      this._eventSocket.start();
      this._eventSocket.on('channelAnswer', this._handleChannelAnswer.bind(this));
      this._eventSocket.on('startTalking', this._handleStartTalking.bind(this));
      this._eventSocket.on('stopTalking', this._handleStopTalking.bind(this));
      this._eventSocket.on('conferenceMember', this._handleConferenceMember.bind(this));
      this._eventSocket.on('volumeChanged', this._handleVolumeChanged.bind(this));
      this._eventSocket.on('muted', this._handleMuted.bind(this));
      this._eventSocket.on('unmuted', this._handleUnmuted.bind(this));
      this._eventSocket.on('floorChanged', this._handleFloorChanged.bind(this));      
      instance = this;
    }

    return instance;
  }
  
  _handleChannelAnswer (channelId, callId) {
    Logger.info(LOG_PREFIX,'Associating channelUUID',channelId,'to callID',callId);
    this._channelIds[callId] = channelId;
    for (var ua in this._userAgents) {
      let userAgent = this._userAgents[ua];
      if (userAgent.session.callId === callId) {
        userAgent.session.channelId = channelId;
        this._channelIdsToUa[channelId] = ua;
      }
      //Logger.info(LOG_PREFIX,'UA calld id',userAgent.session.callId);
    }
  }

  _handleStartTalking (channelId) {
    let elementId = this._channelIdsToUa[channelId];
    Logger.info(LOG_PREFIX,'Emitting User agent',elementId,'start talking event');
    this.emit(C.EVENT.MEDIA_START_TALKING+elementId);
  }

  _handleStopTalking (channelId) {
    let elementId = this._channelIdsToUa[channelId];
    Logger.info(LOG_PREFIX,'Emitting User agent',elementId,'stop talking event');
    this.emit(C.EVENT.MEDIA_STOP_TALKING+elementId);
  }

  _handleConferenceMember (channelId, memberId) {
    Logger.info(LOG_PREFIX,'Associating channelUUID',channelId,'to memberId',memberId);
    this._memberIds[channelId] = memberId;
    let elementId = this._channelIdsToUa[channelId];
    this._memberIdsToUa[memberId] = elementId;
  }

  _handleVolumeChanged (channelId, volume) {
    let elementId = this._channelIdsToUa[channelId];
    const convertedVolume = convertRange({floor: -4, ceiling: 4},
      {floor: 0, ceiling: 100}, volume);
    Logger.info(LOG_PREFIX,'Emitting User ',elementId,'Volume Changed',convertedVolume);
    this.emit(C.EVENT.MEDIA_VOLUME_CHANGED+elementId, convertedVolume);
  }

  _handleMuted (channelId) {
    let elementId = this._channelIdsToUa[channelId];
    Logger.info(LOG_PREFIX,'Emitting User ',elementId,'muted');
    this.emit(C.EVENT.MEDIA_MUTED+elementId);
  }

  _handleUnmuted (channelId) {
    let elementId = this._channelIdsToUa[channelId];
    Logger.info(LOG_PREFIX,'Emitting User ',elementId,'unmuted');
    this.emit(C.EVENT.MEDIA_UNMUTED+elementId);
  }

  _handleFloorChanged (roomId, newFloorMemberId) {
    let newFloorElementId = this._memberIdsToUa[newFloorMemberId];
    Logger.info(LOG_PREFIX,'Emitting conference ',roomId,'video floor changed to',newFloorElementId);
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
    const rtpConverter = this._rtpConverters[sourceId].elementId;

    Logger.debug(LOG_PREFIX,"Connecting", rtpConverter, "to", sinkId);

    if (session) {
      return new Promise((resolve, reject) => {
        switch (type) {
          case C.CONNECTION_TYPE.ALL:

          case C.CONNECTION_TYPE.AUDIO:

          case C.CONNECTION_TYPE.VIDEO:
            this._Kurento.connect(rtpConverter, sinkId, type);
            return resolve();
            break;

          default: return reject(LOG_PREFIX,"Invalid connect type");
        }
      });
    }
    else {
      return Promise.reject(LOG_PREFIX,"Failed to connect " + type + ": " + sourceId + " to " + sinkId);
    }
  }

  stop (roomId, type = {}, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX,"Releasing endpoint", elementId, "from room", roomId);

        await this._stopUserAgent(elementId);
        await this._stopRtpConverter(roomId, elementId);
        await this._stopRtpProxy(roomId, elementId);
        return resolve();
      }
      catch (error) {
        error = this._handleError(error);
        return reject(error);
      }
    });
  }

  async _stopUserAgent (elementId) {
    return new Promise(async (resolve, reject) => {
      Logger.debug(LOG_PREFIX,"Releasing userAgent", elementId);
      let userAgent = this._userAgents[elementId];

      if (userAgent) {
        Logger.debug(LOG_PREFIX,"Stopping user agent", elementId);
        await userAgent.stop();
        delete this._userAgents[elementId];
        let channelId = this._channelIds[elementId];
        delete this._channelIds[elementId];
        delete this._channelIdsToUa[elementId];
        let memberId = this._memberIds[channelId];
        delete this._memberIds[channelId];
        delete this._memberIdsToUa[memberId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  async _stopRtpConverter (voiceBridge, elementId) {
    return new Promise(async (resolve, reject) => {
      let rtpConverter = this._rtpConverters[elementId];
      if (rtpConverter) {
        Logger.debug(LOG_PREFIX,"Stopping converter", rtpConverter.elementId);
        await this._Kurento.stop(voiceBridge, C.MEDIA_TYPE.RTP, rtpConverter.elementId);
        this.balancer.decrementHostStreams(rtpConverter.host.id, 'audio');
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
        this.balancer.decrementHostStreams(rtpProxy.host.id, 'audio');
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

        ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP));
        this._rtpProxies[elementId] = { elementId: mediaElement, host };
        const answer = await this._Kurento.processOffer(mediaElement, offer, { replaceIp: true });
        this.balancer.incrementHostStreams(host.id, 'audio');
        return resolve(answer);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  async processOffer (elementId, sdpOffer, params) {
    const userAgent = this._userAgents[elementId];
    const { voiceBridge } = userAgent;
    const { name, hackProxyViaKurento } = params
    let mediaElement, host, proxyAnswer, isNegotiated = false;

    return new Promise(async (resolve, reject) => {
      try {
        if (userAgent) {
          if (sdpOffer == null || hackProxyViaKurento) {
            if (this._rtpConverters[elementId]) {
              mediaElement = this._rtpConverters[elementId].elementId;
            }
            else {
              ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP));
              this._rtpConverters[elementId] = { elementId: mediaElement, host };
              this.balancer.incrementHostStreams(host.id, 'audio');
            }

            if (hackProxyViaKurento) {
              Logger.info(LOG_PREFIX,"Proxying audio to FS via Kurento for", elementId, "at", voiceBridge);
              proxyAnswer = await this._processProxyElement(voiceBridge, elementId, sdpOffer);
              this._Kurento.connect(this._rtpProxies[elementId].elementId, this._rtpConverters[elementId].elementId, C.CONNECTION_TYPE.AUDIO);
              this._Kurento.connect(this._rtpConverters[elementId].elementId, this._rtpProxies[elementId].elementId, C.CONNECTION_TYPE.AUDIO);

              sdpOffer = null;
            }

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

          userAgent.session = session;

          const handleNegotiationError = (c) => {
            if (!isNegotiated) {
              isNegotiated = true;
              return reject(this._handleError(C.ERROR.MEDIA_PROCESS_OFFER_FAILED));
            }
          }

          session.on('accepted', (response, cause) => {
            if (response) {
              session.callId = response.call_id;
              let channelId = this._channelIds[response.call_id];
              if (channelId) {
                Logger.info(LOG_PREFIX,'Setting channelId',channelId,'of',response.call_id);
                session.channelId = channelId;
                this._channelIdsToUa[channelId] = elementId;
                let memberId = this._memberIds[channelId];
                if (memberId) {
                  this._memberIdsToUa[memberId] = elementId;
                }
              }
            }

            const answer = hackProxyViaKurento ? proxyAnswer : session.mediaHandler.remote_sdp;
            isNegotiated = true;

            return resolve(answer);
          });

          session.on('rejected', (response, cause) => {
            Logger.info(LOG_PREFIX,"Session", elementId, "rejected", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.on('failed', (response, cause) => {
            Logger.info(LOG_PREFIX,"Session", elementId, "failed", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.on('terminated', (response) => {
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
        const { voiceBridge, session } = userAgent;
        Logger.info(LOG_PREFIX,'setVolume ' + mediaElementId + ' volume with ' +
        volume);
        if (session) {
          let channelId = userAgent.session.channelId;
          let memberId = this._memberIds[channelId];

          if (volume != 0 && session.muted) {
            //unmute
            await this._eventSocket.unmute(voiceBridge, memberId);
            session.muted = false;
          } 
          if (volume != 0) {
            const convertedVolume = convertRange({floor: 0, ceiling: 100},
              {floor: -4, ceiling: 4}, volume);
            Logger.info(LOG_PREFIX,"Setting new volume", convertedVolume, "to media", mediaElementId, "with channelId ID", channelId);
            await this._eventSocket.setVolume(voiceBridge, memberId, convertedVolume);
            session.volume = convertedVolume;
          } else if (volume == 0 && !session.muted) {
            //mute
            await this._eventSocket.mute(voiceBridge, memberId);
            session.muted = true;
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
        const { voiceBridge, session } = userAgent;
        if (session) {
          let channelId = userAgent.session.channelId;
          let memberId = this._memberIds[channelId];

          Logger.info(LOG_PREFIX,"Setting mute to media",mediaElementId, "with channelId ID", channelId);
          await this._eventSocket.mute(voiceBridge, memberId);
          session.muted = true;
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
        const { voiceBridge, session } = userAgent;
        if (session) {
          let channelId = userAgent.session.channelId;
          let memberId = this._memberIds[channelId];

          Logger.info(LOG_PREFIX,"Setting unmute to media",mediaElementId, "with channelId ID", channelId);
          await this._eventSocket.unmute(voiceBridge, memberId);
          session.muted = false;
          if (session.volume) {
            this._handleVolumeChanged(channelId, session.volume);
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
    var mediaFactory = mediaHandler.SIPMediaHandler.defaultFactory;
    const uriUser = displayName ? displayName : roomId;
    var newUA = new SIPJS.UA({
      uri: 'sip:' + uriUser + '@' + FREESWITCH_IP,
      wsServers: 'ws://' + FREESWITCH_IP + ':' + FREESWITCH_PORT,
      displayName: displayName,
      register: false,
      mediaHandlerFactory: mediaFactory,
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
  sipCall (userAgent, username, voiceBridge, host, port, rtp, sdpOffer) {
    const inviteWithoutSdp = sdpOffer ? false : true;
    //call options
    var options = {
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

    mediaHandler.SIPMediaHandler.setup(sdpOffer, rtp, this._Kurento);

    var sipUri = new SIPJS.URI('sip', voiceBridge, host, port);

    Logger.info(LOG_PREFIX,'Making SIP call to: ' + sipUri + ' from: ' + username);

    return userAgent.invite(sipUri, options);
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
  sipjsLogConnector (level, category, label, content) {
    Logger.debug('[SIP.js]  ' + content);
  }
};
