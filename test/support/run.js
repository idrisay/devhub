// Hands every `require('vscode')` in the bundle the stub, then runs the suite.
// It has to happen out here: esbuild hoists the bundle's own requires above
// anything the entry point could do about it.
const Module = require('module');
const path = require('path');
const stub = require('./vscode.js');

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : load.call(this, request, ...rest);
};

require(path.join(__dirname, '..', '..', 'dist', 'behaviour.js'));
