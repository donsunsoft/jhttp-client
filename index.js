var http = require('http');
var https = require('https');
var fs = require('fs');
var q = require('q');
var ua = require('random-ua');
var urlParse = require('url');
var cheerio = require('cheerio');
var mime = require('mime');
var CookieManager = require('cookie-manager');
var concatStream = require('concat-stream')
var zlib = require('zlib');
var passStream = require('stream').PassThrough;
var iconv = require('iconv').Iconv;

var normalizeUrl = function(str){
	if(/^https\:\/\//.test(str)) return str;
	if(/^http\:\/\//.test(str)) return str;
	return 'http://'+(str.replace(/^\//,''));
};

var extendArray = function(){
	var v = [];
	for(var i in arguments){
		for(var j in arguments[i]){
			v[j] = arguments[i][j];
		}
	}
	return v;
};

var extendObj = function(){
	var v = {};
	for(var i in arguments){
		for(var j in arguments[i]){
			if(typeof arguments[i][j]=='undefined') continue;
			else if(arguments[i][j].constructor == Array){
				v[j] = extendArray(arguments[i][j]);
			}else if(typeof arguments[i][j] == 'object'){
				v[j] = extendObj(arguments[i][j]);
			}else{
				v[j] = arguments[i][j];
			}
		}
	};

	return v;
};

var defaultOpts = {
	url:'',
	method:'get',
	accept: 'text/html, text/plain, application/json, */*',
	output: 'string',
	expect:200,
	charset: 'UTF-8',
	followRedirect: true,
	useCookie: true,
	auth:'',
	proxy: '',
	ssl:{
		rejectUnauthorized: false
	},
	headers:{
		'user-agent': ua.generate()
	},
	data: false
}

function lowerCaseKeys(c){
	var t = {};
	for(var i in c){
		t[ i.toLowerCase() ] = c[i];
	}
	return t;
}

function upperCaseKeys(c){
	var t = {};
	for(var i in c){
		t[ i.split('-').map(function(s){return s.charAt(0).toUpperCase() + s.slice(1)}).join('-') ] = c[i];
	}
	return t;
}

function constructHeaders(obj){

	var c = lowerCaseKeys(obj['headers']);

	var charset = typeof obj['charset'] == 'undefined' ? defaultOpts['charset'] : obj['charset'];
	var accept = typeof obj['accept'] == 'undefined' ? defaultOpts['accept'] : obj['accept'];

	if( typeof c['accept-charset'] == 'undefined' ) c['accept-charset'] = charset;
	if( typeof c['accept'] == 'undefined' ) c['accept'] = accept;

	//prevent header pattern recognizer (if there is such a thing)
	c['x-http-h'+Math.round(Math.random()*892374)] = Math.round(Math.random()*892374);

	return upperCaseKeys(c);
}

function getBound(){
	return 'seinrv'+Math.round(Math.random()*98237498679869879878976)+'asdfgkljh';
}

function getContentType(data){
	if(typeof data.type != 'undefined') return data.type;
	if(typeof data.file != 'undefined') return 'multipart/form-data';
	return 'application/x-www-form-urlencoded';
}


function encodePostData(data){
	var s = '';
	for(var i in data){
		s += encodeURIComponent(i) + '=' + encodeURIComponent(data[i]) + '&';
	}
	return s.replace(/&$/,'');
}

function constructData(data,bound){

	if(typeof data == 'string') return data;
	if(typeof data.content == 'string') return data.content;

	if(typeof data.content == 'object' && typeof data.file == 'undefined')
		return encodePostData(data.content);

	var content = '--' + bound + "\r\n";
	if(typeof data.content != 'undefined'){
		for(var i in data.content) 
			content += 'Content-Disposition: form-data; name="' + i + '"\r\n\r\n' + 
						data.content[i] + '\r\n' + '--' + bound + '\r\n';
	}

	for(var i in data.file){

		(function(){

			var filename = data.file[i].filename.replace(/\\/,'/').split('/').pop();
			if(typeof data.file[i].content == 'undefined')
				data.file[i].content = fs.readSync(data.file[i].filename);
			if(typeof data.file[i].mime == 'undefined')
				data.file[i].mime = mime.lookup(filename);

			content += 'Content-Disposition: form-data; name="' + data.file[i].name + '"; filename="' + 
						filename + '"\r\n' + 'Content-Type: '+ data.file[i].mime + '\r\n\r\n' + 
						data.file[i].content + '\r\n' + '--' + bound + '\r\n';
		})();
	}

	return content.replace(/\r\n$/,'--');

}

function isRedirection(status){
	return /^3/.test(status+'');
}

var jhttp = function(obj){

	this.options = extendObj(defaultOpts);
	this.req = false;

	this.cookies = new CookieManager();

	this.last = false;

	if(obj && typeof obj == 'object') this.options = extendObj(this.options,obj);
	if(obj && typeof obj == 'string') this.options.url = normalizeUrl(obj);

};

jhttp.prototype.abort = function(){
	if(this.req.toString() == '[Object Promise]') return false;
	this.req.abort();
	return true;
}

jhttp.prototype.request = function(obj){

	if(!obj) obj = {};
	if(obj && typeof obj == 'object') obj = extendObj(this.options,obj);
	if(obj && typeof obj == 'string') {
		var url = obj;
		obj = extendObj(this.options);
		obj.url = url;
	}

	obj.url = normalizeUrl(obj.url);

	if(!obj) obj = extendObj(this.options);

	var url = urlParse.parse(obj.url);
	var dhttp = q.defer();

	// prepare data and headers
	var bound = getBound();
	var dataCons = '';
	var headers = constructHeaders(obj);

	if(headers['Accept']=='*/*' && obj.output == 'json')headers['Accept']='application/json';
	if(headers['Accept']=='*/*' && obj.output == '$')headers['Accept']='text/html';
	if(obj.data && obj.method!='get'){
		headers['Content-Type'] = getContentType(obj.data);
		if(headers['Content-Type'] == 'multipart/form-data')
			headers['Content-Type']+='; boundary='+bound;

		dataCons = constructData(obj.data,bound);
		headers['Content-Length'] = dataCons.length;
	}

	if(typeof headers['Cookie'] == 'undefined') headers['Cookie'] = this.cookies.prepare( url.href );
	if( !headers['Cookie'] || !obj.useCookie )  delete headers['Cookie'];
	headers['Accept-Encoding'] = 'gzip, deflate, identity';
	
	// set opts for native http/https
	var opt = {
		hostname: url.hostname,
		path: url.path,
		method: obj.method.toUpperCase(),
		headers: headers,
		protocol: url.protocol
	}

	if(url.port) opt.port = url.port;
	if(obj.auth) opt.auth = obj.auth;


	//set opts for proxy
	if(obj.proxy){
		var proxy = urlParse.parse(obj.proxy, false);
		opt.path = url.protocol + '//' + url.host + url.path;
		opt.headers.host = url.host;
		opt.protocol = proxy.protocol;
		opt.host = proxy.host;
		opt.hostname = proxy.hostname;
		opt.port = proxy.port;
	}

	//set https transport
	if(opt.protocol=='https:' ) {
		for(var i in obj.ssl) opt[i] = obj.ssl[i];
	}

	//encoding stuff
	opt.encoding=null;
	
	//store last request
	this.last = obj;

	// start request
	var t = this;
	this.req = (opt.protocol=='https:'?https:http).request(opt,function(res){

		//console.log('responded');

		//read status
		if( obj.expect && res.statusCode != obj.expect && !isRedirection(res.statusCode)) {
			delete obj;
			dhttp.reject({
				status: res.statusCode,
				text: 'Unexpected HTTP Status'
			});
			return;
		}

		if( res.statusCode != obj.expect && isRedirection(res.statusCode) && obj.followRedirect) {
			obj.url = res.headers['location'];
			dhttp.resolve( t.request( obj ) );
			return;
		}

		//read & save cookie
		if(typeof res.headers['set-cookie'] != 'undefined'){
			t.cookies.store( url.href, res.headers['set-cookie'] );
		}
		
		//read encoding
		var contentEncoding = typeof res.headers['content-encoding'] == 'undefined' ? '' : res.headers['content-encoding'];
		contentEncoding = contentEncoding=='identity' ? false : contentEncoding;

		var charset = '';
		if(
			typeof res.headers['content-type'] != 'undefined' &&
			(charset = res.headers['content-type'].match(/charset\=(.+)/))
		){
			charset = charset[1];
		}else charset = 'ISO-8859-1';

		charset = charset.toLowerCase();
		//if(charset=='utf-8') res.setEncoding('utf8');

		////////////////////////////
		//contentEncoding ? zlib.createUnzip() : passStream()
		//console.log(res.headers);
		//console.log('charset: '+charset);
		res.pipe(concatStream(function(b){

			var decompress = contentEncoding ? zlib.unzip : function(a,f){ f(false,a); };
			decompress(b,function(e,result){
				if(e){
					if(contentEncoding=='deflate'){
						zlib.inflateRaw(b,function(er,buff){
							if(er) dhttp.reject( er );
							else {
								try{
									dhttp.resolve(parseResponse(buff,charset,res,obj));
								}catch(e){ dhttp.reject(e); }
							}
						});
					}
					else {
						dhttp.reject( e );
					}
				}else{
					try{
						dhttp.resolve(parseResponse(result,charset,res,obj));
					}catch(e){ dhttp.reject(e); }
				}
			});

		}));

	});
	//console.log('sent request');

	this.req.on('error', function(e) {
		delete obj;
		dhttp.reject({ status:0, text: e });
	});

	//console.log('end request');
	// send data if any
	if(dataCons && obj.method != 'get')
	this.req.write( dataCons );
	
	this.req.end();

	//console.log('wait response');
	return dhttp.promise;
};

var parseResponse = function(b,charset,res,obj){
	try{
		if(charset!='utf-8') b = (new iconv(charset, 'utf-8')).convert(b);
	}catch(e){}

	var r = { 
		status: res.statusCode,
		headers: res.headers,
		body: b.toString()
	}

	if( obj.output == 'buffer' ) r.body = new Buffer(r.body);
	if( obj.output == 'json' ) {
		try{
			r.body = JSON.parse(r.body);
		}catch(e){
			throw new Error('jHttp > cannnot parse JSON');
			return false;
		}
		
	}
	if( obj.output == '$' ) r.body = cheerio.load(r.body);
	delete obj;
	return r;

};

module.exports = exports = function(opt){ return new jhttp(opt) };

