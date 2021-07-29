/**
 * @classdesc
 * Base class for output messages sent to BBB
 * 2x model
 * @constructor
 */

const config = require('config');

module.exports = class OutMessage2x {
  static assembleCoreHeader = (fields) => {
    const headers = {};

    // Copy header fiels to the header object
    Object.keys(fields).forEach(key => {
      if (typeof headers[key] === 'undefined') {
        headers[key] = fields[key];
      }
    });

    return headers;
  };

  constructor(messageName, routing, headerFields) {
    this.envelope = {
      name: messageName,
      routing: routing,
      timestamp: Date.now(),
    }
    /**
     * The header template of the message
     * @type {Object}
     * // yeah sure... great type annotation isnt it
     */
    this.core = {
      header : {
        name: messageName,
        ...OutMessage2x.assembleCoreHeader(headerFields)
      }
    };

    /**
     * The body of the message
     * @type {Object}
     */
    this.core.body = null;
  };

  /**
   * Generates the JSON representation of the message
   * @return {String} The JSON string of this message
   */
  toJson () {
    return JSON.stringify(this);
  }
}
