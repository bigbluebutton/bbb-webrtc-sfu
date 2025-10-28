'use strict';

const Logger = require('../common/logger.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');
const { isDisconnectReasonUnexpected } = require('./utils.js');

const SYS_METADATA = JSON.stringify({
  bbb_system: true,
});

/**
 * Receives LiveKit events by connecting to rooms as a hidden participant (agent).
 * The agent does not subscribe nor publish any tracks to a room.
 * It normalizes RTC events into a format similar to LiveKit webhooks and emits them
 * to the provided event gateway.
 */
class LiveKitRtcEventReceiver {
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

  /**
   * @param {import('livekit-server-sdk')} liveKitSDK - The LiveKit Server SDK.
   * @param {import('@livekit/rtc-node')} liveKitRTC - The LiveKit RTC (Node) SDK.
   * @param {import('livekit-server-sdk').RoomServiceClient} roomServiceClient - The LiveKit RoomServiceClient.
   * @param {string} host - The LiveKit server host.
   * @param {string} key - The LiveKit API key.
   * @param {string} secret - The LiveKit API secret.
   * @param {import('./livekit-event-gateway')} eventGateway - The event gateway to emit events to.
   */
  constructor(
    liveKitSDK,
    liveKitRTC,
    roomServiceClient,
    host,
    key,
    secret,
    eventGateway,
  ) {
    if (!liveKitSDK || !liveKitRTC || !host || !key || !secret || !eventGateway) {
      throw new Error('LiveKitRtcEventReceiver: liveKitSDK, liveKitRTC, host, key, secret and eventGateway are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._liveKitRTC = liveKitRTC;
    this._roomServiceClient = roomServiceClient;
    this.host = host;
    this.key = key;
    this.secret = secret;
    this._eventGateway = eventGateway;

    // Map<roomName, Room>
    this._agentMap = new Map();
  }

  /**
   * Formats a TrackPublication into a webhook-like Track object.
   * @param {import('@livekit/rtc-node').TrackPublication} publication - The track publication.
   * @returns {object} A formatted track object.
   * @private
   */
  _formatTrack(publication) {
    if (!publication) return {};

    return {
      sid: publication.sid,
      name: publication.name,
      type: publication.kind,
      kind: publication.kind,
      source: publication.source,
      width: publication.dimensions?.width,
      height: publication.dimensions?.height,
      mimeType: publication.mimeType,
      muted: publication.isMuted,
    }
  }

  /**
   * Formats a Participant into a webhook-like Participant object.
   * @param {import('@livekit/rtc-node').Participant} participant - The participant.
   * @returns {object} A formatted participant object.
   * @private
   */
  _formatParticipant(participant) {
    if (!participant) return {};

    const tracks = [];
    // participant.trackPublications is a Map<string, TrackPublication>.
    // We iterate over its values to get each publication.
    for (const pub of participant.trackPublications.values()) {
      tracks.push(this._formatTrack(pub));
    }

    return {
      sid: participant.sid,
      identity: participant.identity,
      state: participant.state,
      // Webhook payload uses `tracks`, RTC SDK uses `trackPublications`
      tracks,
      metadata: participant.metadata,
      joinedAt: participant.joinedAt,
      name: participant.name,
      version: participant.version,
      permission: participant.permissions,
      region: participant.region,
      kind: participant.kind,
      // `disconnectReason` is not available through RTC events, only webhooks.
      // Consumers of `participant_left` must handle this field being undefined.
    }
  }

  /**
   * Formats a Room into a webhook-like Room object.
   * @param {import('@livekit/rtc-node').Room} room - The room.
   * @returns {object} A formatted room object.
   * @private
   */
  _formatRoom(room) {
    if (!room) return {};

    const agentData = this._agentMap.get(room.name);
    const metadata = agentData?.metadata ?? room.metadata;

    return {
      sid: room.sid,
      name: room.name,
      metadata,
      numParticipants: room.remoteParticipants.size,
      activeRecording: room.isRecording,
    }
  }

  /**
   * Adds an agent to the internal map.
   * @param {string} roomName - The name of the room.
   * @param {import('@livekit/rtc-node').Room} agent - The agent's room object.
   * @param {string} metadata - The room's metadata string.
   * @private
   */
  _addAgent(roomName, agent, metadata) {
    this._agentMap.set(roomName, { agent, metadata });
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_RTC_EVT_RCVRS, this._getAgentCount());
  }

  /**
   * Removes an agent from the internal map.
   * @param {string} roomName - The name of the room.
   * @private
   */
  _removeAgent(roomName) {
    this._agentMap.delete(roomName);
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_RTC_EVT_RCVRS, this._getAgentCount());
  }

  /**
   * Checks if an agent exists for the given room.
   * @param {string} roomName - The name of the room.
   * @returns {boolean} True if the agent exists, false otherwise.
   * @private
   */
  _hasAgent(roomName) {
    return this._agentMap.has(roomName);
  }

  /**
   * Retrieves the agent for the given room.
   * @param {string} roomName - The name of the room.
   * @returns {import('@livekit/rtc-node').Room|null} The agent's room object or null if not found.
   * @private
   */
  _getAgent(roomName) {
    return this._agentMap.get(roomName);
  }

  /**
   * Gets the total number of active agents.
   * @returns {number} The count of active agents.
   * @private
   */
  _getAgentCount() {
    return this._agentMap.size;
  }

  /**
   * Starts an agent to connect to the specified room and monitor events.
   * @param {string} roomName - The name of the room to connect to.
   * @param {string} metadata - The room's metadata string.
   * @returns {Promise<import('@livekit/rtc-node').Room>} The connected agent's room object.
   * private
   */
  async _startAgent(roomName, metadata) {
    try {
      if (this._agentMap.has(roomName)) {
        Logger.debug('LiveKitRtcEventReceiver: Agent already exists for room', { roomName });
        return this._getAgent(roomName);
      }

      const identity = `sfu-agent-${roomName}`;
      const token = new this._liveKitSDK.AccessToken(this.key, this.secret, {
        identity: identity,
        ttl: 86400, // 24 hours
        metadata: SYS_METADATA,
      });

      token.addGrant({
        ...LiveKitRtcEventReceiver.DEFAULT_PERMISSIONS,
        room: roomName,
        roomJoin: true,
      });

      const jwt = await token.toJwt();
      const room = new this._liveKitRTC.Room();

      room.on(this._liveKitRTC.RoomEvent.ParticipantConnected, (participant) => {
        this._eventGateway.emitEvent('participant_joined', {
          event: 'participant_joined',
          room: this._formatRoom(room),
          participant: this._formatParticipant(participant),
        });
      });

      room.on(this._liveKitRTC.RoomEvent.ParticipantDisconnected, (participant) => {
        this._eventGateway.emitEvent('participant_left', {
          event: 'participant_left',
          room: this._formatRoom(room),
          participant: this._formatParticipant(participant),
        });
      });

      room.on(this._liveKitRTC.RoomEvent.TrackPublished, (publication, participant) => {
        this._eventGateway.emitEvent('track_published', {
          event: 'track_published',
          room: this._formatRoom(room),
          participant: this._formatParticipant(participant),
          track: this._formatTrack(publication),
        });
      });

      room.on(this._liveKitRTC.RoomEvent.TrackUnpublished, (publication, participant) => {
        this._eventGateway.emitEvent('track_unpublished', {
          event: 'track_unpublished',
          room: this._formatRoom(room),
          participant: this._formatParticipant(participant),
          track: this._formatTrack(publication),
        });
      });

      room.on(this._liveKitRTC.RoomEvent.Disconnected, (disconnectReason) => {
        const unexpected = isDisconnectReasonUnexpected(disconnectReason);

        if (!unexpected) {
          Logger.info('LiveKitRtcEventReceiver: Agent disconnected from room gracefully', {
            roomName,
            identity,
            disconnectReason,
          });

          this._eventGateway.emitEvent('room_finished', {
            event: 'room_finished',
            room: this._formatRoom(room),
          });
          this._removeAgent(roomName);

          return;
        }

        Logger.error('LiveKitRtcEventReceiver: Agent disconnected from room unexpectedly', {
          roomName,
          identity,
          disconnectReason,
        });

        // TODO implement re-connection logic for unexpected disconnects
        this._removeAgent(roomName);

        PrometheusAgent.increment(SFULK_NAMES.RTC_EVT_RCVRS_DISCONNECTED, {
          disconnectReason: disconnectReason ?? 'unknown',
        });
      });

      room.on(this._liveKitRTC.RoomEvent.Reconnecting, () => {
        Logger.warn('LiveKitRtcEventReceiver: Agent reconnecting to room', { roomName, identity });
        PrometheusAgent.increment(SFULK_NAMES.RTC_EVT_RCVRS_RECONNECTING);
      });

      room.on(this._liveKitRTC.RoomEvent.Reconnected, () => {
        Logger.info('LiveKitRtcEventReceiver: Agent reconnected to room', { roomName });
        PrometheusAgent.increment(SFULK_NAMES.RTC_EVT_RCVRS_RECONNECTED);
      });

      await room.connect(this.host, jwt, { autoSubscribe: false });
      this._addAgent(roomName, room, metadata);
      this._eventGateway.emitEvent('room_started', {
        event: 'room_started',
        room: this._formatRoom(room),
      });

      Logger.info('LiveKitRtcEventReceiver: Agent connected to room', { roomName });

      return room;
    } catch (error) {
      Logger.error('LiveKitRtcEventReceiver: Error creating agent', {
        error: error.message,
        stack: error.stack,
        roomName,
        metadata,
      });

      throw error;
    }
  }

  /*
   * Stops and disconnects the agent from the specified room.
   * @param {string} roomName - The name of the room.
   * @returns {Promise<void>}
   * private
   */
  async _stopAgent(roomName) {
    try {
      const agentData = this._agentMap.get(roomName);

      if (agentData?.agent) {
        await agentData.agent.disconnect();
        this._removeAgent(roomName);
        Logger.info('LiveKitRtcEventReceiver: Agent disconnected from room', { roomName });
      }
    } catch (error) {
      Logger.error('LiveKitRtcEventReceiver: Error disconnecting agent', {
        error: error.message,
        stack: error.stack,
        roomName,
      });
      // Do not throw - stop is an internal failure and should not impact caller.
    }
  }

  /**
   * Initializes the receiver. Currently a no-op as agents are created on-demand.
   */
  init() {
    Logger.info('LiveKitRtcEventReceiver initialized');
  }

  /**
   * Stops the receiver and disconnects all active agents.
   * @returns {Promise<void>}
   */
  async stop() {
    const disconnectPromises = [];

    for (const [roomName] of this._agentMap.entries()) {
      disconnectPromises.push(this._stopAgent(roomName));
    }

    await Promise.all(disconnectPromises);
    this._agentMap.clear();
    PrometheusAgent.set(SFULK_NAMES.ACTIVE_RTC_EVT_RCVRS, this._getAgentCount());

    Logger.info('LiveKitRtcEventReceiver stopped');
  }

  /**
   * Handles the creation of a BigBlueButton meeting. Connects a new agent to the
   * corresponding LiveKit room to start monitoring events.
   * @param {object} event - The BigBlueButton meeting created event.
   * @param {string} metadata - The LiveKit room metadata string.
   * @returns {Promise<void>}
   */
  async handleMeetingCreated (event, metadata) {
    try {
      const roomName = event.meetingId;

      if (!roomName) {
        Logger.warn('LiveKitRtcEventReceiver: Room name not found in meeting created event', { event });
        return;
      }

      await this._startAgent(roomName, metadata);
    } catch (error) {
      Logger.error('LiveKitRtcEventReceiver: Error handling meeting created event', {
        error: error.message,
        stack: error.stack,
        event,
      });
    }
  }

  /**
   * Handles the end of a BigBlueButton meeting. Disconnects the agent from the
   * corresponding LiveKit room.
   * @param {object} payload - The BigBlueButton meeting ended event payload.
   * @returns {Promise<void>}
   */
  async handleMeetingEnded (payload) {
    const roomName = payload?.meetingId || payload?.header?.meetingId;

    if (!roomName) return;

    await this._stopAgent(roomName);
  }
}

module.exports = LiveKitRtcEventReceiver;
