const path = require('path');
const fs = require('fs');

console.log('Testing sysproxy load...');
try {
  const bindingPath = path.join(process.cwd(), 'extra/sidecar/sysproxy.win32-x64-msvc.node');
  console.log('Loading:', bindingPath);
  const binding = require(bindingPath);
  console.log('Success!');
  console.log('Exports:', Object.keys(binding));
} catch (e) {
  console.error('Failed to load:', e);
}

// Keep it alive briefly
setTimeout(() => {
  console.log('Exiting...');
  process.exit(0);
}, 1000);
