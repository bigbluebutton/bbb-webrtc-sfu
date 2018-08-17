'use strict';

const rid = require('readable-id');
const config = require('config');
const Logger = require('../../../utils/Logger');
const KMS_ARRAY = config.get('kurento');
const VIDEO_TRANSPOSING_CEILING = config.get('video-transposing-ceiling');
const AUDIO_TRANSPOSING_CEILING = config.get('audio-transposing-ceiling');
const mediaServerClient = require('kurento-client');
let instance = null;

const _connectToHost = (url, ip) => {
  return new Promise((resolve, reject) => {
    mediaServerClient(url, {failAfter: 1}, (error, client) => {
      if (error) {
        return reject(error);
      }
      const newHost = {
        id: rid(),
        url,
        ip,
        video: 0,
        audio: 0,
        client: client
      };
      return resolve(newHost);
    })
  });
}

class Balancer {
  constructor () {
    if (instance == null) {
      this.hosts = [];
      instance = this;
    }
    return instance;
  }

  async upstartHosts () {
    const processHosts = async () => {
      let validHosts = [];
      for (let i = 0; i < KMS_ARRAY.length; i++) {
        const { url, ip } = KMS_ARRAY[i];
        if (!this._hostStarted(url, ip)) {
          try {
            const newHost = await _connectToHost(url, ip);
            validHosts.push(newHost);
          } catch (err) {
            Logger.error('[mcs-balancer] Failed to connect to candidate host', { url, ip });
          }
        }
      }
      return validHosts;
    }

    this.hosts = await processHosts();

    Logger.info('[mcs-balancer] Available hosts =>', this.hosts.map(h => ({ url: h.url })));
  }

  async getHost () {
    const host = this._fetchAvailableHost();
    Logger.info("[mcs-balancer] Chosen host is", host.id, host.url, host.ip, host.video, host.audio);
    return host;
  }

  decrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]--;
    Logger.info("[mcs-balancer] Host", host.id, "streams decremented", { audio: host.audio }, { video: host.video });
  }

  incrementHostStreams (hostId, nature) {
    const host = this.hosts.find(host => host.id == hostId);
    host[nature]++;
    Logger.info("[mcs-balancer] Host", host.id, "streams incremented", { audio: host.audio }, { video: host.video });
  }

  _fetchAvailableHost () {
    let host = this.hosts.find(host => host.video < VIDEO_TRANSPOSING_CEILING &&
      host.audio < AUDIO_TRANSPOSING_CEILING);

    // Round robin if all instances are fully loaded
    if (host == null) {
      host = this.hosts.shift();
      this.hosts.push(host);
    }

    return host;
  }

  _hostStarted (url, ip) {
    return this.hosts.some(h => h.url == url && h.ip == ip);
  }
}

module.exports = new Balancer();
