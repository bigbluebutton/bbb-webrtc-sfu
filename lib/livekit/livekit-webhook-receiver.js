'use strict';

const express = require('express');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../common/logger.js');

/**
 * Receives and validates incoming webhooks from a LiveKit server.
 * It uses the livekit-server-sdk's WebhookReceiver to ensure authenticity and then
 * emits the validated events to the event gateway.
 * @extends EventEmitter
 */
class LiveKitWebhookReceiver extends EventEmitter {
  /**
   * @param {import('livekit-server-sdk')} liveKitSDK - The LiveKit Server SDK.
   * @param {import('livekit-server-sdk').RoomServiceClient} roomServiceClient - The LiveKit RoomServiceClient.
   * @param {string} host - The LiveKit server host.
   * @param {string} key - The LiveKit API key.
   * @param {string} secret - The LiveKit API secret.
   * @param {number} port - The port to listen on for webhooks.
   * @param {string} path - The URL path for the webhook endpoint.
   * @param {import('./livekit-event-gateway')} eventGateway - The event gateway to emit events to.
   */
  constructor(
    liveKitSDK,
    roomServiceClient,
    host,
    key,
    secret,
    port,
    path,
    eventGateway,
  ) {
    super();

    if (!liveKitSDK || !roomServiceClient || !key || !secret || !path || !port || !eventGateway) {
      throw new Error('LiveKitWebhookReceiver: liveKitSDK, RSC, key, secret, port, path and eventGateway are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._eventGateway = eventGateway;

    this.receiver = new this._liveKitSDK.WebhookReceiver(key, secret);
    this.host = host;
    this.key = key;
    this.secret = secret;
    this.path = path;
    this.port = port;
  }

  /**
   * Initializes the express server to listen for incoming webhooks.
   */
  init() {
    if (this.app) return;

    this.app = express();
    this.app.use(express.raw({ type: 'application/webhook+json' }));

    this.app.post(this.path, async (req, res) => {

      try {
        const event = await this.receiver.receive(req.body, req.get('Authorization'));
        this._handleEvent(event);
        res.status(200).send('OK');
      } catch (error) {
        Logger.error('LiveKitWebhookReceiver: error handling event', error);
        if (error?.message === "authorization header is empty"
          || error?.message === "sha256 checksum of body does not match"
          || error?.type === "JWSSignatureVerificationFailed") {
          res.status(401).send('Unauthorized');
          return;
        }

        res.status(500).send(`Error: ${error.message}`);
      }
    });

    this._server = this.app.listen(this.port, () => {
      Logger.info(`LiveKitWebhookReceiver listening at http://localhost:${this.port}`, {
        path: this.path,
        port: this.port,
      });
    });
  }

  /**
   * Handles a validated webhook event by emitting it to the event gateway.
   * @param {import('livekit-server-sdk').WebhookEvent} webhookEvent - The validated webhook event.
   * @private
   */
  _handleEvent(webhookEvent) {
    this._eventGateway.emitEvent('webhookEvent', webhookEvent);
    this._eventGateway.emitEvent(webhookEvent?.event, webhookEvent);
  }

  /**
   * Stops the express server.
   */
  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
      this.app = null;
    }

    Logger.info('LiveKitWebhookReceiver stopped');
  }
}

module.exports = LiveKitWebhookReceiver;
