'use strict';

const { AudioStream } = require('@livekit/rtc-node');
const Logger = require('../common/logger.js');
const Messaging = require('../bbb/messages/Messaging.js');
const C = require('../bbb/messages/Constants.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');
const {
  getUserIdFromParticipant,
  isValidSourceString,
  isFrontendParticipant,
  isWebUser,
  parseLiveKitMetadata,
  validBBBMetadata,
  trackSourceToString,
} = require('./utils.js');
const AudioEnergyFilter = require('./energy-filter.js');
const SYS_METADATA = JSON.stringify({
  bbb_system: true,
});
const VALID_DTMF_ACTIONS = ['toggleMute']

class LiveKitAgentManager {
  static DEFAULT_PERMISSIONS = {
    agent: true,
    canPublish: false,
    canPublishData: false,
    canPublishSources: [],
    canSubscribe: true,
    canUpdateOwnMetadata: true,
    hidden: true,
    ingressAdmin: false,
    recorder: false,
    roomAdmin: false,
    roomCreate: false,
    roomJoin: true,
    roomList: true,
    roomRecord: false,
  }

  static DEFAULT_SUBSCRIPTION_SOURCES = ['microphone'];

  constructor(
    liveKitSDK,
    liveKitRTC,
    roomServiceClient,
    host,
    key,
    secret,
    eventBus,
    bbbGW, {
      autoSubscribe = false,
      permissions = LiveKitAgentManager.DEFAULT_PERMISSIONS,
      subscriptionSources = LiveKitAgentManager.DEFAULT_SUBSCRIPTION_SOURCES,
      dtmfActions = {},
      energyFilterOptions = {},
    } = {},
  ) {
    if (!liveKitSDK || !liveKitRTC || !host || !key || !secret || !eventBus) {
      throw new Error('LiveKitAgentManager: liveKitSDK, liveKitRTC, host, key, secret, and eventBus are required');
    }

    if (!Array.isArray(subscriptionSources) || !subscriptionSources.every(isValidSourceString)) {
      throw new Error('LiveKitAgentManager: subscriptionSources must be an array of valid source strings');
    }

    this._liveKitSDK = liveKitSDK;
    this._liveKitRTC = liveKitRTC;
    this._roomServiceClient = roomServiceClient;
    this._bbbGW = bbbGW;
    this.host = host;
    this.key = key;
    this.secret = secret;
    this._eventBus = eventBus;
    this._autoSubscribe = autoSubscribe;
    this._permissions = permissions;
    this._subscriptionSources = subscriptionSources;
    this._dtmfActions = dtmfActions;
    this._energyFilterOptions = energyFilterOptions;

    // Map<roomName, Room>
    this._agentMap = new Map();
    this._subscriptionMap = new Map();
    this._dtmfSeqActionMap = this._generateDTMFSeqActionMap(dtmfActions);

    this._handleRoomStarted = this._handleRoomStarted.bind(this);
    this._handleRoomEnded = this._handleRoomEnded.bind(this);
    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleTrackUnpublished = this._handleTrackUnpublished.bind(this);
    this._handleTrackSubscribed = this._handleTrackSubscribed.bind(this);
    this._handleTrackUnsubscribed = this._handleTrackUnsubscribed.bind(this);
    this._handleDTMFReceived = this._handleDTMFReceived.bind(this);
  }

  _validSource(source) {
    const parsedSource = typeof source === 'string' ? source : trackSourceToString(this._liveKitSDK, source);

    return this._subscriptionSources.includes(parsedSource);
  }

  _validParticipant(remoteParticipant) {
    const webUser = isWebUser(remoteParticipant?.identity);
    const frontendParticipant = isFrontendParticipant(
      remoteParticipant?.kind,
      remoteParticipant?.permissions?.hidden,
      remoteParticipant?.metadata,
    )

    return !webUser && frontendParticipant;
  }

  _hasDTMFActions() {
    return Object.keys(this._dtmfActions).length > 0 && this._dtmfSeqActionMap.size > 0;
  }

  _generateDTMFSeqActionMap(dtmfActions) {
    if (Object.keys(dtmfActions).length === 0) return new Map();

    // dtmfActions is a key-value map of actions to be performed when a DTMF
    // sequence is received. Currently supported actions: 'toggleMute'.
    // Format: {
    //   ActionName: DTMFSequence | DTMFSequence[]
    // }
    const seqActionMap = new Map();
    const actionMap = {
      toggleMute: this._toggleMuteParticipant.bind(this),
    };
    const addSeq = (seq, action) => {
      if (typeof seq === 'string' && seq.length > 0) {
        seqActionMap.set(seq, action);
        Logger.debug('LiveKitAgentManager: Added DTMF sequence action', { action, sequence: seq });
      } else {
        Logger.warn('LiveKitAgentManager: Invalid DTMF sequence', { action, sequence: seq });
      }
    };

    Object.entries(dtmfActions).forEach(([action, sequence]) => {
      if (!VALID_DTMF_ACTIONS.includes(action)) {
        Logger.warn('LiveKitAgentManager: Invalid DTMF action', { action });
        return;
      }

      if (seqActionMap.has(action)) return;

      if (Array.isArray(sequence)) {
        sequence.forEach(seq => addSeq(seq, actionMap[action]));
      } else {
        addSeq(sequence, actionMap[action]);
      }
    });

    return seqActionMap;
  }

  _addAgent(roomName, agent) {
    this._agentMap.set(roomName, agent);
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_AGENTS, this.getAgentCount());
  }

  _removeAgent(roomName) {
    this._agentMap.delete(roomName);
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_AGENTS, this.getAgentCount());
  }

  _cancelSubscription(trackSid) {
    const subscription = this._subscriptionMap.get(trackSid);

    if (subscription?.stream && typeof subscription.stream.cancel === 'function') {
      subscription.stream.cancel().catch((error) => {
        Logger.error('LiveKitAgentManager: Error canceling audio stream', {
          trackSid,
          errorMessage: error?.message,
          errorStack: error?.stack,
        });
      });
    }

    this._subscriptionMap.delete(trackSid);
  }

  _clearAllSubscriptions() {
    for (const [trackSid] of this._subscriptionMap) {
      this._cancelSubscription(trackSid);
    }

    this._subscriptionMap.clear();
  }

  async _toggleMuteParticipant({ participant, participantMetadata }) {
    const roomName = participantMetadata?.bbb_meetingId;
    const bbbVoiceConf = participantMetadata?.bbb_voiceConf;
    const participantIdentity = participant?.identity;

    try {
      const targetTracks = Array.from(participant.trackPublications.values()).filter((publication) => {
        return trackSourceToString(this._liveKitSDK, publication?.source) === 'microphone'
      });
      const currentMuteState = targetTracks.length > 0 ? targetTracks[0].muted : true;

      if (targetTracks.length > 0) {
        const newMuteState = !currentMuteState;

        await Promise.all(targetTracks.map((track) => {
          return this._roomServiceClient.mutePublishedTrack(
            roomName, participantIdentity, track.sid, newMuteState
          );
        }));

        this._bbbGW.publish(Messaging.generateUserMutedInVoiceConfEvtMsg(
          bbbVoiceConf,
          participant?.sid, // voiceUserId
          newMuteState,
        ), C.FROM_VOICE_CONF);
      }
    } catch (error) {
      Logger.error('LiveKitAgentManager: Error toggling mute for participant', {
        error: error.message,
        stack: error.stack,
        participantIdentity,
        roomName,
      });
    }
  }

  hasAgent(roomName) {
    return this._agentMap.has(roomName);
  }

  getAgent(roomName) {
    return this._agentMap.get(roomName);
  }

  getAgentCount() {
    return this._agentMap.size;
  }

  init() {
    this._eventBus.on('room_started', this._handleRoomStarted);
    this._eventBus.on('room_finished', this._handleRoomEnded);

    Logger.info('LiveKitAgentManager initialized');
  }

  async _handleRoomStarted(event) {
    try {
      const roomName = event.room?.name;
      const roomMetadata = parseLiveKitMetadata(event.room);

      if (!roomName) {
        Logger.warn('LiveKitAgentManager: Room name not found in event', { event });
        return;
      }

      if (!roomMetadata || !roomMetadata.bbb_meetingId || !roomMetadata.bbb_voiceConf) {
        Logger.debug('LiveKitAgentManager: Invalid room metadata', { roomMetadata, event });
        return;
      }

      if (this.hasAgent(roomName)) {
        Logger.debug('LiveKitAgentManager: Agent already exists for room', { roomName });
        return;
      }

      const identity = `bbb-webrtc-sfu/${roomName}`;

      Logger.info('LiveKitAgentManager: Creating agent for room', {
        agent: identity,
        roomName,
        autoSubscribe: this._autoSubscribe,
        subscriptionSources: this._subscriptionSources,
      });

      const { AccessToken } = this._liveKitSDK;
      const acct = new AccessToken(
        this.key,
        this.secret, {
          identity,
          ttl: 14400,
          metadata: SYS_METADATA,
        },
      );

      acct.addGrant({
        ...this._permissions,
        room: roomName,
      });

      const jwt = await acct.toJwt();
      const room = new this._liveKitRTC.Room();

      await room.connect(this.host, jwt, {
        autoSubscribe: this._autoSubscribe,
        dynacast: false,
      });

      this._addAgent(roomName, room);

      room
        .on(this._liveKitRTC.RoomEvent.ActiveSpeakersChanged, (speakers) => {
          Logger.debug('LiveKitAgentManager: ActiveSpeakersChanged', {
            agent: identity,
            speakers,
          });
        })
        .on(this._liveKitRTC.RoomEvent.TrackSubscribed, this._handleTrackSubscribed)
        .on(this._liveKitRTC.RoomEvent.TrackUnsubscribed, this._handleTrackUnsubscribed)
        .on(this._liveKitRTC.RoomEvent.TrackPublished, this._handleTrackPublished)
        .on(this._liveKitRTC.RoomEvent.TrackUnpublished, this._handleTrackUnpublished)
        .on(this._liveKitRTC.RoomEvent.Disconnected, (reason) => {
          Logger.debug('LiveKitAgentManager: Disconnected', {
            agent: identity,
            reason,
          });
          // Cancel all AudioStreams for this room's subscribed tracks
          // (TrackUnsubscribed may not fire for all tracks on disconnect)
          for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) {
              if (this._subscriptionMap.has(publication.sid)) {
                this._cancelSubscription(publication.sid);
              }
            }
          }
          this._removeAgent(roomName);
        });

      if (this._hasDTMFActions) {
        room.on(this._liveKitRTC.RoomEvent.DtmfReceived, this._handleDTMFReceived);
      }

      Logger.info('LiveKitAgentManager: Agent created for room', {
        agent: identity,
        roomName,
      });
    } catch (error) {
      Logger.error('LiveKitAgentManager: Error creating agent', {
        error: error.message,
        stack: error.stack,
        event,
      });
    }
  }

  async _handleDTMFReceived(code, digit, participant) {
    if (!this._validParticipant(participant)) return;

    Logger.debug('LiveKitAgentManager: DTMF received', {
      code,
      digit,
      participantSid: participant.sid,
      participantIdentity: participant.identity,
      participant,
    });

    // TODO: Handle DTMF sequences (buffer X digits)?
    const action = this._dtmfSeqActionMap.get(digit);

    if (!action) return;

    Logger.debug('LiveKitAgentManager: Executing DTMF action', {
      digit,
      participantSid: participant.sid,
      participantIdentity: participant.identity,
    });

    try {
      const participantMetadata = parseLiveKitMetadata(participant);

      if (!validBBBMetadata(participantMetadata)) throw new Error('Invalid participant metadata');

      await action({ participant, participantMetadata });
      Logger.info('LiveKitAgentManager: DTMF action executed', {
        digit,
        participantSid: participant.sid,
        participantIdentity: participant.identity,
      });
    } catch (error) {
      Logger.error('LiveKitAgentManager: Error executing DTMF action', {
        digit,
        participantSid: participant.sid,
        participantIdentity: participant.identity,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  async _handleRoomEnded(event) {
    try {
      const roomName = event.room?.name;

      if (!roomName) {
        Logger.warn('LiveKitAgentManager: Room name not found in event', { event });
        return;
      }

      const agent = this.getAgent(roomName);

      if (agent) {
        Logger.info('LiveKitAgentManager: Disconnecting agent for room', { roomName });
        await agent.disconnect();
        this._removeAgent(roomName);
      }
    } catch (error) {
      Logger.error('LiveKitAgentManager: Error disconnecting agent', {
        error: error.message,
        stack: error.stack,
        event,
      });
    }
  }

  async _handleTrackPublished(remotePublication, remoteParticipant) {
    if (this._autoSubscribe) return;

    const { source } = remotePublication;

    if (!this._validSource(source) || remotePublication.isSubscribed) {
      Logger.debug('LiveKitAgentManager: Track not valid or already subscribed', {
        source,
        trackSid: remotePublication?.trackSid,
        participantSid: remoteParticipant?.sid,
        participantIdentity: remoteParticipant?.identity,
      });
      return;
    }

    if (!this._validParticipant(remoteParticipant)) {
      Logger.debug('LiveKitAgentManager: Participant not valid', {
        remoteParticipant,
      });
      return;
    }

    Logger.info('LiveKitAgentManager: Subscribing to track', {
      source,
      trackSid: remotePublication?.trackSid,
      participantSid: remoteParticipant?.sid,
      participantIdentity: remoteParticipant?.identity,
    });

    remotePublication.setSubscribed(true);
  }

  async _handleTrackUnpublished(remotePublication, remoteParticipant) {
    Logger.debug('LiveKitAgentManager: _handleTrackUnpublished', { remotePublication, remoteParticipant });
    const { source } = remotePublication;

    if (remotePublication?.trackSid) {
      this._cancelSubscription(remotePublication.trackSid);
    }

    if (this._autoSubscribe) return;

    if (!this._validSource(source) || !remotePublication.isSubscribed) return;
    if (!this._validParticipant(remoteParticipant)) return;

    remotePublication.setSubscribed(false);
  }

  async _handleTrackSubscribed(track, publication, participant) {
    const participantMetadata = parseLiveKitMetadata(participant);

    if (!validBBBMetadata(participantMetadata)) {
      Logger.warn('LiveKitAgentManager: Invalid participant metadata, ignoring track subscription', {
        participantSid: participant?.sid,
        participantIdentity: participant?.identity,
        participantMetadata,
      });

      return;
    }

    Logger.info('LiveKitAgentManager: TrackSubscribed', {
      trackSid: track.sid,
      publicationSid: publication.sid,
      participantSid: participant.sid,
      participantIdentity: participant.identity,
      participantMetadata,
    });

    const stream = new AudioStream(track);
    const energyFilter = new AudioEnergyFilter(this._energyFilterOptions);

    this._subscriptionMap.set(track.sid, {
      publication,
      participant,
      stream,
      energyFilter,
    });

    let lastEnergyState = AudioEnergyFilter.State.SILENCE;
    let lastTalkingState = false;

    for await (const frame of stream) {
      if (!frame || !this._subscriptionMap.has(track.sid)) return;

      const currentEnergyState = energyFilter.update(frame);

      if (currentEnergyState != lastEnergyState) {
        lastEnergyState = currentEnergyState;
        let currentTalkingState = lastTalkingState;

        switch (currentEnergyState) {
          case AudioEnergyFilter.State.SPEAKING:
            currentTalkingState = true;
            break;
          case AudioEnergyFilter.State.END:
            currentTalkingState = false;
            break;
        }

        if (currentTalkingState != lastTalkingState) {
          const userId = getUserIdFromParticipant(participant);

          this._bbbGW.publish(Messaging.generateSetUserTalkingReqMsg(
            participantMetadata?.bbb_meetingId,
            userId,
            currentTalkingState,
          ), C.TO_AKKA_APPS);

          lastTalkingState = currentTalkingState;
        }
      }
    }
  }

  async _handleTrackUnsubscribed(track, publication, participant) {
    Logger.info('LiveKitAgentManager: TrackUnsubscribed', {
      trackSid: track?.sid,
      publicationSid: publication?.sid,
      participantSid: participant?.sid,
      participantIdentity: participant?.identity,
    });

    this._cancelSubscription(track.sid);
  }

  async stop() {
    this._eventBus.removeListener('room_started', this._handleRoomStarted);
    this._eventBus.removeListener('room_finished', this._handleRoomEnded);

    const disconnectPromises = [];

    for (const [roomName, agent] of this._agentMap.entries()) {
      const identity = `bbb-webrtc-sfu/${roomName}`;
      Logger.debug('LiveKitAgentManager: Disconnecting agent during shutdown', {
        agent: identity,
        roomName,
      });
      disconnectPromises.push(agent.disconnect().catch(error => {
        Logger.warn('LiveKitAgentManager: Error disconnecting agent during shutdown', {
          agent: identity,
          roomName,
          error: error?.message,
          stack: error?.stack,
        });
      }));
    }

    await Promise.all(disconnectPromises);
    this._clearAllSubscriptions();
    this._agentMap.clear();
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_AGENTS, 0);

    Logger.info('LiveKitAgentManager stopped');
  }
}

module.exports = LiveKitAgentManager;
