const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const querystring = require('querystring');
const config = require('config');
const Logger = require('../utils/Logger');
const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');

let bbbGW = null;

const AUTH_URL = "/portal/oauth/authorize";
const PUBLISH_URL = "/services/transmission/publish";
const SCHEDULE_URL = "/services/transmission/update/%identifier%/schedule";
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
    streamId,
    streamType,
  }

  let authUrl = generateAuthUrl(client, {
    scope: SCOPES,
    state: streamId,
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

const getCurrentTime = () => {
  let d = new Date();
  return d.getHours() + ":" + d.getMinutes();
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
      startTime: getCurrentTime(),
      endTime: '23:59',
      //keywords: [title, 'mconf', 'webinar'].join(),
      //author: null,
      //eventName: title,
      //passwordURLTransmission: 'mconfpass',
    }
  };
};

const getDateString = () => {
  let date = new Date();

  // Previously RNP used UTC timezone servers, now they're using the same timezone as us
  const offset = 0; //date.getTimezoneOffset() * 60 * 1000;

  // adjust timezone to get correct day
  date = new Date(Date.now() - offset);

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

const rescheduleTransmission = (id, client, endTime, callback) => {
  let path = SCHEDULE_URL.replace('%identifier%', id);
  let json = JSON.stringify({
    transmission: {
      endTime,
    },
  });

  let { credentials, secret } = client;

  let options = {
    method: 'POST',
    host: HOSTNAME,
    path,
    headers: {
      Accept: "application/json",
      "Content-type": "application/json",
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
      return callback(null, JSON.parse(result));
    });

    res.on('error', (err) => {
      Logger.error(LOG_PREFIX, `Reschedule request failed`, { errorMessage: err.message, errorCode: err.code });
      return callback(err);
    });
  });

  req.write(json);
  req.end();
}

const findOrCreateTransmission = (client, callback) => {
  if (!bbbGW) {
    bbbGW = new BigBlueButtonGW();
  }

  const { streamId } = client;
  const streamKey = `${streamId}_stream`;

  Logger.info(LOG_PREFIX, "Find or create transmission", client);

  bbbGW.getKey(streamKey, (err, value) => {
    if (err) {
      Logger.error(LOG_PREFIX, "Redis error", err, streamId);
      return callback(err, null);
    }

    if (value === '' || value === null) {
      Logger.info(LOG_PREFIX, "No prior data, creating transmission", client);
      createTransmission(client, (err, data) => {
        if (err) {
          return callback(err, null);
        }

        bbbGW.setKey(streamKey, JSON.stringify(data), (err) => {
          if (err) {
            Logger.error(LOG_PREFIX, "Redis error", err, streamId);
            return callback(err, null);
          }

          return callback(err, data);
        });
      });
    } else {
      Logger.info(LOG_PREFIX, "Transmission already exists");

      return rescheduleTransmission(streamId, client, '23:59', (err, result) => {
        Logger.info(LOG_PREFIX, 'Rescheduled transmission', err, result);
        return callback(null, parseJSON(value));
      });
    }
  })
}

const createTransmission = (client, callback) => {
  const {credentials, streamId, meetingId, meetingName, secret} = client;

  let params = {
    https: true
  };
  let path = PUBLISH_URL + '/' + streamId + '?' + querystring.stringify(params);
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

        Logger.info(LOG_PREFIX, "Created transmission", transmission);
        return callback(null, transmission);
      } else {
        return callback(parsed.returnMessage.result, null);
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
      return callback(null, parseJSON(result));
    });

    res.on('error', (err) => {
      Logger.error(LOG_PREFIX, err);
      return callback(err);
    });
  });

  req.end();
};

const getStreamKey = (auth, callback) => {
  if (!auth) {
    Logger.error(LOG_PREFIX, "getStreamKey with null client");
    return callback("No auth data returned. Permission denied.");
  }

  findOrCreateTransmission(auth, (err, transmission) => {
    if (err) {
      Logger.error(LOG_PREFIX, "Problem creating transmission", err);
      return callback(err);
    }

    Logger.info(LOG_PREFIX, "Got transmission", transmission);

    getTransmissionData(auth, transmission.id, (err, data) => {
      if (err) {
        Logger.error(LOG_PREFIX, "Problem getting transmission data", err);
        return callback(err);
      }
      Logger.info(LOG_PREFIX, "Got data", data);
      return callback(null, transmission.rtmp, data.transmission.viewPageUrl);
    });
  });
}

const closeOAuth2Connection = (streamId, client, callback) => {
  let endTime = getCurrentTime();
  return rescheduleTransmission(streamId, client, endTime, (err, result) => {
    Logger.info(LOG_PREFIX, 'Update schedule', err, result);
  });
};

module.exports = {
  getToken,
  getOAuth2Url,
  getStreamKey,
  closeOAuth2Connection,
}
