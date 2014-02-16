/**
 * Module dependencies
 */
var Readable = require('stream').Readable
	, _ = require('lodash')
	, log = require('./logger')
	, util = require('util');


// Extend Readable
util.inherits(Upstream, Readable);

/**
 * Constructor
 * @param {[type]} opts [description]
 */
function Upstream (opts) {
	var self = this;
	opts = opts || {};
	_.defaults(opts, {
		objectMode: true,

		// The max # of ms this Upstream will wait without receiving a file
		// before getting frustrated and emitting an error.  (This will tell
		// any connected receivers (writestreams) that they ought to just give
		// up themselves.  This, in turn, triggers the callback for `req.file().upload()`
		maxTimeToWaitForFirstFile: 1500,

		// The max # of ms this Upstream will buffer bytes and wait to be plugged
		// into a receiver.  highWaterMark isn't quite enough, since we want to be
		// allow significant buffering in-memory, but we also want to timeout when the
		// really silly sort of requests come in.
		maxTimeToBuffer: 20000
	});

	// Keep track of file streams which we've emitted.
	this._files = [];

	// Keep track of the receivers we're pumping to.
	this.connectedTo = [];

	// Keep track of timeout timers.
	this.timeouts = {};

	Readable.call(this, opts);

	// Enforce the `maxTimeToWaitForFirstFile` option.
	this.timeouts.untilFirstFileTimer = setTimeout(function () {
		if (self._files.length === 0) {
			var e = new Error();
			e.code = 'ETIMEOUT';
			e.message =
			'ETIMEOUT: An Upstream (`'+self.fieldName+'`) timed out waiting for file(s). '+
			'No files were sent after waiting '+opts.maxTimeToWaitForFirstFile+'ms.';
			self.fatalIncomingError(e);
		}
	}, opts.maxTimeToWaitForFirstFile);

	// Enforce the `maxTimeToBuffer` option.
	this.timeouts.untilMaxBufferTimer = setTimeout(function () {
		if (self.connectedTo.length === 0) {
			var e = new Error();
			e.code = 'ETIMEOUT';
			e.message =
			'ETIMEOUT: An Upstream (`'+self.fieldName+'`) timed out before it was plugged into a receiver. '+
			'It was still unused after waiting '+opts.maxTimeToBuffer+'ms. '+
			'You can configure this timeout by changing the `maxTimeToBuffer` option.';
			self.fatalIncomingError(e);
		}
	}, opts.maxTimeToBuffer);
}




Upstream.prototype._read = function onNewDataRequested ( numBytesRequested ) {

	// Don't really need to do anything in here for now as far as pushing data--
	// we'll push to the receiving writestream when we're ready.

	// However, we will set a flag indicating that we're being read out of by
	// at least one connected receiver.  That doesn't necessarily mean we'll be
	// pumping out any data (we're very fickle), but we'll certainly keep his
	// request in mind.
	this._connected = true;
};



/**
 * upload()
 *
 * Convenience method to pipe to a write stream
 * and provide a traditional node callback.
 * 
 * @param  {stream.Writable}   receiver__
 * @param  {Function} cb
 */
Upstream.prototype.upload = function ( receiver__, cb ) {
	var self = this;

	// Write stream finished successfully!
	receiver__.once('finish', function allFilesUploaded (files) {
		log(('A receiver is finished writing files from Upstream `'+self.fieldName+'`.').grey);
		log('(this doesn\'t necessarily mean any files were actually written...)'.grey);

		// Ensure `files` is an Array.
		files = _.isArray(files) ? files : [];

		cb(null, files);
	});

	// Write stream encountered a fatal error and had to quit early!
	// (some of the files may still have been successfully written, though)
	receiver__.once('error', function unableToUpload (err, files) {
		log(('A receiver handling Upstream `'+self.fieldName+'` encountered a write error :'+util.inspect(err)).red);

		// Ensure `files` is an Array.
		files = _.isArray(files) ? files : [];

		cb(err);
	});

	this.pipe( receiver__ );
};



Upstream.prototype.writeFile = function ( filestream ) {

	// Track incoming file stream in case we need
	// to cancel it:
	this._files.push({
		stream: filestream,
		status: 'bufferingOrWriting'
	});



	// Set up error handlers for the new filestream:
	// 
	var self = this;
	filestream.once('error', function (err) {

		// If the filestream is not being consumed (i.e. this Upstream is not
		// `connected` to anything), then we shouldn't allow errors on it to
		// go unhandled (since it would throw, causing the server to crash).
		
		// On the other hand, if this Upstream is already hooked up to one or more
		// receivers, we're counting on them to listen for "READ" errors on each incoming
		// file stream and handle them accordingly.
		// (i.e. cancel the write and garbage collect the already-written bytes)

		// So basically, in both cases, we'll sort of just catch the file
		// READ error and... well, do nothing.
		//
		// (keep in mind-- an error event will still be emitted on the actual
		// Upstream itself, but that's happening elsewhere.)
	});


	// Pump out the new file
	// (Upstream is a Readable stream, remember?)
	this.push(filestream);
	log(('Upstream: Pumping incoming file through field `'+this.fieldName+'`').grey);
};



/**
 * Called by parser implementation to signal the end of the Upstream.
 * (i.e. no more files are coming)
 * 
 * Anyone trying to `read()` Upstream will no longer be able to get
 * any files from it.
 * 
 */
Upstream.prototype.noMoreFiles = function () {
	log(('Upstream: No more files will be sent through field `'+this.fieldName+'`').grey);
	this.push(null);
};




/**
 * Called by parser implementation to signal an INCOMING fatal error
 * with one or more files being pumped by this Upstream.
 * This means that something went wrong or cancelled the entire file upload on the
 * "source" side (i.e. the request), and that we should invalidate the entire
 * upload.  An example of this scenario is if a user aborts the request.
 *
 * ------------------------------------------------------------------------
 * TODO:
 * Probably can deprecate this, since you almost always want to retain the
 * files that were already uploaded in this case.
 * ------------------------------------------------------------------------
 * 
 * All future files on this Upstream are cancelled (stop listening to file parts)
 * and any currently-uploading files are invalidated.
 *
 * @param  {Error} err
 */
Upstream.prototype.fatalIncomingError = function (err) {

	// Clear all timeouts
	_(this.timeouts).each(function (timer, key) {
		clearTimeout(timer);
	});

	// Log message indicating that we are now aborting/cancelling all
	// future, current, and previously uploaded files from this Upstream.
	log(('Fatal incoming error in Upstream ::   (source or user may have cancelled the request)').red);
	log(err.toString().red);

	// Emit an error event to any of file streams in this Upstream
	// which are still being consumed.
	// 
	// Any `receiver__`s reading this Upstream are responsible for listening to
	// 'error' events on the incoming file readstream(s).  On receipt of such a
	// "READ" error, they should cancel the upload and garbage-collect any bytes
	// which were already written to the destination writestream(s).
	//
	// Receivers should, of course, ALSO listen for "WRITE" errors ('error' events on
	// the outgoing writestream for each file.  The behavior is probably pretty much
	// the same in both cases, although a receiver might, for instance, choose to retry using
	// exponential back-off in the case of a "WRITE" error.  But on receiving a "READ" error,
	// it should always immediately stop.  This is because such an error is usually more
	// serious, and might even be an indication of the user trying to cancel a file upload.
	_(this._files).each(function (file) {
		file.status = 'cancelled';
		file.stream.emit('error', err);
		log(('Upstream: "READ" error on incoming file `'+file.stream.filename+'` ::'+err).red);
	});

	// Indicate the end of the Upstream (no more files coming)
	this.noMoreFiles();


	// Finally, emit error on this Upstream itself to cause some real trouble.
	// If this Upstream is connected to something, this will trigger the error handler
	// on the receiving writestream, which might contain special behavior.
	// Otherwise, the error will be handled by the Parser, which will send a warning
	// back up to the request, or even potentially call `next(err)`, if the parser middleware
	// hasn't handed over control to the app yet.
	this.emit('error', err);

};




module.exports = Upstream;

