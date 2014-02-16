/**
 * Module dependencies
 */

var _ = require('lodash')
	, util = require('util')
	, EventEmitter = require('events').EventEmitter

	, Upstream = require('../Upstream')
	, applyDefaultOptions = require('./defaults');



/**
 * Parser
 *
 * constructor
 * 
 * @param {[type]} req     [description]
 * @param {[type]} options [description]
 * @param {Function} next
 */

function Parser(req, options, next) {

	this.req = req;
	this.next = next;
	this.options = options = applyDefaultOptions(options);
	this.upstreams = [];

	//
	// Note: `this.upstreams` tracks upload streams generated
	// during this request.
	//

	this.parse();
}
util.inherits(Parser, EventEmitter);


/**
 * Parse an incoming multipart request.
 */

Parser.prototype.parse = require('./parse');

Parser.prototype.onFile = require('./onFile');

Parser.prototype.onTextParam = require('./onTextParam');



/**
 * Find the Upstream with `fieldName`, or
 * create and save it for the first time if necessary.
 * (Takes care of managing the collection of upstreams.)
 * 
 * @param  {String} fieldName
 * @return {Upstream}
 */
Parser.prototype.acquireUpstream = function ( fieldName ) {

	var existingStream = _.find(this.upstreams, {
		fieldName: fieldName
	});
	if (existingStream) return existingStream;
	

	// Instantiate a new Upstream, and save the fieldName for it.
	var newUpstream = new Upstream();
	newUpstream.fieldName = fieldName;
	this.upstreams.push(newUpstream);


	// If the new Upstream ever emits an 'error' event ("READ" error),
	var self = this;
	newUpstream.once('error', function (err) {

		// terminate the request early (call `next`)
		if (! self._hasPassedControlToApp ) {
			return self.next(err);
		}

		// TODO:
		// UNLESS control has already been passed!!
		// 
		// If it has, and the upstream is already hooked up to one or more receivers,
		// in which case we should let each of the receiver[s] (write stream[s])
		// handle the error however they see fit:
		// if (!newUpstream.connectedTo || !newUpstream.connectedTo.length) {
			// _.each(newUpstream.connectedTo, function eachReceiver(outs) {
			//   outs.emit('error', err);
			// });
			// return;
		// }

		// TODO:
		// if control has been passed, but nothing has been hooked up yet,
		// we can't really do anything helpful.  We'll log a warning.
		// (this is all to keep from throwing and crashing the app)
		self.emit('warning', 'Error in incoming multipart form upload ::'+err);
		// TODO: use stringfile instead
		// self.emit('warning', STRINGFILE.get('warning.paramArrivedTooLate', [field, field]));
		return;

	});

	return newUpstream;

};



module.exports = Parser;

