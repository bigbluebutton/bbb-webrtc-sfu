const ipaddr = require('ipaddr.js');

const ipaddrRangeMap = {
  linkLocal: 'local',
  loopback: 'local',
  private: 'private',
  unicast: 'public',
  multicast: 'public',
}

const getMappedIP = (remote, map) => {
  try {
    const range = ipaddr.parse(remote).range();
    const mappedRange = ipaddrRangeMap[range];
    const mappedIP = map[mappedRange] || map.public;
    return mappedIP;
  } catch (error) {
    return map.public;
  }
};

module.exports = { getMappedIP };
