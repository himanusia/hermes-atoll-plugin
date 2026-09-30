#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capturePath = path.join(__dirname, 'capture-expanded-demo.js');
const source = fs.readFileSync(capturePath, 'utf8');

const forbidden = [
  ['coordinate helper', /tools[\\/]click/i],
  ['pointer movement or hover', /\b(?:moveto|move_cursor|hover)\b/i],
  ['browser or keyboard input', /\b(?:browser_click|browser_pointer|double_click|right_click|drag|hotkey|press_key|type_text)\b/i],
  ['foreground activation', /\bbring_to_front\b|delivery_mode\s*:\s*['"]foreground['"]/i],
  ['coordinate payload', /\b(?:x|y)\s*:/i],
];
for (const [label, pattern] of forbidden) {
  assert.doesNotMatch(source, pattern, `capture replay must not use ${label}`);
}

assert.match(source, /driverCall\(socket, 'get_window_state'/, 'capture must inspect the exact window through CuaDriver');
assert.match(source, /include_screenshot: false/, 'AX verification must not use a pointer-oriented screenshot action');
assert.match(source, /driverCall\(socket, 'click',[\s\S]{0,500}delivery_mode: 'background'/, 'tab selection must use background AX delivery');
assert.match(source, /element_token/, 'AX selection must use a token from the fresh snapshot');
assert.match(source, /refusing to capture/, 'capture must fail closed when the expected UI state is absent');
assert.match(source, /driverCall\(socket, 'get_desktop_state'/, 'the final screenshot must use the read-only desktop capture');

console.log('capture-expanded-demo replay safety checks passed');
