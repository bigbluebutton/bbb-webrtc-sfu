const http = require('http');
const url = require('url');
const querystring = require('querystring');
const config = require('config');
const Logger = require('../utils/Logger');

const callbacks = {};
const clients = {};

const LOG_PREFIX = "[oauth2/server]";
const SERVER_PORT = 8009;

const YouTube = require('./google');
const RNP = require('./rnp');

const oauth2Adapters = {
  'youtube': YouTube,
  'rnp': RNP,
};

const server = http.createServer((req, res) => {
  let parsedUrl = url.parse(req.url, true);
  let state = parsedUrl.query.state;
  let code = parsedUrl.query.code;
  let callback = callbacks[state];
  let client = clients[state];
  let oauth2Adapter = client && oauth2Adapters[client.streamType];

  if (callback && client) {
    oauth2Adapter.getToken(client, code, (err, token) => {
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

const onToken = (client, callback) => {
  let id = client.streamId;

  if (!callbacks[id]) {
    callbacks[id] = callback;
  }

  if (!clients[id]) {
    clients[id] = client;
  }
};

oauth2Adapters.rnp.onToken = onToken;
oauth2Adapters.youtube.onToken = onToken;

module.exports = oauth2Adapters;
