"use strict";
/**
 * @classdesc
 * Base class for output messages sent to BBB
 * 2x model
 * @constructor
 */
var _a;
const config = require('config');
module.exports = (_a = class OutMessage2x {
        constructor(messageName, routing, headerFields) {
            this.envelope = {
                name: messageName,
                routing: routing,
                timestamp: Date.now(),
            };
            /**
             * The header template of the message
             * @type {Object}
             * // yeah sure... great type annotation isnt it
             */
            this.core = {
                header: Object.assign({ name: messageName }, OutMessage2x.assembleCoreHeader(headerFields))
            };
            /**
             * The body of the message
             * @type {Object}
             */
            this.core.body = null;
        }
        ;
        /**
         * Generates the JSON representation of the message
         * @return {String} The JSON string of this message
         */
        toJson() {
            return JSON.stringify(this);
        }
    },
    _a.assembleCoreHeader = (fields) => {
        const headers = {};
        // Copy header fiels to the header object
        Object.keys(fields).forEach(key => {
            if (typeof headers[key] === 'undefined') {
                headers[key] = fields[key];
            }
        });
        return headers;
    },
    _a);
