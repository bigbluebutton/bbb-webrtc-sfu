const http = require('http')
const fs = require('fs');
const url = require('url');
const querystring = require('querystring');
const Logger = require('../utils/Logger');

const {google} = require('googleapis');
const OAuth2 = google.auth.OAuth2;

const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

const LOG_PREFIX = "[oauth2/youtube]";

const ERROR = {
  NO_BROADCASTS: "No Broadcasts",
  NO_CONTENT: "No content",
  NO_STREAMS: "No streams",
};

let client_secret = null;

fs.readFile('client_secret.json', function processClientSecrets(err, content) {
  if (err) {
    Logger.info(LOG_PREFIX, 'Error loading client secret file: ' + err);
    return;
  }

  client_secret = JSON.parse(content);
});

const getOAuth2Url = (streamId, meetingId, userId, meetingName, streamType, callback) => {

  authorize(client_secret, (oauth2Client) => {

    let authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state: streamId,
    });

    Object.assign(oauth2Client, {
      meetingId,
      userId,
      meetingName,
      streamId,
      streamType,
    });

    return callback(oauth2Client, authUrl);
  });

}

const getToken = (oauth2Client, code, callback) => {
  oauth2Client.getToken(code, (err, token) => {
    if (err) {
      Logger.error(LOG_PREFIX, 'Error while trying to retrieve access token', err);
      return callback(err);
    }

    callback(err, token);
  });
}

const authorize = (credentials, callback) => {
  let clientSecret = credentials.web.client_secret;
  let clientId = credentials.web.client_id;
  let redirectUrl = credentials.web.redirect_uris[0];
  let oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

  return callback(oauth2Client);
}

const getVideoUrl = (videoId) => {
  const YOUTUBE_URL = "https://www.youtube.com/watch?v=";
  return YOUTUBE_URL + videoId;
};

const getStreamKey = (auth, callback) => {
  let service = google.youtube('v3');
  service.liveBroadcasts.list({
      auth,
      part: 'id,snippet,contentDetails',
      broadcastType: 'persistent',
      mine: 'true',
    }, (err, response) => {
    if (err) {
      Logger.error(LOG_PREFIX, 'The API returned an error: ' + err.errors[0].message);
      return callback(err.errors[0].message);
    }

    let broadcast = response.data.items[0];

    if (!broadcast) {
      return callback(ERROR.NO_BROADCASTS);
    }

    let contentDetails = broadcast.contentDetails;

    if (!contentDetails) {
        return callback(ERROR.NO_CONTENT)
    }

    let videoId = broadcast.id;
    let boundId = contentDetails.boundStreamId;

    service.liveStreams.list({
      auth,
      part: 'id,snippet,cdn',
      id: boundId,
    }, (err, response) => {
      if (err) {
        Logger.error(LOG_PREFIX, 'The API returned an error: ' + err.errors[0].message);
        return callback(err.errors[0].message);
      }
      let stream = response.data.items[0];

      if (!stream) {
        return callback(ERROR.NO_STREAMS);
      }

      let prefix = stream.cdn.ingestionInfo.ingestionAddress;
      let key = stream.cdn.ingestionInfo.streamName;

      return callback(null, `${prefix}/${key}`, getVideoUrl(videoId));
    });
  });
}

module.exports = {
  getToken,
  getOAuth2Url,
  getStreamKey,
}
