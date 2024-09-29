const OutMessage2x = require('../OutMessage2x');

const GENERATE_LIVEKIT_TOKEN_RESP_MSG = "GenerateLiveKitTokenRespMsg";

module.exports = class GenerateLiveKitTokenRespMsg extends OutMessage2x {
  constructor (meetingId, userId, token, grant) {
    super(
      GENERATE_LIVEKIT_TOKEN_RESP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body = {
      token,
      grant,
    }
  }
}
