'use strict';

const EventEmitter = require('events');
const Logger = require('../common/logger.js');
const LiveKitWebhookReceiver = require('./livekit-webhook-receiver.js');
const LiveKitRtcEventReceiver = require('./livekit-rtc-event-receiver.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');

/**
 * LiveKitEventGateway is a centralized event bus for LiveKit events.
 * It abstracts the source of events (webhooks or RTC agent) from the consumers.
 * Receivers (webhook or RTC) will push events to this gateway, and consumers
 * will listen for events on it.
 * @extends EventEmitter
 */
class LiveKitEventGateway extends EventEmitter {
  static MAX_LISTENERS = 1000;

  /**
   * @param {import('livekit-server-sdk')} liveKitSDK - The LiveKit Server SDK.
   * @param {import('@livekit/rtc-node')} liveKitRTC - The LiveKit RTC (Node) SDK.
   * @param {import('livekit-server-sdk').RoomServiceClient} roomServiceClient - The LiveKit RoomServiceClient.
   * @param {string} host - The LiveKit server host.
   * @param {string} key - The LiveKit API key.
   * @param {string} secret - The LiveKit API secret.
   * @param {object} options
   * @param {string} options.eventSource - The event source to use ('webhook' or 'agent').
   * @param {number} options.webhookPort - The port for the webhook receiver.
   * @param {string} options.webhookPath - The path for the webhook receiver.
   * @param {number} [options.maxListeners=1000] - The maximum number of listeners for the EventEmitter.
   */
  constructor(
    liveKitSDK,
    liveKitRTC,
    roomServiceClient,
    host,
    key,
    secret, {
      eventSource,
      webhookPort,
      webhookPath,
      maxListeners = LiveKitEventGateway.MAX_LISTENERS,
    }
  ) {
    super();
    this.setMaxListeners(maxListeners);

    this.liveKitSDK = liveKitSDK;
    this.liveKitRTC = liveKitRTC;
    this.roomServiceClient = roomServiceClient;
    this.host = host;
    this.key = key;
    this.secret = secret;
    this.eventSource = eventSource;
    this.webhookPort = webhookPort;
    this.webhookPath = webhookPath;
    this.eventReceiver = null;
  }

  /**
   * Initializes the event receiver based on the configured event source.
   */
  init() {
    switch (this.eventSource) {
      case 'webhook':
        this.eventReceiver = new LiveKitWebhookReceiver(
          this.liveKitSDK,
          this.roomServiceClient,
          this.host,
          this.key,
          this.secret,
          this.webhookPort,
          this.webhookPath,
          this, // eventGateway
        );
        break;
      case 'agent':
        this.eventReceiver = new LiveKitRtcEventReceiver(
          this.liveKitSDK,
          this.liveKitRTC,
          this.roomServiceClient,
          this.host,
          this.key,
          this.secret,
          this, // eventGateway
        );
        break;
      default:
        throw new Error(`LiveKitEventGateway: Unknown event source: ${this.eventSource}`);
    }

    if (this.eventReceiver) {
      this.eventReceiver.init();
    }
  }

  /**
   * Stops the active event receiver.
   */
  stop() {
    if (this.eventReceiver) {
      this.eventReceiver.stop();
    }
  }

  /**
   * Forwards the meeting created event to the agent-based receiver.
   * This is a no-op if the event source is not 'agent'.
   * Rationale: agent-based receiver needs to have room metadata prior to
   * joining the room.
   * @param {object} event - The BigBlueButton meeting created event.
   * @param {string} metadata - The LiveKit room metadata string.
   */
  handleMeetingCreated(event, metadata) {
    if (this.eventSource === 'agent' && this.eventReceiver) {
      this.eventReceiver.handleMeetingCreated(event, metadata);
    }
  }

  /**
   * Forwards the meeting ended event to the agent-based receiver.
   * This is a no-op if the event source is not 'agent'.
   * Rationale: the receiver's agent needs to shut down when the *BBB* meeting
   * ends, not LiveKit's.
   * @param {object} payload - The BigBlueButton meeting ended event payload.
   */
  handleMeetingEnded(payload) {
    if (this.eventSource === 'agent' && this.eventReceiver) {
      this.eventReceiver.handleMeetingEnded(payload);
    }
  }

  /**
   * Emits an event to the gateway, providing a single point for logging and debugging.
   * @param {string} eventName The name of the event to emit.
   * @param {object} payload The payload associated with the event.
   */
  emitEvent(eventName, payload) {
    Logger.debug(`LiveKitEventGateway: Emitting event '${eventName}'`, { payload });
    this.emit(eventName, payload);
    PrometheusAgent.increment(SFULK_NAMES.RTC_EVT_EMITTED, { eventName });
  }
}

module.exports = LiveKitEventGateway;
