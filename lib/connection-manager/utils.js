const extractUserInfos = (websocketReq) => {
  // Websocket req should probably be an upgrade req.
  // User infos are: user-id, meeting-id and voice-bridge.
  // They are set as custom HTTP headers in bbb-web _only if_ the upgrade req
  // goes through the _checkAuthorization_ endpoint && is authorized.
  // If by any reason something here is botched or missing, the method Throws
  // and the WebSocket connection should be closed

  const { headers } = websocketReq;
  const userId = headers['user-id'];
  const meetingId = headers['meeting-id']
  const voiceBridge = headers['voice-bridge'];

  if (typeof userId === 'string'
    && typeof meetingId === 'string'
    && typeof voiceBridge === 'string') {
    return { userId, meetingId, voiceBridge };
  } else {
    throw new Error('Invalid user infos in websocket headers');
  }
};


module.exports = {
  extractUserInfos,
}
