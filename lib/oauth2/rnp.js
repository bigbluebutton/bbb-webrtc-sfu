const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const querystring = require('querystring');
const config = require('config');
const Logger = require('../utils/Logger');

const transmissions = {};

const AUTH_URL = "/portal/oauth/authorize";
const PUBLISH_URL = "/services/transmission/publish";
const DATA_URL = "/services/transmission";
const TOKEN_URL = "/portal/oauth/token";

const SCOPES = ['ws:write'];

const LOG_PREFIX = "[oauth2/rnp]";
const SERVER_PORT = 8010;

const HOSTNAME = config.get("rnp.oauth2.base_url");
const CLIENT_ID = config.get("rnp.oauth2.client_id");
const CLIENT_SECRET = config.get("rnp.oauth2.client_secret");
const REDIRECT_URI = config.get("rnp.oauth2.redirect_uri");
const ENCODER_OUTPUT_IP = config.get("rnp.oauth2.host_ip");

const parseJSON = (json) => {
  let res = null;

  try {
    res = JSON.parse(json);
  } catch (e) {
    Logger.error(LOG_PREFIX, "Problem parsing JSON", e);
  }

  return res;
}

const generateAuthUrl = (client, opts) => {
  let params = {
    state: opts.state,
    scope: opts.scope,
    response_type: 'code',
    client_id: client.id,
    redirect_uri: client.redirect_uri,
  }

  return 'https://' + HOSTNAME + AUTH_URL + "?" + querystring.stringify(params);
};

const getOAuth2Url = (streamId, meetingId, userId, meetingName, streamType, callback) => {

  let client = {
    id: CLIENT_ID,
    secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    meetingId,
    userId,
    meetingName,
    streamId: meetingId,
    streamType,
  }

  let authUrl = generateAuthUrl(client, {
    scope: SCOPES,
    state: meetingId, 
  });

  return callback(client, authUrl);
};

const getToken = (client, code, callback) => {
  let data = querystring.stringify({
    code,
    grant_type: 'authorization_code',
    client_id: client.id,
    redirect_uri: client.redirect_uri,
  });

  let options = {
    hostname: HOSTNAME,
    path: TOKEN_URL,
    method: 'POST',
    headers: {
      client_secret: client.secret,
      "Content-type": "application/x-www-form-urlencoded",
    },
  };

  var req = https.request(options, (res) => {
    if (res.statusCode > 200) {
      Logger.error(LOG_PREFIX, "Problem getting token code: ", res.statusCode);
      return callback(res.statusCode);
    }

    let result = "";
    res.on('data', function (chunk) {
      result += chunk;
    });
    res.on('end', function () {
      let parsed = parseJSON(result);
      return callback(null, parsed.access_token); 
    });
    res.on('error', (err) => {
      Logger.error('Error getting token ', err);
    });
  });

  req.write(data);
  req.end();
};

const transmissionObject = (title) => {
  return {
    transmission: {
      title,
      description: title,
      encoderOutputIP: ENCODER_OUTPUT_IP,
      audienceExpected: 10,
      transmissionRate: 1000,
      days: [
        { day: getDateString(), }
      ],
      visibility: 'PUBLIC',
      startTime: '00:00',
      endTime: '23:59',
      //keywords: [title, 'mconf', 'webinar'].join(),
      //author: null,
      //eventName: title,
      //passwordURLTransmission: 'mconfpass',
    }
  };
};

const getDateString = () => {
  const date = new Date();

  let d = date.getDate();
  let m = date.getMonth() + 1;
  let y = date.getFullYear();

  if (d < 10) {
    d = '0' + d.toString();
  }

  if (m < 10) {
    m = '0' + m.toString();
  }

  return y + '-' + m + '-' + d;
}

const createTransmission = (client, callback) => {

  const {credentials, streamId, meetingId, meetingName, secret} = client;

  Logger.info(LOG_PREFIX, "Create transmission",client);

  if (transmissions[meetingId]) {
    Logger.info(LOG_PREFIX, "Transmission already exists");
    return callback(null, transmissions[streamId]);
  }

  let params = {
    https: true
  };
  let path = PUBLISH_URL + '/' + meetingId + '?' + querystring.stringify(params);
  let json = JSON.stringify(transmissionObject(meetingName));

  let options = {
    method: 'POST',
    host: HOSTNAME,
    path,
    headers: {
      "Content-type": "application/json",
      Authorization: "Bearer " + credentials,
      clientkey: secret,
    },
  };

  var req = https.request(options, (res) => {
    let result = "";
    res.on('data', (d) => {
      result += d;
    });

    res.on('end', () => {
      let parsed = parseJSON(result);

      if (parsed && parsed.returnMessage.operationCode < 100) {
        let transmission = parseJSON(parsed.returnMessage.result);
        transmissions[streamId] = transmission;

        Logger.info(LOG_PREFIX, "Created transmission", transmission);
        return callback(null, transmission);
      }
    });

    res.on('error', (err) => {
      Logger.error(LOG_PREFIX, err);
      return callback(err);
    });
  });

  req.write(json);
  req.end();
} 

const getTransmissionData = (client, id, callback) => {
  const {credentials, secret} = client;

  let path = DATA_URL + '/' + id;

  let options = {
    method: 'GET',
    host: HOSTNAME,
    path,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + credentials,
      clientkey: secret,
    },
  };

  let result = "";
  let req = https.request(options, (res) => {
    res.on('data', (d) => {
      result += d;
    });

    res.on('end', () => {
      callback(null, parseJSON(result));
    });

    res.on('error', (err) => {
      Logger.error(LOG_PREFIX, err);
      return callback(err);
    });
  });

  req.end();
};

const getStreamKey = (auth, callback) => {
  createTransmission(auth, (err, transmission) => {
    if (err) {
      Logger.error(LOG_PREFIX, "Problem creating transmission", err);
      return callback(err);
    }

    Logger.info(LOG_PREFIX, "Got transmission", transmission);

    getTransmissionData(auth, transmission.id, (err, data) => {
      return callback(null, transmission.rtmp, data.transmission.viewPageUrl);
    });
  });
}

module.exports = {
  getToken,
  getOAuth2Url,
  getStreamKey,
}
