const http = require('http')
const fs = require('fs');
const url = require('url');
const querystring = require('querystring');
const Logger = require('../utils/Logger');

const callbacks = {};
const clients = {};

const {google} = require('googleapis');
const OAuth2 = google.auth.OAuth2;

const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

const LOG_PREFIX = "[oauth2]";
const SERVER_PORT = 8009;

let client_secret = null;

fs.readFile('client_secret.json', function processClientSecrets(err, content) {
  if (err) {
    Logger.info(LOG_PREFIX, 'Error loading client secret file: ' + err);
    return;
  }

  client_secret = JSON.parse(content);
});

const getTokenUrl = (state, callback) => {

  authorize(client_secret, (oauth2Client) => {

    let authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state, 
    });

    return callback(oauth2Client, authUrl);
  });

}

const getToken = (oauth2Client, code, callback) => {
  oauth2Client.getToken(code, (err, token) => {
    if (err) {
      Logger.error(LOG_PREFIX, 'Error while trying to retrieve access token', err);
      return;
    }
    oauth2Client.credentials = token;
    callback(oauth2Client);
  });
}

const authorize = (credentials, callback) => {
  let clientSecret = credentials.web.client_secret;
  let clientId = credentials.web.client_id;
  let redirectUrl = credentials.web.redirect_uris[0];
  let oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

  return callback(oauth2Client);
}

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
      return callback('01 - No broadcasts');
    }

    let contentDetails = broadcast.contentDetails;

    if (!contentDetails) {
        return callback('02 - No content')
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
        return callback('No streams');
      }

      let prefix = stream.cdn.ingestionInfo.ingestionAddress;
      let key = stream.cdn.ingestionInfo.streamName;

      return callback(null, `${prefix}/${key}`, videoId);
    });
  });
}

const getStreamUrl = () => {

};

const server = http.createServer((req, res) => {
  let parsedUrl = url.parse(req.url, true);
  let state = parsedUrl.query.state;
  let code = parsedUrl.query.code;
  // let callback = callbacks[meetingId + userId];
  let callback = callbacks[state];
  let client = clients[state];

  if (callback && client) {
    client.getToken(code, (err, token) => {
      if (err) {
        Logger.error(LOG_PREFIX, 'Error while trying to retrieve access token', err);
        return callback(null);
      }

      client.credentials = token;
      return callback(client);
    });
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('');
});

server.listen(SERVER_PORT);

const onToken = (meetingId, userId, client, callback) => {
  let id = meetingId + userId;

  if (!callbacks[id]) {
    callbacks[id] = callback;
  }

  if (!clients[id]) {
    clients[id] = client;
  }
};


module.exports = {
  onToken,
  getTokenUrl,
  getStreamUrl,
  getStreamKey,
}
