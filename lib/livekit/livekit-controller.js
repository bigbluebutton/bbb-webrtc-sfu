'use strict';

const config = require('config');
const BaseManager = require('../base/base-manager.js');
const Logger = require('../common/logger.js');
// We need to convert this commented out require to a dynamic import because
// the updated livekit-server-sdk is an ES module - and we're still using
// CommonJS
// const { AccessToken } = require('livekit-server-sdk');
// Dynamic import:

const C = require('../bbb/messages/Constants.js');
const Messaging = require('../bbb/messages/Messaging.js');

const {
  tokenTTL: TOKEN_TTL = 3600,
  key: LIVEKIT_KEY,
  secret: LIVEKIT_SECRET,
} = config.has('livekit') ? config.get('livekit') : {};

class LiveKitController extends BaseManager {
  static async LiveKitSDK () {
    return import('livekit-server-sdk');
  }

  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
  }

  async start () {
    if (!LIVEKIT_KEY || !LIVEKIT_SECRET) {
      throw new Error('LiveKitController: LIVEKIT_KEY and LIVEKIT_SECRET must be set');
    }

    await super.start();
    this.liveKitSDK = await LiveKitController.LiveKitSDK();
    this._observe();
    Logger.info('LiveKitController started');
  }

  async stop () {
    await super.stop();
    Logger.info('LiveKitController stopped');
  }

  _observe() {
    this._bbbGW.on(
      C.GENERATE_WEBRTC_TOKEN_REQ_MESSAGE,
      this._handleGenerateWebRtcTokenReq.bind(this)
    );
  }

  _handleGenerateWebRtcTokenReq (payload) {
    const { meetingId, userId: identity, userName, grant } = payload;
    try {
      const token = this._createAccessToken(identity, userName, grant);
      Logger.info('LiveKitController: Token created', { meetingId, userId: identity, userName, grant });
      this._bbbGW.publish(Messaging.generateGenerateWebrtcTokenRespMsg(
        meetingId, identity, token, grant,
      ), C.TO_AKKA_APPS_CHAN_2x);
    } catch (error) {
      Logger.error('LiveKitController: Error creating token', error);
    }
  }

  _createAccessToken (identity, userName, grant) {
    const { AccessToken } = this.liveKitSDK;
    const token = new AccessToken(
      LIVEKIT_KEY,
      LIVEKIT_SECRET, {
        identity,
        namm: userName,
        ttl: TOKEN_TTL,
      }
    );

    token.addGrant(grant);

    return token.toJwt();
  }
}

module.exports = LiveKitController;
